/** Public, secret-free description of how an external adapter is configured. */
export interface AdapterStatus {
  readonly name: string;
  readonly mode: 'disabled' | 'sandbox' | 'live';
  readonly detail: string;
}

export class AdapterDisabledError extends Error {
  constructor(adapter: string) {
    super(adapter + ' adapter is disabled: required configuration is missing');
    this.name = 'AdapterDisabledError';
  }
}

export type FetchLike = (input: string, init: {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}) => Promise<{readonly ok: boolean; readonly status: number; json(): Promise<unknown>;
  text(): Promise<string>}>;

export const defaultFetch: FetchLike = (input, init) =>
  fetch(input, {...init, signal: init.signal ?? AbortSignal.timeout(15_000)});
