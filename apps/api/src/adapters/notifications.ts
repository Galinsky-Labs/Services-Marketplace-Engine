import type {
  NotificationChannel, NotificationChannelAdapter, NotificationDeliveryCommand,
} from '@services-marketplace/contracts';
import {AdapterDisabledError, defaultFetch, type AdapterStatus, type FetchLike} from './status.js';

/** Resolves an opaque recipient reference (never raw contact data) to an address. */
export type RecipientResolver = (organizationId: string, recipientReference: string,
  channel: NotificationChannel) => Promise<string | null>;

export interface RenderedMessage {
  readonly subject: string;
  readonly text: string;
}

/** Built-in, industry-neutral templates. Payloads are links, never personal data. */
export function renderTemplate(templateKey: string, payloadReference: string,
  appBaseUrl: string): RenderedMessage | null {
  const link = appBaseUrl.replace(/\/$/, '') + '/r/' + encodeURIComponent(payloadReference);
  const templates: Record<string, RenderedMessage> = {
    'lead.received': {subject: 'You have a new service request',
      text: 'A customer sent a new service request. Review it here: ' + link},
    'quote.received': {subject: 'You received a quote',
      text: 'A provider sent you a quote. Review it here: ' + link},
    'job-room.message': {subject: 'New message in your job room',
      text: 'You have a new message. Read it here: ' + link},
    'generic.update': {subject: 'Update on your service request',
      text: 'There is an update on your request: ' + link},
  };
  return templates[templateKey] ?? null;
}

abstract class BaseChannelAdapter implements NotificationChannelAdapter {
  abstract readonly status: AdapterStatus;
  constructor(protected readonly resolve: RecipientResolver,
    protected readonly appBaseUrl: string, protected readonly fetchImpl: FetchLike) {}

  protected async prepare(command: NotificationDeliveryCommand, channel: NotificationChannel):
    Promise<{address: string; message: RenderedMessage}> {
    if (this.status.mode === 'disabled') throw new AdapterDisabledError(this.status.name);
    const address = await this.resolve(command.organizationId, command.recipientReference, channel);
    const message = renderTemplate(command.templateKey, command.payloadReference, this.appBaseUrl);
    if (!address || !message) throw new Error('notification recipient or template unavailable');
    return {address, message};
  }

  abstract send(command: NotificationDeliveryCommand): Promise<{readonly providerMessageId: string}>;
}

/** Email through the Resend HTTP API. */
export class ResendEmailAdapter extends BaseChannelAdapter {
  readonly status: AdapterStatus;
  constructor(private readonly config: {apiKey?: string | undefined; from?: string | undefined},
    resolve: RecipientResolver, appBaseUrl: string, fetchImpl: FetchLike = defaultFetch) {
    super(resolve, appBaseUrl, fetchImpl);
    this.status = config.apiKey && config.from
      ? {name: 'email-resend', mode: config.apiKey.startsWith('re_test') ? 'sandbox' : 'live',
        detail: 'from ' + config.from}
      : {name: 'email-resend', mode: 'disabled', detail: 'RESEND_API_KEY / EMAIL_FROM not set'};
  }
  async send(command: NotificationDeliveryCommand): Promise<{providerMessageId: string}> {
    const {address, message} = await this.prepare(command, 'email');
    const response = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {authorization: 'Bearer ' + this.config.apiKey, 'content-type': 'application/json',
        'idempotency-key': command.organizationId + ':' + command.requestKey},
      body: JSON.stringify({from: this.config.from, to: [address], subject: message.subject,
        text: message.text}),
    });
    const body = await response.json() as {id?: unknown};
    if (!response.ok || typeof body.id !== 'string') throw new Error('email send failed: ' + response.status);
    return {providerMessageId: body.id.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128)};
  }
}

/** SMS through the Twilio Messages API. */
export class TwilioSmsAdapter extends BaseChannelAdapter {
  readonly status: AdapterStatus;
  constructor(private readonly config: {accountSid?: string | undefined;
    authToken?: string | undefined; from?: string | undefined},
  resolve: RecipientResolver, appBaseUrl: string, fetchImpl: FetchLike = defaultFetch) {
    super(resolve, appBaseUrl, fetchImpl);
    this.status = config.accountSid && config.authToken && config.from
      ? {name: 'sms-twilio', mode: 'live', detail: 'account configured'}
      : {name: 'sms-twilio', mode: 'disabled',
        detail: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM not set'};
  }
  async send(command: NotificationDeliveryCommand): Promise<{providerMessageId: string}> {
    const {address, message} = await this.prepare(command, 'sms');
    const sid = this.config.accountSid!;
    const from = this.config.from!;
    const form = new URLSearchParams({To: address, Body: message.text});
    form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
    const response = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {authorization: 'Basic ' + Buffer.from(sid + ':' + this.config.authToken).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded'},
        body: form.toString(),
      });
    const body = await response.json() as {sid?: unknown};
    if (!response.ok || typeof body.sid !== 'string') throw new Error('sms send failed: ' + response.status);
    return {providerMessageId: body.sid};
  }
}

/** Push notifications through the Expo push service (opt-in with PUSH_PROVIDER=expo). */
export class ExpoPushAdapter extends BaseChannelAdapter {
  readonly status: AdapterStatus;
  constructor(private readonly config: {provider?: string | undefined; accessToken?: string | undefined},
    resolve: RecipientResolver, appBaseUrl: string, fetchImpl: FetchLike = defaultFetch) {
    super(resolve, appBaseUrl, fetchImpl);
    this.status = config.provider === 'expo'
      ? {name: 'push-expo', mode: 'live', detail: config.accessToken ? 'access token set' : 'no access token'}
      : {name: 'push-expo', mode: 'disabled', detail: 'PUSH_PROVIDER=expo not set'};
  }
  async send(command: NotificationDeliveryCommand): Promise<{providerMessageId: string}> {
    const {address, message} = await this.prepare(command, 'push');
    const headers: Record<string, string> = {'content-type': 'application/json', accept: 'application/json'};
    if (this.config.accessToken) headers.authorization = 'Bearer ' + this.config.accessToken;
    const response = await this.fetchImpl('https://exp.host/--/api/v2/push/send', {
      method: 'POST', headers,
      body: JSON.stringify({to: address, title: message.subject, body: message.text}),
    });
    const body = await response.json() as {data?: {status?: unknown; id?: unknown}};
    if (!response.ok || body.data?.status !== 'ok' || typeof body.data.id !== 'string')
      throw new Error('push send failed: ' + response.status);
    return {providerMessageId: body.data.id};
  }
}
