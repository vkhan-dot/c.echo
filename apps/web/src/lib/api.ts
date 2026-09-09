import type { ApiResult, Meeting, User, ConsentStatus, SentiChatResponse, LiveKitTokenResponse } from '@centras/shared'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// ─── Token management ─────────────────────────────────────────────────────────

function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return sessionStorage.getItem('centras_access')
}

function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('centras_refresh')
}

function setTokens(access: string, refresh: string): void {
  sessionStorage.setItem('centras_access', access)
  localStorage.setItem('centras_refresh', refresh)
  if (typeof window !== 'undefined') {
    document.cookie = `centras_access=${access}; path=/; max-age=900; SameSite=Lax; Secure`
  }
}

function clearTokens(): void {
  sessionStorage.removeItem('centras_access')
  localStorage.removeItem('centras_refresh')
  if (typeof window !== 'undefined') {
    document.cookie = 'centras_access=; path=/; max-age=0; SameSite=Lax; Secure'
  }
}

// ─── Core fetch with auto-refresh ────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit & { skipRedirect?: boolean } = {},
  retry = true,
): Promise<ApiResult<T>> {
  const { skipRedirect = false, ...fetchOptions } = options
  const token = getAccessToken()
  const refreshToken = getRefreshToken()

  // Prevent sending requests that are guaranteed to return 401 when no credentials exist
  if (!token && !refreshToken) {
    const isPublic = path.includes('/public-info') || path.includes('/login') || path.includes('/guest') || path.includes('/google') || path.includes('/refresh')
    if (!isPublic) {
      return { error: { code: 'UNAUTHORIZED', message: 'No credentials' } }
    }
  }

  const headers: Record<string, string> = {}
  if (fetchOptions.body !== undefined && !(fetchOptions.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  Object.assign(headers, fetchOptions.headers)

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...fetchOptions, headers })

  // Auto-refresh on 401
  if (res.status === 401 && retry) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      return apiFetch<T>(path, options, false)
    }
    // Refresh failed — redirect to login
    clearTokens()
    if (!skipRedirect) {
      window.location.href = '/login'
    }
    return { error: { code: 'UNAUTHORIZED', message: 'Session expired' } }
  }

  const data = await res.json()
  return data as ApiResult<T>
}

let activeRefreshPromise: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  if (activeRefreshPromise) {
    return activeRefreshPromise
  }

  activeRefreshPromise = (async () => {
    const refreshToken = getRefreshToken()
    if (!refreshToken) return false

    try {
      const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })

      if (!res.ok) return false

      const data = await res.json()
      if (data.data?.accessToken) {
        setTokens(data.data.accessToken, data.data.refreshToken)
        return true
      }
    } catch {
      return false
    } finally {
      activeRefreshPromise = null
    }

    return false
  })()

  return activeRefreshPromise
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  me: (options?: RequestInit & { skipRedirect?: boolean }) => apiFetch<User>('/api/auth/me', options),
  logout: async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    clearTokens()
    window.location.href = '/login'
  },
  googleLoginUrl: () => `${BASE_URL}/api/auth/google`,
  guestLogin: async (name: string) => {
    const res = await apiFetch<{ accessToken: string; refreshToken: string; user: User }>('/api/auth/guest', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    if ('data' in res && res.data) {
      setTokens(res.data.accessToken, res.data.refreshToken)
    }
    return res
  },
}

// ─── Meetings ─────────────────────────────────────────────────────────────────

export const meetingsApi = {
  list: () => apiFetch<Meeting[]>('/api/meetings'),

  get: (id: string) => apiFetch<Meeting>(`/api/meetings/${id}`),

  getPublicInfo: (id: string) =>
    apiFetch<{ id: string; title: string; scheduledStart: string | null; isPublic: boolean; creatorName: string }>(`/api/meetings/${id}/public-info`),

  create: (title: string, scheduledStart?: string | null, isPublic?: boolean, waitingRoomEnabled?: boolean) =>
    apiFetch<Meeting>('/api/meetings', {
      method: 'POST',
      body: JSON.stringify({ title, scheduledStart, isPublic, waitingRoomEnabled }),
    }),

  end: (id: string) =>
    apiFetch<{ ended: boolean }>(`/api/meetings/${id}/end`, { method: 'POST' }),

  join: (id: string) =>
    apiFetch<{ joined: boolean }>(`/api/meetings/${id}/join`, { method: 'POST' }),

  getTranscript: (id: string) =>
    apiFetch<Array<{ id: string; speakerName: string; phrase: string; startSec: number }>>(`/api/meetings/${id}/transcript`),

  search: (id: string, q: string) =>
    apiFetch<Array<{ id: string; speakerName: string; phrase: string; startSec: number }>>(`/api/meetings/${id}/search?q=${encodeURIComponent(q)}`),

  uploadAudio: (id: string, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return apiFetch<{ success: boolean; sentiStatus: string }>(`/api/meetings/${id}/upload`, {
      method: 'POST',
      body: formData,
    })
  },

  getWaitingStatus: (id: string) =>
    apiFetch<{ status: 'admitted' | 'pending' | 'rejected' | 'none' }>(`/api/meetings/${id}/waiting-room/status`),

  joinWaitingRoom: (id: string) =>
    apiFetch<{ status: 'admitted' | 'pending' }>(`/api/meetings/${id}/waiting-room/join`, { method: 'POST' }),

  getWaitingList: (id: string) =>
    apiFetch<Array<{ userId: string; name: string; email: string; avatarUrl: string | null }>>(`/api/meetings/${id}/waiting-room`),

  admitUser: (id: string, userId: string) =>
    apiFetch<{ admitted: boolean }>(`/api/meetings/${id}/waiting-room/${userId}/admit`, { method: 'POST' }),

  rejectUser: (id: string, userId: string) =>
    apiFetch<{ rejected: boolean }>(`/api/meetings/${id}/waiting-room/${userId}/reject`, { method: 'POST' }),

  setMuteOnEntry: (id: string, enabled: boolean) =>
    apiFetch<{ muteOnEntry: boolean }>(`/api/meetings/${id}/mute-on-entry`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  transferHost: (id: string, newHostId: string) =>
    apiFetch<{ hostId: string }>(`/api/meetings/${id}/transfer-host`, {
      method: 'POST',
      body: JSON.stringify({ newHostId }),
    }),

  translate: (text: string, srcLang: string, dstLang: string) =>
    apiFetch<{ translated: string }>('/api/meetings/translate', {
      method: 'POST',
      body: JSON.stringify({ text, srcLang, dstLang }),
    }),
}

// ─── Consent ──────────────────────────────────────────────────────────────────

export const consentApi = {
  give: (meetingId: string) =>
    apiFetch<ConsentStatus>(`/api/meetings/${meetingId}/consent`, { method: 'POST' }),

  revoke: (meetingId: string) =>
    apiFetch<ConsentStatus>(`/api/meetings/${meetingId}/consent`, { method: 'DELETE' }),

  status: (meetingId: string) =>
    apiFetch<ConsentStatus>(`/api/meetings/${meetingId}/consent/status`),
}

// ─── LiveKit ──────────────────────────────────────────────────────────────────

export const livekitApi = {
  token: (meetingId: string) =>
    apiFetch<LiveKitTokenResponse>('/api/livekit/token', {
      method: 'POST',
      body: JSON.stringify({ meetingId }),
    }),

  startRecording: (meetingId: string) =>
    apiFetch<{ recording: boolean }>('/api/livekit/egress/start', {
      method: 'POST',
      body: JSON.stringify({ meetingId }),
    }),

  stopRecording: (meetingId: string) =>
    apiFetch<{ stopped: boolean; sentiStatus: string }>('/api/livekit/egress/stop', {
      method: 'POST',
      body: JSON.stringify({ meetingId }),
    }),
}

// ─── Senti ────────────────────────────────────────────────────────────────────

export const sentiApi = {
  chat: (meetingId: string, question: string, history?: Array<{ role: string; text: string }>) =>
    apiFetch<SentiChatResponse>('/api/senti/chat', {
      method: 'POST',
      body: JSON.stringify({ meetingId, question, history }),
    }),
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export const adminApi = {
  listUsers: () => apiFetch<User[]>('/api/admin/users'),

  createUser: (data: { email: string; name: string; role: 'admin' | 'moderator' | 'employee' }) =>
    apiFetch<User>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateUser: (id: string, data: { name?: string; role?: string }) =>
    apiFetch<User>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteUser: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),

  stats: () => apiFetch<{ totalUsers: number; totalMeetings: number; activeMeetings: number }>('/api/admin/stats'),
}
