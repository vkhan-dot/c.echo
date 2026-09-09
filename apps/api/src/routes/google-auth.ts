import type { FastifyPluginAsync } from 'fastify'
import { pool } from '../db/pool.js'

// Google OAuth2 flow:
// 1. Frontend redirects to GET /api/auth/google
// 2. Google redirects to GET /api/auth/google/callback?code=...
// 3. We exchange code for tokens, get user profile
// 4. Find or update user in DB (must be pre-created by admin)
// 5. Issue our JWT and redirect to frontend

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

interface GoogleUserInfo {
  sub: string
  email: string
  name: string
  picture?: string
  email_verified: boolean
}

export const googleAuthRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/auth/google — redirect to Google OAuth consent screen
  app.get('/google', async (request, reply) => {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
    })

    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  })

  // GET /api/auth/google/callback — Google redirects here after consent
  app.get('/google/callback', async (request, reply) => {
    const { code, error } = request.query as { code?: string; error?: string }

    if (error || !code) {
      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'
      return reply.redirect(`${frontendUrl}/login?error=google_denied`)
    }

    // Exchange authorization code for access token
    let googleTokens: { access_token: string }
    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
          grant_type: 'authorization_code',
        }),
      })
      googleTokens = await tokenRes.json() as { access_token: string }
    } catch (err) {
      app.log.error(err, 'Google OAuth token exchange failed')
      return reply.redirect(`${process.env.FRONTEND_URL}/login?error=google_token_failed`)
    }

    // Fetch user profile from Google
    let googleUser: GoogleUserInfo
    try {
      const userRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${googleTokens.access_token}` },
      })
      googleUser = await userRes.json() as GoogleUserInfo
    } catch (err) {
      app.log.error(err, 'Google OAuth profile fetch failed')
      return reply.redirect(`${process.env.FRONTEND_URL}/login?error=google_profile_failed`)
    }

    if (!googleUser.email_verified) {
      return reply.redirect(`${process.env.FRONTEND_URL}/login?error=email_not_verified`)
    }

    // Look up user in our DB by email (must be pre-created by admin)
    const existing = await pool.query(
      `SELECT id, email, name, role, avatar_url, google_id
       FROM users WHERE email = $1`,
      [googleUser.email.toLowerCase()],
    )

    let user = existing.rows[0]

    if (!user) {
      // Check if DB has any users. If 0, bootstrap the first user as admin
      const countRes = await pool.query('SELECT COUNT(*) FROM users')
      const totalUsers = Number(countRes.rows[0].count)
      if (totalUsers === 0) {
        const insertRes = await pool.query(
          `INSERT INTO users (email, name, role, google_id, avatar_url)
           VALUES ($1, $2, 'admin', $3, $4)
           RETURNING id, email, name, role, avatar_url, google_id`,
          [googleUser.email.toLowerCase(), googleUser.name, googleUser.sub, googleUser.picture ?? null]
        )
        user = insertRes.rows[0]
      } else {
        const allowedDomainsStr = process.env.ALLOWED_DOMAINS ?? ''
        const allowedDomains = allowedDomainsStr.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
        const emailDomain = googleUser.email.split('@')[1]?.toLowerCase()
        const isAllowedDomain = emailDomain ? allowedDomains.includes(emailDomain) : false

        if (isAllowedDomain) {
          const insertRes = await pool.query(
            `INSERT INTO users (email, name, role, google_id, avatar_url)
             VALUES ($1, $2, 'employee', $3, $4)
             RETURNING id, email, name, role, avatar_url, google_id`,
            [googleUser.email.toLowerCase(), googleUser.name, googleUser.sub, googleUser.picture ?? null]
          )
          user = insertRes.rows[0]
        } else {
          // User not found — they must be invited by admin first
          return reply.redirect(`${process.env.FRONTEND_URL}/login?error=not_invited`)
        }
      }
    }

    // Link Google account on first SSO login (store google_id)
    if (!user.google_id) {
      await pool.query(
        'UPDATE users SET google_id = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3',
        [googleUser.sub, googleUser.picture ?? null, user.id],
      )
    }

    // Issue our JWT tokens
    const accessToken = app.jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role },
      { expiresIn: '15m' },
    )
    const refreshToken = app.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: '7d' },
    )

    // Redirect to frontend with tokens in URL fragment (never in query params)
    // Frontend reads from fragment and stores in memory / httpOnly cookie
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'
    return reply.redirect(
      `${frontendUrl}/auth/callback#access=${accessToken}&refresh=${refreshToken}`,
    )
  })
}
