'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// This page handles the Google OAuth callback.
// The backend redirects here with tokens in the URL fragment:
//   /auth/callback#access=<token>&refresh=<token>
// We read from the fragment (never sent to server), store tokens,
// then redirect to dashboard.

export default function AuthCallbackPage() {
  const router = useRouter()

  useEffect(() => {
    const fragment = window.location.hash.slice(1) // remove leading #
    const params = new URLSearchParams(fragment)

    const accessToken = params.get('access')
    const refreshToken = params.get('refresh')

    if (!accessToken || !refreshToken) {
      router.replace('/login?error=callback_missing_tokens')
      return
    }

    // Store tokens in sessionStorage (access) and localStorage (refresh)
    sessionStorage.setItem('centras_access', accessToken)
    localStorage.setItem('centras_refresh', refreshToken)
    document.cookie = `centras_access=${accessToken}; path=/; max-age=900; SameSite=Lax; Secure`

    // Clear the fragment from URL immediately (security)
    window.history.replaceState(null, '', '/auth/callback')

    // Redirect to dashboard
    router.replace('/dashboard')
  }, [router])

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100dvh',
      gap: '12px',
      color: 'var(--color-text-muted)',
      fontFamily: 'var(--font-primary)',
    }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"
        style={{ animation: 'spin 0.7s linear infinite' }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeDashoffset="8"/>
      </svg>
      Авторизация...
    </div>
  )
}
