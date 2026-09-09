import type { FastifyPluginAsync } from 'fastify'
import { RoomServiceClient } from 'livekit-server-sdk'
import { pool } from '../db/pool.js'
import { getLiveKitApiUrl, getLiveKitCredentials } from '../services/livekit-config.js'

export const consentsRoutes: FastifyPluginAsync = async (app) => {

  app.addHook('onRequest', app.authenticate)

  // POST /api/meetings/:id/consent — participant gives consent
  app.post('/:id/consent', async (request, reply) => {
    const user = request.user as { sub: string }
    const { id } = request.params as { id: string }

    // Verify participant is in this meeting
    const participant = await pool.query(
      'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
      [id, user.sub],
    )
    if (!participant.rows[0]) {
      return reply.status(403).send({ error: { code: 'NOT_PARTICIPANT', message: 'You are not in this meeting' } })
    }

    await pool.query(
      `INSERT INTO meeting_consents (meeting_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [id, user.sub],
    )

    // Return updated status
    const status = await getConsentStatus(id)
    return reply.send({ data: status })
  })

  // DELETE /api/meetings/:id/consent — revoke consent
  app.delete('/:id/consent', async (request, reply) => {
    const user = request.user as { sub: string }
    const { id } = request.params as { id: string }

    await pool.query(
      'DELETE FROM meeting_consents WHERE meeting_id = $1 AND user_id = $2',
      [id, user.sub],
    )

    const status = await getConsentStatus(id)
    return reply.send({ data: status })
  })

  // GET /api/meetings/:id/consent/status — get full consent status
  app.get('/:id/consent/status', async (request, reply) => {
    const user = request.user as { sub: string }
    const { id } = request.params as { id: string }

    // Must be participant or creator
    const access = await pool.query(
      `SELECT 1 FROM meetings m
       LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = $2
       WHERE m.id = $1 AND (m.creator_id = $2 OR mp.user_id IS NOT NULL)`,
      [id, user.sub],
    )
    if (!access.rows[0]) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } })
    }

    const status = await getConsentStatus(id)
    return reply.send({ data: status })
  })
}

async function getConsentStatus(meetingId: string) {
  let activeUserIds: string[] | null = null
  try {
    const meetingRes = await pool.query(
      'SELECT livekit_room FROM meetings WHERE id = $1',
      [meetingId]
    )
    const meeting = meetingRes.rows[0]
    if (meeting) {
      const { apiKey, apiSecret } = getLiveKitCredentials()
      const client = new RoomServiceClient(getLiveKitApiUrl(), apiKey, apiSecret)
      const participants = await client.listParticipants(meeting.livekit_room)
      activeUserIds = participants.map((p) => p.identity)
    }
  } catch (err) {
    console.warn('Failed to fetch active participants from LiveKit in getConsentStatus:', err)
  }

  let query = `
    SELECT
      u.id, u.name, u.avatar_url,
      mc.consented_at IS NOT NULL AS has_consented
    FROM meeting_participants mp
    JOIN users u ON u.id = mp.user_id
    LEFT JOIN meeting_consents mc
      ON mc.meeting_id = mp.meeting_id AND mc.user_id = mp.user_id
    WHERE mp.meeting_id = $1
  `
  const params: any[] = [meetingId]

  if (activeUserIds && activeUserIds.length > 0) {
    query += ` AND mp.user_id = ANY($2::uuid[])`
    params.push(activeUserIds)
  }

  const result = await pool.query(query, params)

  const participants = result.rows
  const total = participants.length
  const consented = participants.filter((p) => p.has_consented).length

  return {
    meetingId,
    total,
    consented,
    allConsented: total > 0 && consented === total,
    participants: participants.map((p) => ({
      userId: p.id,
      name: p.name,
      avatarUrl: p.avatar_url,
      hasConsented: p.has_consented,
    })),
  }
}
