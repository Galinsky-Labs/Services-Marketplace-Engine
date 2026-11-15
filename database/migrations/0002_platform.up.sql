ALTER TABLE marketplace.organizations
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE marketplace.memberships
  ADD COLUMN role_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE marketplace.roles (
  organization_id uuid NOT NULL REFERENCES marketplace.organizations(id) ON DELETE CASCADE,
  role_id text NOT NULL CHECK (role_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, role_id)
);

CREATE TABLE marketplace.api_keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[a-z0-9]{16,32}$'),
  organization_id uuid NOT NULL REFERENCES marketplace.organizations(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX api_keys_subject ON marketplace.api_keys (organization_id, subject_id);

CREATE TABLE marketplace.audit_events (
  event_id text PRIMARY KEY,
  occurred_at bigint NOT NULL,
  action text NOT NULL,
  subject_id text,
  organization_id text,
  resource_organization_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('authorized', 'denied')),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_resource_time
  ON marketplace.audit_events (resource_organization_id, occurred_at DESC);

-- Tenant-scoped document storage shared by every domain store adapter. Values are the
-- frozen contract objects; writes are compare-and-swap on the full previous value.
CREATE TABLE marketplace.documents (
  organization_id uuid NOT NULL REFERENCES marketplace.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]{0,63}$'),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  data jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, kind, id)
);

CREATE INDEX documents_data ON marketplace.documents USING gin (data jsonb_path_ops);

CREATE TABLE marketplace.document_keys (
  organization_id uuid NOT NULL,
  kind text NOT NULL,
  key_name text NOT NULL,
  key_value text NOT NULL,
  document_id text NOT NULL,
  PRIMARY KEY (organization_id, kind, key_name, key_value),
  FOREIGN KEY (organization_id, kind, document_id)
    REFERENCES marketplace.documents (organization_id, kind, id) ON DELETE CASCADE
);

ALTER TABLE marketplace.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE marketplace.document_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace.document_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_documents ON marketplace.documents
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY tenant_document_keys ON marketplace.document_keys
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

INSERT INTO marketplace.schema_migrations (id) VALUES ('0002_platform');
