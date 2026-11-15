import crypto from 'node:crypto';
import type {EsignAdapter, EsignProviderEvent} from '@services-marketplace/contracts';
import {AdapterDisabledError, defaultFetch, type AdapterStatus, type FetchLike} from './status.js';

/** Canonical string the e-sign vendor signs for webhook events. */
export function esignEventPayload(event: EsignProviderEvent): string {
  return [event.contractVersion, event.providerEnvelopeId, event.documentDigest, event.status,
    event.occurredAt].join('.');
}

/**
 * E-signature adapter for an HTTPS vendor exposing `POST /envelopes` and HMAC-signed
 * webhooks (`evidence.signature` = hex HMAC-SHA256 of `esignEventPayload`). Disabled
 * without ESIGN_API_URL, ESIGN_API_KEY and ESIGN_WEBHOOK_SECRET.
 */
export class HttpEsignAdapter implements EsignAdapter {
  readonly status: AdapterStatus;

  constructor(private readonly config: {readonly url?: string | undefined;
    readonly apiKey?: string | undefined; readonly webhookSecret?: string | undefined},
  private readonly fetchImpl: FetchLike = defaultFetch) {
    this.status = config.url?.startsWith('https://') && config.apiKey && config.webhookSecret
      ? {name: 'esign', mode: 'live', detail: 'vendor ' + new URL(config.url).host}
      : {name: 'esign', mode: 'disabled',
        detail: 'ESIGN_API_URL / ESIGN_API_KEY / ESIGN_WEBHOOK_SECRET not set'};
  }

  async createEnvelope(input: {envelopeId: string; documentDigest: string;
    customerSubjectId: string}): Promise<{providerEnvelopeId: string; signingUrl: string}> {
    if (this.status.mode !== 'live') throw new AdapterDisabledError('esign');
    const response = await this.fetchImpl(this.config.url!.replace(/\/$/, '') + '/envelopes', {
      method: 'POST',
      headers: {authorization: 'Bearer ' + this.config.apiKey, 'content-type': 'application/json',
        'idempotency-key': input.envelopeId},
      body: JSON.stringify({externalId: input.envelopeId, documentDigest: input.documentDigest,
        signerReference: input.customerSubjectId}),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof body.id !== 'string' || typeof body.signingUrl !== 'string' ||
      !body.signingUrl.startsWith('https://')) {
      throw new Error('esign vendor request failed with status ' + response.status);
    }
    return {providerEnvelopeId: body.id, signingUrl: body.signingUrl};
  }

  async verifyEvent(event: EsignProviderEvent): Promise<boolean> {
    if (this.status.mode !== 'live') return false;
    const signature = (event.evidence as {signature?: unknown} | null)?.signature;
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
    const expected = crypto.createHmac('sha256', this.config.webhookSecret!)
      .update(esignEventPayload(event)).digest();
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expected);
  }
}
