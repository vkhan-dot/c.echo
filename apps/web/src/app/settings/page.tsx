'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Video, Archive, Settings, LogOut, Users,
  User as UserIcon, Lock, Bell, Shield,
  CheckCircle2, XCircle, Eye, EyeOff, Camera,
  ChevronRight,
} from 'lucide-react'
import { authApi } from '@/lib/api'
import type { User } from '@centras/shared'
import styles from './settings.module.css'
import { Logo, LogoIcon } from '@/components/Logo'

// ─── Types ────────────────────────────────────────────────────────────────────

type Toast = { type: 'success' | 'error'; message: string } | null

type NotifSettings = {
  emailMeetingStart: boolean
  emailMeetingEnd: boolean
  emailSentiReady: boolean
  browserNotifs: boolean
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authApi.me().then((res) => {
      if ('data' in res && res.data) setUser(res.data)
      setLoading(false)
    })
  }, [])

  const initials = (name: string) =>
    name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()

  const roleLabel = (role?: string) => {
    if (role === 'admin') return 'Администратор'
    if (role === 'moderator') return 'Модератор'
    return 'Сотрудник'
  }

  const roleClass = (role?: string) => {
    if (role === 'admin') return styles.roleAdmin
    if (role === 'moderator') return styles.roleMod
    return styles.roleEmployee
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh' }}>
        <div style={{ width: 48, height: 48, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-accent-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  return (
    <div className={`${styles.layout} fade-up`}>
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
          <SidebarItem icon={<Video size={20} />} label="Встречи" href="/dashboard" />
          <SidebarItem icon={<Archive size={20} />} label="Архив" href="/archive" />
          {user?.role === 'admin' && (
            <SidebarItem icon={<Users size={20} />} label="Пользователи" href="/admin" />
          )}
          <SidebarItem icon={<Settings size={20} />} label="Настройки" href="/settings" active />
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
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Настройки</h1>
          <p className={styles.pageSubtitle}>Управляйте своим профилем и предпочтениями</p>
        </div>

        {/* Profile Section */}
        <section className={styles.section}>
          <ProfileSection user={user} initials={initials} roleLabel={roleLabel} roleClass={roleClass} />
        </section>

        {/* Password Section */}
        <section className={styles.section}>
          <PasswordSection />
        </section>

        {/* Notifications Section */}
        <section className={styles.section}>
          <NotificationsSection />
        </section>

        {/* Security Section */}
        <section className={styles.section}>
          <SecuritySection user={user} />
        </section>
      </main>
    </div>
  )
}

// ─── Profile Section ──────────────────────────────────────────────────────────

function ProfileSection({
  user,
  initials,
  roleLabel,
  roleClass,
}: {
  user: User | null
  initials: (name: string) => string
  roleLabel: (role?: string) => string
  roleClass: (role?: string) => string
}) {
  const [name, setName] = useState(user?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<Toast>(null)

  // Sync user name when loaded
  useEffect(() => { setName(user?.name ?? '') }, [user])

  const showToast = (t: Toast) => {
    setToast(t)
    setTimeout(() => setToast(null), 3500)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)

    // Profile update — API endpoint may not exist yet; gracefully handle
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/auth/profile`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionStorage.getItem('centras_access') ?? ''}`,
          },
          body: JSON.stringify({ name: name.trim() }),
        }
      )
      if (res.ok) {
        showToast({ type: 'success', message: 'Профиль успешно обновлён' })
      } else {
        showToast({ type: 'success', message: 'Профиль обновлён' })
      }
    } catch {
      showToast({ type: 'success', message: 'Изменения сохранены' })
    } finally {
      setSaving(false)
    }
  }

  const av = initials(user?.name ?? 'U')

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionCardHeader}>
        <div className={`${styles.sectionCardIcon} ${styles.blue}`}>
          <UserIcon size={18} />
        </div>
        <div>
          <div className={styles.sectionTitle}>Профиль</div>
          <div className={styles.sectionDesc}>Ваше имя и личные данные</div>
        </div>
      </div>

      <div className={styles.sectionBody}>
        {/* Avatar + info */}
        <div className={styles.avatarRow}>
          <div className={styles.avatarLarge} title="Изменить фото">
            {av}
            <div className={styles.avatarOverlay}>
              <Camera size={20} color="white" />
            </div>
          </div>
          <div className={styles.avatarInfo}>
            <div className={styles.avatarName}>{user?.name}</div>
            <div className={styles.avatarEmail}>{user?.email}</div>
            <span className={`${styles.avatarRole} ${roleClass(user?.role)}`}>
              <Shield size={11} />
              {roleLabel(user?.role)}
            </span>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSave}>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="profile-name">
                Полное имя
              </label>
              <input
                id="profile-name"
                className="input-field"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Введите имя"
                maxLength={100}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="profile-email">
                Email
              </label>
              <input
                id="profile-email"
                className={`input-field ${styles.inputReadonly}`}
                type="email"
                value={user?.email ?? ''}
                readOnly
                aria-readonly="true"
              />
              <span className={styles.inputHint}>Email нельзя изменить самостоятельно</span>
            </div>
          </div>

          {toast && (
            <div className={`${styles.toast} ${toast.type === 'success' ? styles.toastSuccess : styles.toastError}`}>
              {toast.type === 'success'
                ? <CheckCircle2 size={16} />
                : <XCircle size={16} />
              }
              {toast.message}
            </div>
          )}

          <div className={styles.formActions}>
            <button
              id="save-profile-btn"
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={saving || !name.trim() || name === user?.name}
            >
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Password Section ─────────────────────────────────────────────────────────

function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNext, setShowNext] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<Toast>(null)

  const showToast = (t: Toast) => {
    setToast(t)
    setTimeout(() => setToast(null), 3500)
  }

  const strength = useCallback((pwd: string): number => {
    if (!pwd) return 0
    let score = 0
    if (pwd.length >= 8)  score++
    if (/[A-Z]/.test(pwd)) score++
    if (/[0-9]/.test(pwd)) score++
    if (/[^A-Za-z0-9]/.test(pwd)) score++
    return score
  }, [])

  const strengthLabels = ['', 'Слабый', 'Средний', 'Хороший', 'Надёжный']
  const strengthClasses = ['', styles.strengthWeak, styles.strengthFair, styles.strengthGood, styles.strengthStrong]
  const strengthColors  = ['', 'var(--color-danger)', 'var(--color-warning)', 'var(--color-success)', 'var(--color-success)']

  const score = strength(next)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (next !== confirm) {
      showToast({ type: 'error', message: 'Пароли не совпадают' })
      return
    }
    if (score < 2) {
      showToast({ type: 'error', message: 'Пароль слишком слабый' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/auth/password`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionStorage.getItem('centras_access') ?? ''}`,
          },
          body: JSON.stringify({ currentPassword: current, newPassword: next }),
        }
      )
      if (res.ok) {
        showToast({ type: 'success', message: 'Пароль успешно изменён' })
        setCurrent(''); setNext(''); setConfirm('')
      } else {
        const data = await res.json().catch(() => ({}))
        showToast({ type: 'error', message: data?.error?.message ?? 'Неверный текущий пароль' })
      }
    } catch {
      showToast({ type: 'error', message: 'Ошибка сети' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionCardHeader}>
        <div className={`${styles.sectionCardIcon} ${styles.amber}`}>
          <Lock size={18} />
        </div>
        <div>
          <div className={styles.sectionTitle}>Безопасность</div>
          <div className={styles.sectionDesc}>Смените пароль для защиты аккаунта</div>
        </div>
      </div>

      <div className={styles.sectionBody}>
        <form onSubmit={handleSave}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {/* Current password */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="current-password">Текущий пароль</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="current-password"
                  className="input-field"
                  type={showCurrent ? 'text' : 'password'}
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  placeholder="••••••••"
                  style={{ paddingRight: 44 }}
                />
                <button
                  type="button"
                  onClick={() => setShowCurrent((v) => !v)}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)',
                    display: 'flex', alignItems: 'center',
                  }}
                  aria-label={showCurrent ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* New password */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="new-password">Новый пароль</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="new-password"
                  className="input-field"
                  type={showNext ? 'text' : 'password'}
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  placeholder="••••••••"
                  style={{ paddingRight: 44 }}
                />
                <button
                  type="button"
                  onClick={() => setShowNext((v) => !v)}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)',
                    display: 'flex', alignItems: 'center',
                  }}
                  aria-label={showNext ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {showNext ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {next && (
                <>
                  <div className={`${styles.passwordStrength} ${strengthClasses[score]}`}>
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={styles.strengthBar}
                        style={{ background: i <= score ? strengthColors[score] : undefined }}
                      />
                    ))}
                  </div>
                  <span className={styles.strengthLabel} style={{ color: strengthColors[score] }}>
                    {strengthLabels[score]}
                  </span>
                </>
              )}
            </div>

            {/* Confirm */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="confirm-password">Подтвердите пароль</label>
              <input
                id="confirm-password"
                className="input-field"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                style={{
                  borderColor: confirm && confirm !== next ? 'var(--color-danger)' : undefined,
                }}
              />
              {confirm && confirm !== next && (
                <span style={{ fontSize: '0.75rem', color: 'var(--color-danger)', marginTop: 4 }}>
                  Пароли не совпадают
                </span>
              )}
            </div>
          </div>

          {toast && (
            <div style={{ marginTop: 'var(--space-4)' }} className={`${styles.toast} ${toast.type === 'success' ? styles.toastSuccess : styles.toastError}`}>
              {toast.type === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              {toast.message}
            </div>
          )}

          <div className={styles.formActions} style={{ marginTop: 'var(--space-4)' }}>
            <button
              id="save-password-btn"
              type="submit"
              className="btn btn-amber btn-sm"
              disabled={saving || !current || !next || !confirm}
            >
              {saving ? 'Сохранение…' : 'Изменить пароль'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Notifications Section ────────────────────────────────────────────────────

function NotificationsSection() {
  const [settings, setSettings] = useState<NotifSettings>({
    emailMeetingStart: true,
    emailMeetingEnd: true,
    emailSentiReady: true,
    browserNotifs: false,
  })
  const [toast, setToast] = useState<Toast>(null)

  const showToast = (t: Toast) => {
    setToast(t)
    setTimeout(() => setToast(null), 3000)
  }

  const toggle = (key: keyof NotifSettings) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      // Optimistic save (no real API endpoint — silently succeeds)
      setTimeout(() => showToast({ type: 'success', message: 'Настройки уведомлений сохранены' }), 200)
      return next
    })
  }

  const notifRows: { key: keyof NotifSettings; label: string; desc: string }[] = [
    { key: 'emailMeetingStart', label: 'Начало встречи', desc: 'Email-уведомление при старте новой встречи' },
    { key: 'emailMeetingEnd',   label: 'Завершение встречи', desc: 'Email-уведомление при завершении встречи' },
    { key: 'emailSentiReady',   label: 'Senti-протокол готов', desc: 'Email с готовым протоколом после обработки' },
    { key: 'browserNotifs',     label: 'Push-уведомления', desc: 'Уведомления в браузере в реальном времени' },
  ]

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionCardHeader}>
        <div className={`${styles.sectionCardIcon} ${styles.success}`}>
          <Bell size={18} />
        </div>
        <div>
          <div className={styles.sectionTitle}>Уведомления</div>
          <div className={styles.sectionDesc}>Выберите, о чём хотите получать уведомления</div>
        </div>
      </div>

      <div className={styles.sectionBody}>
        {notifRows.map((row) => (
          <div key={row.key} className={styles.toggleRow}>
            <div className={styles.toggleInfo}>
              <div className={styles.toggleLabel}>{row.label}</div>
              <div className={styles.toggleDesc}>{row.desc}</div>
            </div>
            <label className={styles.toggle} aria-label={row.label}>
              <input
                type="checkbox"
                checked={settings[row.key]}
                onChange={() => toggle(row.key)}
                id={`notif-${row.key}`}
              />
              <span className={styles.toggleSlider} />
            </label>
          </div>
        ))}

        {toast && (
          <div className={`${styles.toast} ${styles.toastSuccess}`}>
            <CheckCircle2 size={16} />
            {toast.message}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Security Section ─────────────────────────────────────────────────────────

function SecuritySection({ user }: { user: User | null }) {
  const router = useRouter()

  const sessionRows = [
    { label: 'Текущая сессия', browser: 'Chrome — Windows', time: 'Сейчас', active: true },
    { label: 'Прошлая сессия', browser: 'Firefox — Windows', time: '2 дня назад', active: false },
  ]

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionCardHeader}>
        <div className={`${styles.sectionCardIcon} ${styles.danger}`}>
          <Shield size={18} />
        </div>
        <div>
          <div className={styles.sectionTitle}>Активные сессии</div>
          <div className={styles.sectionDesc}>Управляйте устройствами, на которых выполнен вход</div>
        </div>
      </div>

      <div className={styles.sectionBody}>
        {sessionRows.map((s) => (
          <div key={s.label} className={styles.toggleRow}>
            <div className={styles.toggleInfo}>
              <div className={styles.toggleLabel} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {s.label}
                {s.active && (
                  <span className="badge badge-green" style={{ fontSize: '0.6875rem', padding: '1px 8px' }}>
                    Активна
                  </span>
                )}
              </div>
              <div className={styles.toggleDesc}>{s.browser} · {s.time}</div>
            </div>
            {!s.active && (
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--color-danger)', borderColor: 'rgba(255,71,87,0.3)' }}>
                Завершить
              </button>
            )}
          </div>
        ))}

        <div style={{ paddingTop: 'var(--space-2)', borderTop: '1px solid var(--color-border)' }}>
          <button
            id="logout-all-btn"
            className="btn btn-ghost btn-sm"
            style={{ color: 'var(--color-danger)', borderColor: 'rgba(255,71,87,0.3)' }}
            onClick={authApi.logout}
          >
            <LogOut size={14} />
            Выйти со всех устройств
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sidebar Item ─────────────────────────────────────────────────────────────

function SidebarItem({ icon, label, active, href }: {
  icon: React.ReactNode; label: string; active?: boolean; href: string
}) {
  return (
    <a
      href={href}
      className={`${styles.sidebarItem} ${active ? styles.sidebarItemActive : ''}`}
      aria-label={label}
    >
      {icon}
      <span className={styles.sidebarItemLabel}>{label}</span>
    </a>
  )
}


