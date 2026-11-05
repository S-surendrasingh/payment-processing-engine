import 'dotenv/config';
import { Client } from 'pg';
import { z } from 'zod';
const password = z
  .string()
  .min(24)
  .refine((value) => !value.startsWith('replace-'))
  .parse(process.env.RUNTIME_DB_PASSWORD);
const client = new Client({
  connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
});
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('payment-engine-role-setup'))");
  // SQL format(%L) escapes the password on the server; never interpolate untrusted shell/SQL text.
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'payment_app'");
  if (!exists.rowCount) await client.query('CREATE ROLE payment_app LOGIN');
  const command = await client.query<{ sql: string }>(
    "SELECT format('ALTER ROLE payment_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text) AS sql",
    [password],
  );
  await client.query(command.rows[0]!.sql);
  await client.query('GRANT USAGE ON SCHEMA public TO payment_app');
  await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM payment_app');
  await client.query(
    'GRANT SELECT, INSERT, UPDATE ON customers, payments, refunds, idempotency_keys, payment_transactions, processor_records, webhook_events, reconciliation_records TO payment_app',
  );
  await client.query('COMMIT');
  console.log('Runtime role configured with scoped table permissions');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
