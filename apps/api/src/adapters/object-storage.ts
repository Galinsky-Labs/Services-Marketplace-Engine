import crypto from 'node:crypto';
import type {QuarantineObjectStore} from '@services-marketplace/contracts';
import {AdapterDisabledError, defaultFetch, type AdapterStatus, type FetchLike} from './status.js';

export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly pathStyle: boolean;
}

const encode = (value: string, keepSlash: boolean): string =>
  [...Buffer.from(value, 'utf8')].map(byte => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9\-._~]/.test(character) || (keepSlash && character === '/')
      ? character : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }).join('');

const hmac = (key: crypto.BinaryLike, value: string): Buffer =>
  crypto.createHmac('sha256', key).update(value, 'utf8').digest();

/** AWS Signature Version 4 query-string presigning (S3, R2 and compatible stores). */
export function presignS3Url(config: S3Config, method: 'GET' | 'PUT' | 'DELETE', key: string,
  expiresSeconds: number, now: Date): string {
  const endpoint = new URL(config.endpoint);
  const host = config.pathStyle ? endpoint.host : config.bucket + '.' + endpoint.host;
  const path = config.pathStyle ? '/' + encode(config.bucket, false) + '/' + encode(key, true)
    : '/' + encode(key, true);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', config.accessKeyId + '/' + scope],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query.map(([name, value]) => [encode(name, false), encode(value, false)])
    .sort(([left], [right]) => left! < right! ? -1 : 1).map(([name, value]) => name + '=' + value)
    .join('&');
  const canonicalRequest = [method, path, canonicalQuery, 'host:' + host, '', 'host',
    'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + config.secretAccessKey, date), config.region),
    's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Quarantine bucket for attachments. Disabled unless all S3_* settings are present. */
export class S3QuarantineObjectStore implements QuarantineObjectStore {
  readonly status: AdapterStatus;
  readonly #config: S3Config | null;

  constructor(env: Readonly<Record<string, string | undefined>>, private readonly now: () => Date,
    private readonly fetchImpl: FetchLike = defaultFetch) {
    const ready = env.S3_ENDPOINT?.startsWith('https://') && env.S3_BUCKET &&
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY;
    this.#config = ready ? {endpoint: env.S3_ENDPOINT!, region: env.S3_REGION || 'auto',
      bucket: env.S3_BUCKET!, accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!, pathStyle: env.S3_PATH_STYLE !== 'false'} : null;
    this.status = this.#config
      ? {name: 'object-storage-s3', mode: 'live', detail: 'bucket ' + this.#config.bucket}
      : {name: 'object-storage-s3', mode: 'disabled',
        detail: 'S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY not set'};
  }

  #require(): S3Config {
    if (!this.#config) throw new AdapterDisabledError('object-storage');
    return this.#config;
  }

  async createUploadUrl(objectKey: string, _contentType: string, _sizeBytes: number): Promise<string> {
    return presignS3Url(this.#require(), 'PUT', objectKey, 900, this.now());
  }

  async createDownloadUrl(objectKey: string): Promise<string> {
    return presignS3Url(this.#require(), 'GET', objectKey, 300, this.now());
  }

  async delete(objectKey: string): Promise<void> {
    const url = presignS3Url(this.#require(), 'DELETE', objectKey, 60, this.now());
    const response = await this.fetchImpl(url, {method: 'DELETE', headers: {}});
    if (!response.ok && response.status !== 404) throw new Error('object delete failed: ' + response.status);
  }
}
