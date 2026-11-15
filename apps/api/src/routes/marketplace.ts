import {
  CUSTOMER_REJECTED, PROVIDER_REJECTED, createCustomerProfile, createProviderLocation,
  createProviderOrganization, getCustomerProfile, getProviderOrganization, listProviderLocations,
  updateCustomerProfile, type CustomerProfile, type CustomerStore, type ProviderLocation,
  type ProviderOrganization, type ProviderStore, type SavedAsset,
} from '@services-marketplace/contracts';
import type {AppServices} from '../app.js';
import type {RouteDefinition} from '../http/router.js';
import {s, type JsonSchema} from '../http/schema.js';
import type {DocumentStore} from '../store/documents.js';
import {contractOptions, organizationPath, respond, route, tenantOf} from './common.js';

export function customerStore(documents: DocumentStore): CustomerStore {
  return {
    createProfile: profile => documents.put(profile.organizationId, {kind: 'customer-profile',
      id: profile.customerProfileId, expected: null, next: profile}),
    getProfile: (organizationId, id) => documents.get<CustomerProfile>(organizationId, 'customer-profile', id),
    replaceProfile: (current, next) => documents.put(next.organizationId, {kind: 'customer-profile',
      id: next.customerProfileId, expected: current, next}),
    createSavedAsset: asset => documents.put(asset.organizationId, {kind: 'saved-asset',
      id: asset.savedAssetId, expected: null, next: asset}),
    getSavedAsset: (organizationId, id) => documents.get<SavedAsset>(organizationId, 'saved-asset', id),
    replaceSavedAsset: (current, next) => documents.put(next.organizationId, {kind: 'saved-asset',
      id: next.savedAssetId, expected: current, next}),
    listSavedAssets: (organizationId, customerProfileId) => documents.list<SavedAsset>(
      organizationId, 'saved-asset', {customerProfileId}),
  };
}

export function providerStore(documents: DocumentStore): ProviderStore {
  return {
    createProvider: provider => documents.put(provider.organizationId, {kind: 'provider',
      id: provider.providerOrganizationId, expected: null, next: provider}),
    getProvider: (organizationId, id) => documents.get<ProviderOrganization>(organizationId, 'provider', id),
    replaceProvider: (current, next) => documents.put(next.organizationId, {kind: 'provider',
      id: next.providerOrganizationId, expected: current, next}),
    createLocation: location => documents.put(location.organizationId, {kind: 'provider-location',
      id: location.providerLocationId, expected: null, next: location}),
    getLocation: (organizationId, id) => documents.get<ProviderLocation>(organizationId,
      'provider-location', id),
    replaceLocation: (current, next) => documents.put(next.organizationId, {kind: 'provider-location',
      id: next.providerLocationId, expected: current, next}),
    listLocations: (organizationId, providerOrganizationId) => documents.list<ProviderLocation>(
      organizationId, 'provider-location', {providerOrganizationId}),
  };
}

export const marketplaceSchemas: Record<string, JsonSchema> = {
  CustomerProfile: s.object({customerProfileId: s.string(), organizationId: s.string(),
    customerSubjectId: s.string(), displayName: s.string(), email: s.nullable(s.string()),
    phone: s.nullable(s.string()), status: s.enum('active', 'closed'), version: s.integer(),
    createdAt: s.integer(), updatedAt: s.integer()}),
  CustomerProfileInput: s.object({customerSubjectId: s.id(), displayName: s.string({minLength: 1, maxLength: 120}),
    email: s.nullable(s.string({maxLength: 254})), phone: s.nullable(s.string({maxLength: 32}))},
  ['customerSubjectId', 'displayName']),
  ProviderOrganization: s.object({providerOrganizationId: s.string(), organizationId: s.string(),
    legalName: s.string(), publicName: s.string(), status: s.enum('draft', 'active', 'suspended', 'closed'),
    version: s.integer(), createdAt: s.integer(), updatedAt: s.integer()}),
  ProviderLocation: s.object({providerLocationId: s.string(), organizationId: s.string(),
    providerOrganizationId: s.string(), name: s.string(), addressLines: s.array(s.string()),
    locality: s.string(), administrativeArea: s.string(), postalCode: s.string(), countryCode: s.string(),
    timeZone: s.string(), serviceModes: s.array(s.enum('on_site', 'mobile', 'remote')),
    status: s.enum('active', 'inactive'), version: s.integer(), createdAt: s.integer(), updatedAt: s.integer()}),
};

export function marketplaceRoutes(services: AppServices): RouteDefinition[] {
  const customers = {...contractOptions(services), store: customerStore(services.documents)};
  const providers = {...contractOptions(services), store: providerStore(services.documents)};
  return [
    route({method: 'POST', path: organizationPath + '/customers', operationId: 'createCustomerProfile',
      tag: 'Customers', auth: 'tenant', permission: 'customer-profile:write', rejectionCode: CUSTOMER_REJECTED,
      summary: 'Create a customer profile', requestBody: s.ref('CustomerProfileInput'),
      success: {status: 201, description: 'Profile created', schema: s.ref('CustomerProfile')},
      handler: async context => respond(await createCustomerProfile(1,
        tenantOf(context).request('customer-profile:write'), tenantOf(context).state,
        context.body as never, customers), 201)}),
    route({method: 'GET', path: organizationPath + '/customers/{customerProfileId}',
      operationId: 'getCustomerProfile', tag: 'Customers', auth: 'tenant',
      permission: 'customer-profile:read', rejectionCode: CUSTOMER_REJECTED,
      summary: 'Read an active customer profile',
      success: {status: 200, description: 'Profile', schema: s.ref('CustomerProfile')},
      handler: async context => respond(await getCustomerProfile(
        tenantOf(context).request('customer-profile:read'), tenantOf(context).state,
        context.params.customerProfileId!, customers))}),
    route({method: 'PUT', path: organizationPath + '/customers/{customerProfileId}',
      operationId: 'updateCustomerProfile', tag: 'Customers', auth: 'tenant',
      permission: 'customer-profile:write', rejectionCode: CUSTOMER_REJECTED,
      summary: 'Replace a customer profile (optimistic version check)',
      requestBody: s.object({expectedVersion: s.integer({minimum: 1}), profile: s.ref('CustomerProfileInput')}),
      success: {status: 200, description: 'Profile updated', schema: s.ref('CustomerProfile')},
      handler: async context => {
        const body = context.body as {expectedVersion: number; profile: never};
        return respond(await updateCustomerProfile(tenantOf(context).request('customer-profile:write'),
          tenantOf(context).state, context.params.customerProfileId!, body.expectedVersion,
          body.profile, customers));
      }}),
    route({method: 'POST', path: organizationPath + '/providers', operationId: 'createProviderOrganization',
      tag: 'Providers', auth: 'tenant', permission: 'provider:write', rejectionCode: PROVIDER_REJECTED,
      summary: 'Create a provider organization (starts as draft)',
      requestBody: s.object({legalName: s.string({minLength: 1, maxLength: 200}),
        publicName: s.string({minLength: 1, maxLength: 120})}),
      success: {status: 201, description: 'Provider created', schema: s.ref('ProviderOrganization')},
      handler: async context => respond(await createProviderOrganization(1,
        tenantOf(context).request('provider:write'), tenantOf(context).state,
        context.body as never, providers), 201)}),
    route({method: 'GET', path: organizationPath + '/providers/{providerOrganizationId}',
      operationId: 'getProviderOrganization', tag: 'Providers', auth: 'tenant',
      permission: 'provider:read', rejectionCode: PROVIDER_REJECTED, summary: 'Read a provider organization',
      success: {status: 200, description: 'Provider', schema: s.ref('ProviderOrganization')},
      handler: async context => respond(await getProviderOrganization(
        tenantOf(context).request('provider:read'), tenantOf(context).state,
        context.params.providerOrganizationId!, providers))}),
    route({method: 'POST', path: organizationPath + '/providers/{providerOrganizationId}/locations',
      operationId: 'createProviderLocation', tag: 'Providers', auth: 'tenant',
      permission: 'provider-location:write', rejectionCode: PROVIDER_REJECTED,
      summary: 'Add a service location to a provider',
      requestBody: s.object({name: s.string({minLength: 1, maxLength: 120}),
        addressLines: s.array(s.string({maxLength: 200}), {minItems: 1, maxItems: 4}),
        locality: s.string({maxLength: 120}), administrativeArea: s.string({maxLength: 120}),
        postalCode: s.string({maxLength: 20}), countryCode: s.string({pattern: '^[A-Z]{2}$'}),
        timeZone: s.string({maxLength: 64}),
        serviceModes: s.array(s.enum('on_site', 'mobile', 'remote'), {minItems: 1, maxItems: 3})}),
      success: {status: 201, description: 'Location created', schema: s.ref('ProviderLocation')},
      handler: async context => respond(await createProviderLocation(1,
        tenantOf(context).request('provider-location:write'), tenantOf(context).state,
        {...(context.body as object), providerOrganizationId: context.params.providerOrganizationId!} as never,
        providers), 201)}),
    route({method: 'GET', path: organizationPath + '/providers/{providerOrganizationId}/locations',
      operationId: 'listProviderLocations', tag: 'Providers', auth: 'tenant',
      permission: 'provider-location:read', rejectionCode: PROVIDER_REJECTED, summary: 'List provider locations',
      success: {status: 200, description: 'Locations', schema: s.object({items: s.array(s.ref('ProviderLocation'))})},
      handler: async context => respond(await listProviderLocations(
        tenantOf(context).request('provider-location:read'), tenantOf(context).state,
        context.params.providerOrganizationId!, providers), 200, value => ({items: value}))}),
  ];
}
