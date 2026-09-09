'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { meetingsApi, authApi } from '@/lib/api'
import type { Meeting, User } from '@centras/shared'
import { Archive, Clock, Users, Search, Bot, Video, CheckSquare } from 'lucide-react'
import styles from './archive.module.css'
import { LogoIcon } from '@/components/Logo'



function Sidebar({ user }: { user: User | null }) {
  return (
    <aside className="sidebar">
      <div style={{ marginBottom: 'var(--space-6)', display: 'flex', justifyContent: 'center' }}>
        <LogoIcon width={38} height={38} />
      </div>
      <a href="/dashboard" aria-label="Встречи" title="Встречи">
        <Video size={22} color="var(--color-text-muted)" />
      </a>
      <a href="/archive" aria-label="Архив" title="Архив">
        <Archive size={22} color="var(--color-accent-blue)" />
      </a>
      {user?.role === 'admin' && (
        <a href="/admin" aria-label="Пользователи" title="Пользователи">
          <Users size={22} color="var(--color-text-muted)" />
        </a>
      )}
    </aside>
  )
}

// ─── Archive page ─────────────────────────────────────────────────────────────

export default function ArchivePage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)

  // Filters
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'senti' | 'no-senti'>('all')

  const loadData = useCallback(async () => {
    const [meRes, meetRes] = await Promise.all([authApi.me(), meetingsApi.list()])
    if ('data' in meRes) setUser(meRes.data ?? null)
    if ('data' in meetRes) setMeetings((meetRes.data ?? []).filter((m) => m.endedAt))
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const filtered = meetings.filter((m) => {
    if (filter === 'senti' && m.sentiStatus !== 'done') return false
    if (filter === 'no-senti' && m.sentiStatus === 'done') return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return m.title.toLowerCase().includes(q) ||
        m.summary?.summary?.toLowerCase().includes(q)
    }
    return true
  })

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))

  const formatDuration = (sec?: number) => {
    if (!sec) return '—'
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  return (
    <div className={`${styles.layout} fade-up`}>
      <Sidebar user={user} />
      <main className={styles.main}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h1>
              <Archive
                size={28}
                style={{ marginRight: 10, verticalAlign: 'middle', color: 'var(--color-accent-blue)' }}
              />
              Архив встреч
            </h1>
            <p className={styles.headerSub}>
              {loading ? 'Загрузка…' : `${meetings.length} встреч завершено`}
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className={styles.filters}>
          <div className={styles.searchWrap}>
            <Search size={16} className={styles.searchIcon} />
            <input
              id="archive-search"
              type="search"
              className={styles.searchInput}
              placeholder="Поиск по названию или резюме…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            id="archive-filter-select"
            className={styles.filterSelect}
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="all">Все встречи</option>
            <option value="senti">С Senti-протоколом</option>
            <option value="no-senti">Без протокола</option>
          </select>
        </div>

        {/* Grid */}
        {loading ? (
          <SkeletonGrid />
        ) : (
          <div className={styles.meetingsGrid}>
            {filtered.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>
                  <Archive size={32} color="var(--color-text-muted)" />
                </div>
                <p className={styles.emptyTitle}>Нет встреч</p>
                <p className={styles.emptyDesc}>
                  {search || filter !== 'all'
                    ? 'Ничего не найдено. Измените параметры фильтрации.'
                    : 'Завершённые встречи появятся здесь'}
                </p>
              </div>
            ) : (
              filtered.map((m) => (
                <MeetingCard
                  key={m.id}
                  meeting={m}
                  formatDate={formatDate}
                  formatDuration={formatDuration}
                  onClick={() => router.push(`/archive/${m.id}`)}
                />
              ))
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// ─── Meeting card ─────────────────────────────────────────────────────────────

function MeetingCard({
  meeting,
  formatDate,
  formatDuration,
  onClick,
}: {
  meeting: Meeting
  formatDate: (s: string) => string
  formatDuration: (n?: number) => string
  onClick: () => void
}) {
  const hasSenti = meeting.sentiStatus === 'done'
  const isProcessing = meeting.sentiStatus === 'processing'

  return (
    <button className={styles.card} onClick={onClick} id={`meeting-card-${meeting.id}`}>
      <div className={styles.cardTop}>
        {hasSenti ? (
          <span className="badge badge-amber">
            <Bot size={11} />
            Senti
          </span>
        ) : isProcessing ? (
          <span className="badge badge-blue">
            <Bot size={11} />
            Обрабатывается…
          </span>
        ) : (
          <span className="badge" style={{ background: 'var(--color-bg-surface-2)', color: 'var(--color-text-muted)' }}>
            <Video size={11} />
            Без протокола
          </span>
        )}
      </div>

      <div className={styles.cardTitle}>{meeting.title}</div>

      <div className={styles.cardMeta}>
        <span className={styles.cardMetaItem}>
          <Clock size={12} />
          {formatDate(meeting.createdAt)}
        </span>
        <span className={styles.cardMetaItem}>
          <Clock size={12} />
          {formatDuration(meeting.durationSec)}
        </span>
        {meeting.participants && (
          <span className={styles.cardMetaItem}>
            <Users size={12} />
            {meeting.participants.length}
          </span>
        )}
      </div>

      {hasSenti && meeting.summary?.summary && (
        <p className={styles.cardSummary}>{meeting.summary.summary}</p>
      )}

      {hasSenti && meeting.summary?.tasks && meeting.summary.tasks.length > 0 && (
        <div className={styles.cardTasks}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
            <CheckSquare size={12} color="var(--color-accent-amber)" />
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontWeight: 600 }}>
              Задачи ({meeting.summary.tasks.length})
            </span>
          </div>
          {meeting.summary.tasks.slice(0, 2).map((t) => (
            <div key={t.id} className={styles.cardTask}>
              <div className={styles.cardTaskDot} />
              <span>{t.text}</span>
            </div>
          ))}
          {meeting.summary.tasks.length > 2 && (
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginLeft: 13 }}>
              +{meeting.summary.tasks.length - 2} ещё
            </span>
          )}
        </div>
      )}
    </button>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div className={styles.skeletonGrid}>
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className={styles.skeletonCard}>
          <div className="skeleton" style={{ width: 80, height: 22, borderRadius: 20 }} />
          <div className="skeleton" style={{ height: 20, width: '80%' }} />
          <div className="skeleton" style={{ height: 14, width: '60%' }} />
          <div className="skeleton" style={{ height: 40 }} />
        </div>
      ))}
    </div>
  )
}
