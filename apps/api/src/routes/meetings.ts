import type { FastifyPluginAsync } from 'fastify'
import '@fastify/multipart'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { RoomServiceClient } from 'livekit-server-sdk'
import { pool, runWithUser } from '../db/pool.js'
import { runThrottledCleanup, MAX_ACTIVE_MEETINGS } from '../services/limits.js'
import { getLiveKitApiUrl, getLiveKitCredentials } from '../services/livekit-config.js'

let lkClient: RoomServiceClient | null = null
const getLkClient = () => {
  if (!lkClient) {
    const { apiKey, apiSecret } = getLiveKitCredentials()
    lkClient = new RoomServiceClient(getLiveKitApiUrl(), apiKey, apiSecret)
  }
  return lkClient
}

async function getActiveParticipants(livekitRoom: string): Promise<any[]> {
  try {
    const client = getLkClient()
    const participants = await client.listParticipants(livekitRoom)
    if (!participants || participants.length === 0) {
      return []
    }
    const identities = participants.map((p) => p.identity)
    const result = await pool.query(
      `SELECT id AS "userId", name, avatar_url AS "avatarUrl"
       FROM users
       WHERE id = ANY($1::uuid[])`,
      [identities]
    )
    return result.rows
  } catch (err) {
    return []
  }
}


const CreateMeetingSchema = z.object({
  title: z.string().min(1).max(200),
  scheduledStart: z.string().datetime().optional().nullable(),
  isPublic: z.boolean().optional(),
  waitingRoomEnabled: z.boolean().optional(),
})

// Helper: verify user is a participant of a meeting
async function assertParticipant(meetingId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM meetings m
     LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = $2
     WHERE m.id = $1 AND (m.creator_id = $2 OR mp.user_id IS NOT NULL)`,
    [meetingId, userId],
  )
  return result.rows.length > 0
}

export const meetingsRoutes: FastifyPluginAsync = async (app) => {

  // ─── Public Routes (No Auth Required) ──────────────────────────────────────

  app.get('/:id/public-info', async (request, reply) => {
    const { id } = request.params as { id: string }

    const result = await pool.query(
      `SELECT
         m.id, m.title, m.scheduled_start AS "scheduledStart", m.is_public AS "isPublic",
         u.name AS "creatorName"
       FROM meetings m
       LEFT JOIN users u ON u.id = m.creator_id
       WHERE m.id = $1`,
      [id],
    )

    const meeting = result.rows[0]
    if (!meeting) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
    }

    if (!meeting.isPublic) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Meeting is private' } })
    }

    return reply.send({ data: meeting })
  })

  // ─── Private Routes (Auth Required) ────────────────────────────────────────

  app.register(async (app) => {
    app.addHook('onRequest', app.authenticate)

    // GET /api/meetings
    app.get('/', async (request, reply) => {
      const user = request.user as { sub: string }

      // Run guest and inactive room cleanup in the background asynchronously
      runThrottledCleanup()

      const result = await runWithUser(user.sub, (client) =>
        client.query(
          `SELECT
             m.id, m.title, m.creator_id AS "creatorId",
             COALESCE(m.host_id, m.creator_id) AS "hostId",
             m.livekit_room AS "livekitRoom",
             m.created_at AS "createdAt", m.ended_at AS "endedAt",
             m.duration_sec AS "durationSec", m.is_recorded AS "isRecorded",
             m.senti_status AS "sentiStatus", m.summary,
             m.scheduled_start AS "scheduledStart", m.is_public AS "isPublic",
             m.waiting_room_enabled AS "waitingRoomEnabled",
             m.mute_on_entry AS "muteOnEntry",
             json_build_object('id', u.id, 'name', u.name, 'avatarUrl', u.avatar_url) AS creator,
             (
               SELECT json_agg(json_build_object(
                 'userId', p.id, 'name', p.name, 'avatarUrl', p.avatar_url, 'joinedAt', mp2.joined_at
               ))
               FROM meeting_participants mp2
               JOIN users p ON p.id = mp2.user_id
               WHERE mp2.meeting_id = m.id
             ) AS participants
           FROM meetings m
           JOIN users u ON u.id = m.creator_id
           WHERE m.creator_id = $1
              OR m.id IN (SELECT meeting_id FROM meeting_participants WHERE user_id = $1)
           ORDER BY m.created_at DESC
           LIMIT 50`,
          [user.sub],
        )
      )

      const meetings = result.rows
      await Promise.all(
        meetings.map(async (m: any) => {
          if (!m.endedAt) {
            m.participants = await getActiveParticipants(m.livekitRoom)
          }
        })
      )

      return reply.send({ data: meetings })
    })

    // POST /api/meetings
    app.post('/', async (request, reply) => {
      const user = request.user as { sub: string; name: string }
      const body = CreateMeetingSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })
      }

      // Enforce active meetings limit for this user before creation
      const activeCount = await pool.query(
        "SELECT COUNT(*) FROM meetings WHERE ended_at IS NULL AND creator_id = $1",
        [user.sub],
      )
      if (Number(activeCount.rows[0].count) >= MAX_ACTIVE_MEETINGS) {
        return reply.status(429).send({
          error: {
            code: 'LIMIT_EXCEEDED',
            message: `Превышен лимит активных встреч. У вас может быть не более ${MAX_ACTIVE_MEETINGS} активных встреч одновременно.`,
          },
        })
      }

      // Run guest and inactive room cleanup in the background asynchronously
      runThrottledCleanup()

      const { title, scheduledStart, isPublic, waitingRoomEnabled } = body.data
      const roomName = `centras-${randomUUID()}`
      const result = await pool.query(
        `INSERT INTO meetings (title, creator_id, host_id, livekit_room, scheduled_start, is_public, waiting_room_enabled)
         VALUES ($1, $2, $2, $3, $4, $5, $6)
         RETURNING id, title, creator_id AS "creatorId", host_id AS "hostId", livekit_room AS "livekitRoom", created_at AS "createdAt", scheduled_start AS "scheduledStart", is_public AS "isPublic", waiting_room_enabled AS "waitingRoomEnabled", is_recorded AS "isRecorded", senti_status AS "sentiStatus"`,
        [title, user.sub, roomName, scheduledStart ? new Date(scheduledStart) : null, isPublic ?? false, waitingRoomEnabled ?? false],
      )

      const meeting = result.rows[0]

      // Auto-add creator as participant
      await pool.query(
        'INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [meeting.id, user.sub],
      )

      return reply.status(201).send({ data: meeting })
    })

    // GET /api/meetings/:id
    app.get('/:id', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }

      const allowed = await assertParticipant(id, user.sub)
      if (!allowed) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } })
      }

      // Run guest and inactive room cleanup in the background asynchronously
      runThrottledCleanup()

      const result = await runWithUser(user.sub, (client) =>
        client.query(
          `SELECT
             m.id, m.title, m.creator_id AS "creatorId",
             COALESCE(m.host_id, m.creator_id) AS "hostId",
             m.livekit_room AS "livekitRoom",
             m.created_at AS "createdAt", m.ended_at AS "endedAt",
             m.duration_sec AS "durationSec", m.is_recorded AS "isRecorded",
             m.senti_status AS "sentiStatus", m.summary,
             m.scheduled_start AS "scheduledStart", m.is_public AS "isPublic",
             m.waiting_room_enabled AS "waitingRoomEnabled",
             m.mute_on_entry AS "muteOnEntry",
             json_build_object('id', u.id, 'name', u.name, 'avatarUrl', u.avatar_url) AS creator,
             (
               SELECT json_agg(json_build_object(
                 'userId', p.id, 'name', p.name, 'avatarUrl', p.avatar_url, 'joinedAt', mp.joined_at
               ))
               FROM meeting_participants mp
               JOIN users p ON p.id = mp.user_id
               WHERE mp.meeting_id = m.id
             ) AS participants
           FROM meetings m
           JOIN users u ON u.id = m.creator_id
           WHERE m.id = $1`,
          [id],
        )
      )

      if (!result.rows[0]) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
      }

      const m = result.rows[0]
      if (m && !m.endedAt) {
        m.participants = await getActiveParticipants(m.livekitRoom)
      }

      return reply.send({ data: m })
    })

    // POST /api/meetings/:id/join — record participant join
    app.post('/:id/join', async (request, reply) => {
      const user = request.user as { sub: string; email?: string }
      const { id } = request.params as { id: string }

      const meetingResult = await pool.query(
        'SELECT id, creator_id, COALESCE(host_id, creator_id) AS host_id, ended_at, is_public AS "isPublic", waiting_room_enabled AS "waitingRoomEnabled" FROM meetings WHERE id = $1',
        [id]
      )
      const meeting = meetingResult.rows[0]
      if (!meeting) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
      }
      if (meeting.ended_at) {
        return reply.status(400).send({ error: { code: 'MEETING_ENDED', message: 'Meeting has ended' } })
      }

      const isGuest = user.email?.endsWith('@guest.centras-echo.local') ?? false
      if (!meeting.isPublic && isGuest) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Гостям запрещен доступ к приватным встречам' } })
      }

      const isHost = meeting.host_id === user.sub
      if (meeting.waitingRoomEnabled && !isHost) {
        const waitResult = await pool.query(
          'SELECT status FROM meeting_waiting_room WHERE meeting_id = $1 AND user_id = $2',
          [id, user.sub]
        )
        const status = waitResult.rows[0]?.status
        if (status !== 'admitted') {
          return reply.status(403).send({ error: { code: 'WAITING_ROOM', message: 'Вы должны быть одобрены организатором для входа' } })
        }
      }

      await pool.query(
        'INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, user.sub],
      )

      return reply.send({ data: { joined: true } })
    })

    // PATCH /api/meetings/:id/mute-on-entry — host-only toggle for "new joiners muted"
    app.patch('/:id/mute-on-entry', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }
      const body = request.body as { enabled?: boolean }
      if (typeof body?.enabled !== 'boolean') {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'enabled (boolean) is required' } })
      }

      const meeting = await pool.query('SELECT COALESCE(host_id, creator_id) AS host_id FROM meetings WHERE id = $1', [id])
      if (!meeting.rows[0]) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
      }
      if (meeting.rows[0].host_id !== user.sub) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Host only' } })
      }

      await pool.query('UPDATE meetings SET mute_on_entry = $1 WHERE id = $2', [body.enabled, id])
      return reply.send({ data: { muteOnEntry: body.enabled } })
    })

    // POST /api/meetings/:id/transfer-host — current host transfers the role to another participant
    app.post('/:id/transfer-host', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }
      const body = request.body as { newHostId?: string }
      if (!body?.newHostId || typeof body.newHostId !== 'string') {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'newHostId is required' } })
      }
      if (body.newHostId === user.sub) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Already host' } })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const meeting = await client.query(
          'SELECT COALESCE(host_id, creator_id) AS host_id FROM meetings WHERE id = $1 AND ended_at IS NULL FOR UPDATE',
          [id],
        )
        if (!meeting.rows[0]) {
          await client.query('ROLLBACK')
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Active meeting not found' } })
        }
        if (meeting.rows[0].host_id !== user.sub) {
          await client.query('ROLLBACK')
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only the current host can transfer the role' } })
        }

        const participant = await client.query(
          'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
          [id, body.newHostId],
        )
        if (!participant.rows[0]) {
          await client.query('ROLLBACK')
          return reply.status(400).send({ error: { code: 'NOT_PARTICIPANT', message: 'New host must already be a participant' } })
        }

        await client.query('UPDATE meetings SET host_id = $1 WHERE id = $2', [body.newHostId, id])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      return reply.send({ data: { hostId: body.newHostId } })
    })

    // POST /api/meetings/:id/end — host or participant ends the meeting
    app.post('/:id/end', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }

      const allowed = await assertParticipant(id, user.sub)
      if (!allowed) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } })
      }

      const meeting = await pool.query(
        'SELECT COALESCE(host_id, creator_id) AS host_id, created_at, livekit_room FROM meetings WHERE id = $1 AND ended_at IS NULL',
        [id],
      )

      if (!meeting.rows[0]) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Active meeting not found' } })
      }
      if (meeting.rows[0].host_id !== user.sub) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only host can end meeting' } })
      }

      const durationSec = Math.floor((Date.now() - new Date(meeting.rows[0].created_at).getTime()) / 1000)

      await pool.query(
        'UPDATE meetings SET ended_at = NOW(), duration_sec = $1 WHERE id = $2',
        [durationSec, id],
      )

      // Forcefully disconnect all participants from LiveKit
      try {
        await getLkClient().deleteRoom(meeting.rows[0].livekit_room)
      } catch (err) {
        request.log.warn({ err, livekit_room: meeting.rows[0].livekit_room }, 'Failed to delete LiveKit room on end')
      }

      // Run guest and inactive room cleanup in the background
      runThrottledCleanup()

      return reply.send({ data: { ended: true, durationSec } })
    })

    // GET /api/meetings/:id/transcript
    app.get('/:id/transcript', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }

      const allowed = await assertParticipant(id, user.sub)
      if (!allowed) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } })
      }

      const result = await pool.query(
        `SELECT id, speaker_name AS "speakerName", phrase, start_sec AS "startSec", end_sec AS "endSec"
         FROM meeting_transcripts
         WHERE meeting_id = $1
         ORDER BY start_sec ASC`,
        [id],
      )

      return reply.send({ data: result.rows })
    })

    // GET /api/meetings/:id/search — full-text search in transcript
    app.get('/:id/search', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }
      const { q } = request.query as { q?: string }

      if (!q || q.trim().length < 2) {
        return reply.status(400).send({ error: { code: 'INVALID_QUERY', message: 'Query must be at least 2 chars' } })
      }

      const allowed = await assertParticipant(id, user.sub)
      if (!allowed) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } })
      }

      const result = await pool.query(
        `SELECT id, speaker_name AS "speakerName", phrase, start_sec AS "startSec",
                ts_rank(phrase_tsv, query) AS rank
         FROM meeting_transcripts, plainto_tsquery('russian', $2) query
         WHERE meeting_id = $1 AND phrase_tsv @@ query
         ORDER BY rank DESC, start_sec ASC
         LIMIT 20`,
        [id, q],
      )

      return reply.send({ data: result.rows })
    })

    // POST /api/meetings/:id/upload — upload offline recording
    app.post('/:id/upload', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }

      const allowed = await assertParticipant(id, user.sub)
      if (!allowed) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } })
      }

      const fileData = await request.file()
      if (!fileData) {
        return reply.status(400).send({ error: { code: 'NO_FILE', message: 'No file uploaded' } })
      }

      const allowedMimeTypes = ['audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4', 'video/webm']
      const allowedExtensions = ['.mp3', '.webm', '.ogg', '.wav', '.aac', '.m4a', '.mp4']
      const ext = fileData.filename.slice(fileData.filename.lastIndexOf('.')).toLowerCase()

      if (!allowedMimeTypes.includes(fileData.mimetype) && !allowedExtensions.includes(ext)) {
        return reply.status(400).send({ error: { code: 'INVALID_FORMAT', message: 'Unsupported audio format. Supported formats: MP3, WebM, Ogg, WAV, AAC, M4A' } })
      }

      const audioPath = `/data/audio/${id}${ext}`
      
      // Ensure directory exists
      const fs = await import('fs')
      const { pipeline } = await import('stream/promises')
      const { dirname } = await import('path')
      
      try {
        fs.mkdirSync(dirname(audioPath), { recursive: true })
        await pipeline(fileData.file, fs.createWriteStream(audioPath))
      } catch (err: any) {
        return reply.status(500).send({ error: { code: 'UPLOAD_FAILED', message: err.message } })
      }

      // Set meeting status to processing
      await pool.query(
        "UPDATE meetings SET senti_status = 'processing' WHERE id = $1",
        [id],
      )

      // Trigger AI pipeline (non-blocking)
      import('../services/gemini.js').then(({ runSentiPipeline }) => {
        runSentiPipeline(id, audioPath).catch((err) => {
          app.log.error({ err, meetingId: id }, 'Senti pipeline failed')
          pool.query("UPDATE meetings SET senti_status = 'failed' WHERE id = $1", [id])
        })
      })

      return reply.send({ data: { success: true, sentiStatus: 'processing' } })
    })

    // POST /api/meetings/translate — translate text via Google Translate proxy
    app.post('/translate', async (request, reply) => {
      const { text, srcLang, dstLang } = request.body as { text: string; srcLang: string; dstLang: string }
      if (!text) {
        return reply.status(400).send({ error: { code: 'MISSING_TEXT', message: 'text is required' } })
      }

      const sl = srcLang || 'auto'
      const tl = dstLang || 'en'

      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error('Google Translate API error')
        }
        const json = await res.json() as any
        const translated = json[0].map((item: any) => item[0]).join('')
        return reply.send({ data: { translated } })
      } catch (err: any) {
        return reply.status(500).send({ error: { code: 'TRANSLATION_FAILED', message: err.message } })
      }
    })

    // ─── Waiting Room Routes ────────────────────────────────────────────────
    
    app.get('/:id/waiting-room/status', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }

      const meetingRes = await pool.query(
        'SELECT COALESCE(host_id, creator_id) AS host_id, waiting_room_enabled FROM meetings WHERE id = $1',
        [id]
      )
      const meeting = meetingRes.rows[0]
      if (!meeting) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
      }

      if (meeting.host_id === user.sub || !meeting.waiting_room_enabled) {
        return reply.send({ data: { status: 'admitted' } })
      }

      const participantCheck = await pool.query(
        'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
        [id, user.sub]
      )
      if (participantCheck.rows.length > 0) {
        return reply.send({ data: { status: 'admitted' } })
      }

      const waitingRes = await pool.query(
        'SELECT status FROM meeting_waiting_room WHERE meeting_id = $1 AND user_id = $2',
        [id, user.sub]
      )
      
      if (waitingRes.rows.length === 0) {
        return reply.send({ data: { status: 'none' } })
      }

      return reply.send({ data: { status: waitingRes.rows[0].status } })
    })

    app.post('/:id/waiting-room/join', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }

      const meetingRes = await pool.query('SELECT COALESCE(host_id, creator_id) AS host_id, waiting_room_enabled FROM meetings WHERE id = $1', [id])
      if (!meetingRes.rows[0]) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
      }

      if (!meetingRes.rows[0].waiting_room_enabled || meetingRes.rows[0].host_id === user.sub) {
        await pool.query(
          'INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, user.sub]
        )
        return reply.send({ data: { status: 'admitted' } })
      }

      await pool.query(
        `INSERT INTO meeting_waiting_room (meeting_id, user_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = 'pending'`,
        [id, user.sub]
      )

      return reply.send({ data: { status: 'pending' } })
    })

    app.get('/:id/waiting-room', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id } = request.params as { id: string }

      const meetingRes = await pool.query('SELECT COALESCE(host_id, creator_id) AS host_id FROM meetings WHERE id = $1', [id])
      if (!meetingRes.rows[0]) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
      }

      if (meetingRes.rows[0].host_id !== user.sub) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only the host can view the waiting room' } })
      }

      const result = await pool.query(
        `SELECT wr.id, wr.user_id AS "userId", wr.status, wr.created_at AS "createdAt",
                u.name, u.avatar_url AS "avatarUrl", u.email
         FROM meeting_waiting_room wr
         JOIN users u ON u.id = wr.user_id
         WHERE wr.meeting_id = $1 AND wr.status = 'pending'
         ORDER BY wr.created_at ASC`,
        [id]
      )

      return reply.send({ data: result.rows })
    })

    app.post('/:id/waiting-room/:userId/admit', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id, userId } = request.params as { id: string; userId: string }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const meetingRes = await client.query(
          'SELECT COALESCE(host_id, creator_id) AS host_id FROM meetings WHERE id = $1 FOR UPDATE',
          [id]
        )
        if (!meetingRes.rows[0]) {
          await client.query('ROLLBACK')
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
        }
        if (meetingRes.rows[0].host_id !== user.sub) {
          await client.query('ROLLBACK')
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only the host can admit users' } })
        }

        await client.query(
          "UPDATE meeting_waiting_room SET status = 'admitted' WHERE meeting_id = $1 AND user_id = $2",
          [id, userId]
        )
        await client.query(
          'INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, userId]
        )

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      return reply.send({ data: { admitted: true } })
    })

    app.post('/:id/waiting-room/:userId/reject', async (request, reply) => {
      const user = request.user as { sub: string }
      const { id, userId } = request.params as { id: string; userId: string }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const meetingRes = await client.query(
          'SELECT COALESCE(host_id, creator_id) AS host_id FROM meetings WHERE id = $1 FOR UPDATE',
          [id]
        )
        if (!meetingRes.rows[0]) {
          await client.query('ROLLBACK')
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } })
        }
        if (meetingRes.rows[0].host_id !== user.sub) {
          await client.query('ROLLBACK')
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only the host can reject users' } })
        }

        await client.query(
          "UPDATE meeting_waiting_room SET status = 'rejected' WHERE meeting_id = $1 AND user_id = $2",
          [id, userId]
        )
        await client.query(
          'DELETE FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
          [id, userId]
        )

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      return reply.send({ data: { rejected: true } })
    })
  })
}
