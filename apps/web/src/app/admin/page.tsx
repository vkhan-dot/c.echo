'use client'

import { useEffect, useState, useCallback } from 'react'
import { adminApi, authApi } from '@/lib/api'
import type { User } from '@centras/shared'
import styles from './admin.module.css'
import { UserPlus, Trash2, Shield, Edit2, X, Check, Users, Video, BarChart2, Archive } from 'lucide-react'
import { LogoIcon } from '@/components/Logo'

type Role = 'admin' | 'moderator' | 'employee'

const ROLE_LABELS: Record<Role, string> = {
  admin: 'Администратор',
  moderator: 'Модератор',
  employee: 'Сотрудник',
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([])
  const [stats, setStats] = useState({ totalUsers: 0, totalMeetings: 0, activeMeetings: 0 })
  const [showCreate, setShowCreate] = useState(false)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ email: '', name: '', role: 'employee' as Role })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    const [usersRes, statsRes, meRes] = await Promise.all([
      adminApi.listUsers(),
      adminApi.stats(),
      authApi.me()
    ])
    if ('data' in usersRes) setUsers(usersRes.data ?? [])
    if ('data' in statsRes) setStats(statsRes.data ?? { totalUsers: 0, totalMeetings: 0, activeMeetings: 0 })
    if ('data' in meRes) setCurrentUser(meRes.data ?? null)
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setError(null)

    const res = await adminApi.createUser(form)
    if ('data' in res && res.data) {
      setUsers((prev) => [res.data!, ...prev])
      setShowCreate(false)
      setForm({ email: '', name: '', role: 'employee' })
      setStats((s) => ({ ...s, totalUsers: s.totalUsers + 1 }))
    } else {
      setError(res.error.message)
    }
    setCreating(false)
  }

  const handleUpdateRole = async (id: string, role: string) => {
    const res = await adminApi.updateUser(id, { role })
    if ('data' in res && res.data) {
      setUsers((prev) => prev.map((u) => u.id === id ? { ...u, role: res.data!.role } : u))
      setEditingId(null)
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Удалить пользователя ${name}? Это действие нельзя отменить.`)) return
    await adminApi.deleteUser(id)
    setUsers((prev) => prev.filter((u) => u.id !== id))
    setStats((s) => ({ ...s, totalUsers: s.totalUsers - 1 }))
  }

  const initials = (name: string) =>
    name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()

  if (loading) {
    return <div style={{ padding: 'var(--space-8)' }}>
      {[1,2,3,4].map((i) => (
        <div key={i} className="skeleton" style={{ height: 64, marginBottom: 12, borderRadius: 'var(--radius-md)' }} />
      ))}
    </div>
  }

  return (
    <div className="app-layout fade-up">
      <Sidebar user={currentUser} />
      <main className="main-content">
        <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1>Управление пользователями</h1>
          <p>Добавляйте сотрудников — они войдут через корпоративный Google аккаунт</p>
        </div>
        <button
          id="add-user-btn"
          className="btn btn-primary"
          onClick={() => setShowCreate(true)}
        >
          <UserPlus size={18} />
          Добавить сотрудника
        </button>
      </div>

      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <Users size={20} color="var(--color-accent-blue)" />
          <div className={styles.statNum}>{stats.totalUsers}</div>
          <div className={styles.statLabel}>Пользователей</div>
        </div>
        <div className={styles.statCard}>
          <Video size={20} color="var(--color-accent-amber)" />
          <div className={styles.statNum}>{stats.totalMeetings}</div>
          <div className={styles.statLabel}>Всего встреч</div>
        </div>
        <div className={styles.statCard}>
          <BarChart2 size={20} color="var(--color-success)" />
          <div className={styles.statNum}>{stats.activeMeetings}</div>
          <div className={styles.statLabel}>Активных сейчас</div>
        </div>
      </div>

      {/* Users table */}
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Пользователь</th>
              <th>Email</th>
              <th>Роль</th>
              <th>Дата добавления</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className={styles.tableRow}>
                <td>
                  <div className={styles.userCell}>
                    <div className="avatar avatar-sm">{initials(user.name)}</div>
                    <span className={styles.userName}>{user.name}</span>
                  </div>
                </td>
                <td className={styles.email}>{user.email}</td>
                <td>
                  {editingId === user.id ? (
                    <div className={styles.roleEdit}>
                      <select
                        className={styles.roleSelect}
                        defaultValue={user.role}
                        onChange={(e) => handleUpdateRole(user.id, e.target.value)}
                        autoFocus
                        aria-label="Изменить роль"
                      >
                        {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditingId(null)}>
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className={styles.roleDisplay}>
                      <span className={`badge ${user.role === 'admin' ? 'badge-amber' : 'badge-blue'}`}>
                        {user.role === 'admin' && <Shield size={11} />}
                        {ROLE_LABELS[user.role as Role] ?? user.role}
                      </span>
                      <button
                        className={styles.editBtn}
                        onClick={() => setEditingId(user.id)}
                        title="Изменить роль"
                        aria-label={`Изменить роль ${user.name}`}
                      >
                        <Edit2 size={13} />
                      </button>
                    </div>
                  )}
                </td>
                <td className={styles.date}>
                  {new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(user.createdAt))}
                </td>
                <td>
                  <button
                    className="btn btn-ghost btn-sm btn-icon"
                    onClick={() => handleDelete(user.id, user.name)}
                    title="Удалить пользователя"
                    aria-label={`Удалить ${user.name}`}
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {users.length === 0 && (
          <div className={styles.emptyTable}>
            <Users size={32} color="var(--color-text-muted)" />
            <p>Нет пользователей. Добавьте первого сотрудника.</p>
          </div>
        )}
      </div>

      {/* Create user modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 'var(--space-2)' }}>Добавить сотрудника</h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-6)' }}>
              Сотрудник получит доступ к платформе через корпоративный Google аккаунт.
            </p>

            {error && (
              <div className="badge badge-red" style={{ display: 'flex', padding: '10px 14px', marginBottom: 'var(--space-4)', borderRadius: 'var(--radius-md)' }}>
                {error}
              </div>
            )}

            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <div>
                <label className={styles.label} htmlFor="new-user-name">Имя и фамилия</label>
                <input
                  id="new-user-name"
                  className="input-field"
                  type="text"
                  placeholder="Айжан Сейткали"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className={styles.label} htmlFor="new-user-email">Корпоративный email</label>
                <input
                  id="new-user-email"
                  className="input-field"
                  type="email"
                  placeholder="a.seitkali@centras.kz"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className={styles.label} htmlFor="new-user-role">Роль</label>
                <select
                  id="new-user-role"
                  className="input-field"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
                >
                  {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end', marginTop: 'var(--space-2)' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>
                  Отмена
                </button>
                <button
                  id="confirm-create-user-btn"
                  type="submit"
                  className="btn btn-primary"
                  disabled={creating}
                >
                  {creating ? 'Добавление...' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
        </div>
      </main>
    </div>
  )
}



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
        <Archive size={22} color="var(--color-text-muted)" />
      </a>
      {user?.role === 'admin' && (
        <a href="/admin" aria-label="Пользователи" title="Пользователи">
          <Users size={22} color="var(--color-accent-blue)" />
        </a>
      )}
    </aside>
  )
}
