import type { FastifyPluginAsync } from 'fastify'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { pool } from '../db/pool.js'
import { getParticipantCount, MAX_PARTICIPANTS_PER_MEETING } from '../services/limits.js'
import { getLiveKitApiUrl, getLiveKitCredentials, getPublicLiveKitUrl } from '../services/livekit-config.js'

const getLiveKitClient = () => {
  const { apiKey, apiSecret } = getLiveKitCredentials()
  return new RoomServiceClient(getLiveKitApiUrl(), apiKey, apiSecret)
}

export const livekitRoutes: FastifyPluginAsync = async (app) => {

  app.addHook('onRequest', app.authenticate)

  // POST /api/livekit/token — generate participant token
  app.post('/token', async (request, reply) => {
    const user = request.user as { sub: string; name: string; email: string }
    const { meetingId } = request.body as { meetingId: string }

    if (!meetingId) {
      return reply.status(400).send({ error: { code: 'MISSING_MEETING_ID', message: 'meetingId required' } })
    }

    // Load meeting
    const meetingResult = await pool.query(
      'SELECT id, livekit_room, ended_at, creator_id, COALESCE(host_id, creator_id) AS host_id, waiting_room_enabled, is_public FROM meetings WHERE id = $1',
      [meetingId],
    )
    const meeting = meetingResult.rows[0]
    if (!meeting) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
    }
    if (meeting.ended_at) {
      return reply.status(400).send({ error: { code: 'MEETING_ENDED', message: 'Meeting has ended' } })
    }

    // Enforce guest check for private meetings
    const isGuest = user.email?.endsWith('@guest.centras-echo.local') ?? false
    if (!meeting.is_public && isGuest) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Гостям запрещен доступ к приватным встречам' }
      })
    }

    // Enforce waiting room check for non-hosts
    if (meeting.waiting_room_enabled && meeting.host_id !== user.sub) {
      const waitResult = await pool.query(
        'SELECT status FROM meeting_waiting_room WHERE meeting_id = $1 AND user_id = $2',
        [meetingId, user.sub]
      )
      const status = waitResult.rows[0]?.status
      if (status !== 'admitted') {
        return reply.status(403).send({
          error: { code: 'WAITING_ROOM', message: 'Вы должны быть одобрены организатором для входа' }
        })
      }
    }

    // Enforce participant limit
    const count = await getParticipantCount(meetingId)
    if (count >= MAX_PARTICIPANTS_PER_MEETING) {
      return reply.status(429).send({
        error: { code: 'ROOM_FULL', message: `Максимум ${MAX_PARTICIPANTS_PER_MEETING} участников` },
      })
    }

    // Build LiveKit access token
    const { apiKey, apiSecret } = getLiveKitCredentials()
    const at = new AccessToken(apiKey, apiSecret, {
      identity: user.sub,
      name: user.name,
      ttl: '2h',
    })

    at.addGrant({
      room: meeting.livekit_room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    })

    const token = await at.toJwt()

    // Record join in participants table
    await pool.query(
      'INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [meetingId, user.sub],
    )

    return reply.send({
      data: {
        token,
        serverUrl: getPublicLiveKitUrl(),
      },
    })
  })

  // POST /api/livekit/egress/start — start audio recording (host only)
  app.post('/egress/start', async (request, reply) => {
    const user = request.user as { sub: string }
    const { meetingId } = request.body as { meetingId: string }

    // Check host
    const meeting = await pool.query(
      'SELECT COALESCE(host_id, creator_id) AS host_id, livekit_room, is_recorded FROM meetings WHERE id = $1',
      [meetingId],
    )
    if (!meeting.rows[0]) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
    }
    if (meeting.rows[0].host_id !== user.sub) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only host can start recording' } })
    }
    if (meeting.rows[0].is_recorded) {
      return reply.status(400).send({ error: { code: 'ALREADY_RECORDING', message: 'Recording already started' } })
    }

    // Verify all active participants consented
    let activeUserIds: string[] | null = null
    try {
      const client = getLiveKitClient()
      const participants = await client.listParticipants(meeting.rows[0].livekit_room)
      activeUserIds = participants.map((p) => p.identity)
    } catch (err) {
      request.log.warn(err, 'Failed to fetch active participants from LiveKit in egress start')
    }

    let query = `
      SELECT
        COUNT(DISTINCT mp.user_id) AS total,
        COUNT(DISTINCT mc.user_id) AS consented
      FROM meeting_participants mp
      LEFT JOIN meeting_consents mc
        ON mc.meeting_id = mp.meeting_id AND mc.user_id = mp.user_id
      WHERE mp.meeting_id = $1
    `
    const params: any[] = [meetingId]
    if (activeUserIds && activeUserIds.length > 0) {
      query += ` AND mp.user_id = ANY($2::uuid[])`
      params.push(activeUserIds)
    }

    const consentCheck = await pool.query(query, params)
    const { total, consented } = consentCheck.rows[0]
    if (Number(total) !== Number(consented)) {
      return reply.status(403).send({
        error: {
          code: 'CONSENT_INCOMPLETE',
          message: `Ожидается согласие: ${consented}/${total} участников`,
        },
      })
    }

    // Mark meeting as recording in DB
    try {
      await pool.query(
        `UPDATE meetings
         SET is_recorded = TRUE, egress_id = 'client-recorded'
         WHERE id = $1`,
        [meetingId],
      )
      return reply.send({ data: { recording: true, egressId: 'client-recorded' } })
    } catch (err: any) {
      app.log.error({ err, meetingId }, 'Failed to start recording state')
      return reply.status(500).send({
        error: { code: 'RECORDING_START_FAILED', message: 'Failed to update recording state' },
      })
    }
  })

  // POST /api/livekit/egress/stop — stop recording (client-side recorder coordinates upload)
  app.post('/egress/stop', async (request, reply) => {
    const user = request.user as { sub: string }
    const { meetingId } = request.body as { meetingId: string }

    const meeting = await pool.query(
      'SELECT COALESCE(host_id, creator_id) AS host_id FROM meetings WHERE id = $1',
      [meetingId],
    )
    if (!meeting.rows[0]) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
    }
    if (meeting.rows[0].host_id !== user.sub) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only host can stop recording' } })
    }

    try {
      await pool.query(
        `UPDATE meetings
         SET is_recorded = FALSE
         WHERE id = $1`,
        [meetingId],
      )
      return reply.send({ data: { stopped: true } })
    } catch (err: any) {
      app.log.error({ err, meetingId }, 'Failed to stop recording state')
      return reply.status(500).send({
        error: { code: 'RECORDING_STOP_FAILED', message: 'Failed to update recording state' },
      })
    }
  })
}
