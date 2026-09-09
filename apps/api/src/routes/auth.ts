import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { pool } from '../db/pool.js'
import type { User } from '@centras/shared'

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
})

export const authRoutes: FastifyPluginAsync = async (app) => {

  // POST /api/auth/login
  app.post('/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const body = LoginSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })
    }

    const { email, password } = body.data

    const result = await pool.query<User & { password_hash: string }>(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase()],
    )

    const user = result.rows[0]
    if (!user) {
      return reply.status(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password incorrect' } })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.status(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password incorrect' } })
    }

    const accessToken = app.jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role },
      { expiresIn: '15m' },
    )

    const refreshToken = app.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: '7d' },
    )

    // Store refresh token hash
    const tokenHash = await bcrypt.hash(refreshToken, 10)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt],
    )

    return reply.send({
      data: {
        accessToken,
        refreshToken,
        expiresIn: 900,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatarUrl: (user as any).avatar_url,
          createdAt: (user as any).created_at,
        },
      },
    })
  })

  // POST /api/auth/refresh
  app.post('/refresh', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken?: string }
    if (!refreshToken) {
      return reply.status(400).send({ error: { code: 'MISSING_TOKEN', message: 'Refresh token required' } })
    }

    let payload: { sub: string; type: string }
    try {
      payload = app.jwt.verify<{ sub: string; type: string }>(refreshToken)
    } catch {
      return reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } })
    }

    if (payload.type !== 'refresh') {
      return reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: 'Not a refresh token' } })
    }

    // Validate stored tokens
    const stored = await pool.query(
      'SELECT * FROM refresh_tokens WHERE user_id = $1 AND expires_at > NOW()',
      [payload.sub],
    )

    let validToken = false
    for (const row of stored.rows) {
      if (await bcrypt.compare(refreshToken, row.token_hash)) {
        validToken = true
        await pool.query('DELETE FROM refresh_tokens WHERE id = $1', [row.id])
        break
      }
    }

    if (!validToken) {
      return reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: 'Token not found or expired' } })
    }

    const user = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub])
    if (!user.rows[0]) {
      return reply.status(401).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } })
    }

    const u = user.rows[0]
    const newAccessToken = app.jwt.sign(
      { sub: u.id, email: u.email, name: u.name, role: u.role },
      { expiresIn: '15m' },
    )
    const newRefreshToken = app.jwt.sign({ sub: u.id, type: 'refresh' }, { expiresIn: '7d' })
    const tokenHash = await bcrypt.hash(newRefreshToken, 10)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [u.id, tokenHash, expiresAt],
    )

    return reply.send({ data: { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: 900 } })
  })

  // POST /api/auth/guest
  app.post('/guest', async (request, reply) => {
    const { name } = request.body as { name?: string }
    if (!name || !name.trim()) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Name is required' } })
    }

    const guestId = randomUUID()
    const guestEmail = `guest-${guestId}@guest.centras-echo.local`

    await pool.query(
      `INSERT INTO users (id, email, name, role, password_hash)
       VALUES ($1, $2, $3, 'employee', 'GUEST_ACCOUNT')`,
      [guestId, guestEmail, name.trim()],
    )

    const accessToken = app.jwt.sign(
      { sub: guestId, email: guestEmail, name: name.trim(), role: 'employee' },
      { expiresIn: '2h' },
    )

    const refreshToken = app.jwt.sign(
      { sub: guestId, type: 'refresh' },
      { expiresIn: '1d' },
    )

    const tokenHash = await bcrypt.hash(refreshToken, 10)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [guestId, tokenHash, expiresAt],
    )

    return reply.send({
      data: {
        accessToken,
        refreshToken,
        expiresIn: 7200,
        user: {
          id: guestId,
          email: guestEmail,
          name: name.trim(),
          role: 'employee',
          avatarUrl: null,
          createdAt: new Date().toISOString(),
        },
      },
    })
  })

  // POST /api/auth/logout
  app.post('/logout', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as { sub: string; email?: string }
    const isGuest = user.email?.endsWith('@guest.centras-echo.local')
    if (isGuest) {
      await pool.query('DELETE FROM users WHERE id = $1', [user.sub])
    } else {
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.sub])
    }
    return reply.send({ data: { success: true } })
  })

  // GET /api/auth/me
  app.get('/me', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as { sub: string }
    const result = await pool.query(
      'SELECT id, email, name, role, avatar_url, created_at FROM users WHERE id = $1',
      [user.sub],
    )
    if (!result.rows[0]) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'User not found' } })
    }
    const u = result.rows[0]
    return reply.send({
      data: { id: u.id, email: u.email, name: u.name, role: u.role, avatarUrl: u.avatar_url, createdAt: u.created_at },
    })
  })
}

// Extend Fastify types for authenticate decorator
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
  }
}
