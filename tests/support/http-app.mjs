import {createHttpServer, createMemoryApp} from '../../apps/api/dist/index.js';
import {createClient} from '../../packages/sdk/dist/index.js';

export const ADMIN_TOKEN = 'smeadmin_' + 'a'.repeat(64);

/** Starts an in-memory API on an ephemeral port and returns helpers bound to it. */
export async function startApi(options = {}) {
  const app = createMemoryApp({env: {PLATFORM_ADMIN_TOKEN: ADMIN_TOKEN, ...(options.env ?? {})},
    ...(options.now ? {now: options.now} : {}), ...(options.fetch ? {fetch: options.fetch} : {}),
    ...(options.ai ? {ai: options.ai} : {})});
  const server = createHttpServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;

  async function raw(method, path, {token, body, headers = {}, rawBody} = {}) {
    const response = await fetch(baseUrl + path, {method, headers: {
      'x-contract-version': '1',
      ...(body !== undefined || rawBody !== undefined ? {'content-type': 'application/json'} : {}),
      ...(token ? {authorization: 'Bearer ' + token} : {}), ...headers},
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined)});
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return {status: response.status, headers: response.headers, json, text};
  }

  async function provision(name = 'Organization') {
    const result = await raw('POST', '/v1/admin/organizations', {token: ADMIN_TOKEN, body: {name}});
    if (result.status !== 201) throw new Error('provision failed ' + result.status + ' ' + result.text);
    const {organizationId, ownerSubjectId, apiKey} = result.json;
    const client = createClient({baseUrl, bearerToken: apiKey.token, fetch: (input, init) => fetch(input, init)});
    return {organizationId, ownerSubjectId, token: apiKey.token, client};
  }

  /** Adds a member with a dedicated role and returns their key. */
  async function addMember(owner, roleId, permissions) {
    const subjectId = crypto.randomUUID();
    await owner.client.putRole(owner.organizationId, roleId, {permissions});
    await owner.client.putMembership(owner.organizationId, subjectId, {status: 'active', roleIds: [roleId]});
    const key = await owner.client.createApiKey(owner.organizationId, {subjectId, label: roleId});
    const client = createClient({baseUrl, bearerToken: key.token, fetch: (input, init) => fetch(input, init)});
    return {subjectId, token: key.token, client, keyId: key.keyId};
  }

  return {app, server, baseUrl, raw, provision, addMember,
    close: () => new Promise(resolve => server.close(resolve))};
}
