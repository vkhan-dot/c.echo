import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool } from '../db/pool.js'

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  role: z.enum(['admin', 'moderator', 'employee']).default('employee'),
})

const UpdateUserSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  role: z.enum(['admin', 'moderator', 'employee']).optional(),
})

export const adminRoutes: FastifyPluginAsync = async (app) => {

  // All admin routes require auth + admin role
  app.addHook('onRequest', async (request, reply) => {
    await app.authenticate(request, reply)
    if (reply.sent) return // authenticate already emitted 401

    const user = request.user as { role: string } | undefined
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      })
    }
  })

  // GET /api/admin/users — list all users
  app.get('/users', async (_request, reply) => {
    const result = await pool.query(
      `SELECT id, email, name, role, avatar_url AS "avatarUrl", created_at AS "createdAt"
       FROM users
       ORDER BY created_at DESC`,
    )
    return reply.send({ data: result.rows })
  })

  // POST /api/admin/users — admin creates a new user
  // User receives an invite link or sets password on first login
  app.post('/users', async (request, reply) => {
    const body = CreateUserSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })
    }

    const { email, name, role } = body.data

    // Check if user already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    if (existing.rows[0]) {
      return reply.status(409).send({ error: { code: 'CONFLICT', message: 'User with this email already exists' } })
    }

    // Create user without password_hash — they MUST login via Google SSO
    // The google_id column links their Google account on first OAuth login
    const result = await pool.query(
      `INSERT INTO users (email, name, role, password_hash)
       VALUES ($1, $2, $3, 'GOOGLE_SSO_ONLY')
       RETURNING id, email, name, role, avatar_url AS "avatarUrl", created_at AS "createdAt"`,
      [email.toLowerCase(), name, role],
    )

    return reply.status(201).send({ data: result.rows[0] })
  })

  // PATCH /api/admin/users/:id — update user role or name
  app.patch('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = UpdateUserSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })
    }

    const updates: string[] = []
    const values: (string | undefined)[] = []
    let i = 1

    if (body.data.name !== undefined) {
      updates.push(`name = $${i++}`)
      values.push(body.data.name)
    }
    if (body.data.role !== undefined) {
      updates.push(`role = $${i++}`)
      values.push(body.data.role)
    }

    if (updates.length === 0) {
      return reply.status(400).send({ error: { code: 'NO_UPDATES', message: 'No fields to update' } })
    }

    values.push(id)
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, email, name, role`,
      values,
    )

    if (!result.rows[0]) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'User not found' } })
    }

    return reply.send({ data: result.rows[0] })
  })

  // DELETE /api/admin/users/:id — deactivate user
  app.delete('/users/:id', async (request, reply) => {
    const admin = request.user as { sub: string }
    const { id } = request.params as { id: string }

    if (admin.sub === id) {
      return reply.status(400).send({ error: { code: 'SELF_DELETE', message: 'Cannot delete yourself' } })
    }

    await pool.query('DELETE FROM users WHERE id = $1', [id])
    return reply.send({ data: { deleted: true } })
  })

  // GET /api/admin/stats — platform stats
  app.get('/stats', async (_request, reply) => {
    const [users, meetings, active] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM meetings'),
      pool.query("SELECT COUNT(*) FROM meetings WHERE ended_at IS NULL"),
    ])

    return reply.send({
      data: {
        totalUsers: Number(users.rows[0].count),
        totalMeetings: Number(meetings.rows[0].count),
        activeMeetings: Number(active.rows[0].count),
      },
    })
  })
}
