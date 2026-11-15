import type {
  CredentialCheckAdapter, CredentialCheckAdapterRequest, CredentialCheckAdapterResult,
} from '@services-marketplace/contracts';
import {AdapterDisabledError, defaultFetch, type AdapterStatus, type FetchLike} from './status.js';

/**
 * Background / credential check adapter for an HTTPS verification vendor that accepts a
 * JSON check request and returns `{reference, outcome, validUntil?}`.
 * - disabled: no BACKGROUND_CHECK_API_URL / BACKGROUND_CHECK_API_KEY.
 * - sandbox simulator (BACKGROUND_CHECK_MODE=sandbox): always returns `review` so no
 *   simulated result can ever auto-verify a provider.
 */
export class HttpCredentialCheckAdapter implements CredentialCheckAdapter {
  readonly status: AdapterStatus;

  constructor(private readonly config: {readonly url?: string | undefined;
    readonly apiKey?: string | undefined; readonly mode?: string | undefined},
  private readonly now: () => number, private readonly fetchImpl: FetchLike = defaultFetch) {
    this.status = config.mode === 'sandbox'
      ? {name: 'credential-check', mode: 'sandbox', detail: 'simulator: every check returns review'}
      : config.url?.startsWith('https://') && config.apiKey
        ? {name: 'credential-check', mode: 'live', detail: 'vendor ' + new URL(config.url).host}
        : {name: 'credential-check', mode: 'disabled',
          detail: 'BACKGROUND_CHECK_API_URL / BACKGROUND_CHECK_API_KEY not set'};
  }

  async check(request: CredentialCheckAdapterRequest): Promise<CredentialCheckAdapterResult> {
    const base = {credentialCheckId: request.credentialCheckId,
      organizationId: request.organizationId,
      providerOrganizationId: request.providerOrganizationId,
      subjectReference: request.subjectReference, attachmentSha256: request.attachmentSha256};
    if (this.status.mode === 'sandbox') {
      return {...base, adapterName: 'sandbox-simulator',
        adapterReference: 'sim-' + request.credentialCheckId, outcome: 'review',
        checkedAt: this.now()};
    }
    if (this.status.mode !== 'live') throw new AdapterDisabledError('credential-check');
    const response = await this.fetchImpl(this.config.url!.replace(/\/$/, '') + '/checks', {
      method: 'POST',
      headers: {authorization: 'Bearer ' + this.config.apiKey, 'content-type': 'application/json',
        'idempotency-key': request.credentialCheckId},
      body: JSON.stringify({reference: request.credentialCheckId,
        subjectReference: request.subjectReference, credentialType: request.credentialType,
        documentSha256: request.attachmentSha256, purpose: request.purposeCode,
        consentedAt: new Date(request.consentedAt).toISOString()}),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof body.reference !== 'string' ||
      !['verified', 'review', 'rejected'].includes(String(body.outcome))) {
      throw new Error('credential check vendor request failed with status ' + response.status);
    }
    const validUntil = typeof body.validUntil === 'string' ? Date.parse(body.validUntil) : NaN;
    return {...base, adapterName: new URL(this.config.url!).host,
      adapterReference: body.reference, outcome: body.outcome as 'verified' | 'review' | 'rejected',
      checkedAt: this.now(), ...(Number.isFinite(validUntil) ? {validUntil} : {})};
  }
}
