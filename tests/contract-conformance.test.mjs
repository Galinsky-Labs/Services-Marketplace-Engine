import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {componentSchemas, createMemoryApp, validateSchema} from '../apps/api/dist/index.js';
import {conforms} from '../packages/sdk/dist/index.js';
import {startApi} from './support/http-app.mjs';

test('contracts/openapi.json is generated from the live route table', () => {
  const generated = JSON.stringify(createMemoryApp().openApiDocument(), null, 2) + '\n';
  assert.equal(fs.readFileSync('contracts/openapi.json', 'utf8'), generated);
});

test('every public route is documented with security, errors and a success schema', () => {
  const app = createMemoryApp();
  const spec = app.openApiDocument();
  for (const route of app.routes.filter(candidate => !candidate.internal)) {
    const operation = spec.paths[route.path]?.[route.method.toLowerCase()];
    assert.ok(operation, route.operationId);
    assert.equal(operation.operationId, route.operationId);
    if (route.auth !== 'none') {
      assert.deepEqual(operation.security, [{bearerAuth: []}]);
      for (const status of ['400', '401', '403', '429']) assert.ok(operation.responses[status], route.operationId + ' ' + status);
    }
    if (route.auth === 'tenant') assert.ok(operation['x-required-permission'], route.operationId);
    if (route.rejectionCode) assert.equal(operation.responses['422'].content['application/json'].schema.properties.code.const, route.rejectionCode);
  }
  const refs = JSON.stringify(spec).match(/#\/components\/schemas\/[A-Za-z]+/g) ?? [];
  for (const ref of refs) assert.ok(spec.components.schemas[ref.split('/').at(-1)], ref);
});

test('live responses conform to the documented schemas (server and SDK validators agree)', async t => {
  const api = await startApi();
  t.after(api.close);
  const owner = await api.provision();
  const org = owner.organizationId;
  const spec = api.app.openApiDocument();
  const samples = [
    ['GET', '/health', undefined, '/health'],
    ['GET', '/ready', undefined, '/ready'],
    ['POST', `/v1/organizations/${org}/providers`, {legalName: 'A LLC', publicName: 'A'}, '/v1/organizations/{organizationId}/providers'],
    ['POST', `/v1/organizations/${org}/customers`, {customerSubjectId: 's-1', displayName: 'S', email: null, phone: null}, '/v1/organizations/{organizationId}/customers'],
    ['GET', `/v1/organizations/${org}/feature-flags/x.y?environment=production`, undefined, '/v1/organizations/{organizationId}/feature-flags/{flagKey}'],
    ['GET', `/v1/organizations/${org}/audit-events`, undefined, '/v1/organizations/{organizationId}/audit-events'],
    ['POST', `/v1/organizations/${org}/incidents`, {requestKey: 'r', dedupeKey: 'd', title: 'T', severity: 'sev3'}, '/v1/organizations/{organizationId}/incidents'],
    ['GET', `/v1/organizations/${org}/consents/${owner.ownerSubjectId}/ai-processing`, undefined, '/v1/organizations/{organizationId}/consents/{subjectId}/{purpose}'],
    ['GET', `/v1/organizations/${org}/customers/missing`, undefined, '/v1/organizations/{organizationId}/customers/{customerProfileId}'],
    ['GET', `/v1/organizations/${org}/customers/missing`, undefined, '/v1/organizations/{organizationId}/customers/{customerProfileId}', 'bad-token'],
  ];
  const components = {...spec.components.schemas};
  for (const [method, path, body, template, token] of samples) {
    const response = await api.raw(method, path, {token: token ?? owner.token, body});
    const documented = spec.paths[template][method.toLowerCase()].responses[String(response.status)];
    assert.ok(documented, `${method} ${template} returned undocumented ${response.status}`);
    const schema = documented.content['application/json'].schema;
    assert.equal(validateSchema(schema, response.json, components), null, `${method} ${template} ${response.status}`);
    assert.equal(conforms(schema, response.json), true);
  }
  assert.ok(Object.keys(componentSchemas).length > 30);
});
