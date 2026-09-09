'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { meetingsApi, authApi } from '@/lib/api'
import type { Meeting, User } from '@centras/shared'
import styles from './dashboard.module.css'
import { Logo, LogoIcon } from '@/components/Logo'
import {
  Video, Plus, Archive, Settings, LogOut, Users,
  Clock, Shield, ChevronRight, Zap,
  Calendar, Copy, Check, CalendarClock, Globe
} from 'lucide-react'

const MAX_ACTIVE = 5
const MAX_PER_ROOM = 7

export default function DashboardPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [loading, setLoading] = useState(true)

  // Scheduling & public states
  const [isScheduled, setIsScheduled] = useState(false)
  const [scheduleTime, setScheduleTime] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [waitingRoomEnabled, setWaitingRoomEnabled] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    const [meRes, meetRes] = await Promise.all([authApi.me(), meetingsApi.list()])
    if ('data' in meRes) setUser(meRes.data ?? null)
    if ('data' in meetRes) setMeetings(meetRes.data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const now = new Date()
  const activeMeetings = meetings.filter((m) => !m.endedAt && (!m.scheduledStart || new Date(m.scheduledStart) <= now))
  const scheduledMeetings = meetings
    .filter((m) => !m.endedAt && m.scheduledStart && new Date(m.scheduledStart) > now)
    .sort((a, b) => new Date(a.scheduledStart!).getTime() - new Date(b.scheduledStart!).getTime())
  const pastMeetings = meetings.filter((m) => m.endedAt)
  const canCreate = activeMeetings.length < MAX_ACTIVE

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim() || !canCreate) return
    setCreating(true)

    let utcScheduledStart: string | null = null
    if (isScheduled && scheduleTime) {
      try {
        const [datePart, timePart] = scheduleTime.split('T')
        const [year, month, day] = datePart.split('-').map(Number)
        const [hours, minutes] = timePart.split(':').map(Number)
        const localDate = new Date(year, month - 1, day, hours, minutes)
        utcScheduledStart = localDate.toISOString()
      } catch (err) {
        console.error('Failed to parse scheduled time:', err)
        utcScheduledStart = new Date(scheduleTime).toISOString()
      }
    }

    const res = await meetingsApi.create(
      newTitle.trim(),
      utcScheduledStart,
      isPublic,
      waitingRoomEnabled,
    )
    if ('data' in res && res.data) {
      setShowCreate(false)
      setNewTitle('')
      setIsScheduled(false)
      setScheduleTime('')
      setIsPublic(false)
      setWaitingRoomEnabled(false)
      if (!isScheduled) {
        router.push(`/room/${res.data.id}`)
      } else {
        loadData()
      }
    }
    setCreating(false)
  }

  const handleCopyInvite = (meeting: Meeting) => {
    const inviteUrl = typeof window !== 'undefined' ? `${window.location.origin}/room/${meeting.id}` : `/room/${meeting.id}`
    const creatorName = (meeting as any).creator?.name ?? user?.name ?? 'Организатор'
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
    setCopiedId(meeting.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const formatDuration = (sec?: number) => {
    if (!sec) return '—'
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const formatDate = (iso: string) => {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  }

  const initials = (name: string) =>
    name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()

  if (loading) return <DashboardSkeleton />

  return (
    <div className={`${styles.layout} fade-up`}>
      {/* Mobile Header */}
      <header className={styles.mobileHeader}>
        <Logo size={28} />
        <div className={styles.mobileUser}>
          <div className="avatar avatar-sm" title={user?.name}>
            {initials(user?.name ?? 'U')}
          </div>
          <button
            className={styles.logoutBtn}
            onClick={authApi.logout}
            title="Выйти"
            aria-label="Выйти из системы"
            style={{ display: 'flex', padding: '6px' }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {/* Sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarLogo}>
          <div className={styles.fullLogo}>
            <Logo size={30} />
          </div>
          <div className={styles.iconLogo}>
            <LogoIcon width={38} height={38} />
          </div>
        </div>

        <nav className={styles.sidebarNav}>
          <SidebarItem icon={<Video size={20} />} label="Встречи" active href="/dashboard" />
          <SidebarItem icon={<Archive size={20} />} label="Архив" href="/archive" />
          {user?.role === 'admin' && (
            <SidebarItem icon={<Users size={20} />} label="Пользователи" href="/admin" />
          )}
          <SidebarItem icon={<Settings size={20} />} label="Настройки" href="/settings" />
        </nav>

        <div className={styles.sidebarUser}>
          <div className="avatar avatar-sm" title={user?.name}>
            {initials(user?.name ?? 'U')}
          </div>
          <button
            className={styles.logoutBtn}
            onClick={authApi.logout}
            title="Выйти"
            aria-label="Выйти из системы"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className={styles.main}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.greeting}>
              Привет, {user?.name?.split(' ')[0] ?? 'Сотрудник'}! 👋
            </h1>
            <p className={styles.date}>
              {(() => {
                const dStr = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
                return dStr.charAt(0).toUpperCase() + dStr.slice(1)
              })()}
            </p>
          </div>

          <button
            id="create-meeting-btn"
            className={`btn btn-primary ${!canCreate ? 'disabled' : ''}`}
            onClick={() => setShowCreate(true)}
            disabled={!canCreate}
            title={!canCreate ? `Достигнут лимит ${MAX_ACTIVE} встреч` : ''}
          >
            <Plus size={18} />
            Новая встреча
          </button>
        </div>

        {/* Stats row */}
        <div className={styles.statsRow}>
          <StatCard
            icon={<Video size={20} />}
            label="Активных встреч"
            value={`${activeMeetings.length} / ${MAX_ACTIVE}`}
            accent="blue"
          />
          <StatCard
            icon={<Users size={20} />}
            label="Участников макс."
            value={String(MAX_PER_ROOM)}
            accent="blue"
          />
          <StatCard
            icon={<Archive size={20} />}
            label="Всего встреч"
            value={String(meetings.length)}
            accent="amber"
          />
          <StatCard
            icon={<Shield size={20} />}
            label="С протоколом Senti"
            value={String(meetings.filter((m) => m.sentiStatus === 'done').length)}
            accent="amber"
          />
        </div>

        {/* Active meetings */}
        {activeMeetings.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Активные встречи</h2>
              <div className={styles.liveIndicator}>
                <span className="live-dot" aria-hidden="true" />
                <span>Live</span>
              </div>
            </div>

            <div className={styles.meetingsGrid}>
              {activeMeetings.map((m) => (
                <MeetingCard
                  key={m.id}
                  meeting={m}
                  isActive
                  onJoin={() => router.push(`/room/${m.id}`)}
                  formatDate={formatDate}
                  onCopyInvite={() => handleCopyInvite(m)}
                  copiedId={copiedId}
                />
              ))}
            </div>
          </section>
        )}

        {/* Scheduled meetings */}
        {scheduledMeetings.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Запланированные конференции</h2>
              <div className={styles.scheduledIndicator}>
                <CalendarClock size={16} />
                <span>Ожидают начала</span>
              </div>
            </div>

            <div className={styles.scheduledList}>
              {scheduledMeetings.map((m) => {
                const isCopied = copiedId === m.id
                return (
                  <div key={m.id} className={styles.scheduledRow}>
                    <div className={styles.scheduledInfo}>
                      <div className={styles.scheduledIcon}>
                        <Calendar size={22} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <h3 className={styles.scheduledTitle}>{m.title}</h3>
                        <div className={styles.scheduledMeta}>
                          <span className={styles.scheduledMetaItem}>
                            <Clock size={12} /> {formatDate(m.scheduledStart!)}
                          </span>
                          {m.isPublic && (
                            <span className="badge badge-green" style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Globe size={11} /> Публичная
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className={styles.scheduledActions}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleCopyInvite(m)}
                        title="Скопировать ссылку-приглашение"
                      >
                        {isCopied ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
                        {isCopied ? 'Скопировано!' : 'Копировать ссылку'}
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => router.push(`/room/${m.id}`)}
                      >
                        <Zap size={14} /> Войти
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Past meetings */}
        {pastMeetings.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Прошедшие встречи</h2>
              <a href="/archive" className={styles.viewAll}>
                Все <ChevronRight size={14} />
              </a>
            </div>

            <div className={styles.meetingsList}>
              {pastMeetings.slice(0, 5).map((m) => (
                <PastMeetingRow
                  key={m.id}
                  meeting={m}
                  onClick={() => router.push(`/archive/${m.id}`)}
                  formatDate={formatDate}
                  formatDuration={formatDuration}
                />
              ))}
            </div>
          </section>
        )}

        {meetings.length === 0 && (
          <EmptyState onCreate={() => setShowCreate(true)} />
        )}
      </main>

      {/* Create meeting modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3 style={{ marginBottom: 'var(--space-4)' }}>Новая встреча</h3>
            <form onSubmit={handleCreate}>
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <label className={styles.label} htmlFor="meeting-title">
                  Название встречи
                </label>
                <input
                  id="meeting-title"
                  className="input-field"
                  type="text"
                  placeholder="Еженедельный синк команды"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  autoFocus
                  maxLength={200}
                  required
                />
              </div>

              {/* Schedule meeting checkbox */}
              <div className={styles.modalOption}>
                <input
                  id="schedule-toggle"
                  type="checkbox"
                  checked={isScheduled}
                  onChange={(e) => {
                    setIsScheduled(e.target.checked)
                    if (e.target.checked && !scheduleTime) {
                      const d = new Date()
                      d.setHours(d.getHours() + 1)
                      d.setMinutes(0)
                      const offset = d.getTimezoneOffset()
                      const localDate = new Date(d.getTime() - offset * 60 * 1000)
                      setScheduleTime(localDate.toISOString().slice(0, 16))
                    }
                  }}
                />
                <label htmlFor="schedule-toggle">
                  Запланировать на определённое время
                </label>
              </div>

              {/* Date & Time Picker */}
              {isScheduled && (
                <div style={{ marginBottom: 'var(--space-4)', animation: 'fade-up 0.2s ease' }}>
                  <label className={styles.label} htmlFor="meeting-time">
                    Дата и время начала
                  </label>
                  <input
                    id="meeting-time"
                    className="input-field"
                    type="datetime-local"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    required={isScheduled}
                  />
                </div>
              )}

              {/* Public toggle */}
              <div className={styles.modalOption} style={{ marginBottom: 'var(--space-4)' }}>
                <input
                  id="public-toggle"
                  type="checkbox"
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                />
                <label htmlFor="public-toggle">
                  Публичная встреча (разрешить вход гостям без авторизации)
                </label>
              </div>

              {/* Waiting Room toggle */}
              <div className={styles.modalOption} style={{ marginBottom: 'var(--space-6)' }}>
                <input
                  id="waiting-room-toggle"
                  type="checkbox"
                  checked={waitingRoomEnabled}
                  onChange={(e) => setWaitingRoomEnabled(e.target.checked)}
                />
                <label htmlFor="waiting-room-toggle">
                  Включить зал ожидания (требуется одобрение организатора)
                </label>
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>
                  Отмена
                </button>
                <button
                  id="confirm-create-btn"
                  type="submit"
                  className="btn btn-primary"
                  disabled={!newTitle.trim() || creating}
                >
                  {creating ? 'Создание...' : isScheduled ? 'Запланировать' : 'Создать и войти'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ icon, label, value, accent }: {
  icon: React.ReactNode; label: string; value: string; accent: 'blue' | 'amber'
}) {
  return (
    <div className={`${styles.statCard} ${styles[`statCard_${accent}`]}`}>
      <div className={`${styles.statIcon} ${styles[`statIcon_${accent}`]}`}>{icon}</div>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

function MeetingCard({ meeting, isActive, onJoin, formatDate, onCopyInvite, copiedId }: {
  meeting: Meeting; isActive: boolean; onJoin: () => void; formatDate: (s: string) => string; onCopyInvite: () => void; copiedId: string | null
}) {
  const count = meeting.participants?.length ?? 0
  const isCopied = copiedId === meeting.id
  return (
    <div className={styles.meetingCard}>
      <div className={styles.meetingCardTop}>
        <span className="badge badge-green">
          <span className="live-dot" style={{ width: 6, height: 6 }} aria-hidden="true" />
          Активна
        </span>
        <span className={styles.participantCount}>
          <Users size={12} />
          {count} / {MAX_PER_ROOM}
        </span>
      </div>
      <h3 className={styles.meetingTitle}>{meeting.title}</h3>
      <p className={styles.meetingMeta}>
        <Clock size={12} /> {meeting.scheduledStart ? `Начало: ${formatDate(meeting.scheduledStart)}` : formatDate(meeting.createdAt)}
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'auto', width: '100%' }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onCopyInvite}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: '0.8125rem' }}
          title="Скопировать приглашение"
        >
          {isCopied ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
          {isCopied ? 'Скопировано' : 'Пригласить'}
        </button>
        <button
          id={`join-meeting-${meeting.id}`}
          className="btn btn-primary btn-sm"
          onClick={onJoin}
          style={{ flex: 1 }}
        >
          <Zap size={14} /> Войти
        </button>
      </div>
    </div>
  )
}

function PastMeetingRow({ meeting, onClick, formatDate, formatDuration }: {
  meeting: Meeting; onClick: () => void; formatDate: (s: string) => string; formatDuration: (s?: number) => string
}) {
  return (
    <button className={styles.pastRow} onClick={onClick}>
      <div className={styles.pastRowIcon}>
        {meeting.sentiStatus === 'done'
          ? <span className="badge badge-amber" style={{ fontSize: 10 }}>Senti</span>
          : <Archive size={14} color="var(--color-text-muted)" />
        }
      </div>
      <div className={styles.pastRowContent}>
        <span className={styles.pastRowTitle}>{meeting.title}</span>
        <span className={styles.pastRowMeta}>{formatDate(meeting.scheduledStart ?? meeting.createdAt)}</span>
      </div>
      <div className={styles.pastRowDuration}>
        <Clock size={12} />
        {formatDuration(meeting.durationSec)}
      </div>
      <ChevronRight size={16} color="var(--color-text-muted)" />
    </button>
  )
}

function SidebarItem({ icon, label, active, href }: {
  icon: React.ReactNode; label: string; active?: boolean; href: string
}) {
  return (
    <a
      href={href}
      className={`${styles.sidebarItem} ${active ? styles.sidebarItemActive : ''}`}
      title={label}
      aria-label={label}
    >
      {icon}
      <span className={styles.sidebarItemLabel}>{label}</span>
    </a>
  )
}



function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}><Video size={40} color="var(--color-text-muted)" /></div>
      <h3>Нет встреч</h3>
      <p>Создайте первую встречу и пригласите коллег</p>
      <button className="btn btn-primary" onClick={onCreate}><Plus size={16} />Создать встречу</button>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div style={{ padding: 'var(--space-8)' }}>
      {[1, 2, 3].map((i) => (
        <div key={i} className="skeleton" style={{ height: 80, marginBottom: 16, borderRadius: 'var(--radius-lg)' }} />
      ))}
    </div>
  )
}
