import crypto from 'node:crypto';
import type {
  PaymentProcessorAdapter, ProcessorPaymentIntent, ProcessorPaymentIntentRequest,
} from '@services-marketplace/contracts';
import {AdapterDisabledError, defaultFetch, type AdapterStatus, type FetchLike} from './status.js';

const STRIPE_API = 'https://api.stripe.com/v1';

function mapStatus(status: string): ProcessorPaymentIntent['status'] | null {
  switch (status) {
  case 'requires_payment_method':
  case 'requires_confirmation': return 'requires_payment_method';
  case 'requires_action': return 'requires_action';
  case 'requires_capture':
  case 'processing':
  case 'succeeded': return 'authorized';
  default: return null;
  }
}

/** Stripe Connect destination charges. Disabled unless STRIPE_SECRET_KEY is set. */
export class StripeConnectAdapter implements PaymentProcessorAdapter {
  readonly status: AdapterStatus;

  constructor(private readonly secretKey: string | undefined,
    private readonly fetchImpl: FetchLike = defaultFetch) {
    this.status = !secretKey ? {name: 'stripe-connect', mode: 'disabled',
      detail: 'STRIPE_SECRET_KEY not set'}
      : {name: 'stripe-connect', mode: secretKey.startsWith('sk_live_') ? 'live' : 'sandbox',
        detail: secretKey.startsWith('sk_live_') ? 'live keys' : 'test-mode keys'};
  }

  async createPaymentIntent(request: ProcessorPaymentIntentRequest): Promise<ProcessorPaymentIntent> {
    if (!this.secretKey) throw new AdapterDisabledError('stripe-connect');
    const form = new URLSearchParams({
      amount: String(request.amountMinor),
      currency: request.currency.toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
      'transfer_data[destination]': request.destinationAccountReference,
      'metadata[organizationId]': request.metadata.organizationId,
      'metadata[jobRoomId]': request.metadata.jobRoomId,
      'metadata[paymentIntentId]': request.metadata.paymentIntentId,
    });
    const response = await this.fetchImpl(STRIPE_API + '/payment_intents', {
      method: 'POST',
      headers: {authorization: 'Bearer ' + this.secretKey,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': request.idempotencyKey},
      body: form.toString(),
    });
    const body = await response.json() as Record<string, unknown>;
    const status = typeof body.status === 'string' ? mapStatus(body.status) : null;
    const transfer = body.transfer_data as {destination?: unknown} | null | undefined;
    if (!response.ok || typeof body.id !== 'string' || status === null ||
      body.amount !== request.amountMinor ||
      String(body.currency).toUpperCase() !== request.currency ||
      transfer?.destination !== request.destinationAccountReference) {
      throw new Error('stripe payment intent request failed with status ' + response.status);
    }
    return {processor: 'stripe_connect', processorIntentReference: body.id,
      destinationAccountReference: request.destinationAccountReference,
      amountMinor: request.amountMinor, currency: request.currency, status};
  }
}

/** Verifies a `Stripe-Signature` header (v1 HMAC-SHA256) within a timestamp tolerance. */
export function verifyStripeSignature(payload: string, header: string | undefined, secret: string,
  nowSeconds: number, toleranceSeconds = 300): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map(part => part.split('=') as [string, string]);
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds)
    return false;
  const expected = crypto.createHmac('sha256', secret).update(timestamp + '.' + payload)
    .digest();
  return signatures.some(signature => {
    const candidate = Buffer.from(signature ?? '', 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  });
}
