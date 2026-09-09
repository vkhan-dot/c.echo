import type { FastifyPluginAsync } from 'fastify'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { z } from 'zod'
import { pool } from '../db/pool.js'
import { maskPII } from '../services/masking.js'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const ChatSchema = z.object({
  meetingId: z.string().uuid(),
  question: z.string().min(2).max(500),
  history: z.array(z.object({
    role: z.enum(['user', 'senti', 'model']),
    text: z.string(),
  })).optional(),
})

export const sentiRoutes: FastifyPluginAsync = async (app) => {

  app.addHook('onRequest', app.authenticate)

  // POST /api/senti/chat — ask Senti about a meeting
  app.post('/chat', async (request, reply) => {
    const user = request.user as { sub: string }
    const body = ChatSchema.safeParse(request.body)

    if (!body.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } })
    }

    const { meetingId, question, history } = body.data

    // Verify access (participant or creator)
    const access = await pool.query(
      `SELECT 1 FROM meetings m
       LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = $2
       WHERE m.id = $1 AND (m.creator_id = $2 OR mp.user_id IS NOT NULL)`,
      [meetingId, user.sub],
    )
    if (!access.rows[0]) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } })
    }

    // Verify Senti protocol is available
    const meeting = await pool.query(
      "SELECT senti_status, summary FROM meetings WHERE id = $1",
      [meetingId],
    )
    if (!meeting.rows[0] || meeting.rows[0].senti_status !== 'done') {
      return reply.status(400).send({
        error: { code: 'SENTI_NOT_READY', message: 'Протокол Senti ещё не готов или не активирован' },
      })
    }

    // Load transcript from DB (no re-upload of audio)
    const transcript = await pool.query(
      `SELECT speaker_name, phrase, start_sec
       FROM meeting_transcripts
       WHERE meeting_id = $1
       ORDER BY start_sec ASC`,
      [meetingId],
    )

    const transcriptText = transcript.rows
      .map((r) => `[${r.start_sec}s] ${r.speaker_name}: ${r.phrase}`)
      .join('\n')

    let historyText = ''
    if (history && history.length > 0) {
      historyText = 'Previous conversation history:\n' + history
        .map((h) => `${h.role === 'user' ? 'User' : 'Senti'}: ${h.text}`)
        .join('\n') + '\n\n'
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })

    const prompt = `You are Senti, the corporate AI secretary for Centras.Echo.
Answer the following question about the meeting transcript strictly based on what was said.
Do not add interpretations or information not present in the transcript.

MEETING TRANSCRIPT:
${transcriptText}

${historyText}QUESTION: ${maskPII(question)}

Respond in JSON:
{
  "answer": "Your precise answer based on the transcript",
  "references": [
    {"speaker": "Name", "sec": 120, "quote": "exact quote from transcript"}
  ]
}
If the question cannot be answered from the transcript, say so clearly in the "answer" field.
Return ONLY valid JSON, no markdown.`

    const result = await model.generateContent(prompt)
    const rawText = result.response.text()

    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return reply.status(500).send({ error: { code: 'AI_ERROR', message: 'Failed to parse Senti response' } })
    }

    let response: { answer: string; references: Array<{ speaker: string; sec: number; quote: string }> }
    try {
      response = JSON.parse(jsonMatch[0])
    } catch {
      return reply.status(500).send({ error: { code: 'AI_ERROR', message: 'Invalid JSON from Senti' } })
    }

    return reply.send({ data: response })
  })
}
