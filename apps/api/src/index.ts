import 'dotenv/config'
import Fastify, { FastifyRequest, FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'

import { authRoutes } from './routes/auth.js'
import { googleAuthRoutes } from './routes/google-auth.js'
import { meetingsRoutes } from './routes/meetings.js'
import { consentsRoutes } from './routes/consents.js'
import { livekitRoutes } from './routes/livekit.js'
import { sentiRoutes } from './routes/senti.js'
import { adminRoutes } from './routes/admin.js'
import { pool } from './db/pool.js'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

// ─── Plugins ──────────────────────────────────────────────────────────────────

await app.register(cors, {
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  credentials: true,
})

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error(
    'JWT_SECRET environment variable is required and must be at least 32 characters long.',
  )
}

await app.register(jwt, {
  secret: jwtSecret,
  sign: { expiresIn: '15m' },
})

app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify()
  } catch {
    return reply
      .status(401)
      .send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
  }
})

await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
})

await app.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
})

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', async () => {
  const dbCheck = await pool.query('SELECT 1').then(() => 'ok').catch(() => 'error')
  return { status: 'ok', db: dbCheck, timestamp: new Date().toISOString() }
})

// ─── Routes ───────────────────────────────────────────────────────────────────

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(googleAuthRoutes, { prefix: '/api/auth' })
await app.register(meetingsRoutes, { prefix: '/api/meetings' })
await app.register(consentsRoutes, { prefix: '/api/meetings' })
await app.register(livekitRoutes, { prefix: '/api/livekit' })
await app.register(sentiRoutes, { prefix: '/api/senti' })
await app.register(adminRoutes, { prefix: '/api/admin' })

// ─── Start ────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

try {
  await app.listen({ port, host })
  app.log.info(`Centras.Echo API running on http://${host}:${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
