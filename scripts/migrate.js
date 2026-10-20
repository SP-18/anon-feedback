import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPool } from '../src/db.js';

const sqlDir = fileURLToPath(new URL('../sql/', import.meta.url));

export const DEFAULT_WRITER_ROLE = 'feedback_writer';

async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// The app connects as this role, which may only INSERT the body column: no SELECT, UPDATE, DELETE
// or TRUNCATE, so only the table owner can read feedback. Safe to re-run.
async function setUpWriterRole(client, role, password) {
  const ident = client.escapeIdentifier(role);

  const { rows: [me] } = await client.query(
    `SELECT current_user AS name, (SELECT tableowner FROM pg_tables
       WHERE schemaname = current_schema() AND tablename = 'submissions') AS owner`);
  if (role === me.name || role === me.owner) {
    throw new Error(`WRITER_ROLE "${role}" must be a separate role, not the migrating user or the table owner`);
  }

  const { rows: [existing] } = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [role]);
  if (existing?.rolsuper) throw new Error(`WRITER_ROLE "${role}" is a superuser; use a dedicated role`);
  if (!existing) await client.query(`CREATE ROLE ${ident} LOGIN`);
  await client.query(`ALTER ROLE ${ident} LOGIN`);

  // Revoking table privileges also revokes column privileges, so each run starts from a clean slate.
  await client.query(`REVOKE ALL ON submissions FROM PUBLIC, ${ident}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
  // Column-level grant: id and submitted_on always come from their defaults.
  await client.query(`GRANT INSERT (body) ON submissions TO ${ident}`);

  // pg_get_serial_sequence returns an already-quoted, schema-qualified name.
  const { rows: [{ seq }] } = await client.query("SELECT pg_get_serial_sequence('submissions', 'id') AS seq");
  await client.query(`REVOKE ALL ON SEQUENCE ${seq} FROM PUBLIC, ${ident}`);
  await client.query(`GRANT USAGE ON SEQUENCE ${seq} TO ${ident}`);

  if (password) {
    // ALTER ROLE can't take bind parameters, so the password is sent as an escaped literal.
    await client.query(`ALTER ROLE ${ident} PASSWORD ${client.escapeLiteral(password)}`);
  }
}

// Must run as the table owner (with CREATEROLE). All sql/*.sql files are idempotent and re-run every time.
export async function runMigrations(pool, { writerRole = DEFAULT_WRITER_ROLE, writerPassword, log = () => {} } = {}) {
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(sqlDir, file), 'utf8');
    try {
      await inTransaction(pool, (client) => client.query(sql));
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
    log(`Applied ${file}`);
  }

  await inTransaction(pool, (client) => setUpWriterRole(client, writerRole, writerPassword));
  log(`Granted INSERT-only access to ${writerRole}`);
  if (writerPassword) {
    log(`Set ${writerRole} password`);
  } else {
    log(`WRITER_PASSWORD not set — set it manually with psql: \\password ${writerRole}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { MIGRATION_DATABASE_URL, WRITER_ROLE, WRITER_PASSWORD } = process.env;
  if (!MIGRATION_DATABASE_URL) {
    console.error('Migration failed: MIGRATION_DATABASE_URL must be set');
    process.exit(1);
  }
  const pool = createPool(MIGRATION_DATABASE_URL);
  try {
    await runMigrations(pool, {
      writerRole: WRITER_ROLE || DEFAULT_WRITER_ROLE,
      writerPassword: WRITER_PASSWORD || undefined,
      log: console.log,
    });
  } catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
