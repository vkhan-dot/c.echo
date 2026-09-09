import pg from 'pg'

const { Pool } = pg

function resolveSslConfig(): pg.PoolConfig['ssl'] {
  if (process.env.NODE_ENV !== 'production') return false

  // Preferred: managed CA bundle pinned via env (Railway / Supabase / Neon export this)
  if (process.env.DATABASE_CA_CERT) {
    return { ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true }
  }

  // Explicit escape hatch — only honored when the operator sets it deliberately.
  // Logged loudly so MITM exposure is never silent.
  if (process.env.DATABASE_SSL_INSECURE === 'true') {
    console.warn(
      '[db] DATABASE_SSL_INSECURE=true — PostgreSQL certificate verification is OFF. ' +
        'Set DATABASE_CA_CERT to restore proper TLS validation.',
    )
    return { rejectUnauthorized: false }
  }

  // Secure default: validate against Node's trusted CA store.
  return { rejectUnauthorized: true }
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSslConfig(),
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
})

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err)
})

export async function runWithUser<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId])
    const res = await fn(client)
    await client.query('COMMIT')
    return res
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
