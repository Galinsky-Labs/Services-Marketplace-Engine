import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {createApp, createServicesWith} from './create-app.js';
import {runMigrations} from './db/migrate.js';
import {createHttpServer} from './http/server.js';
import {MemoryDocumentStore, PostgresDocumentStore} from './store/documents.js';
import {MemoryIdentityRepository, PostgresIdentityRepository} from './store/identity.js';

const log = (entry: Readonly<Record<string, unknown>>): void => {
  process.stdout.write(JSON.stringify({time: new Date().toISOString(), ...entry}) + '\n');
};

async function main(): Promise<void> {
  const env = process.env;
  const port = Number(env.PORT) || 3000;
  const databaseUrl = env.DATABASE_URL;
  const production = env.APP_ENV === 'production';
  if (!databaseUrl && production) throw new Error('DATABASE_URL is required when APP_ENV=production');

  let pool: pg.Pool | null = null;
  let services;
  if (databaseUrl) {
    if (env.RUN_MIGRATIONS !== 'false') {
      const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');
      const applied = await runMigrations(env.MIGRATION_DATABASE_URL || databaseUrl, 'up', directory,
        message => log({level: 'info', msg: 'migration', detail: message}));
      log({level: 'info', msg: 'migrations complete', applied: applied.length});
    }
    pool = new pg.Pool({connectionString: databaseUrl, max: Number(env.DATABASE_POOL_MAX) || 5,
      idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: 'sme-api'});
    pool.on('error', error => log({level: 'error', msg: 'idle database client error', error: error.message}));
    services = createServicesWith(new PostgresIdentityRepository(pool), new PostgresDocumentStore(pool),
      env, 'postgres', log);
  } else {
    log({level: 'warn', msg: 'DATABASE_URL not set: using volatile in-memory storage'});
    services = createServicesWith(new MemoryIdentityRepository(), new MemoryDocumentStore(), env, 'memory', log);
  }

  const app = createApp(services);
  for (const status of [services.adapters.ai.status, services.adapters.stripe.status,
    services.adapters.credentialCheck.status, services.adapters.esign.status, services.adapters.email.status,
    services.adapters.sms.status, services.adapters.push.status, services.adapters.objectStorage.status]) {
    log({level: 'info', msg: 'adapter', name: status.name, mode: status.mode});
  }
  if (services.config.platformAdminTokenHash === null) {
    log({level: 'warn', msg: 'PLATFORM_ADMIN_TOKEN not set or malformed: organization provisioning disabled'});
  }
  const server = createHttpServer(app.handler);
  server.listen(port, '0.0.0.0', () => log({level: 'info', msg: 'listening', port,
    persistence: services.config.persistence, environment: services.config.environment}));

  const shutdown = (signal: string) => {
    log({level: 'info', msg: 'shutting down', signal});
    server.close(() => {
      void (pool?.end() ?? Promise.resolve()).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  log({level: 'fatal', msg: 'startup failed', error: error instanceof Error ? error.message : String(error)});
  process.exit(1);
});
