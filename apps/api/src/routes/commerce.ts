import {
  NOTIFICATION_ADAPTER_REJECTED, PAYMENT_ABSTRACTION_REJECTED, createStripeConnectPaymentIntent,
  dispatchNotification, type ConnectedPaymentAccount, type CustomerProfile,
  type MarketplacePaymentIntent, type NotificationAdapterStore, type NotificationChannel,
  type NotificationDelivery, type NotificationIntent, type OrganizationAuthorizationState,
  type PaymentAbstractionStore, type PaymentJobRoom,
} from '@services-marketplace/contracts';
import type {RecipientResolver} from '../adapters/notifications.js';
import type {AppServices} from '../app.js';
import type {RouteDefinition} from '../http/router.js';
import {s, type JsonSchema} from '../http/schema.js';
import type {DocumentStore} from '../store/documents.js';
import {auditOptions, contractOptions, operatorFrom, organizationPath, respond, route, tenantOf} from './common.js';

type StateLoader = (organizationId: string, subjectId: string) =>
  Promise<OrganizationAuthorizationState>;

export function paymentStore(documents: DocumentStore): PaymentAbstractionStore {
  return {
    getJobRoom: (organizationId, id) => documents.get<PaymentJobRoom>(organizationId, 'job-room', id),
    getPaymentAccount: (organizationId, id) => documents.get<ConnectedPaymentAccount>(organizationId, 'payment-account', id),
    getPaymentIntentByRequestKey: (organizationId, requestKey) => documents.findOne<MarketplacePaymentIntent>(
      organizationId, 'payment-intent', {requestKey}),
    recordPaymentIntent: value => documents.put(value.organizationId, {kind: 'payment-intent',
      id: value.paymentIntentId, expected: null, next: value, uniqueKeys: ['requestKey']}),
  };
}

export function notificationStore(documents: DocumentStore, load: StateLoader): NotificationAdapterStore {
  return {
    getOperator: async (organizationId, subjectId) =>
      operatorFrom(await load(organizationId, subjectId), organizationId, subjectId),
    getIntent: (organizationId, id) => documents.get<NotificationIntent>(organizationId, 'notification-intent', id),
    getDeliveryByRequestKey: (organizationId, requestKey) => documents.findOne<NotificationDelivery>(
      organizationId, 'notification-delivery', {requestKey}),
    commit: (intent, delivery) => documents.putAll(delivery.organizationId, [
      {kind: 'notification-intent', id: intent.intentId, expected: intent, next: intent},
      {kind: 'notification-delivery', id: delivery.deliveryId, expected: null, next: delivery,
        uniqueKeys: ['requestKey']},
    ]),
  };
}

/**
 * Recipient references are opaque: `customer-profile:<id>` resolves to the profile email
 * or phone; `push-device:<id>` resolves to a registered push token.
 */
export function recipientResolver(documents: DocumentStore): RecipientResolver {
  return async (organizationId, reference, channel: NotificationChannel) => {
    const [type, id] = reference.split(/:(.+)/) as [string, string | undefined];
    if (!id) return null;
    if (type === 'customer-profile' && channel !== 'push') {
      const profile = await documents.get<CustomerProfile>(organizationId, 'customer-profile', id);
      if (profile?.status !== 'active') return null;
      return channel === 'email' ? profile.email : profile.phone;
    }
    if (type === 'push-device' && channel === 'push') {
      const device = await documents.get<{token: string; status: string}>(organizationId, 'push-device', id);
      return device?.status === 'active' ? device.token : null;
    }
    return null;
  };
}

export const commerceSchemas: Record<string, JsonSchema> = {
  JobRoom: s.object({organizationId: s.string(), jobRoomId: s.string(), customerSubjectId: s.string(),
    providerOrganizationId: s.string(), status: s.enum('active', 'completed', 'closed')}),
  PaymentAccount: s.object({paymentAccountId: s.string(), organizationId: s.string(),
    providerOrganizationId: s.string(), processor: {const: 'stripe_connect'},
    processorAccountReference: s.string(), status: s.enum('active', 'restricted', 'closed'),
    chargesEnabled: s.boolean(), payoutsEnabled: s.boolean()}),
  PaymentIntent: s.object({paymentIntentId: s.string(), organizationId: s.string(), requestKey: s.string(),
    jobRoomId: s.string(), customerSubjectId: s.string(), providerOrganizationId: s.string(),
    paymentAccountId: s.string(), processor: {const: 'stripe_connect'}, processorIntentReference: s.string(),
    amountMinor: s.integer(), currency: s.string(),
    status: s.enum('requires_payment_method', 'requires_action', 'authorized'), createdAt: s.integer()}),
  NotificationIntent: s.object({intentId: s.string(), organizationId: s.string(),
    status: s.enum('ready', 'cancelled'), channel: s.enum('email', 'push', 'sms'),
    recipientReference: s.string(), templateKey: s.string(), payloadReference: s.string(),
    notBefore: s.integer(), expiresAt: s.integer()}),
  NotificationDelivery: s.object({deliveryId: s.string(), organizationId: s.string(), requestKey: s.string(),
    intentId: s.string(), channel: s.enum('email', 'push', 'sms'), recipientReference: s.string(),
    templateKey: s.string(), payloadReference: s.string(), providerMessageId: s.string(),
    actorSubjectId: s.string(), dispatchedAt: s.integer()}),
};

export function commerceRoutes(services: AppServices): RouteDefinition[] {
  const load: StateLoader = (organizationId, subjectId) =>
    services.identity.loadAuthorizationState(organizationId, subjectId);
  const payments = {store: paymentStore(services.documents), processor: services.adapters.stripe,
    audit: auditOptions(services), now: services.now};
  const notifications = {...contractOptions(services), store: notificationStore(services.documents, load),
    adapters: {email: services.adapters.email, sms: services.adapters.sms, push: services.adapters.push}};
  const id = s.id();
  return [
    route({method: 'PUT', path: organizationPath + '/job-rooms/{jobRoomId}', operationId: 'putJobRoom',
      tag: 'Commerce', auth: 'tenant', permission: 'job-rooms:write',
      summary: 'Register the job room a payment belongs to (customer and provider binding)',
      requestBody: s.object({customerSubjectId: id, providerOrganizationId: id,
        status: s.enum('active', 'completed', 'closed')}),
      success: {status: 200, description: 'Job room stored', schema: s.ref('JobRoom')},
      handler: async context => {
        const tenant = tenantOf(context);
        const jobRoomId = context.params.jobRoomId!;
        const body = context.body as Omit<PaymentJobRoom, 'organizationId' | 'jobRoomId'>;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobRoomId)) return {status: 400, body: {code: 'invalid_request'}};
        const current = await services.documents.get<PaymentJobRoom>(tenant.organizationId, 'job-room', jobRoomId);
        const next: PaymentJobRoom = {organizationId: tenant.organizationId, jobRoomId, ...body};
        if (current && (current.customerSubjectId !== next.customerSubjectId ||
          current.providerOrganizationId !== next.providerOrganizationId)) return {status: 409, body: {code: 'conflict'}};
        return await services.documents.put(tenant.organizationId, {kind: 'job-room', id: jobRoomId,
          expected: current, next}) ? {status: 200, body: next} : {status: 409, body: {code: 'conflict'}};
      }}),
    route({method: 'PUT', path: organizationPath + '/payment-accounts/{paymentAccountId}',
      operationId: 'putPaymentAccount', tag: 'Commerce', auth: 'tenant', permission: 'commerce:payment-accounts:write',
      summary: 'Record a provider\'s Stripe Connect account and its capability status',
      requestBody: s.object({providerOrganizationId: id, processorAccountReference: s.string({pattern: '^acct_[A-Za-z0-9]{1,64}$'}),
        status: s.enum('active', 'restricted', 'closed'), chargesEnabled: s.boolean(), payoutsEnabled: s.boolean()}),
      success: {status: 200, description: 'Account stored', schema: s.ref('PaymentAccount')},
      handler: async context => {
        const tenant = tenantOf(context);
        const paymentAccountId = context.params.paymentAccountId!;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(paymentAccountId)) return {status: 400, body: {code: 'invalid_request'}};
        const current = await services.documents.get<ConnectedPaymentAccount>(tenant.organizationId,
          'payment-account', paymentAccountId);
        const next: ConnectedPaymentAccount = {paymentAccountId, organizationId: tenant.organizationId,
          processor: 'stripe_connect', ...(context.body as Omit<ConnectedPaymentAccount,
            'paymentAccountId' | 'organizationId' | 'processor'>)};
        return await services.documents.put(tenant.organizationId, {kind: 'payment-account', id: paymentAccountId,
          expected: current, next}) ? {status: 200, body: next} : {status: 409, body: {code: 'conflict'}};
      }}),
    route({method: 'POST', path: organizationPath + '/payment-intents', operationId: 'createPaymentIntent',
      tag: 'Commerce', auth: 'tenant', permission: 'commerce:payment-intents:create',
      rejectionCode: PAYMENT_ABSTRACTION_REJECTED,
      summary: 'Create a Stripe Connect destination-charge intent for the job room\'s customer',
      requestBody: s.object({requestKey: id, jobRoomId: id, paymentAccountId: id,
        amountMinor: s.integer({minimum: 1, maximum: 9_999_999_999}), currency: s.string({pattern: '^[A-Z]{3}$'})}),
      success: {status: 201, description: 'Intent created', schema: s.ref('PaymentIntent')},
      handler: async context => {
        if (services.adapters.stripe.status.mode === 'disabled') return {status: 503, body: {code: 'dependency_unavailable'}};
        return respond(await createStripeConnectPaymentIntent(1,
          tenantOf(context).request('commerce:payment-intents:create'), tenantOf(context).state,
          context.body as never, payments), 201);
      }}),
    route({method: 'POST', path: organizationPath + '/notification-intents', operationId: 'createNotificationIntent',
      tag: 'Notifications', auth: 'tenant', permission: 'notifications:write',
      summary: 'Queue a notification intent (opaque recipient and payload references only)',
      requestBody: s.object({channel: s.enum('email', 'push', 'sms'),
        recipientReference: s.string({pattern: '^(customer-profile|push-device):[A-Za-z0-9._-]{1,100}$'}),
        templateKey: s.enum('lead.received', 'quote.received', 'job-room.message', 'generic.update'),
        payloadReference: id, notBefore: s.integer({minimum: 0}), expiresAt: s.integer({minimum: 1})}),
      success: {status: 201, description: 'Intent queued', schema: s.ref('NotificationIntent')},
      handler: async context => {
        const tenant = tenantOf(context);
        const body = context.body as Omit<NotificationIntent, 'intentId' | 'organizationId' | 'status'>;
        if (body.expiresAt <= body.notBefore) return {status: 400, body: {code: 'invalid_request'}};
        const intent: NotificationIntent = {intentId: services.createId(), organizationId: tenant.organizationId,
          status: 'ready', ...body};
        await services.documents.put(tenant.organizationId, {kind: 'notification-intent', id: intent.intentId,
          expected: null, next: intent});
        return {status: 201, body: intent};
      }}),
    route({method: 'POST', path: organizationPath + '/notification-deliveries', operationId: 'dispatchNotification',
      tag: 'Notifications', auth: 'tenant', permission: 'notifications:dispatch',
      rejectionCode: NOTIFICATION_ADAPTER_REJECTED, summary: 'Send a queued intent through its channel adapter',
      requestBody: s.object({requestKey: id, intentId: id}),
      success: {status: 201, description: 'Delivered to the provider', schema: s.ref('NotificationDelivery')},
      handler: async context => {
        const tenant = tenantOf(context);
        const intent = await notifications.store.getIntent(tenant.organizationId,
          (context.body as {intentId: string}).intentId);
        if (intent && services.adapters[intent.channel].status.mode === 'disabled')
          return {status: 503, body: {code: 'dependency_unavailable'}};
        return respond(await dispatchNotification(1, tenant.request('notifications:dispatch'), tenant.state,
          context.body as never, notifications), 201);
      }}),
    route({method: 'PUT', path: organizationPath + '/push-devices/{deviceId}', operationId: 'putPushDevice',
      tag: 'Notifications', auth: 'tenant', permission: 'notifications:write',
      summary: 'Register or deactivate a push token (referenced as push-device:<deviceId>)',
      requestBody: s.object({token: s.string({minLength: 10, maxLength: 256}), status: s.enum('active', 'inactive')}),
      success: {status: 200, description: 'Device stored', schema: s.object({deviceId: s.string(), status: s.enum('active', 'inactive')})},
      handler: async context => {
        const tenant = tenantOf(context);
        const deviceId = context.params.deviceId!;
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(deviceId)) return {status: 400, body: {code: 'invalid_request'}};
        const body = context.body as {token: string; status: 'active' | 'inactive'};
        const current = await services.documents.get(tenant.organizationId, 'push-device', deviceId);
        await services.documents.put(tenant.organizationId, {kind: 'push-device', id: deviceId, expected: current,
          next: {deviceId, token: body.token, status: body.status, subjectId: tenant.subjectId}});
        return {status: 200, body: {deviceId, status: body.status}};
      }}),
  ];
}
