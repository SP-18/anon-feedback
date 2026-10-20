import pg from 'pg';

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString });
  // Idle client errors would otherwise crash the process.
  pool.on('error', (err) => console.error(`Postgres pool error: ${err.message}`));
  return pool;
}
