import type pg from 'pg';
import type {
  OrganizationAuthorizationState, TenantAuditSink, TenantAuthorizationAuditEvent,
} from '@services-marketplace/contracts';

export interface ApiKeyRecord {
  readonly keyId: string;
  readonly organizationId: string;
  readonly subjectId: string;
  readonly secretHash: string;
  readonly label: string;
  readonly status: 'active' | 'revoked';
}

export interface MembershipRecord {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly status: 'active' | 'suspended' | 'revoked';
  readonly roleIds: readonly string[];
}

export interface RoleRecord {
  readonly organizationId: string;
  readonly roleId: string;
  readonly permissions: readonly string[];
}

/** Platform identity: organizations, roles, memberships, API keys and audit events. */
export interface IdentityRepository extends TenantAuditSink {
  createOrganization(organizationId: string, name: string): Promise<void>;
  putRole(role: RoleRecord): Promise<void>;
  putMembership(membership: MembershipRecord): Promise<void>;
  createApiKey(key: ApiKeyRecord): Promise<void>;
  revokeApiKey(organizationId: string, keyId: string): Promise<boolean>;
  getApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  /** RBAC state for one subject inside one organization (only that organization's rows). */
  loadAuthorizationState(organizationId: string, subjectId: string):
    Promise<OrganizationAuthorizationState>;
  listAuditEvents(organizationId: string, limit: number):
    Promise<readonly TenantAuthorizationAuditEvent[]>;
  ping(): Promise<boolean>;
}

export class MemoryIdentityRepository implements IdentityRepository {
  readonly organizations = new Map<string, {name: string; status: 'active' | 'suspended' | 'closed'}>();
  readonly roles = new Map<string, RoleRecord>();
  readonly memberships = new Map<string, MembershipRecord>();
  readonly keys = new Map<string, ApiKeyRecord>();
  readonly audit: TenantAuthorizationAuditEvent[] = [];

  async createOrganization(organizationId: string, name: string): Promise<void> {
    if (this.organizations.has(organizationId)) throw new Error('organization exists');
    this.organizations.set(organizationId, {name, status: 'active'});
  }
  async putRole(role: RoleRecord): Promise<void> {
    if (!this.organizations.has(role.organizationId)) throw new Error('unknown organization');
    this.roles.set(role.organizationId + '/' + role.roleId, Object.freeze({...role,
      permissions: Object.freeze([...role.permissions])}));
  }
  async putMembership(membership: MembershipRecord): Promise<void> {
    if (!this.organizations.has(membership.organizationId)) throw new Error('unknown organization');
    this.memberships.set(membership.organizationId + '/' + membership.subjectId,
      Object.freeze({...membership, roleIds: Object.freeze([...membership.roleIds])}));
  }
  async createApiKey(key: ApiKeyRecord): Promise<void> {
    if (this.keys.has(key.keyId)) throw new Error('key exists');
    this.keys.set(key.keyId, Object.freeze({...key}));
  }
  async revokeApiKey(organizationId: string, keyId: string): Promise<boolean> {
    const key = this.keys.get(keyId);
    if (key?.organizationId !== organizationId) return false;
    this.keys.set(keyId, Object.freeze({...key, status: 'revoked'}));
    return true;
  }
  async getApiKey(keyId: string): Promise<ApiKeyRecord | null> {
    return this.keys.get(keyId) ?? null;
  }
  async loadAuthorizationState(organizationId: string,
    subjectId: string): Promise<OrganizationAuthorizationState> {
    const organization = this.organizations.get(organizationId);
    const membership = this.memberships.get(organizationId + '/' + subjectId);
    return {
      organizations: organization ? [{organizationId, status: organization.status}] : [],
      memberships: membership ? [{subjectId, organizationId, status: membership.status,
        roleIds: membership.roleIds}] : [],
      roles: [...this.roles.values()].filter(role => role.organizationId === organizationId)
        .map(role => ({roleId: role.roleId, organizationId, permissions: role.permissions})),
    };
  }
  async append(event: TenantAuthorizationAuditEvent): Promise<void> {
    this.audit.push(event);
    if (this.audit.length > 10_000) this.audit.shift();
  }
  async listAuditEvents(organizationId: string,
    limit: number): Promise<readonly TenantAuthorizationAuditEvent[]> {
    return this.audit.filter(event => event.resourceOrganizationId === organizationId)
      .slice(-limit).reverse();
  }
  async ping(): Promise<boolean> { return true; }
}

const statusFromRow = (status: string): MembershipRecord['status'] =>
  status === 'active' ? 'active' : status === 'revoked' ? 'revoked' : 'suspended';

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createOrganization(organizationId: string, name: string): Promise<void> {
    await this.pool.query('INSERT INTO marketplace.organizations (id, name) VALUES ($1, $2)',
      [organizationId, name]);
  }
  async putRole(role: RoleRecord): Promise<void> {
    await this.pool.query(
      'INSERT INTO marketplace.roles (organization_id, role_id, permissions) VALUES ($1, $2, $3) ' +
      'ON CONFLICT (organization_id, role_id) DO UPDATE SET permissions = EXCLUDED.permissions',
      [role.organizationId, role.roleId, [...role.permissions]]);
  }
  async putMembership(membership: MembershipRecord): Promise<void> {
    // The 0001 schema stores 'inactive' for non-active, non-revoked memberships.
    const status = membership.status === 'suspended' ? 'inactive' : membership.status;
    await this.pool.query(
      'INSERT INTO marketplace.memberships (organization_id, subject_id, status, role_ids) ' +
      'VALUES ($1, $2, $3, $4) ON CONFLICT (organization_id, subject_id) DO UPDATE SET ' +
      'status = EXCLUDED.status, role_ids = EXCLUDED.role_ids, updated_at = now()',
      [membership.organizationId, membership.subjectId, status, [...membership.roleIds]]);
  }
  async createApiKey(key: ApiKeyRecord): Promise<void> {
    await this.pool.query(
      'INSERT INTO marketplace.api_keys (key_id, organization_id, subject_id, secret_hash, label, status) ' +
      'VALUES ($1, $2, $3, $4, $5, $6)',
      [key.keyId, key.organizationId, key.subjectId, key.secretHash, key.label, key.status]);
  }
  async revokeApiKey(organizationId: string, keyId: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE marketplace.api_keys SET status = 'revoked' WHERE key_id = $1 AND organization_id = $2",
      [keyId, organizationId]);
    return result.rowCount === 1;
  }
  async getApiKey(keyId: string): Promise<ApiKeyRecord | null> {
    const result = await this.pool.query<{key_id: string; organization_id: string;
      subject_id: string; secret_hash: string; label: string; status: 'active' | 'revoked'}>(
      'SELECT key_id, organization_id, subject_id, secret_hash, label, status ' +
      'FROM marketplace.api_keys WHERE key_id = $1', [keyId]);
    const row = result.rows[0];
    if (!row) return null;
    void this.pool.query('UPDATE marketplace.api_keys SET last_used_at = now() WHERE key_id = $1',
      [keyId]).catch(() => {});
    return {keyId: row.key_id, organizationId: row.organization_id, subjectId: row.subject_id,
      secretHash: row.secret_hash, label: row.label, status: row.status};
  }
  async loadAuthorizationState(organizationId: string,
    subjectId: string): Promise<OrganizationAuthorizationState> {
    const [organizations, memberships, roles] = await Promise.all([
      this.pool.query<{id: string; status: 'active' | 'suspended' | 'closed'}>(
        'SELECT id, status FROM marketplace.organizations WHERE id = $1', [organizationId]),
      this.pool.query<{status: string; role_ids: string[]}>(
        'SELECT status, role_ids FROM marketplace.memberships WHERE organization_id = $1 AND subject_id = $2',
        [organizationId, subjectId]),
      this.pool.query<{role_id: string; permissions: string[]}>(
        'SELECT role_id, permissions FROM marketplace.roles WHERE organization_id = $1',
        [organizationId]),
    ]);
    return {
      organizations: organizations.rows.map(row => ({organizationId: row.id, status: row.status})),
      memberships: memberships.rows.map(row => ({subjectId, organizationId,
        status: statusFromRow(row.status), roleIds: row.role_ids})),
      roles: roles.rows.map(row => ({roleId: row.role_id, organizationId,
        permissions: row.permissions})),
    };
  }
  async append(event: TenantAuthorizationAuditEvent): Promise<void> {
    await this.pool.query(
      'INSERT INTO marketplace.audit_events (event_id, occurred_at, action, subject_id, ' +
      'organization_id, resource_organization_id, outcome) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [event.eventId, event.occurredAt, event.action, event.subjectId, event.organizationId,
        event.resourceOrganizationId, event.outcome]);
  }
  async listAuditEvents(organizationId: string,
    limit: number): Promise<readonly TenantAuthorizationAuditEvent[]> {
    const result = await this.pool.query<{event_id: string; occurred_at: string; action: string;
      subject_id: string | null; organization_id: string | null;
      resource_organization_id: string; outcome: 'authorized' | 'denied'}>(
      'SELECT event_id, occurred_at, action, subject_id, organization_id, resource_organization_id, outcome ' +
      'FROM marketplace.audit_events WHERE resource_organization_id = $1 ' +
      'ORDER BY occurred_at DESC, event_id DESC LIMIT $2', [organizationId, limit]);
    return result.rows.map(row => ({eventId: row.event_id, occurredAt: Number(row.occurred_at),
      action: row.action, subjectId: row.subject_id, organizationId: row.organization_id,
      resourceOrganizationId: row.resource_organization_id, outcome: row.outcome}));
  }
  async ping(): Promise<boolean> {
    const result = await this.pool.query<{ok: number}>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }
}
