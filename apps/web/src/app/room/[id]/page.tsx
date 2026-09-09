'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  LiveKitRoom,
  useParticipants,
  useLocalParticipant,
  useRoomContext,
  RoomAudioRenderer,
  ParticipantTile,
  useTracks,
  useParticipantContext,
} from '@livekit/components-react'
import '@livekit/components-styles'
import { Track, RoomEvent, ConnectionQuality, ParticipantEvent } from 'livekit-client'
import {
  Mic, MicOff, Video, VideoOff, Monitor, Users,
  PhoneOff, Bot, Shield, CheckCircle2, XCircle,
  Circle, StopCircle, X, LogOut, MessageSquare, Send,
  Globe, Copy, Check, Calendar, Lock, Hand, Smile, VolumeX,
  LayoutGrid, User as UserIcon, MoreHorizontal, Settings
} from 'lucide-react'
import { livekitApi, meetingsApi, consentApi, authApi } from '@/lib/api'
import type { Meeting, User, ConsentStatus } from '@centras/shared'
import styles from './room.module.css'
import { Logo, LogoIcon } from '@/components/Logo'

type TrackRefLike = ReturnType<typeof useTracks>[number]
const forceLiveKitRelay = process.env.NEXT_PUBLIC_LIVEKIT_FORCE_RELAY === 'true'

function removeReplacedPlaceholders(tracks: TrackRefLike[]) {
  const publishedKeys = new Set(
    tracks
      .filter((track) => track.publication)
      .map((track) => `${track.participant.identity}:${track.source}`),
  )

  return tracks.filter((track) => (
    track.publication || !publishedKeys.has(`${track.participant.identity}:${track.source}`)
  ))
}

// ─── Connection Quality Indicator Component ───────────────────────────────────

function ConnectionQualityBar({ participant }: { participant: any }) {
  const [quality, setQuality] = useState<ConnectionQuality>(participant.connectionQuality)

  useEffect(() => {
    const handleQualityChanged = (q: ConnectionQuality) => {
      setQuality(q)
    }
    participant.on(ParticipantEvent.ConnectionQualityChanged, handleQualityChanged)
    setQuality(participant.connectionQuality)
    return () => {
      participant.off(ParticipantEvent.ConnectionQualityChanged, handleQualityChanged)
    }
  }, [participant])

  let color = 'rgba(255, 255, 255, 0.2)'
  let bars = 0
  let label = 'Неизвестно'

  if (quality === ConnectionQuality.Excellent) {
    color = 'var(--color-success)'
    bars = 3
    label = 'Отличное'
  } else if (quality === ConnectionQuality.Good) {
    color = 'var(--color-accent-amber)'
    bars = 2
    label = 'Хорошее'
  } else if (quality === ConnectionQuality.Poor) {
    color = 'var(--color-danger)'
    bars = 1
    label = 'Плохое'
  }

  return (
    <div className={styles.qualityIndicator} title={`Качество связи: ${label}`}>
      <span className={styles.qualityBar} style={{ height: '30%', backgroundColor: bars >= 1 ? color : 'rgba(255,255,255,0.15)' }} />
      <span className={styles.qualityBar} style={{ height: '60%', backgroundColor: bars >= 2 ? color : 'rgba(255,255,255,0.15)' }} />
      <span className={styles.qualityBar} style={{ height: '100%', backgroundColor: bars >= 3 ? color : 'rgba(255,255,255,0.15)' }} />
    </div>
  )
}

// ─── Main page (token fetching layer) ─────────────────────────────────────────

export default function RoomPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [token, setToken] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string>('')
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Guest welcome screen states
  const [showWelcome, setShowWelcome] = useState(false)
  const [publicInfo, setPublicInfo] = useState<{ id: string; title: string; scheduledStart: string | null; isPublic: boolean; creatorName: string } | null>(null)
  const [guestName, setGuestName] = useState('')
  const [loggingInGuest, setLoggingInGuest] = useState(false)
  const [copied, setCopied] = useState(false)

  const [isInWaitingRoom, setIsInWaitingRoom] = useState(false)
  const [isEnded, setIsEnded] = useState(false)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Pre-join state — chosen by the user before connecting to LiveKit.
  const [preJoinDone, setPreJoinDone] = useState(false)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [selectedCamId, setSelectedCamId] = useState<string | undefined>(undefined)
  const [selectedMicId, setSelectedMicId] = useState<string | undefined>(undefined)
  const [initialCamEnabled, setInitialCamEnabled] = useState(true)
  const [initialMicEnabled, setInitialMicEnabled] = useState(true)

  // Hardware status
  const [hasCamera, setHasCamera] = useState(false)
  const [hasMicrophone, setHasMicrophone] = useState(false)

  // Involuntary disconnect & recovery
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const isLeavingRef = useRef(false)
  const livekitConnectOptions = useMemo(() => ({
    autoSubscribe: true,
    peerConnectionTimeout: 45000,
    ...(forceLiveKitRelay
      ? { rtcConfig: { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } }
      : {}),
  }), [])

  // System-level check of camera/mic presence on mount
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        const hasCam = devices.some((d) => d.kind === 'videoinput')
        const hasMic = devices.some((d) => d.kind === 'audioinput')
        setHasCamera(hasCam)
        setHasMicrophone(hasMic)
        if (!hasCam) setInitialCamEnabled(false)
        if (!hasMic) setInitialMicEnabled(false)
      }).catch((err) => {
        console.warn('Enumerate devices on page mount failed, assuming hardware exists:', err)
      })
    } else {
      setHasCamera(false)
      setHasMicrophone(false)
      setInitialCamEnabled(false)
      setInitialMicEnabled(false)
    }
  }, [])

  const init = useCallback(async () => {
    // 1. Try to load authenticated user profile
    const meRes = await authApi.me({ skipRedirect: true })

    if ('error' in meRes) {
      // User is not authenticated. Check if meeting is public
      const pubRes = await meetingsApi.getPublicInfo(id)
      if ('data' in pubRes && pubRes.data && pubRes.data.isPublic) {
        setPublicInfo(pubRes.data)
        setShowWelcome(true)
      } else {
        setError('Для доступа к этой конференции требуется авторизация')
      }
      return
    }

    setShowWelcome(false)

    // Check waiting room status
    const statusRes = await meetingsApi.getWaitingStatus(id)
    if ('data' in statusRes && statusRes.data) {
      const { status } = statusRes.data
      if (status === 'pending') {
        setIsInWaitingRoom(true)
        if (!publicInfo) {
          const pubRes = await meetingsApi.getPublicInfo(id)
          if ('data' in pubRes && pubRes.data) setPublicInfo(pubRes.data)
        }
        return
      } else if (status === 'rejected') {
        setError('Организатор отклонил ваш запрос на вход в эту конференцию')
        return
      } else if (status === 'none') {
        // Request to join waiting room
        const joinRes = await meetingsApi.joinWaitingRoom(id)
        if ('data' in joinRes && joinRes.data) {
          if (joinRes.data.status === 'pending') {
            setIsInWaitingRoom(true)
            if (!publicInfo) {
              const pubRes = await meetingsApi.getPublicInfo(id)
              if ('data' in pubRes && pubRes.data) setPublicInfo(pubRes.data)
            }
            return
          }
        } else {
          setError('Не удалось войти в зал ожидания')
          return
        }
      }
    }

    // 2. User is authenticated (or logged in as guest). Join the meeting first to ensure access in DB.
    const joinRes = await meetingsApi.join(id)
    if ('error' in joinRes) {
      setError(joinRes.error?.message ?? 'Не удалось присоединиться к конференции')
      return
    }

    // 3. Fetch meeting details and LiveKit token.
    const [meetRes, tokenRes] = await Promise.all([
      meetingsApi.get(id),
      livekitApi.token(id),
    ])

    if ('error' in meetRes) {
      setError(meetRes.error?.message ?? 'Встреча не найдена')
      return
    }
    if ('error' in tokenRes) {
      setError(tokenRes.error?.message ?? 'Ошибка подключения')
      return
    }

    setUser(meRes.data)
    setMeeting(meetRes.data)
    setToken(tokenRes.data.token)
    setServerUrl(tokenRes.data.serverUrl)
    setShowWelcome(false)
    setIsInWaitingRoom(false)

    // Apply mute-on-entry: non-host joiners start with mic off.
    if (meetRes.data.muteOnEntry && meetRes.data.creatorId !== meRes.data.id) {
      setInitialMicEnabled(false)
    }
  }, [id, publicInfo])

  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    init()
  }, [id])

  // Poll waiting room status
  useEffect(() => {
    if (!isInWaitingRoom) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      return
    }

    pollIntervalRef.current = setInterval(async () => {
      const res = await meetingsApi.getWaitingStatus(id)
      if ('data' in res && res.data) {
        const { status } = res.data
        if (status === 'admitted') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          setIsInWaitingRoom(false)
          init()
        } else if (status === 'rejected') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          setIsInWaitingRoom(false)
          setError('Организатор отклонил ваш запрос на вход в эту конференцию')
        }
      }
    }, 2000)

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [isInWaitingRoom, id, init])

  const handleGuestJoin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!guestName.trim()) return
    setLoggingInGuest(true)

    const res = await authApi.guestLogin(guestName.trim())
    if ('data' in res && res.data) {
      // Instantly hide welcome screen so the user sees a transition (loading spinner)
      // while init() resolves the actual destination (waiting room / room / error).
      setShowWelcome(false)
      await init()
    } else {
      setError('Не удалось подключиться в качестве гостя')
    }
    setLoggingInGuest(false)
  }

  const handleCopyLink = () => {
    if (typeof window !== 'undefined' && publicInfo) {
      const inviteUrl = window.location.href
      const creatorName = publicInfo.creatorName ?? 'Организатор'
      const dateStr = publicInfo.scheduledStart
        ? new Intl.DateTimeFormat('ru-RU', {
            day: 'numeric',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(publicInfo.scheduledStart))
        : null

      const lines = [
        `${creatorName} приглашает вас на видеоконференцию Centras Echo.`,
        `Тема: ${publicInfo.title}`,
        `Ссылка: ${inviteUrl}`,
        `Доступ: ${publicInfo.isPublic ? 'Публичный (вход без авторизации)' : 'Приватный (требуется авторизация)'}`,
      ]

      if (dateStr) {
        lines.push(`Время: ${dateStr}`)
      }

      navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (error) {
    return (
      <div className={styles.loadingRoom}>
        <XCircle size={48} color="var(--color-danger)" />
        <p style={{ color: 'var(--color-danger)', textAlign: 'center', marginTop: 16 }}>{error}</p>
        <button className="btn btn-ghost" style={{ marginTop: 16 }} onClick={() => router.push('/dashboard')}>
          На главную
        </button>
      </div>
    )
  }

  if (connectionError) {
    return (
      <div className={styles.loadingRoom}>
        <XCircle size={48} color="var(--color-danger)" />
        <h2 style={{ color: 'var(--color-text-primary)', marginTop: 16, fontSize: '1.25rem', fontWeight: 600 }}>
          Соединение прервано
        </h2>
        <p style={{ color: 'var(--color-text-secondary)', textAlign: 'center', marginTop: 8, maxWidth: 420, fontSize: '0.875rem', lineHeight: 1.5 }}>
          {connectionError}
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button className="btn btn-primary" onClick={() => {
            setConnectionError(null)
            setToken(null)
            isLeavingRef.current = false
            init()
          }}>
            Подключиться повторно
          </button>
          <button className="btn btn-ghost" onClick={() => router.push('/dashboard')}>
            На главную
          </button>
        </div>
      </div>
    )
  }

  if (isEnded) {
    return (
      <div className={styles.welcomeLayout}>
        <div className={styles.welcomeCard} style={{ textAlign: 'center', padding: 'var(--space-10) var(--space-8)' }}>
          <div className={styles.welcomeLogo} style={{ marginBottom: 'var(--space-6)' }}>
            <Logo size={42} centered />
          </div>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'var(--color-success-dim)',
            color: 'var(--color-success)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto var(--space-4)'
          }}>
            <CheckCircle2 size={28} />
          </div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 'var(--space-2)' }}>
            Конференция завершена
          </h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9375rem', lineHeight: 1.5, margin: 0 }}>
            Вы успешно вышли из конференции.
            <br />
            Эту вкладку браузера можно закрыть.
          </p>
        </div>
      </div>
    )
  }

  if (showWelcome && publicInfo) {
    return (
      <div className={styles.welcomeLayout}>
        <div className={styles.welcomeCard}>
          <div className={styles.welcomeHeader}>
            <div className={styles.welcomeLogo}>
              <Logo size={42} centered />
            </div>
            <h1 className={styles.welcomeTitle}>Подключение к конференции</h1>
            <p className={styles.welcomeSubtitle}>Centras Echo · Безопасные видеоконференции</p>
          </div>

          <div className={styles.meetingInfoBox}>
            <h2 className={styles.meetingInfoTitle}>{publicInfo.title}</h2>
            
            <div className={styles.meetingInfoRow}>
              <span>Организатор:</span>
              <span style={{ fontWeight: 600 }}>{publicInfo.creatorName ?? 'Система'}</span>
            </div>

            {publicInfo.scheduledStart && (
              <div className={styles.meetingInfoRow}>
                <span>Запланировано на:</span>
                <span>
                  {new Intl.DateTimeFormat('ru-RU', {
                    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
                  }).format(new Date(publicInfo.scheduledStart))}
                </span>
              </div>
            )}

            <div className={styles.meetingInfoRow}>
              <span>Доступ:</span>
              <span style={{ color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Globe size={12} /> Публичный (вход без авторизации)
              </span>
            </div>

            <div style={{
              marginTop: 'var(--space-4)',
              paddingTop: 'var(--space-3)',
              borderTop: '1px solid var(--color-border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6
            }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)', textAlign: 'left' }}>
                Текст приглашения:
              </span>
              <textarea
                className="input-field"
                readOnly
                value={(() => {
                  const url = typeof window !== 'undefined' ? window.location.href : ''
                  const creator = publicInfo.creatorName ?? 'Организатор'
                  const date = publicInfo.scheduledStart
                    ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(publicInfo.scheduledStart))
                    : null
                  return [
                    `${creator} приглашает вас на видеоконференцию Centras Echo.`,
                    `Тема: ${publicInfo.title}`,
                    `Ссылка: ${url}`,
                    `Доступ: ${publicInfo.isPublic ? 'Публичный (вход без авторизации)' : 'Приватный (требуется авторизация)'}`,
                    ...(date ? [`Время: ${date}`] : [])
                  ].join('\n')
                })()}
                style={{
                  fontSize: '0.75rem',
                  fontFamily: 'var(--font-mono)',
                  height: 90,
                  resize: 'none',
                  background: 'var(--color-bg-primary)',
                  color: 'var(--color-text-secondary)',
                  padding: '8px'
                }}
              />
            </div>
          </div>

          <form onSubmit={handleGuestJoin} className={styles.guestForm}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label htmlFor="guest-name" style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                Представьтесь, чтобы войти в комнату:
              </label>
              <input
                id="guest-name"
                className="input-field"
                type="text"
                placeholder="Ваше имя"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                maxLength={60}
                required
                autoFocus
              />
            </div>

            <button
              id="guest-join-btn"
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', padding: '12px', fontSize: '0.9375rem' }}
              disabled={!guestName.trim() || loggingInGuest}
            >
              {loggingInGuest ? 'Подключение…' : 'Присоединиться к конференции'}
            </button>

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleCopyLink}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                {copied ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
                {copied ? 'Приглашение скопировано' : 'Скопировать приглашение'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => router.push('/login')}
                style={{ flex: 1 }}
              >
                Войти через аккаунт
              </button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  if (isInWaitingRoom && publicInfo) {
    return (
      <div className={styles.welcomeLayout}>
        <div className={styles.welcomeCard}>
          <div className={styles.welcomeHeader}>
            <div className={styles.welcomeLogo}>
              <Logo size={42} centered />
            </div>
            <h1 className={styles.welcomeTitle}>Зал ожидания</h1>
            <p className={styles.welcomeSubtitle}>Centras Echo · Контроль доступа</p>
          </div>

          <div className={styles.meetingInfoBox}>
            <h2 className={styles.meetingInfoTitle}>{publicInfo.title}</h2>
            
            <div className={styles.meetingInfoRow}>
              <span>Организатор:</span>
              <span style={{ fontWeight: 600 }}>{publicInfo.creatorName ?? 'Система'}</span>
            </div>

            <div className={styles.meetingInfoRow}>
              <span>Статус:</span>
              <span style={{ color: 'var(--color-accent-amber)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Circle size={10} fill="var(--color-accent-amber)" /> Ожидание одобрения...
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: 'var(--space-4) 0' }}>
            <div className={styles.loadingSpinner} />
            <p style={{ textAlign: 'center', fontSize: '0.875rem', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              Вы в зале ожидания. Пожалуйста, подождите, пока организатор одобрит ваше участие во встрече.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => router.push('/dashboard')}
          >
            Вернуться на главную
          </button>
        </div>
      </div>
    )
  }

  if (!token || !meeting || !user) {
    return (
      <div className={styles.loadingRoom}>
        <div className={styles.loadingSpinner} />
        <p className={styles.loadingText}>Подключение к комнате…</p>
      </div>
    )
  }

  if (isTransitioning) {
    return (
      <div className={styles.loadingRoom}>
        <div className={styles.loadingSpinner} />
        <p className={styles.loadingText}>Подготовка медиа-устройств…</p>
      </div>
    )
  }

  if (!preJoinDone) {
    return (
      <PreJoinScreen
        meetingTitle={meeting.title}
        userName={user.name}
        selectedCamId={selectedCamId}
        selectedMicId={selectedMicId}
        micEnabled={initialMicEnabled}
        camEnabled={initialCamEnabled}
        onCamChange={setSelectedCamId}
        onMicChange={setSelectedMicId}
        onToggleMic={() => setInitialMicEnabled((v) => !v)}
        onToggleCam={() => setInitialCamEnabled((v) => !v)}
        onJoin={async () => {
          setIsTransitioning(true)
          await new Promise((resolve) => setTimeout(resolve, 300))
          setPreJoinDone(true)
          setIsTransitioning(false)
        }}
      />
    )
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect={true}
      video={hasCamera && initialCamEnabled ? (selectedCamId ? { deviceId: selectedCamId } : true) : false}
      audio={hasMicrophone && initialMicEnabled ? (selectedMicId ? { deviceId: selectedMicId } : true) : false}
      connectOptions={livekitConnectOptions}
      onDisconnected={() => {
        const handleLeave = () => {
          const isGuest = user?.email.endsWith('@guest.centras-echo.local')
          if (isGuest) {
            setIsEnded(true)
            sessionStorage.removeItem('centras_access')
            localStorage.removeItem('centras_refresh')
            document.cookie = 'centras_access=; path=/; max-age=0; SameSite=Lax; Secure'
          } else {
            router.push('/dashboard')
          }
        }

        if (isLeavingRef.current) {
          handleLeave()
          return
        }

        // Involuntary disconnect — check if meeting ended or show error
        meetingsApi.get(id).then((res) => {
          if ('data' in res && res.data && res.data.endedAt) {
            handleLeave()
          } else {
            setConnectionError('Соединение с сервером видеоконференций Centras Echo потеряно. Проверьте стабильность интернет-соединения и настройки корпоративного брандмауэра.')
          }
        }).catch(() => {
          setConnectionError('Соединение с сервером видеоконференций Centras Echo потеряно. Проверьте стабильность интернет-соединения и настройки корпоративного брандмауэра.')
        })
      }}
      style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
    >
      <RoomAudioRenderer />
      <RoomInner
        meeting={meeting}
        user={user}
        meetingId={id}
        router={router}
        selectedMicId={selectedMicId}
        onLeave={() => {
          isLeavingRef.current = true
        }}
      />
    </LiveKitRoom>
  )
}

// ─── Participant Hand Overlay Component ──────────────────────────────────────────

function ParticipantHandOverlay({ raisedHands }: { raisedHands: Record<string, boolean> }) {
  const participant = useParticipantContext()
  if (!participant) return null
  const isHandRaised = raisedHands[participant.identity]
  if (!isHandRaised) return null
  return (
    <div className={styles.tileHandRaisedOverlay} title="Поднята рука">
      <span>✋</span>
    </div>
  )
}

// ─── Speaker view (one big tile + thumbnail strip) ────────────────────────────

function GalleryView({ tracks, raisedHands }: { tracks: TrackRefLike[]; raisedHands: Record<string, boolean> }) {
  return (
    <div className={styles.galleryGrid}>
      {tracks.map((trackRef) => (
        <ParticipantTile
          key={`${trackRef.participant.identity}:${trackRef.source}:${trackRef.publication?.trackSid ?? 'placeholder'}`}
          trackRef={trackRef}
          style={{ width: '100%', height: '100%' }}
        >
          <ParticipantHandOverlay raisedHands={raisedHands} />
        </ParticipantTile>
      ))}
    </div>
  )
}

function SpeakerView({ tracks, raisedHands }: { tracks: ReturnType<typeof useTracks>; raisedHands: Record<string, boolean> }) {
  // Pick the focus track: prefer a ScreenShare, otherwise the active speaker, otherwise the first remote camera, otherwise any.
  const screenShare = tracks.find((t) => t.source === Track.Source.ScreenShare)
  const speakingCam = tracks.find(
    (t) => t.source === Track.Source.Camera && (t.participant as any)?.isSpeaking && !t.participant.isLocal,
  )
  const remoteCam = tracks.find((t) => t.source === Track.Source.Camera && !t.participant.isLocal)
  const focus = screenShare ?? speakingCam ?? remoteCam ?? tracks[0]

  const others = tracks.filter((t) => t !== focus && t.source === Track.Source.Camera)

  if (!focus) {
    return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>Нет видео-потоков</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <ParticipantTile trackRef={focus} style={{ width: '100%', height: '100%' }}>
          <ParticipantHandOverlay raisedHands={raisedHands} />
        </ParticipantTile>
      </div>
      {others.length > 0 && (
        <div style={{ display: 'flex', gap: 8, height: 120, flexShrink: 0, overflowX: 'auto', paddingBottom: 4 }}>
          {others.map((t) => (
            <div key={`${t.participant.identity}-${t.source}`} style={{ width: 180, height: '100%', flexShrink: 0, borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              <ParticipantTile trackRef={t} style={{ width: '100%', height: '100%' }}>
                <ParticipantHandOverlay raisedHands={raisedHands} />
              </ParticipantTile>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Pre-join screen (device pick + preview before LiveKit connect) ───────────

interface PreJoinScreenProps {
  meetingTitle: string
  userName: string
  selectedCamId: string | undefined
  selectedMicId: string | undefined
  micEnabled: boolean
  camEnabled: boolean
  onCamChange: (id: string) => void
  onMicChange: (id: string) => void
  onToggleMic: () => void
  onToggleCam: () => void
  onJoin: () => void
}

function PreJoinScreen({
  meetingTitle, userName,
  selectedCamId, selectedMicId,
  micEnabled, camEnabled,
  onCamChange, onMicChange,
  onToggleMic, onToggleCam,
  onJoin,
}: PreJoinScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const [cams, setCams] = useState<MediaDeviceInfo[]>([])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [audioLevel, setAudioLevel] = useState(0)
  const [permissionError, setPermissionError] = useState<string | null>(null)

  // Stop existing preview stream
  const stopStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  // Load initially available hardware devices and match enabled flags to physical hardware
  useEffect(() => {
    const checkDevices = async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
        setCams([])
        setMics([])
        return
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const hasCam = devices.some((d) => d.kind === 'videoinput')
        const hasMic = devices.some((d) => d.kind === 'audioinput')
        
        setCams(devices.filter((d) => d.kind === 'videoinput'))
        setMics(devices.filter((d) => d.kind === 'audioinput'))
        
        // If device is physically absent but enabled, toggle it off to prevent initial fail
        if (!hasCam && camEnabled) {
          onToggleCam()
        }
        if (!hasMic && micEnabled) {
          onToggleMic()
        }
      } catch (e) {
        console.warn('Failed to enumerate devices initially:', e)
      }
    }
    checkDevices()
  }, [])

  // Acquire / re-acquire preview stream when device choices or enable flags change
  useEffect(() => {
    let cancelled = false

    const acquire = async () => {
      stopStream()
      if (!camEnabled && !micEnabled) {
        setAudioLevel(0)
        return
      }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
        setPermissionError('Медиа-устройства не поддерживаются в данном браузере (требуется HTTPS).')
        return
      }
      try {
        const constraints: MediaStreamConstraints = {
          video: camEnabled
            ? (selectedCamId ? { deviceId: { exact: selectedCamId } } : true)
            : false,
          audio: micEnabled
            ? (selectedMicId ? { deviceId: { exact: selectedMicId } } : true)
            : false,
        }
        
        let stream: MediaStream
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints)
        } catch (err: any) {
          // Fallback: if both were requested, try to acquire only audio
          if (constraints.video && constraints.audio) {
            console.warn('Dual getUserMedia failed, retrying audio-only constraints')
            stream = await navigator.mediaDevices.getUserMedia({
              audio: constraints.audio,
              video: false,
            })
            // Gracefully toggle off camera state to match reality
            if (camEnabled) {
              onToggleCam()
            }
          } else {
            throw err
          }
        }
        
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current && camEnabled && stream.getVideoTracks().length > 0) {
          videoRef.current.srcObject = stream
        }

        // Audio level meter
        if (micEnabled && stream.getAudioTracks().length > 0) {
          const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
          const ctx = new AudioCtx()
          audioCtxRef.current = ctx
          const src = ctx.createMediaStreamSource(stream)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 512
          src.connect(analyser)
          const buf = new Uint8Array(analyser.frequencyBinCount)
          const tick = () => {
            analyser.getByteFrequencyData(buf)
            let sum = 0
            for (let i = 0; i < buf.length; i++) sum += buf[i]
            const avg = sum / buf.length / 255
            setAudioLevel(avg)
            rafRef.current = requestAnimationFrame(tick)
          }
          tick()
        }

        // Populate device lists once permission is granted (labels become visible)
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setCams(devices.filter((d) => d.kind === 'videoinput'))
        setMics(devices.filter((d) => d.kind === 'audioinput'))
        setPermissionError(null)
      } catch (err: any) {
        setPermissionError(
          err?.name === 'NotAllowedError'
            ? 'Доступ к камере или микрофону не предоставлен. Разрешите его в браузере и обновите страницу.'
            : 'Не удалось получить доступ к устройствам: ' + (err?.message ?? 'неизвестная ошибка'),
        )
      }
    }

    acquire()

    return () => {
      cancelled = true
      stopStream()
    }
  }, [selectedCamId, selectedMicId, camEnabled, micEnabled, stopStream, onToggleCam, onToggleMic])

  const handleJoin = async () => {
    stopStream()
    // Explicitly wait 250ms to allow iOS Safari to release the audio/video interface hardware
    await new Promise((resolve) => setTimeout(resolve, 250))
    onJoin()
  }

  const levelPct = Math.min(100, Math.round(audioLevel * 180))

  return (
    <div className={styles.welcomeLayout}>
      <div className={styles.welcomeCard} style={{ maxWidth: 560 }}>
        <div className={styles.welcomeHeader}>
          <div className={styles.welcomeLogo}>
            <Logo size={42} centered />
          </div>
          <h1 className={styles.welcomeTitle}>Готовы войти?</h1>
          <p className={styles.welcomeSubtitle}>{meetingTitle} · {userName}</p>
        </div>

        {/* Video preview */}
        <div style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 9',
          background: '#000',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          marginBottom: 'var(--space-4)',
          border: '1px solid var(--color-border)',
        }}>
          {camEnabled ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
              Камера выключена
            </div>
          )}
        </div>

        {permissionError && (
          <div style={{ background: 'var(--color-danger-dim, rgba(229,0,18,0.08))', color: 'var(--color-danger)', padding: '10px 12px', borderRadius: 'var(--radius-md)', fontSize: '0.8125rem', marginBottom: 'var(--space-4)' }}>
            {permissionError}
          </div>
        )}

        {/* Device selectors */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>Камера</span>
            <select
              className="input-field"
              value={selectedCamId ?? ''}
              onChange={(e) => onCamChange(e.target.value || '')}
              disabled={!camEnabled || cams.length === 0}
              style={{ width: '100%' }}
            >
              {cams.length === 0 && <option value="">Устройства не найдены</option>}
              {cams.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Камера ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>Микрофон</span>
            <select
              className="input-field"
              value={selectedMicId ?? ''}
              onChange={(e) => onMicChange(e.target.value || '')}
              disabled={!micEnabled || mics.length === 0}
              style={{ width: '100%' }}
            >
              {mics.length === 0 && <option value="">Устройства не найдены</option>}
              {mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Микрофон ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
            {/* Audio level meter */}
            <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
              <div style={{
                height: '100%',
                width: `${levelPct}%`,
                background: levelPct > 60 ? 'var(--color-success)' : 'var(--color-accent-blue)',
                transition: 'width 60ms linear',
              }} />
            </div>
          </label>
        </div>

        {/* Mic / Cam toggle + Join */}
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <button
            type="button"
            className={`btn btn-ghost`}
            onClick={onToggleMic}
            title={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
            style={{ width: 44, height: 44, padding: 0, justifyContent: 'center' }}
          >
            {micEnabled ? <Mic size={18} /> : <MicOff size={18} color="var(--color-danger)" />}
          </button>
          <button
            type="button"
            className={`btn btn-ghost`}
            onClick={onToggleCam}
            title={camEnabled ? 'Выключить камеру' : 'Включить камеру'}
            style={{ width: 44, height: 44, padding: 0, justifyContent: 'center' }}
          >
            {camEnabled ? <Video size={18} /> : <VideoOff size={18} color="var(--color-danger)" />}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleJoin}
            style={{ flex: 1, padding: '12px', fontSize: '0.9375rem' }}
          >
            Войти в комнату
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Device Settings Modal Component ──────────────────────────────────────────

function DeviceSettingsModal({ room, onClose }: { room: any; onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [activeMic, setActiveMic] = useState<string>('')
  const [activeCam, setActiveCam] = useState<string>('')
  const [activeSpeaker, setActiveSpeaker] = useState<string>('')
  const [loading, setLoading] = useState(true)

  const updateDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list)

      const localMicTrack = room.localParticipant?.getTrackPublication(Track.Source.Microphone)?.track
      const localCamTrack = room.localParticipant?.getTrackPublication(Track.Source.Camera)?.track

      const currentMicId = localMicTrack?.mediaStreamTrack?.getSettings()?.deviceId || ''
      const currentCamId = localCamTrack?.mediaStreamTrack?.getSettings()?.deviceId || ''
      const currentSpeakerId = room.getActiveDevice('audiooutput') || 'default'

      setActiveMic(currentMicId)
      setActiveCam(currentCamId)
      setActiveSpeaker(currentSpeakerId)
    } catch (e) {
      console.error('Failed to get devices:', e)
    } finally {
      setLoading(false)
    }
  }, [room])

  useEffect(() => {
    updateDevices()
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', updateDevices)
    }
    return () => {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
        navigator.mediaDevices.removeEventListener('devicechange', updateDevices)
      }
    }
  }, [updateDevices])

  const handleMicChange = async (id: string) => {
    setActiveMic(id)
    try {
      await room.switchActiveDevice('audioinput', id)
    } catch (err) {
      console.error('Failed to switch microphone:', err)
    }
  }

  const handleCamChange = async (id: string) => {
    setActiveCam(id)
    try {
      await room.switchActiveDevice('videoinput', id)
    } catch (err) {
      console.error('Failed to switch camera:', err)
    }
  }

  const handleSpeakerChange = async (id: string) => {
    setActiveSpeaker(id)
    try {
      await room.switchActiveDevice('audiooutput', id)
    } catch (err) {
      console.error('Failed to switch speaker:', err)
    }
  }

  const mics = devices.filter((d) => d.kind === 'audioinput')
  const cams = devices.filter((d) => d.kind === 'videoinput')
  const speakers = devices.filter((d) => d.kind === 'audiooutput')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-content ${styles.settingsModal}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.settingsModalHeader}>
          <h3>Настройки устройств</h3>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Закрыть настройки">
            <X size={18} />
          </button>
        </div>
        
        {loading ? (
          <div className={styles.loadingSpinner} />
        ) : (
          <div className={styles.settingsModalBody}>
            <div className={styles.settingsFormGroup}>
              <label htmlFor="select-mic">Микрофон</label>
              <select id="select-mic" value={activeMic} onChange={(e) => handleMicChange(e.target.value)}>
                {mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Микрофон (${d.deviceId.slice(0, 5)})`}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.settingsFormGroup}>
              <label htmlFor="select-cam">Камера</label>
              <select id="select-cam" value={activeCam} onChange={(e) => handleCamChange(e.target.value)}>
                {cams.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Камера (${d.deviceId.slice(0, 5)})`}
                  </option>
                ))}
              </select>
            </div>

            {speakers.length > 0 && (
              <div className={styles.settingsFormGroup}>
                <label htmlFor="select-speaker">Динамик</label>
                <select id="select-speaker" value={activeSpeaker} onChange={(e) => handleSpeakerChange(e.target.value)}>
                  {speakers.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Динамик (${d.deviceId.slice(0, 5)})`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
        
        <div className={styles.settingsModalFooter}>
          <button className="btn btn-primary" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Inner room (has access to LiveKit context) ────────────────────────────────

interface RoomInnerProps {
  meeting: Meeting
  user: User
  meetingId: string
  router: ReturnType<typeof useRouter>
  onLeave: () => void
  selectedMicId?: string
}

interface ChatMessage {
  id: string
  userId: string
  userName: string
  text: string
  timestamp: number
}

function RoomInner({ meeting, user, meetingId, router, onLeave, selectedMicId }: RoomInnerProps) {
  const room = useRoomContext()
  const remoteParticipants = useParticipants().filter((p) => !p.isLocal)
  const { localParticipant } = useLocalParticipant()
  const allParticipants = localParticipant ? [localParticipant, ...remoteParticipants] : remoteParticipants

  // Current host can change at runtime via transfer-host. Keep it as state so all
  // UI gates (isHost, "Организатор" badge, host-only buttons) update reactively.
  const [currentHostId, setCurrentHostId] = useState<string>(meeting.hostId ?? meeting.creatorId)
  const isHost = currentHostId === user.id

  // LiveKit participant.identity === user.id (set in /api/livekit token route).
  const connectedIdentities = new Set(allParticipants.map((p) => p.identity))

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  )
  const visibleTracks = useMemo(() => removeReplacedPlaceholders(tracks), [tracks])

  // UI state
  const [showSenti, setShowSenti] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [roomCopied, setRoomCopied] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)

  // Senti Translate (BETA) states
  const [showTranslate, setShowTranslate] = useState(false)
  const [isTranslateActive, setIsTranslateActive] = useState(false)
  const [translateInputLang, setTranslateInputLang] = useState('auto')
  const [translateTargetLang, setTranslateTargetLang] = useState('ru')
  const [translateHistory, setTranslateHistory] = useState<Array<{
    id: string
    userId: string
    userName: string
    srcLang: string
    srcText: string
    dstLang: string
    dstText: string
    timestamp: number
  }>>([])
  const [activeSubtitle, setActiveSubtitle] = useState<{
    userName: string
    srcLang: string
    srcText: string
    dstLang: string
    dstText: string
  } | null>(null)

  const toggleTranslate = () => {
    setShowTranslate((v) => {
      const next = !v
      if (next) {
        setShowChat(false)
        setShowSenti(false)
        setShowParticipants(false)
        setShowMoreMenu(false)
      }
      return next
    })
  }

  const handleCopyRoomInvite = () => {
    if (typeof window !== 'undefined') {
      const inviteUrl = window.location.href
      const creatorName = (meeting as any).creator?.name ?? (meeting.creatorId === user.id ? user.name : 'Организатор')
      const dateStr = meeting.scheduledStart
        ? new Intl.DateTimeFormat('ru-RU', {
            day: 'numeric',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(meeting.scheduledStart))
        : null

      const lines = [
        `${creatorName} приглашает вас на видеоконференцию Centras Echo.`,
        `Тема: ${meeting.title}`,
        `Ссылка: ${inviteUrl}`,
        `Доступ: ${meeting.isPublic ? 'Публичный (вход без авторизации)' : 'Приватный (требуется авторизация)'}`,
      ]

      if (dateStr) {
        lines.push(`Время: ${dateStr}`)
      }

      navigator.clipboard.writeText(lines.join('\n'))
      setRoomCopied(true)
      setTimeout(() => setRoomCopied(false), 2000)
    }
  }
  const [showParticipants, setShowParticipants] = useState(true)
  const [showConsentModal, setShowConsentModal] = useState(false)
  const [showEndConfirm, setShowEndConfirm] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)

  // Audio playback permission check (browser autoplay policy)
  const [audioPlaybackAllowed, setAudioPlaybackAllowed] = useState(room.canPlaybackAudio)

  useEffect(() => {
    const handleAudioPlaybackChanged = (allowed: boolean) => {
      setAudioPlaybackAllowed(allowed)
    }
    room.on(RoomEvent.AudioPlaybackStatusChanged, handleAudioPlaybackChanged)
    setAudioPlaybackAllowed(room.canPlaybackAudio)
    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, handleAudioPlaybackChanged)
    }
  }, [room])

  // Reactions + Raise Hand states
  const [raisedHands, setRaisedHands] = useState<Record<string, boolean>>({})
  const [floatingReactions, setFloatingReactions] = useState<Array<{ id: string; identity: string; emoji: string }>>([])
  const [showReactionsMenu, setShowReactionsMenu] = useState(false)

  // Video layout
  const [viewMode, setViewMode] = useState<'gallery' | 'speaker'>('gallery')

  // Host moderation state
  const [muteOnEntry, setMuteOnEntry] = useState<boolean>(meeting.muteOnEntry ?? false)
  const [transferTarget, setTransferTarget] = useState<{ identity: string; name: string } | null>(null)

  // Waiting Room state for host
  const [waitingUsers, setWaitingUsers] = useState<any[]>([])
  const prevWaitingCountRef = useRef(0)

  // Noise Suppression state
  const [noiseSuppression, setNoiseSuppression] = useState(false)
  const nsCtxRef = useRef<AudioContext | null>(null)
  const nsOriginalTrackRef = useRef<any>(null)
  const nsPublishedTrackRef = useRef<any>(null)

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const chatBottomRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    const container = chatContainerRef.current
    if (!container) return

    const lastMsg = messages[messages.length - 1]
    const isMyMessage = lastMsg?.userId === localParticipant?.identity
    const threshold = 100
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= threshold

    if (isNearBottom || isMyMessage || messages.length <= 1) {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, localParticipant])

  // Clear unread when opening chat
  useEffect(() => {
    if (showChat) setUnreadCount(0)
  }, [showChat])

  // Media state (derived from LiveKit)
  const [micEnabled, setMicEnabled] = useState(true)
  const [camEnabled, setCamEnabled] = useState(true)
  const [screenSharing, setScreenSharing] = useState(false)

  // Recording state
  const [isRecording, setIsRecording] = useState(meeting.isRecorded)
  const [consentStatus, setConsentStatus] = useState<ConsentStatus | null>(null)

  // Client-side recording references
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const activeSourcesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map())
  const lastTranslateTimeRef = useRef<number>(0)
  const interimTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Timer
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())
  useEffect(() => {
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [])

  // Poll consent status when Senti panel is open
  const pollConsent = useCallback(async () => {
    const res = await consentApi.status(meetingId)
    if ('data' in res && res.data) setConsentStatus(res.data)
  }, [meetingId])

  useEffect(() => {
    if (!showSenti) return
    pollConsent()
    const iv = setInterval(pollConsent, 3000)
    return () => clearInterval(iv)
  }, [showSenti, pollConsent])

  // Poll waiting room if host
  useEffect(() => {
    if (!isHost) return
    const fetchWaiting = async () => {
      const res = await meetingsApi.getWaitingList(meetingId)
      if ('data' in res && res.data) {
        setWaitingUsers(res.data)
      }
    }
    fetchWaiting()
    const iv = setInterval(fetchWaiting, 3000)
    return () => clearInterval(iv)
  }, [isHost, meetingId])

  // Audio chime if user joins waiting room
  useEffect(() => {
    if (waitingUsers.length > prevWaitingCountRef.current) {
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.connect(gain)
        gain.connect(audioCtx.destination)
        
        osc.type = 'sine'
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime) // D5
        osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.15) // A5
        
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4)
        
        osc.start()
        osc.stop(audioCtx.currentTime + 0.4)
      } catch (e) {
        // Autoplay policy bypass
      }
    }
    prevWaitingCountRef.current = waitingUsers.length
  }, [waitingUsers])

  // Listen to LiveKit DataChannel
  useEffect(() => {
    const handleDataReceived = (payload: Uint8Array, participant: any) => {
      try {
        const decoder = new TextDecoder()
        const data = JSON.parse(decoder.decode(payload))
        const isHostMessage = participant?.identity === currentHostId
        if (data.type === 'consent_updated') {
          pollConsent()
        } else if (data.type === 'request_consent') {
          if (isHostMessage && !isHost) {
            setShowConsentModal(true)
          }
        } else if (data.type === 'mute_participant') {
          if (isHostMessage && data.targetIdentity === localParticipant?.identity) {
            localParticipant.setMicrophoneEnabled(false)
            setMicEnabled(false)
          }
        } else if (data.type === 'mute_all') {
          // Host requested everyone to mute. Host's own mic is unaffected (they send, not receive their own data).
          if (isHostMessage && localParticipant && participant?.identity !== localParticipant.identity) {
            localParticipant.setMicrophoneEnabled(false)
            setMicEnabled(false)
          }
        } else if (data.type === 'host_changed') {
          // Host transfer broadcast — sync local host state for all clients.
          if (isHostMessage && typeof data.newHostId === 'string') {
            setCurrentHostId(data.newHostId)
          }
        } else if (data.type === 'recording_started') {
          if (isHostMessage) setIsRecording(true)
        } else if (data.type === 'recording_stopped') {
          if (isHostMessage) setIsRecording(false)
        } else if (data.type === 'raise_hand') {
          setRaisedHands((prev) => ({ ...prev, [participant.identity]: data.raised }))
        } else if (data.type === 'reaction') {
          const id = Math.random().toString(36).substr(2, 9)
          setFloatingReactions((prev) => [...prev, { id, identity: participant.identity, emoji: data.emoji }])
          setTimeout(() => {
            setFloatingReactions((prev) => prev.filter((r) => r.id !== id))
          }, 3000)
        } else if (data.type === 'chat') {
          const newMsg: ChatMessage = {
            id: Math.random().toString(36).substr(2, 9),
            userId: participant?.identity || 'unknown',
            userName: participant?.name || 'Гость',
            text: data.text,
            timestamp: Date.now(),
          }
          setMessages((prev) => [...prev, newMsg])
          if (!showChat) setUnreadCount((c) => c + 1)
        } else if (data.type === 'senti_translation') {
          const runRemoteTranslation = async () => {
            let finalDstText = data.dstText
            if (translateTargetLang !== 'none' && data.dstLang !== translateTargetLang) {
              try {
                const transRes = await meetingsApi.translate(data.srcText, data.srcLang, translateTargetLang)
                if ('data' in transRes && transRes.data?.translated) {
                  finalDstText = transRes.data.translated
                }
              } catch (e) {
                console.error('Remote translation failed:', e)
              }
            }

            if (data.isFinal) {
              setTranslateHistory((prev) => [
                ...prev,
                {
                  id: Math.random().toString(36).substr(2, 9),
                  userId: participant?.identity || 'unknown',
                  userName: participant?.name || 'Участник',
                  srcLang: data.srcLang,
                  srcText: data.srcText,
                  dstLang: translateTargetLang,
                  dstText: finalDstText,
                  timestamp: Date.now(),
                },
              ])
              setActiveSubtitle(null)
            } else {
              setActiveSubtitle({
                userName: participant?.name || 'Участник',
                srcLang: data.srcLang,
                srcText: data.srcText,
                dstLang: translateTargetLang,
                dstText: finalDstText,
              })
            }
          }
          runRemoteTranslation()
        }
      } catch (err) {
        console.error('Failed to parse data channel message:', err)
      }
    }

    const handleParticipantDisconnected = (p: any) => {
      setRaisedHands((prev) => {
        const copy = { ...prev }
        delete copy[p.identity]
        return copy
      })
    }

    room.on(RoomEvent.DataReceived, handleDataReceived)
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected)
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived)
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected)
    }
  }, [room, isHost, pollConsent, showChat, localParticipant, currentHostId, translateTargetLang])

  // ─── Senti Translate (BETA) Audio Recognition & Simulation ───
  const recognitionRef = useRef<any>(null)

  // Local user speech recognition via Web Speech API
  useEffect(() => {
    let active = true

    if (!isTranslateActive) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop()
        } catch (e) {}
        recognitionRef.current = null
      }
      setActiveSubtitle(null)
      return
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition is not supported in this browser.')
      return
    }

    const rec = new SpeechRecognition()
    rec.continuous = true
    rec.interimResults = true
    
    let langTag = 'ru-RU'
    if (translateInputLang === 'en') langTag = 'en-US'
    else if (translateInputLang === 'es') langTag = 'es-ES'
    else if (translateInputLang === 'kk') langTag = 'kk-KZ'
    rec.lang = langTag

    rec.onresult = async (event: any) => {
      if (!active) return

      let interimTranscript = ''
      let finalTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript
        } else {
          interimTranscript += event.results[i][0].transcript
        }
      }

      const activeText = finalTranscript || interimTranscript
      if (!activeText.trim()) return

      const srcL = translateInputLang === 'auto' ? 'ru' : translateInputLang
      const dstL = translateTargetLang
      const isFinal = !!finalTranscript

      const performTranslation = async (textToTranslate: string, finalFlag: boolean) => {
        let translated = textToTranslate
        if (srcL !== dstL && dstL !== 'none') {
          try {
            const transRes = await meetingsApi.translate(textToTranslate, srcL, dstL)
            if ('data' in transRes && transRes.data?.translated) {
              translated = transRes.data.translated
            }
          } catch (e) {
            console.error('Translation failed:', e)
          }
        }

        if (localParticipant) {
          try {
            const encoder = new TextEncoder()
            const payload = encoder.encode(
              JSON.stringify({
                type: 'senti_translation',
                srcLang: srcL,
                srcText: textToTranslate,
                dstLang: dstL,
                dstText: translated,
                isFinal: finalFlag,
              })
            )
            await localParticipant.publishData(payload, { reliable: true })
          } catch (e) {
            console.error('Failed to broadcast translation:', e)
          }
        }

        if (finalFlag) {
          setTranslateHistory((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substr(2, 9),
              userId: localParticipant?.identity || 'local',
              userName: localParticipant?.name || user.name || 'Вы',
              srcLang: srcL,
              srcText: textToTranslate,
              dstLang: dstL,
              dstText: translated,
              timestamp: Date.now(),
            },
          ])
          setActiveSubtitle(null)
        } else {
          setActiveSubtitle({
            userName: localParticipant?.name || user.name || 'Вы',
            srcLang: srcL,
            srcText: textToTranslate,
            dstLang: dstL,
            dstText: translated,
          })
        }
      }

      if (isFinal) {
        if (interimTimeoutRef.current) {
          clearTimeout(interimTimeoutRef.current)
          interimTimeoutRef.current = null
        }
        await performTranslation(activeText, true)
      } else {
        const now = Date.now()
        // Throttle interim translations to avoid DDOSing translate API
        if (now - lastTranslateTimeRef.current > 1200) {
          lastTranslateTimeRef.current = now
          await performTranslation(activeText, false)
        } else {
          // Responsive local feedback: update local subtitle overlay with original text immediately
          setActiveSubtitle({
            userName: localParticipant?.name || user.name || 'Вы',
            srcLang: srcL,
            srcText: activeText,
            dstLang: dstL,
            dstText: activeText,
          })
          // Schedule a delayed catchup translation at the end of speech pauses
          if (interimTimeoutRef.current) {
            clearTimeout(interimTimeoutRef.current)
          }
          interimTimeoutRef.current = setTimeout(async () => {
            if (active) {
              lastTranslateTimeRef.current = Date.now()
              await performTranslation(activeText, false)
            }
          }, 1200)
        }
      }
    }

    rec.onerror = (e: any) => {
      console.warn('SpeechRecognition error:', e)
      if (!active) return
      if (e.error === 'no-speech' || e.error === 'aborted') {
        try {
          rec.start()
        } catch (_) {}
      }
    }

    rec.onend = () => {
      if (!active) return
      try {
        rec.start()
      } catch (_) {}
    }

    try {
      rec.start()
      recognitionRef.current = rec
    } catch (e) {
      console.error('Speech recognition failed to start:', e)
    }

    return () => {
      active = false
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onend = null
          recognitionRef.current.onerror = null
          recognitionRef.current.onresult = null
          recognitionRef.current.stop()
        } catch (e) {}
        recognitionRef.current = null
      }
    }
  }, [isTranslateActive, translateInputLang, translateTargetLang, localParticipant])



  const handleMuteParticipant = async (targetIdentity: string) => {
    if (!localParticipant || !isHost) return
    try {
      const encoder = new TextEncoder()
      const data = encoder.encode(JSON.stringify({ type: 'mute_participant', targetIdentity }))
      await localParticipant.publishData(data, { reliable: true })
    } catch (err) {
      console.error('Failed to broadcast mute participant signal:', err)
    }
  }

  const handleMuteAll = async () => {
    if (!localParticipant || !isHost) return
    try {
      const encoder = new TextEncoder()
      const data = encoder.encode(JSON.stringify({ type: 'mute_all' }))
      await localParticipant.publishData(data, { reliable: true })
    } catch (err) {
      console.error('Failed to broadcast mute_all signal:', err)
    }
  }

  // Mute-on-entry toggle (host only). Local meeting state mirrors the server.
  const handleToggleMuteOnEntry = async () => {
    if (!isHost) return
    const next = !muteOnEntry
    setMuteOnEntry(next)
    const res = await meetingsApi.setMuteOnEntry(meetingId, next)
    if ('error' in res) {
      setMuteOnEntry(!next) // revert
    }
  }

  // Transfer-host: confirmation modal + API + DataChannel broadcast.
  const handleTransferHost = async () => {
    if (!isHost || !transferTarget || !localParticipant) return
    const newHostId = transferTarget.identity
    const res = await meetingsApi.transferHost(meetingId, newHostId)
    if ('data' in res && res.data) {
      // Update locally — we're no longer host as of now.
      setCurrentHostId(newHostId)
      // Notify all other participants so their UI flips too.
      try {
        const encoder = new TextEncoder()
        const data = encoder.encode(JSON.stringify({ type: 'host_changed', newHostId }))
        await localParticipant.publishData(data, { reliable: true })
      } catch (err) {
        console.error('Failed to broadcast host_changed:', err)
      }
    } else {
      alert((res as any).error?.message ?? 'Не удалось передать роль организатора')
    }
    setTransferTarget(null)
  }

  // Waiting Room Host Actions
  const handleAdmit = async (targetUserId: string) => {
    const res = await meetingsApi.admitUser(meetingId, targetUserId)
    if ('data' in res) {
      setWaitingUsers((prev) => prev.filter((u) => u.userId !== targetUserId))
    }
  }

  const handleReject = async (targetUserId: string) => {
    const res = await meetingsApi.rejectUser(meetingId, targetUserId)
    if ('data' in res) {
      setWaitingUsers((prev) => prev.filter((u) => u.userId !== targetUserId))
    }
  }

  // Reactions & Raise Hand Actions
  const sendReaction = async (emoji: string) => {
    if (!localParticipant) return
    try {
      const encoder = new TextEncoder()
      const data = encoder.encode(JSON.stringify({ type: 'reaction', emoji }))
      await localParticipant.publishData(data, { reliable: true })
      
      // Show locally immediately
      const id = Math.random().toString(36).substr(2, 9)
      setFloatingReactions((prev) => [...prev, { id, identity: localParticipant.identity, emoji }])
      setTimeout(() => {
        setFloatingReactions((prev) => prev.filter((r) => r.id !== id))
      }, 3000)
    } catch (err) {
      console.error('Failed to publish reaction:', err)
    }
    setShowReactionsMenu(false)
  }

  const toggleRaiseHand = async () => {
    if (!localParticipant) return
    try {
      const nextState = !raisedHands[localParticipant.identity]
      setRaisedHands((prev) => ({ ...prev, [localParticipant.identity]: nextState }))
      
      const encoder = new TextEncoder()
      const data = encoder.encode(JSON.stringify({ type: 'raise_hand', raised: nextState }))
      await localParticipant.publishData(data, { reliable: true })
    } catch (err) {
      console.error('Failed to publish raise hand:', err)
    }
  }

  // Noise Suppression Action
  const toggleNoiseSuppression = async () => {
    if (!localParticipant) return
    try {
      if (noiseSuppression) {
        setNoiseSuppression(false)
        if (nsCtxRef.current) {
          await nsCtxRef.current.close().catch(() => {})
          nsCtxRef.current = null
        }
        if (nsPublishedTrackRef.current) {
          await localParticipant.unpublishTrack(nsPublishedTrackRef.current.track).catch(() => {})
          nsPublishedTrackRef.current = null
        }
        // Restore default mic
        await localParticipant.setMicrophoneEnabled(true)
        setMicEnabled(true)
      } else {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
          alert('Доступ к микрофону недоступен в этом браузере (требуется HTTPS).')
          setNoiseSuppression(false)
          return
        }
        setNoiseSuppression(true)
        
        // 1. Unpublish current microphone FIRST to release hardware lock and avoid conflict
        const micPublication = localParticipant.getTrackPublication(Track.Source.Microphone)
        if (micPublication && micPublication.track) {
          nsOriginalTrackRef.current = micPublication.track
          await localParticipant.unpublishTrack(micPublication.track)
          // Wait 150ms for the browser to fully release the microphone device
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        
        // 2. Get raw media stream from microphone (now device is guaranteed free)
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : { echoCancellation: true, noiseSuppression: true }
        })
        
        // 3. Web Audio setup
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
        const ctx = new AudioContextClass()
        nsCtxRef.current = ctx
        
        const source = ctx.createMediaStreamSource(stream)
        
        // Low frequency cut filter (120Hz highpass)
        const hpFilter = ctx.createBiquadFilter()
        hpFilter.type = 'highpass'
        hpFilter.frequency.value = 120
        
        // High frequency bandpass to keep speech range (80Hz to 6000Hz)
        const lpFilter = ctx.createBiquadFilter()
        lpFilter.type = 'lowpass'
        lpFilter.frequency.value = 6000
        
        // Noise Gate compressor
        const gate = ctx.createDynamicsCompressor()
        gate.threshold.value = -42 // Attenuate audio below -42dB
        gate.knee.value = 12
        gate.ratio.value = 15
        gate.attack.value = 0.003 // Quick open
        gate.release.value = 0.12 // Smooth close
        
        const dest = ctx.createMediaStreamDestination()
        
        source.connect(hpFilter)
        hpFilter.connect(lpFilter)
        lpFilter.connect(gate)
        gate.connect(dest)
        
        const cleanTrack = dest.stream.getAudioTracks()[0]
        
        // 4. Publish clean track
        const pub = await localParticipant.publishTrack(cleanTrack, {
          name: 'microphone-clean',
          source: Track.Source.Microphone
        })
        nsPublishedTrackRef.current = pub
        setMicEnabled(true)
      }
    } catch (err) {
      console.error('Failed to toggle noise suppression:', err)
      setNoiseSuppression(false)
      // Attempt recovery of original microphone on fail
      try {
        await localParticipant.setMicrophoneEnabled(true)
        setMicEnabled(true)
      } catch (recErr) {
        console.error('Failed to recover microphone after noise suppression error:', recErr)
      }
    }
  }

  // Send message
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!chatInput.trim() || !localParticipant) return
    const msg = { type: 'chat', text: chatInput }
    const encoder = new TextEncoder()
    const data = encoder.encode(JSON.stringify(msg))
    await localParticipant.publishData(data, { reliable: true })
    
    setMessages((prev) => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      userId: localParticipant.identity,
      userName: localParticipant.name || user.name || 'Вы',
      text: chatInput,
      timestamp: Date.now(),
    }])
    setChatInput('')
  }

  // Toggle microphone
  const toggleMic = useCallback(async () => {
    await localParticipant.setMicrophoneEnabled(!micEnabled)
    setMicEnabled((v) => !v)
  }, [localParticipant, micEnabled])

  // Toggle camera
  const toggleCam = useCallback(async () => {
    await localParticipant.setCameraEnabled(!camEnabled)
    setCamEnabled((v) => !v)
  }, [localParticipant, camEnabled])

  // Toggle screen share
  const toggleScreen = useCallback(async () => {
    if (screenSharing) {
      await localParticipant.setScreenShareEnabled(false)
    } else {
      await localParticipant.setScreenShareEnabled(true)
    }
    setScreenSharing((v) => !v)
  }, [localParticipant, screenSharing])

  // Give consent
  const handleGiveConsent = async () => {
    await consentApi.give(meetingId)
    await pollConsent()
    setShowConsentModal(false)

    // Broadcast consent update via DataChannel
    if (localParticipant) {
      try {
        const encoder = new TextEncoder()
        const data = encoder.encode(JSON.stringify({ type: 'consent_updated' }))
        await localParticipant.publishData(data, { reliable: true })
      } catch (err) {
        console.error('Failed to broadcast consent update:', err)
      }
    }
  }

  // Request consent (host only)
  const handleRequestConsent = async () => {
    if (localParticipant) {
      try {
        const encoder = new TextEncoder()
        const data = encoder.encode(JSON.stringify({ type: 'request_consent' }))
        await localParticipant.publishData(data, { reliable: true })
      } catch (err) {
        console.error('Failed to broadcast consent request:', err)
      }
    }

    await pollConsent()
    
    // Show local ConsentModal for host as well if they haven't consented
    const myConsent = consentStatus?.participants?.find((p) => p.userId === user.id)
    if (!myConsent?.hasConsented) {
      setShowConsentModal(true)
    }
  }

  // Helpers for client-side recording
  const stopAndUploadRecording = () => {
    return new Promise<void>((resolve) => {
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
        resolve()
        return
      }
      (window as any)._resolveUpload = resolve
      mediaRecorderRef.current.stop()
    })
  }

  // Start recording (host only)
  const handleStartRecording = async () => {
    if (!localParticipant) return
    let backendStarted = false
    try {
      // 1. Notify backend and update state in DB first to perform consent validation
      const res = await livekitApi.startRecording(meetingId)
      if ('error' in res) {
        alert(`Не удалось запустить запись в базе: ${res.error?.message}`)
        return
      }
      backendStarted = true

      // 2. Initialize Web Audio API Mixer
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      const audioCtx = new AudioContextClass()
      const dest = audioCtx.createMediaStreamDestination()

      audioContextRef.current = audioCtx
      audioDestRef.current = dest
      activeSourcesRef.current.clear()

      // Function to safely connect a track stream to the destination mixer
      const connectStream = (stream: MediaStream, id: string) => {
        const existing = activeSourcesRef.current.get(id)
        if (existing) {
          if (existing.mediaStream === stream) return
          try {
            existing.disconnect()
          } catch (e) {}
          activeSourcesRef.current.delete(id)
        }
        try {
          if (stream.getAudioTracks().length === 0) return
          const source = audioCtx.createMediaStreamSource(stream)
          source.connect(dest)
          activeSourcesRef.current.set(id, source)
        } catch (e) {
          console.error(`Failed to connect stream to audio mixer for ${id}:`, e)
        }
      }

      // Connect local participant microphone
      const localStream = localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStream
      if (localStream) {
        connectStream(localStream, localParticipant.identity)
      }

      // Connect existing remote participants
      remoteParticipants.forEach((p) => {
        const stream = p.getTrackPublication(Track.Source.Microphone)?.track?.mediaStream
        if (stream) {
          connectStream(stream, p.identity)
        }
      })

      // Dynamically connect new participants who join or enable mic during recording
      const onTrackSubscribed = (track: any, publication: any, participant: any) => {
        if (track.kind === 'audio' && track.mediaStream) {
          connectStream(track.mediaStream, participant.identity)
        }
      }

      const onTrackUnsubscribed = (track: any, publication: any, participant: any) => {
        if (track.kind === 'audio') {
          const existing = activeSourcesRef.current.get(participant.identity)
          if (existing) {
            try {
              existing.disconnect()
            } catch (e) {}
            activeSourcesRef.current.delete(participant.identity)
          }
        }
      }

      room.on(RoomEvent.TrackSubscribed, onTrackSubscribed)
      room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      ;(window as any)._onTrackSubscribed = onTrackSubscribed
      ;(window as any)._onTrackUnsubscribed = onTrackUnsubscribed

      // 3. Initialize MediaRecorder
      const options = { mimeType: 'audio/webm;codecs=opus' }
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(dest.stream, options)
      } catch (e) {
        recorder = new MediaRecorder(dest.stream) // Safari fallback
      }

      const chunks: Blob[] = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }

      recorder.onstop = async () => {
        room.off(RoomEvent.TrackSubscribed, (window as any)._onTrackSubscribed)
        room.off(RoomEvent.TrackUnsubscribed, (window as any)._onTrackUnsubscribed)
        if (audioContextRef.current) {
          await audioContextRef.current.close().catch(() => {})
        }

        const blob = new Blob(chunks, { type: recorder.mimeType })
        const ext = recorder.mimeType.includes('webm') ? '.webm' : recorder.mimeType.includes('ogg') ? '.ogg' : '.mp3'
        const file = new File([blob], `meeting-${meetingId}${ext}`, { type: recorder.mimeType })

        // Upload mixed audio recording to server
        const uploadRes = await meetingsApi.uploadAudio(meetingId, file)
        if ('error' in uploadRes) {
          alert(`Не удалось загрузить аудиозапись встречи: ${uploadRes.error?.message}`)
        }

        if ((window as any)._resolveUpload) {
          (window as any)._resolveUpload()
        }
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setIsRecording(true)

      // Broadcast signal to other participants via DataChannel
      const encoder = new TextEncoder()
      const data = encoder.encode(JSON.stringify({ type: 'recording_started' }))
      await localParticipant.publishData(data, { reliable: true })

    } catch (err: any) {
      alert(`Ошибка запуска аудиозаписи: ${err.message}`)
      // Revert backend state if updated
      if (backendStarted) {
        await livekitApi.stopRecording(meetingId).catch(() => {})
      }
      // Revert local state
      setIsRecording(false)
      if (mediaRecorderRef.current) {
        try {
          mediaRecorderRef.current.stop()
        } catch (e) {}
        mediaRecorderRef.current = null
      }
      if (audioContextRef.current) {
        await audioContextRef.current.close().catch(() => {})
        audioContextRef.current = null
      }
      room.off(RoomEvent.TrackSubscribed, (window as any)._onTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, (window as any)._onTrackUnsubscribed)
    }
  }

  // Stop recording (host only)
  const handleStopRecording = async () => {
    await livekitApi.stopRecording(meetingId)

    // Broadcast stop signal to other participants
    if (localParticipant) {
      try {
        const encoder = new TextEncoder()
        const data = encoder.encode(JSON.stringify({ type: 'recording_stopped' }))
        await localParticipant.publishData(data, { reliable: true })
      } catch (err) {
        console.error('Failed to broadcast recording stop:', err)
      }
    }

    await stopAndUploadRecording()
    setIsRecording(false)
  }

  // Leave call (just exit, don't end)
  const handleLeaveCall = async () => {
    onLeave()
    if (isHost && isRecording) {
      await livekitApi.stopRecording(meetingId)
      await stopAndUploadRecording()
    }
    room.disconnect()
  }

  // End call
  const handleEndCall = async () => {
    onLeave()
    if (isRecording) {
      await livekitApi.stopRecording(meetingId)
      await stopAndUploadRecording()
    }
    await meetingsApi.end(meetingId)
    room.disconnect()
  }

  const formatTimer = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  // Consent counts only people who are currently connected to the room.
  // The DB tracks consent for everyone who ever joined, but participants who left
  // shouldn't block recording or be asked for consent again.
  const liveConsentParticipants = (consentStatus?.participants ?? []).filter((p) =>
    connectedIdentities.has(p.userId),
  )
  const liveConsentTotal = liveConsentParticipants.length
  const liveConsented = liveConsentParticipants.filter((p) => p.hasConsented).length
  const liveAllConsented = liveConsentTotal > 0 && liveConsented === liveConsentTotal
  // WebRTC unmount cleanup for any active recording listeners
  useEffect(() => {
    return () => {
      if ((window as any)._onTrackSubscribed) {
        room.off(RoomEvent.TrackSubscribed, (window as any)._onTrackSubscribed)
        ;(window as any)._onTrackSubscribed = null
      }
      if ((window as any)._onTrackUnsubscribed) {
        room.off(RoomEvent.TrackUnsubscribed, (window as any)._onTrackUnsubscribed)
        ;(window as any)._onTrackUnsubscribed = null
      }
      if (interimTimeoutRef.current) {
        clearTimeout(interimTimeoutRef.current)
      }
    }
  }, [room])

  return (
    <div className={styles.roomLayout}>
      {/* ── Participants sidebar ── */}
      <aside className={`${styles.participantsSidebar} ${!showParticipants ? styles.collapsed : ''}`}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Участники</span>
          <span className={styles.participantCount}>{allParticipants.length}</span>
        </div>

        {/* Waiting Room Section for Host */}
        {isHost && waitingUsers.length > 0 && (
          <div className={styles.waitingRoomSection}>
            <div className={styles.waitingRoomSubheader}>В зале ожидания ({waitingUsers.length})</div>
            <div className={styles.waitingList}>
              {waitingUsers.map((u) => (
                <div key={u.userId} className={styles.waitingItem}>
                  <span className={styles.waitingName} title={u.name}>{u.name}</span>
                  <div className={styles.waitingActions}>
                    <button className={styles.waitBtnAdmit} onClick={() => handleAdmit(u.userId)} title="Разрешить вход">
                      <Check size={12} />
                    </button>
                    <button className={styles.waitBtnReject} onClick={() => handleReject(u.userId)} title="Отклонить">
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.participantsList}>
          {allParticipants.map((p) => {
            const isSpeaking = p.isSpeaking
            const displayName = p.isLocal ? (p.name || user.name || 'Вы') : (p.name || p.identity)
            const initials = displayName && displayName !== 'unknown'
              ? displayName.split(' ').filter(Boolean).map((n) => n[0]).slice(0, 2).join('').toUpperCase()
              : '??'
            const micPub = p.getTrackPublication(Track.Source.Microphone)
            const camPub = p.getTrackPublication(Track.Source.Camera)
            const isMuted = !micPub?.isMuted === false || !micPub?.track

            return (
              <div key={p.identity} className={styles.participantItem}>
                <div className={styles.participantAvatar}>
                  <div className="avatar avatar-sm">{initials}</div>
                  {isSpeaking && <div className={styles.participantSpeaking} />}
                </div>
                <div className={styles.participantInfo}>
                  <div className={styles.participantName}>
                    {displayName}
                    {p.isLocal && ' (вы)'}
                  </div>
                  {p.identity === currentHostId && (
                    <div className={styles.participantRole}>Организатор</div>
                  )}
                </div>
                <div className={styles.participantIcons}>
                  {raisedHands[p.identity] && (
                    <span className={styles.raisedHandSidebarBadge} title="Поднята рука">✋</span>
                  )}
                  <ConnectionQualityBar participant={p} />
                  {isHost && !p.isLocal && p.identity !== currentHostId && (
                    <button
                      className={styles.muteActionBtn}
                      onClick={() => setTransferTarget({ identity: p.identity, name: p.name ?? p.identity })}
                      title="Передать роль организатора"
                      aria-label={`Передать роль организатора ${p.name ?? p.identity}`}
                    >
                      <Shield size={14} />
                    </button>
                  )}
                  {isMuted ? (
                    <MicOff size={14} className={styles.mutedIcon} />
                  ) : (
                    isHost && !p.isLocal ? (
                      <button
                        className={styles.muteActionBtn}
                        onClick={() => handleMuteParticipant(p.identity)}
                        title="Выключить микрофон участника"
                        aria-label={`Выключить микрофон ${p.name ?? p.identity}`}
                      >
                        <Mic size={14} />
                      </button>
                    ) : (
                      <Mic size={14} />
                    )
                  )}
                  {!camPub?.track && <VideoOff size={14} />}
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      {/* ── Video area ── */}
      <div className={styles.videoArea}>
        {/* Header */}
        <div className={styles.videoHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className={styles.meetingTitle}>{meeting.title}</span>
            <button
              id="copy-room-invite-btn"
              className="btn btn-ghost btn-sm"
              onClick={handleCopyRoomInvite}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', height: 'auto', fontSize: '0.75rem', borderColor: 'var(--color-border)' }}
              title="Скопировать приглашение на встречу"
            >
              {roomCopied ? <Check size={12} color="var(--color-success)" /> : <Copy size={12} />}
              {roomCopied ? 'Скопировано!' : 'Пригласить'}
            </button>
          </div>
          <div className={styles.meetingMeta}>
            {isRecording && (
              <span className={styles.recordingBadge}>
                <span className="live-dot" style={{ width: 6, height: 6 }} />
                REC
              </span>
            )}
            <span className={styles.timer}>{formatTimer(elapsed)}</span>
          </div>
        </div>

        {!audioPlaybackAllowed && (
          <div className={styles.audioBlockedBanner}>
            <div className={styles.audioBlockedContent}>
              <VolumeX size={18} className={styles.audioBlockedIcon} />
              <span>Звук встречи заблокирован вашим браузером. Нажмите кнопку, чтобы включить звук.</span>
            </div>
            <button className={styles.audioBlockedBtn} onClick={async () => {
              try {
                await room.startAudio()
              } catch (e) {
                console.error("Failed to start audio playback:", e)
              }
            }}>
              Включить звук
            </button>
          </div>
        )}

        {/* LiveKit video grid */}
        <div className={styles.videoGrid}>
          {viewMode === 'gallery' ? (
            <GalleryView tracks={visibleTracks} raisedHands={raisedHands} />
          ) : (
            <SpeakerView tracks={visibleTracks} raisedHands={raisedHands} />
          )}

          {/* Floating Consent Banner inside video area */}
          {showConsentModal && (
            <div className={styles.consentBannerFloating}>
              <div className={styles.consentBannerIcon}>
                <Shield size={18} />
              </div>
              <div className={styles.consentBannerText}>
                <strong>Запрос согласия на запись:</strong> Для запуска Senti-протокола требуется согласие всех участников на запись и обработку аудиоданных.
              </div>
              <button className="btn btn-sm btn-primary" onClick={handleGiveConsent}>
                Дать согласие
              </button>
              <button className={styles.consentBannerClose} onClick={() => setShowConsentModal(false)} aria-label="Закрыть">
                <X size={14} />
              </button>
            </div>
          )}

          {/* Floating reactions layer */}
          <div className={styles.reactionsLayer}>
            {floatingReactions.map((reaction) => {
              const p = allParticipants.find((x) => x.identity === reaction.identity)
              const name = p?.name || 'Участник'
              return (
                <div key={reaction.id} className={styles.floatingReaction}>
                  <span className={styles.reactionEmoji}>{reaction.emoji}</span>
                  <span className={styles.reactionName}>{name}</span>
                </div>
              )
            })}
          </div>

          {/* Senti Translate Subtitle Overlay */}
          {isTranslateActive && activeSubtitle && (
            <div className={styles.subtitlesOverlay}>
              <div className={styles.subtitleBox}>
                <div className={styles.subtitleSpeakerLine}>
                  <span className={styles.subtitleSpeakerName}>{activeSubtitle.userName}</span>
                  <span className={styles.subtitleLangDirection}>
                    {activeSubtitle.srcLang.toUpperCase()}
                    {activeSubtitle.dstLang !== 'none' && ` ➔ ${activeSubtitle.dstLang.toUpperCase()}`}
                  </span>
                </div>
                {activeSubtitle.srcLang !== activeSubtitle.dstLang && activeSubtitle.dstLang !== 'none' ? (
                  <>
                    <p className={styles.subtitleOriginalText}>{activeSubtitle.srcText}</p>
                    <p className={styles.subtitleTranslatedText}>{activeSubtitle.dstText}</p>
                  </>
                ) : (
                  <p className={styles.subtitleTranslatedText}>{activeSubtitle.srcText}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className={styles.controlsBar}>
          {/* Left: participants + layout + host moderation */}
          <div className={`${styles.controlsLeft} ${styles.desktopOnly}`}>
            <Tooltip label={showParticipants ? 'Скрыть участников' : 'Показать участников'}>
              <button
                id="toggle-participants-btn"
                className={`${styles.controlBtn} ${showParticipants ? styles.active : ''}`}
                onClick={() => setShowParticipants((v) => !v)}
                aria-label="Участники"
              >
                <Users size={20} />
              </button>
            </Tooltip>

            <Tooltip label={viewMode === 'gallery' ? 'Вид: active speaker' : 'Вид: grid'}>
              <button
                id="toggle-view-mode-btn"
                className={`${styles.controlBtn} ${viewMode === 'speaker' ? styles.active : ''}`}
                onClick={() => setViewMode((v) => (v === 'gallery' ? 'speaker' : 'gallery'))}
                aria-label="Переключить вид"
              >
                {viewMode === 'gallery' ? <UserIcon size={20} /> : <LayoutGrid size={20} />}
              </button>
            </Tooltip>

            {isHost && (
              <>
                <Tooltip label="Выключить микрофоны у всех">
                  <button
                    id="mute-all-btn"
                    className={styles.controlBtn}
                    onClick={handleMuteAll}
                    aria-label="Выключить микрофоны у всех"
                  >
                    <MicOff size={20} />
                  </button>
                </Tooltip>

                <Tooltip label={muteOnEntry ? 'Новые входят со включённым мик.' : 'Новые входят с выключенным мик.'}>
                  <button
                    id="mute-on-entry-btn"
                    className={`${styles.controlBtn} ${muteOnEntry ? styles.active : ''}`}
                    onClick={handleToggleMuteOnEntry}
                    aria-label="Выключать микрофон при входе"
                  >
                    <Lock size={20} />
                  </button>
                </Tooltip>
              </>
            )}
          </div>

          {/* Center: mic, cam, screen, hand, reactions, noise suppression, end */}
          <div className={styles.controlsCenter}>
            <div className={styles.controlGroup}>
              <Tooltip label={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}>
                <button
                  id="toggle-mic-btn"
                  className={`${styles.controlBtn} ${!micEnabled ? styles.muted : ''}`}
                  onClick={toggleMic}
                  aria-label={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
                >
                  {micEnabled ? <Mic size={20} /> : <MicOff size={20} />}
                </button>
              </Tooltip>
              <span className={styles.controlLabel}>{micEnabled ? 'Микрофон' : 'Без звука'}</span>
            </div>

            <div className={styles.controlGroup}>
              <Tooltip label={camEnabled ? 'Выключить камеру' : 'Включить камеру'}>
                <button
                  id="toggle-cam-btn"
                  className={`${styles.controlBtn} ${!camEnabled ? styles.muted : ''}`}
                  onClick={toggleCam}
                  aria-label={camEnabled ? 'Выключить камеру' : 'Включить камеру'}
                >
                  {camEnabled ? <Video size={20} /> : <VideoOff size={20} />}
                </button>
              </Tooltip>
              <span className={styles.controlLabel}>{camEnabled ? 'Камера' : 'Камера откл.'}</span>
            </div>

            <div className={`${styles.controlGroup} ${styles.desktopOnly}`}>
              <Tooltip label={screenSharing ? 'Остановить трансляцию' : 'Показать экран'}>
                <button
                  id="toggle-screen-btn"
                  className={`${styles.controlBtn} ${screenSharing ? styles.active : ''}`}
                  onClick={toggleScreen}
                  aria-label="Демонстрация экрана"
                >
                  <Monitor size={20} />
                </button>
              </Tooltip>
              <span className={styles.controlLabel}>{screenSharing ? 'Трансляция' : 'Экран'}</span>
            </div>

            {/* Raise Hand */}
            <div className={`${styles.controlGroup} ${styles.desktopOnly}`}>
              <Tooltip label={raisedHands[localParticipant?.identity || ''] ? 'Опустить руку' : 'Поднять руку'}>
                <button
                  id="toggle-raise-hand-btn"
                  className={`${styles.controlBtn} ${raisedHands[localParticipant?.identity || ''] ? styles.active : ''}`}
                  onClick={toggleRaiseHand}
                  aria-label="Поднять руку"
                >
                  <Hand size={20} />
                </button>
              </Tooltip>
              <span className={styles.controlLabel}>
                {raisedHands[localParticipant?.identity || ''] ? 'Опустить' : 'Поднять'}
              </span>
            </div>

            {/* Reactions (Smile menu) */}
            <div className={`${styles.controlGroup} ${styles.desktopOnly}`} style={{ position: 'relative' }}>
              <Tooltip label="Реакции">
                <button
                  id="toggle-reactions-btn"
                  className={`${styles.controlBtn} ${showReactionsMenu ? styles.active : ''}`}
                  onClick={() => setShowReactionsMenu((v) => !v)}
                  aria-label="Реакции"
                >
                  <Smile size={20} />
                </button>
              </Tooltip>
              <span className={styles.controlLabel}>Реакции</span>
              
              {showReactionsMenu && (
                <div className={styles.reactionsMenu}>
                  {['👍', '👏', '❤️', '😂', '🎉', '😮'].map((emoji) => (
                    <button
                      key={emoji}
                      className={styles.reactionMenuBtn}
                      onClick={() => sendReaction(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Noise Suppression */}
            <div className={`${styles.controlGroup} ${styles.desktopOnly}`}>
              <Tooltip label={noiseSuppression ? 'Отключить шумоподавление' : 'Включить шумоподавление'}>
                <button
                  id="toggle-noise-suppression-btn"
                  className={`${styles.controlBtn} ${noiseSuppression ? styles.active : ''}`}
                  onClick={toggleNoiseSuppression}
                  aria-label="Шумоподавление"
                >
                  <VolumeX size={20} />
                </button>
              </Tooltip>
              <span className={styles.controlLabel}>
                {noiseSuppression ? 'Шум откл.' : 'Шумопод.'}
              </span>
            </div>

            {/* Mobile More button */}
            <div className={`${styles.controlGroup} ${styles.mobileOnly}`}>
              <button
                id="mobile-more-btn"
                className={`${styles.controlBtn} ${showMoreMenu ? styles.active : ''}`}
                onClick={() => {
                  setShowMoreMenu((v) => !v)
                  setShowChat(false)
                  setShowSenti(false)
                  setShowParticipants(false)
                }}
                aria-label="Ещё"
              >
                <MoreHorizontal size={20} />
              </button>
              <span className={styles.controlLabel}>Ещё</span>
            </div>

            <button
              id="end-call-btn"
              className={styles.endCallBtn}
              onClick={() => {
                if (isHost) {
                  setShowEndConfirm(true)
                } else {
                  handleLeaveCall()
                }
              }}
              aria-label={isHost ? "Завершить звонок" : "Выйти из звонка"}
            >
              {isHost ? <PhoneOff size={18} /> : <LogOut size={18} />}
              {isHost ? 'Завершить' : 'Выйти'}
            </button>
          </div>

          {/* Right: Senti + Chat */}
          <div className={styles.controlsRight}>
            <Tooltip label={showChat ? 'Закрыть чат' : 'Открыть чат'}>
              <div className={styles.controlBtnBadge}>
                <button
                  id="toggle-chat-btn"
                  className={`${styles.controlBtn} ${showChat ? styles.active : ''}`}
                  onClick={() => {
                    setShowChat((v) => !v)
                    if (showSenti) setShowSenti(false)
                    if (showTranslate) setShowTranslate(false)
                    setShowMoreMenu(false)
                    setShowParticipants(false)
                  }}
                  aria-label="Чат встречи"
                >
                  <MessageSquare size={20} />
                </button>
                {unreadCount > 0 && !showChat && (
                  <span className={styles.unreadBadge}>{unreadCount > 9 ? '9+' : unreadCount}</span>
                )}
              </div>
            </Tooltip>
            
            <Tooltip label={showTranslate ? 'Закрыть перевод' : 'Открыть перевод (BETA)'}>
              <button
                id="toggle-translate-btn"
                className={`${styles.controlBtn} ${showTranslate ? styles.active : ''} ${isTranslateActive ? styles.activeTranslateBtn : ''}`}
                onClick={toggleTranslate}
                aria-label="Перевод встречи"
              >
                <Globe size={20} />
              </button>
            </Tooltip>

            {isHost && (
              <div className={styles.desktopOnly}>
                <Tooltip label={showSenti ? 'Закрыть Senti' : 'Открыть Senti-протокол'}>
                  <button
                    id="toggle-senti-btn"
                    className={`${styles.controlBtn} ${showSenti ? styles.sentiActive : ''}`}
                    onClick={() => {
                      setShowSenti((v) => !v)
                      if (showChat) setShowChat(false)
                      if (showTranslate) setShowTranslate(false)
                      setShowMoreMenu(false)
                      setShowParticipants(false)
                    }}
                    aria-label="Senti протокол"
                  >
                    <Bot size={20} />
                  </button>
                </Tooltip>
              </div>
            )}

            <Tooltip label="Настройки устройств">
              <button
                id="toggle-settings-btn"
                className={`${styles.controlBtn} ${showSettingsModal ? styles.active : ''}`}
                onClick={() => {
                  setShowSettingsModal((v) => {
                    const next = !v
                    if (next) {
                      setShowChat(false)
                      setShowSenti(false)
                      setShowTranslate(false)
                      setShowMoreMenu(false)
                      setShowParticipants(false)
                    }
                    return next
                  })
                }}
                aria-label="Настройки устройств"
              >
                <Settings size={20} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* ── Chat Panel ── */}
      {showChat && (
        <aside className={styles.chatPanel}>
          <div className={styles.chatHeader}>
            <div className={styles.chatTitle}>
              <MessageSquare size={18} color="var(--color-accent-blue)" />
              Чат встречи
            </div>
            <button
              className={styles.controlBtn}
              style={{ width: 32, height: 32 }}
              onClick={() => setShowChat(false)}
              aria-label="Закрыть чат"
            >
              <X size={16} />
            </button>
          </div>

          <div ref={chatContainerRef} className={styles.chatMessages}>
            {messages.length === 0 ? (
              <div className={styles.chatEmpty}>
                <div className={styles.chatEmptyIcon}>
                  <MessageSquare size={24} />
                </div>
                <p className={styles.chatEmptyText}>
                  Сообщений пока нет.<br />Напишите первым!
                </p>
              </div>
            ) : (
              messages.map((m) => {
                const isMine = m.userId === localParticipant?.identity
                return (
                  <div
                    key={m.id}
                    className={`${styles.chatMessage} ${isMine ? styles.chatMessageMine : styles.chatMessageOther}`}
                  >
                    <span className={styles.chatMessageSender}>
                      {m.userName} {isMine && ' (Вы)'}
                    </span>
                    <div className={`${styles.chatBubble} ${isMine ? styles.chatBubbleMine : styles.chatBubbleOther}`}>
                      {m.text}
                    </div>
                    <span className={styles.chatMessageTime}>
                      {new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(m.timestamp))}
                    </span>
                  </div>
                )
              })
            )}
            <div ref={chatBottomRef} />
          </div>

          <div className={styles.chatInputArea}>
            <textarea
              id="chat-input"
              className={styles.chatInput}
              placeholder="Написать сообщение…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendMessage(e as unknown as React.FormEvent)
                }
              }}
              rows={1}
              aria-label="Сообщение в чат"
            />
            <button
              id="chat-send-btn"
              className={styles.chatSendBtn}
              onClick={(e) => sendMessage(e as unknown as React.FormEvent)}
              disabled={!chatInput.trim()}
              aria-label="Отправить сообщение"
            >
              <Send size={18} />
            </button>
          </div>
        </aside>
      )}

      {/* ── Senti Panel ── */}
      {showSenti && (
        <aside className={styles.sentiPanel}>
          <div className={styles.sentiHeader}>
            <div className={styles.sentiTitle}>
              <Bot size={18} color="var(--color-accent-amber)" />
              <span className="senti-text">Senti</span>
            </div>
            <button
              className={`${styles.controlBtn} btn-sm`}
              style={{ width: 32, height: 32 }}
              onClick={() => setShowSenti(false)}
              aria-label="Закрыть панель"
            >
              <X size={16} />
            </button>
          </div>

          <div className={styles.sentiBody}>
            {/* Recording status */}
            {isRecording ? (
              <div className={styles.recordingStatus}>
                <StopCircle size={20} color="var(--color-danger)" />
                <div className={styles.recordingInfo}>
                  <div className={styles.recordingTitle}>Запись идёт</div>
                  <div className={styles.recordingDesc}>Senti анализирует в реальном времени</div>
                </div>
                {isHost && (
                  <button
                    id="stop-recording-btn"
                    className="btn btn-danger btn-sm"
                    onClick={handleStopRecording}
                  >
                    Стоп
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* Consent status */}
                {consentStatus && (
                  <div className={styles.consentStatus}>
                    <div className={styles.consentStatusTitle}>Согласия</div>
                    <div className={styles.consentBar}>
                      <div
                        className={styles.consentBarFill}
                        style={{
                          width: liveConsentTotal > 0
                            ? `${(liveConsented / liveConsentTotal) * 100}%`
                            : '0%'
                        }}
                      />
                    </div>
                    <div className={styles.consentNumbers}>
                      <span style={{ color: 'var(--color-success)', fontSize: '0.75rem', fontWeight: 600 }}>
                        {liveConsented} дали согласие
                      </span>
                      <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
                        из {liveConsentTotal}
                      </span>
                    </div>
                    <div className={styles.consentParticipants}>
                      {liveConsentParticipants.length === 0 ? (
                        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textAlign: 'center', padding: '8px 0' }}>
                          Нет участников в комнате
                        </div>
                      ) : (
                        liveConsentParticipants.map((p) => (
                          <div key={p.userId} className={styles.consentParticipantRow}>
                            <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                              {p.name}
                            </span>
                            {p.hasConsented
                              ? <CheckCircle2 size={14} color="var(--color-success)" className={styles.consentIcon} />
                              : <Circle size={14} color="var(--color-text-muted)" className={styles.consentIcon} />
                            }
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* Action button for host */}
                {isHost && liveAllConsented && !isRecording && (
                  <button
                    id="start-recording-btn"
                    className="btn btn-amber"
                    style={{ width: '100%' }}
                    onClick={handleStartRecording}
                  >
                    <Bot size={18} />
                    Начать запись Senti
                  </button>
                )}

                {isHost && !liveAllConsented && (
                  <button
                    id="request-consent-btn"
                    className="btn btn-ghost"
                    style={{ width: '100%', borderColor: 'rgba(229,0,18,0.35)', color: 'var(--color-accent-amber)' }}
                    onClick={handleRequestConsent}
                  >
                    <Shield size={18} />
                    Запросить согласие
                  </button>
                )}

                {!isHost && (
                  <div className={styles.sentiIdle}>
                    <div className={styles.sentiIdleIcon}>
                      <Bot size={28} />
                    </div>
                    <p className={styles.sentiIdleTitle}>Ожидание хоста</p>
                    <p className={styles.sentiIdleDesc}>
                      Организатор встречи может запустить Senti-протокол после получения согласия всех участников
                    </p>
                    <button
                      id="give-consent-btn"
                      className="btn btn-primary btn-sm"
                      onClick={handleGiveConsent}
                    >
                      <Shield size={16} />
                      Дать согласие заранее
                    </button>
                  </div>
                )}
              </>
            )}

            {!consentStatus && !isRecording && isHost && (
              <div className={styles.sentiIdle}>
                <div className={styles.sentiIdleIcon}>
                  <Bot size={28} />
                </div>
                <p className={styles.sentiIdleTitle}>Senti готов</p>
                <p className={styles.sentiIdleDesc}>
                  Запросите согласие у всех участников, чтобы начать запись и автоматическое протоколирование
                </p>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* ── Senti Translate Panel ── */}
      {showTranslate && (
        <aside className={styles.translatePanel}>
          <div className={styles.translateHeader}>
            <div className={styles.translateTitle}>
              <Globe size={18} color="var(--color-accent-blue)" />
              <span>Senti Translate</span>
              <span className={styles.translateBetaBadge}>BETA</span>
            </div>
            <button
              className={styles.controlBtn}
              style={{ width: 32, height: 32 }}
              onClick={() => setShowTranslate(false)}
              aria-label="Закрыть панель"
            >
              <X size={16} />
            </button>
          </div>

          <div className={styles.translateBody}>
            {/* Controls */}
            <div className={styles.translateControls}>
              <div className={styles.translateToggleRow}>
                <span className={styles.translateToggleLabel}>Запустить перевод</span>
                <label className={styles.translateSwitch}>
                  <input
                    type="checkbox"
                    checked={isTranslateActive}
                    onChange={(e) => setIsTranslateActive(e.target.checked)}
                  />
                  <span className={styles.translateSlider}></span>
                </label>
              </div>

              {isTranslateActive && (
                <div className={styles.translateLangSelects}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className={styles.translateLangLabel}>Язык ввода (Источник):</span>
                    <select
                      className={styles.translateLangSelect}
                      value={translateInputLang}
                      onChange={(e) => setTranslateInputLang(e.target.value)}
                    >
                      <option value="auto">🌐 Автоопределение</option>
                      <option value="ru">Русский (RU)</option>
                      <option value="en">English (EN)</option>
                      <option value="kk">Қазақша (KK)</option>
                      <option value="es">Español (ES)</option>
                    </select>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className={styles.translateLangLabel}>Язык вывода (Перевод):</span>
                    <select
                      className={styles.translateLangSelect}
                      value={translateTargetLang}
                      onChange={(e) => setTranslateTargetLang(e.target.value)}
                    >
                      <option value="none">Без перевода (Только субтитры)</option>
                      <option value="ru">Русский (RU)</option>
                      <option value="en">English (EN)</option>
                      <option value="kk">Қазақша (KK)</option>
                      <option value="es">Español (ES)</option>
                    </select>
                  </label>
                </div>
              )}
            </div>

            {/* Translation History Section */}
            <div className={styles.translateHistorySection}>
              <span className={styles.translateHistoryTitle}>История перевода</span>
              <div className={styles.translateHistoryFeed}>
                {translateHistory.length === 0 ? (
                  <div className={styles.translateFeedEmpty}>
                    <Globe size={24} style={{ color: 'var(--color-text-muted)' }} />
                    <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                      {isTranslateActive
                        ? 'Ожидание речи... Начните говорить или подождите участников встречи.'
                        : 'Включите переключатель "Запустить перевод" выше, чтобы активировать распознавание и трансляцию.'}
                    </p>
                  </div>
                ) : (
                  translateHistory.map((item) => (
                    <div key={item.id} className={styles.translateHistoryItem}>
                      <div className={styles.translateItemMeta}>
                        <span className={styles.translateItemSpeaker}>
                          {item.userName}
                          <span className={styles.translateItemLangTag}>{item.srcLang.toUpperCase()}</span>
                        </span>
                        <span className={styles.translateItemTime}>
                          {new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(item.timestamp))}
                        </span>
                      </div>
                      
                      {item.srcLang !== item.dstLang && item.dstLang !== 'none' ? (
                        <>
                          <p className={styles.translateItemOriginal}>{item.srcText}</p>
                          <p className={styles.translateItemTranslated}>{item.dstText}</p>
                        </>
                      ) : (
                        <p className={styles.translateItemTranslated}>{item.srcText}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </aside>
      )}



      {/* ── End Call Confirm ── */}
      {showEndConfirm && (
        <div className="modal-overlay" onClick={() => setShowEndConfirm(false)}>
          <div
            className={`modal-content ${styles.endCallModal}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 450 }}
          >
            <div className={styles.endCallIcon}>
              <PhoneOff size={24} />
            </div>
            <h3 style={{ marginBottom: 'var(--space-2)' }}>
              Завершить встречу или выйти?
            </h3>
            <p style={{ marginBottom: 'var(--space-6)', fontSize: '0.875rem', color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
              Как организатор, вы можете завершить встречу для всех участников (с сохранением протокола Senti) или просто выйти, оставив встречу активной для остальных.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
              <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                <button
                  id="confirm-end-call-btn"
                  className="btn btn-danger"
                  style={{ flex: 1, padding: '10px 12px', fontSize: '0.875rem' }}
                  onClick={handleEndCall}
                >
                  <PhoneOff size={14} />
                  Завершить для всех
                </button>
                <button
                  id="confirm-leave-call-btn"
                  className="btn btn-ghost"
                  style={{ flex: 1, borderColor: 'var(--color-accent-blue)', color: 'var(--color-accent-blue)', padding: '10px 12px', fontSize: '0.875rem' }}
                  onClick={handleLeaveCall}
                >
                  <LogOut size={14} />
                  Просто выйти
                </button>
              </div>
              <button className="btn btn-ghost" style={{ marginTop: 'var(--space-2)', width: '100%' }} onClick={() => setShowEndConfirm(false)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Transfer Host Confirm ── */}
      {transferTarget && (
        <div className="modal-overlay" onClick={() => setTransferTarget(null)}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 420, padding: 'var(--space-6)', textAlign: 'center' }}
          >
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'var(--color-accent-amber-dim, rgba(245, 158, 11, 0.15))',
              color: 'var(--color-accent-amber, #f59e0b)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto var(--space-4)',
            }}>
              <Shield size={22} />
            </div>
            <h3 style={{ marginBottom: 'var(--space-2)' }}>Передать роль организатора?</h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-6)', lineHeight: 1.5 }}>
              <strong>{transferTarget.name}</strong> станет организатором: сможет одобрять участников из зала ожидания, выключать микрофоны, запускать запись и передавать роль дальше. Вы потеряете эти права.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setTransferTarget(null)}>
                Отмена
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleTransferHost}>
                Передать
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Device Settings Modal ── */}
      {showSettingsModal && (
        <DeviceSettingsModal
          room={room}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

      {/* ── Mobile Backdrop ── */}
      {(showChat || showSenti || showTranslate || showParticipants || showMoreMenu) && (
        <div
          className={styles.mobileBackdrop}
          onClick={() => {
            setShowChat(false)
            setShowSenti(false)
            setShowTranslate(false)
            setShowParticipants(false)
            setShowMoreMenu(false)
          }}
        />
      )}

      {/* ── Mobile More Menu Drawer ── */}
      {showMoreMenu && (
        <aside className={styles.moreMenuDrawer}>
          <div className={styles.moreMenuHeader}>
            <span className={styles.moreMenuTitle}>Ещё</span>
            <button
              className={styles.controlBtn}
              style={{ width: 32, height: 32 }}
              onClick={() => setShowMoreMenu(false)}
              aria-label="Закрыть меню"
            >
              <X size={16} />
            </button>
          </div>

          {/* Quick Reactions Grid directly in drawer */}
          <div style={{ display: 'flex', justifyContent: 'space-around', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--color-border)', marginBottom: 'var(--space-3)' }}>
            {['👍', '👏', '❤️', '😂', '🎉', '😮'].map((emoji) => (
              <button
                key={emoji}
                style={{ fontSize: '1.6rem', background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={() => {
                  sendReaction(emoji)
                  setShowMoreMenu(false)
                }}
              >
                {emoji}
              </button>
            ))}
          </div>

          <div className={styles.moreMenuGrid}>
            {/* Raise Hand */}
            <button
              className={`${styles.moreMenuBtn} ${raisedHands[localParticipant?.identity || ''] ? styles.moreMenuBtnActive : ''}`}
              onClick={() => {
                toggleRaiseHand()
                setShowMoreMenu(false)
              }}
            >
              <div className={styles.moreMenuIconWrapper}>
                <Hand size={20} />
              </div>
              <span className={styles.moreMenuBtnLabel}>
                {raisedHands[localParticipant?.identity || ''] ? 'Опустить руку' : 'Поднять руку'}
              </span>
            </button>

            {/* Noise Suppression */}
            <button
              className={`${styles.moreMenuBtn} ${noiseSuppression ? styles.moreMenuBtnActive : ''}`}
              onClick={() => {
                toggleNoiseSuppression()
                setShowMoreMenu(false)
              }}
            >
              <div className={styles.moreMenuIconWrapper}>
                <VolumeX size={20} />
              </div>
              <span className={styles.moreMenuBtnLabel}>Шумоподавление</span>
            </button>

            {/* Participants list toggle */}
            <button
              className={`${styles.moreMenuBtn} ${showParticipants ? styles.moreMenuBtnActive : ''}`}
              onClick={() => {
                setShowParticipants((v) => !v)
                setShowMoreMenu(false)
              }}
            >
              <div className={styles.moreMenuIconWrapper}>
                <Users size={20} />
              </div>
              <span className={styles.moreMenuBtnLabel}>Участники ({allParticipants.length})</span>
            </button>

            {/* Senti AI toggle (Host only) */}
            {isHost && (
              <button
                className={`${styles.moreMenuBtn} ${showSenti ? styles.moreMenuBtnActive : ''}`}
                onClick={() => {
                  setShowSenti((v) => !v)
                  setShowMoreMenu(false)
                }}
              >
                <div className={styles.moreMenuIconWrapper}>
                  <Bot size={20} color="var(--color-accent-amber)" />
                </div>
                <span className={styles.moreMenuBtnLabel}>Senti AI</span>
              </button>
            )}

            {/* Senti Translate toggle */}
            <button
              className={`${styles.moreMenuBtn} ${showTranslate ? styles.moreMenuBtnActive : ''} ${isTranslateActive ? styles.moreMenuBtnActive : ''}`}
              onClick={() => {
                toggleTranslate()
                setShowMoreMenu(false)
              }}
            >
              <div className={styles.moreMenuIconWrapper}>
                <Globe size={20} color="var(--color-accent-blue)" />
              </div>
              <span className={styles.moreMenuBtnLabel}>Перевод (BETA)</span>
            </button>

            {/* Toggle View mode */}
            <button
              className={styles.moreMenuBtn}
              onClick={() => {
                setViewMode((v) => (v === 'gallery' ? 'speaker' : 'gallery'))
                setShowMoreMenu(false)
              }}
            >
              <div className={styles.moreMenuIconWrapper}>
                {viewMode === 'gallery' ? <UserIcon size={20} /> : <LayoutGrid size={20} />}
              </div>
              <span className={styles.moreMenuBtnLabel}>
                {viewMode === 'gallery' ? 'Докладчик' : 'Сетка'}
              </span>
            </button>

            {/* Device Settings */}
            <button
              className={`${styles.moreMenuBtn} ${showSettingsModal ? styles.moreMenuBtnActive : ''}`}
              onClick={() => {
                setShowSettingsModal(true)
                setShowMoreMenu(false)
              }}
            >
              <div className={styles.moreMenuIconWrapper}>
                <Settings size={20} />
              </div>
              <span className={styles.moreMenuBtnLabel}>Устройства</span>
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}

// ─── Tooltip wrapper ──────────────────────────────────────────────────────────

function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.tooltipWrapper}>
      {children}
      <span className={styles.tooltip} role="tooltip">{label}</span>
    </div>
  )
}
