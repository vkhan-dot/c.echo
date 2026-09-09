import type { FastifyPluginAsync } from 'fastify'
import { RoomServiceClient } from 'livekit-server-sdk'
import { pool } from '../db/pool.js'
import type { User } from '@centras/shared'
import { getLiveKitApiUrl, getLiveKitCredentials } from './livekit-config.js'

// Constants enforced at API level
export const MAX_PARTICIPANTS_PER_MEETING = 7
export const MAX_ACTIVE_MEETINGS = 5

let lastCleanupTime = 0

export async function cleanupGuests(): Promise<void> {
  await pool.query(`
    DELETE FROM users
    WHERE email LIKE '%@guest.centras-echo.local'
      AND NOT EXISTS (
        SELECT 1
        FROM meeting_participants mp
        JOIN meetings m ON m.id = mp.meeting_id
        WHERE mp.user_id = users.id
          AND m.ended_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM meeting_waiting_room wr
        JOIN meetings m ON m.id = wr.meeting_id
        WHERE wr.user_id = users.id
          AND m.ended_at IS NULL
      )
  `)
}

export async function runThrottledCleanup(): Promise<void> {
  const now = Date.now()
  if (now - lastCleanupTime < 60000) {
    return
  }
  lastCleanupTime = now

  // Run cleanup asynchronously in the background so it doesn't block critical read API paths
  ;(async () => {
    try {
      await pool.query(
        `UPDATE meetings 
         SET ended_at = created_at + INTERVAL '30 minutes',
             duration_sec = 1800
         WHERE ended_at IS NULL AND created_at < NOW() - INTERVAL '2 hours'`
      )
      await cleanupGuests()
    } catch (err) {
      console.error('Background DB cleanup failed:', err)
    }
  })()
}

export const limitsRoutes: FastifyPluginAsync = async (app) => {

  // Checks used by meetings routes
  app.decorate('checkMeetingLimits', async (meetingId: string, userId: string) => {
    // 1. Check participant count for this meeting
    const participantCount = await getParticipantCount(meetingId)
    if (participantCount >= MAX_PARTICIPANTS_PER_MEETING) {
      return { allowed: false, reason: `Максимум ${MAX_PARTICIPANTS_PER_MEETING} участников на встречу` }
    }

    // 2. Check active meetings count
    const activeCount = await pool.query(
      "SELECT COUNT(*) FROM meetings WHERE ended_at IS NULL AND creator_id = $1",
      [userId],
    )
    if (Number(activeCount.rows[0].count) >= MAX_ACTIVE_MEETINGS) {
      return { allowed: false, reason: `Максимум ${MAX_ACTIVE_MEETINGS} active meetings simultaneously` }
    }

    return { allowed: true, reason: null }
  })
}

// System-wide active meetings check (for global limit)
export async function getActiveCount(): Promise<number> {
  // Trigger cleanup in background without blocking the query response
  await runThrottledCleanup()

  const result = await pool.query(
    "SELECT COUNT(*) FROM meetings WHERE ended_at IS NULL",
  )
  return Number(result.rows[0].count)
}

export async function getParticipantCount(meetingId: string): Promise<number> {
  // 1. Get livekit_room name
  const meetingRes = await pool.query(
    'SELECT livekit_room, ended_at FROM meetings WHERE id = $1',
    [meetingId]
  )
  const meeting = meetingRes.rows[0]
  if (!meeting || meeting.ended_at) {
    return 0
  }

  // 2. Count active participants in LiveKit
  try {
    const { apiKey, apiSecret } = getLiveKitCredentials()
    const client = new RoomServiceClient(getLiveKitApiUrl(), apiKey, apiSecret)
    const participants = await client.listParticipants(meeting.livekit_room)
    return participants.length
  } catch (err) {
    // If room doesn't exist yet or connection fails, default to 0
    return 0
  }
}

