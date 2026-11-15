import crypto from 'node:crypto';
import type {IdentityRepository} from './store/identity.js';

const TOKEN = /^sme_([a-z0-9]{24})_([0-9a-f]{64})$/;

export interface IssuedApiKey {
  readonly keyId: string;
  readonly token: string;
  readonly secretHash: string;
}

export const sha256Hex = (value: string): string =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export function issueApiKey(): IssuedApiKey {
  const keyId = crypto.randomBytes(15).toString('base64url').toLowerCase()
    .replace(/[^a-z0-9]/g, '0').slice(0, 24).padEnd(24, '0');
  const secret = crypto.randomBytes(32).toString('hex');
  return {keyId, token: 'sme_' + keyId + '_' + secret, secretHash: sha256Hex(secret)};
}

function equalHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b);
}

export type Authentication =
  | {readonly kind: 'tenant'; readonly keyId: string; readonly organizationId: string;
      readonly subjectId: string}
  | {readonly kind: 'platform-admin'}
  | {readonly kind: 'none'};

export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string' || header.length > 512) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  return match?.[1] ?? null;
}

/** Resolves a bearer token. Every failure is indistinguishable to the caller. */
export async function authenticate(header: string | undefined, identity: IdentityRepository,
  platformAdminTokenHash: string | null): Promise<Authentication> {
  const token = bearerToken(header);
  if (token === null) return {kind: 'none'};
  if (platformAdminTokenHash !== null && token.startsWith('smeadmin_') &&
    equalHex(sha256Hex(token), platformAdminTokenHash)) return {kind: 'platform-admin'};
  const match = TOKEN.exec(token);
  if (!match) return {kind: 'none'};
  const key = await identity.getApiKey(match[1]!);
  const candidate = sha256Hex(match[2]!);
  if (key === null || key.status !== 'active' || !equalHex(candidate, key.secretHash))
    return {kind: 'none'};
  return {kind: 'tenant', keyId: key.keyId, organizationId: key.organizationId,
    subjectId: key.subjectId};
}
