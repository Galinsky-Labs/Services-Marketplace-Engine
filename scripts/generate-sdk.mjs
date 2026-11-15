import assert from 'node:assert/strict';
import fs from 'node:fs';

const specPath = new URL('../contracts/openapi.json', import.meta.url);
const outputPath = new URL('../packages/sdk/src/index.ts', import.meta.url);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

// Contract invariants the SDK depends on.
assert.equal(spec.openapi, '3.1.0');
const bootstrap = spec.paths?.['/v1/organizations/{organizationId}/resources/{resourceId}']?.get;
assert.equal(bootstrap?.operationId, 'getResource');
assert.deepEqual(bootstrap.security, [{bearerAuth: []}]);
for (const status of ['200', '400', '403']) assert.ok(bootstrap.responses?.[status]);
assert.equal(spec.components?.parameters?.ContractVersion?.schema?.const, 1);
assert.equal(spec.components?.schemas?.AuthorizationDenied?.properties?.code?.const, 'authorization_denied');
assert.equal(spec.components?.schemas?.UnsupportedContractVersion?.properties?.code?.const,
  'unsupported_contract_version');

const schemas = spec.components.schemas;
const refName = ref => ref.replace('#/components/schemas/', '');
const literal = value => JSON.stringify(value);

function tsType(schema, indent = '') {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(' | ');
  if (schema.oneOf) return schema.oneOf.map(option => tsType(option, indent)).join(' | ');
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const rendered = types.map(type => {
    switch (type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return 'readonly (' + tsType(schema.items ?? {}, indent) + ')[]';
    case 'object': {
      if (!schema.properties) {
        return typeof schema.additionalProperties === 'object'
          ? 'Readonly<Record<string, ' + tsType(schema.additionalProperties, indent) + '>>'
          : 'Readonly<Record<string, unknown>>';
      }
      const required = new Set(schema.required ?? []);
      const lines = Object.entries(schema.properties).map(([name, property]) =>
        indent + '  readonly ' + name + (required.has(name) ? '' : '?') + ': ' +
        tsType(property, indent + '  ') + ';');
      return '{\n' + lines.join('\n') + '\n' + indent + '}';
    }
    default: return 'unknown';
    }
  });
  return rendered.join(' | ');
}

const errorCodes = new Set(['unexpected_response']);
const collectCodes = schema => {
  if (!schema) return;
  if (schema.$ref) return collectCodes(schemas[refName(schema.$ref)]);
  const code = schema.properties?.code;
  if (code?.const) errorCodes.add(code.const);
  for (const value of code?.enum ?? []) errorCodes.add(value);
};

const operations = [];
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    const pathParams = [...path.matchAll(/\{([A-Za-z0-9]+)\}/g)].map(match => match[1]);
    const queryParams = (operation.parameters ?? []).filter(parameter => parameter.in === 'query');
    const versioned = (operation.parameters ?? []).some(parameter =>
      parameter.$ref === '#/components/parameters/ContractVersion');
    const secured = (operation.security ?? []).length > 0;
    const success = {};
    const errors = {};
    for (const [status, response] of Object.entries(operation.responses)) {
      const schema = response.content?.['application/json']?.schema ?? null;
      if (Number(status) < 300) success[status] = schema;
      else { errors[status] = schema; collectCodes(schema); }
    }
    operations.push({path, method: method.toUpperCase(), operation, pathParams, queryParams,
      versioned, secured, success, errors,
      body: operation.requestBody?.content?.['application/json']?.schema ?? null});
  }
}
operations.sort((left, right) => left.operation.operationId.localeCompare(right.operation.operationId));

const componentTypes = Object.entries(schemas).map(([name, schema]) =>
  schema.type === 'object' && schema.properties
    ? 'export interface ' + name + ' ' + tsType(schema) + '\n'
    : 'export type ' + name + ' = ' + tsType(schema) + ';\n').join('\n');

function methodSource(entry) {
  const {operation, pathParams, queryParams, body, success} = entry;
  const args = pathParams.map(name => name + ': string');
  if (body) args.push('body: ' + tsType(body, '    '));
  if (queryParams.length > 0) {
    args.push('query: {' + queryParams.map(parameter =>
      'readonly ' + parameter.name + '?: ' + tsType(parameter.schema)).join('; ') + '} = {}');
  }
  const successSchemas = Object.values(success).filter(Boolean);
  const returnType = successSchemas.length === 0 ? 'void'
    : [...new Set(successSchemas.map(schema => tsType(schema, '    ')))].join(' | ');
  const pathExpression = "'" + entry.path.replace(/\{([A-Za-z0-9]+)\}/g,
    (_, name) => "' + requiredSegment('" + name + "', " + name + ") + '") + "'";
  return `    /** ${operation.summary}${operation['x-required-permission'] ? ' Requires `' + operation['x-required-permission'] + '`.' : ''} */
    async ${operation.operationId}(${args.join(', ')}): Promise<${returnType}> {
      return await send({method: '${entry.method}', path: ${pathExpression.replace(/ \+ ''$/, '')}, secured: ${entry.secured}, versioned: ${entry.versioned},
        ${queryParams.length > 0 ? 'query, ' : ''}${body ? 'body, ' : ''}success: ${JSON.stringify(success)},
        errors: ${JSON.stringify(entry.errors)}}) as ${returnType};
    },`;
}

const generated = `// Generated by scripts/generate-sdk.mjs from contracts/openapi.json. Do not edit.
/* eslint-disable */
export const CONTRACT_VERSION = ${spec.components.parameters.ContractVersion.schema.const} as const;
export const API_VERSION = ${literal(spec.info.version)};

${componentTypes}
export type ApiErrorCode = ${[...errorCodes].sort().map(literal).join(' | ')};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init: {readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string},
) => Promise<FetchResponse>;

export interface ClientOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly fetch: FetchLike;
}

type Schema = {readonly [key: string]: unknown};
const SCHEMAS: Readonly<Record<string, Schema>> = ${JSON.stringify(schemas)};

function typeOf(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array'
    : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
}

/** Fail-closed validation of response bodies against the published JSON schemas. */
export function conforms(schema: Schema, value: unknown): boolean {
  if (typeof schema.$ref === 'string') {
    const target = SCHEMAS[schema.$ref.replace('#/components/schemas/', '')];
    return target !== undefined && conforms(target, value);
  }
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter(option => conforms(option as Schema, value)).length === 1;
  if ('const' in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) return false;
  }
  if (Array.isArray(value)) {
    return schema.items === undefined || value.every(item => conforms(schema.items as Schema, item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(schema.required) && !schema.required.every(name => typeof name === 'string' && Object.hasOwn(record, name))) return false;
    return Object.entries(record).every(([key, child]) => Object.hasOwn(properties, key)
      ? conforms(properties[key]!, child)
      : schema.additionalProperties === false ? false
        : typeof schema.additionalProperties === 'object' ? conforms(schema.additionalProperties as Schema, child) : true);
  }
  return true;
}

function requiredSegment(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(name + ' is required');
  return encodeURIComponent(value);
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly secured: boolean;
  readonly versioned: boolean;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  readonly success: Readonly<Record<string, Schema | null>>;
  readonly errors: Readonly<Record<string, Schema | null>>;
}

export function createClient(options: ClientOptions) {
  if (!/^https:\\/\\//.test(options.baseUrl) && !/^http:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?(\\/|$)/.test(options.baseUrl)) {
    throw new TypeError('baseUrl must use HTTPS');
  }
  if (options.bearerToken.length === 0) throw new TypeError('bearerToken is required');
  const baseUrl = options.baseUrl.replace(/\\/$/, '');

  async function send(call: Call): Promise<unknown> {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) search.set(name, String(value));
    }
    const headers: Record<string, string> = {accept: 'application/json'};
    if (call.secured) headers.authorization = 'Bearer ' + options.bearerToken;
    if (call.versioned) headers['x-contract-version'] = String(CONTRACT_VERSION);
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    const query = search.toString();
    const init = call.body === undefined ? {method: call.method, headers}
      : {method: call.method, headers, body: JSON.stringify(call.body)};
    const response = await options.fetch(baseUrl + call.path + (query ? '?' + query : ''), init);
    const status = String(response.status);
    if (response.ok && status in call.success && call.success[status] === null) return undefined;
    let body: unknown;
    try { body = await response.json(); } catch { throw new ApiError(response.status, 'unexpected_response'); }
    if (!response.ok) {
      const schema = call.errors[status];
      const resolved = schema && typeof schema.$ref === 'string'
        ? SCHEMAS[schema.$ref.replace('#/components/schemas/', '')] : schema;
      const codeSchema = (resolved?.properties as Record<string, Schema> | undefined)?.code;
      const candidate = body !== null && typeof body === 'object' ? (body as {code?: unknown}).code : undefined;
      // Only the documented code escapes; any other field of an error body is discarded.
      const code = codeSchema && typeof candidate === 'string' && conforms(codeSchema, candidate)
        ? candidate as ApiErrorCode : 'unexpected_response';
      throw new ApiError(response.status, code);
    }
    const schema = call.success[status];
    if (!schema || !conforms(schema, body)) throw new ApiError(response.status, 'unexpected_response');
    return body;
  }

  return {
${operations.map(methodSource).join('\n')}
  };
}

export type Client = ReturnType<typeof createClient>;
`;

if (process.argv.includes('--check')) {
  assert.equal(fs.readFileSync(outputPath, 'utf8'), generated, 'generated SDK is stale; run npm run generate:sdk');
  console.log('Generated SDK matches contracts/openapi.json (' + operations.length + ' operations)');
} else {
  fs.mkdirSync(new URL('../packages/sdk/src/', import.meta.url), {recursive: true});
  fs.writeFileSync(outputPath, generated);
  console.log('Generated SDK with ' + operations.length + ' operations');
}
