'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { meetingsApi, sentiApi, authApi } from '@/lib/api'
import type { Meeting, User, TranscriptEntry, SentiChatResponse } from '@centras/shared'
import {
  Archive, Clock, Users, Bot, ChevronRight, Search,
  Send, Volume2, CheckSquare, Zap, FileText, MessageSquare,
  Circle, CheckCircle2, AlertCircle, User as UserIcon, Calendar,
  Video,
} from 'lucide-react'
import styles from './protocol.module.css'
import { LogoIcon } from '@/components/Logo'

type TabId = 'protocol' | 'transcript' | 'chat'

// ─── Chat message type ────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'senti'
  text: string
  references?: SentiChatResponse['references']
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProtocolPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabId>('protocol')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      const [meRes, meetRes, transcriptRes] = await Promise.all([
        authApi.me(),
        meetingsApi.get(id),
        meetingsApi.getTranscript(id),
      ])
      if (!active) return
      if ('data' in meRes) setUser(meRes.data ?? null)
      if ('data' in meetRes) setMeeting(meetRes.data ?? null)
      if ('data' in transcriptRes) setTranscript((transcriptRes.data ?? []) as TranscriptEntry[])
      setLoading(false)
    }
    load()
    return () => {
      active = false
    }
  }, [id])

  const handleUploadAudio = async (file: File) => {
    const res = await meetingsApi.uploadAudio(id, file)
    if ('error' in res) {
      throw new Error(res.error?.message ?? 'Ошибка загрузки')
    }
    setMeeting((prev) => prev ? { ...prev, sentiStatus: 'processing' } : null)

    // Poll for completion
    const iv = setInterval(async () => {
      const meetRes = await meetingsApi.get(id)
      if ('data' in meetRes && meetRes.data) {
        if (meetRes.data.sentiStatus === 'done') {
          clearInterval(iv)
          setMeeting(meetRes.data)
          const transcriptRes = await meetingsApi.getTranscript(id)
          if ('data' in transcriptRes) {
            setTranscript((transcriptRes.data ?? []) as TranscriptEntry[])
          }
        } else if (meetRes.data.sentiStatus === 'failed') {
          clearInterval(iv)
          setMeeting(meetRes.data)
        }
      }
    }, 5000)
  }

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))

  const formatDuration = (sec?: number) => {
    if (!sec) return '—'
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    if (h > 0) return `${h}ч ${m}мин`
    return `${m}мин`
  }

  const formatSec = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  if (loading) {
    return (
      <div className={styles.layout}>
        <Sidebar user={null} />
        <main className={styles.main}>
          <div className={styles.loading}>
            <div className={styles.spinner} />
            <span>Загрузка протокола…</span>
          </div>
        </main>
      </div>
    )
  }

  if (!meeting) {
    return (
      <div className={styles.layout}>
        <Sidebar user={null} />
        <main className={styles.main}>
          <div className={styles.noSenti}>
            <div className={styles.noSentiIcon}>
              <AlertCircle size={28} color="var(--color-danger)" />
            </div>
            <p>Встреча не найдена</p>
            <button className="btn btn-ghost btn-sm" onClick={() => router.push('/archive')}>
              В архив
            </button>
          </div>
        </main>
      </div>
    )
  }

  const hasSenti = meeting.sentiStatus === 'done'
  const isProcessing = meeting.sentiStatus === 'processing'

  // Calculate metrics
  const totalPhrases = transcript.length
  const totalWords = transcript.reduce((acc, entry) => acc + (entry.phrase?.split(/\s+/).filter(Boolean).length || 0), 0)

  // Speaker breakdown
  const speakerMap: Record<string, { phrases: number; words: number }> = {}
  transcript.forEach((entry) => {
    const speaker = entry.speakerName || 'Неизвестный'
    if (!speakerMap[speaker]) {
      speakerMap[speaker] = { phrases: 0, words: 0 }
    }
    speakerMap[speaker].phrases += 1
    speakerMap[speaker].words += entry.phrase?.split(/\s+/).filter(Boolean).length || 0
  })

  const speakerStats = Object.entries(speakerMap).map(([name, stats]) => ({
    name,
    phrases: stats.phrases,
    words: stats.words,
    percentage: totalPhrases > 0 ? Math.round((stats.phrases / totalPhrases) * 100) : 0,
  })).sort((a, b) => b.phrases - a.phrases)

  const tabs: { id: TabId; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
    {
      id: 'protocol',
      label: 'Протокол',
      icon: <FileText size={15} />,
      disabled: !hasSenti,
    },
    {
      id: 'transcript',
      label: 'Транскрипт',
      icon: <MessageSquare size={15} />,
      disabled: transcript.length === 0,
    },
    {
      id: 'chat',
      label: 'Спроси Senti',
      icon: <Bot size={15} />,
      disabled: !hasSenti,
    },
  ]

  const handleExportPDF = async () => {
    if (exporting) return
    setExporting(true)

    try {
      const { jsPDF } = await import('jspdf')
      const html2canvas = (await import('html2canvas')).default

      const sourceElement = document.querySelector(`.${styles.printOnlyContainer}`) as HTMLElement
      if (!sourceElement) {
        throw new Error('Печатная форма не найдена')
      }

      // Temporarily display the source to clone nodes
      const originalDisplay = sourceElement.style.display
      sourceElement.style.setProperty('display', 'block', 'important')

      // Create temporary container for layout
      const tempContainer = document.createElement('div')
      tempContainer.style.position = 'absolute'
      tempContainer.style.left = '-9999px'
      tempContainer.style.top = '0'
      tempContainer.style.width = '794px'
      tempContainer.style.background = '#ffffff'
      document.body.appendChild(tempContainer)

      const createNewPage = () => {
        const page = document.createElement('div')
        page.className = styles.pdfPage
        page.style.width = '794px'
        page.style.height = '1123px'
        page.style.padding = '50px 60px'
        page.style.boxSizing = 'border-box'
        page.style.display = 'flex'
        page.style.flexDirection = 'column'
        page.style.background = '#ffffff'
        page.style.position = 'relative'
        return page
      }

      const pages: HTMLElement[] = []
      let currentPage = createNewPage()
      tempContainer.appendChild(currentPage)
      pages.push(currentPage)

      // Get all blocks with class 'pdf-section'
      const blocks = sourceElement.querySelectorAll('.pdf-section')
      const MAX_PAGE_CONTENT_HEIGHT = 970 // usable page content height leaving room for footer

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i].cloneNode(true) as HTMLElement
        currentPage.appendChild(block)

        // Calculate height including margins
        let currentHeight = 0
        const children = Array.from(currentPage.children)
        for (let j = 0; j < children.length; j++) {
          const child = children[j] as HTMLElement
          const style = window.getComputedStyle(child)
          const marginTop = parseFloat(style.marginTop || '0')
          const marginBottom = parseFloat(style.marginBottom || '0')
          currentHeight += (child.offsetHeight || 0) + marginTop + marginBottom
        }

        if (currentHeight > MAX_PAGE_CONTENT_HEIGHT && currentPage.children.length > 1) {
          currentPage.removeChild(block)

          currentPage = createNewPage()
          tempContainer.appendChild(currentPage)
          pages.push(currentPage)

          currentPage.appendChild(block)
        }
      }

      sourceElement.style.display = originalDisplay

      const pdf = new jsPDF({
        orientation: 'p',
        unit: 'px',
        format: [794, 1123],
      })

      for (let i = 0; i < pages.length; i++) {
        if (i > 0) {
          pdf.addPage()
        }

        // Footer element
        const footer = document.createElement('div')
        footer.style.position = 'absolute'
        footer.style.bottom = '25px'
        footer.style.left = '60px'
        footer.style.right = '60px'
        footer.style.display = 'flex'
        footer.style.justifyContent = 'space-between'
        footer.style.fontSize = '9px'
        footer.style.color = '#94A3B8'
        footer.style.borderTop = '1px solid #E2E8F0'
        footer.style.paddingTop = '8px'
        footer.style.fontFamily = 'sans-serif'
        footer.innerHTML = `<span>Centras Echo · Официальный протокол</span><span>Страница ${i + 1} из ${pages.length}</span>`
        pages[i].appendChild(footer)

        const canvas = await html2canvas(pages[i], {
          scale: 2.2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#ffffff',
          logging: false,
        })

        const imgData = canvas.toDataURL('image/jpeg', 0.92)
        pdf.addImage(imgData, 'JPEG', 0, 0, 794, 1123)
      }

      document.body.removeChild(tempContainer)

      const filename = `Protocol_${meeting.title.replace(/[^a-zA-Z0-9а-яА-ЯёЁ\s]/g, '_')}.pdf`
      pdf.save(filename)
    } catch (error) {
      console.error('Failed to export PDF:', error)
      alert('Не удалось экспортировать PDF: ' + (error as Error).message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={`${styles.layout} fade-up`}>
      <Sidebar user={user} />
      <main className={styles.main}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.breadcrumb}>
            <a href="/archive" className={styles.breadcrumbLink}>Архив</a>
            <ChevronRight size={14} />
            <span>{meeting.title}</span>
          </div>

          <div className={styles.titleRow}>
            <div>
              <h1 className={styles.meetingTitle}>{meeting.title}</h1>
              <div className={styles.meetingMeta}>
                <span className={styles.metaItem}>
                  <Clock size={13} />
                  {formatDate(meeting.createdAt)}
                </span>
                <span className={styles.metaItem}>
                  <Clock size={13} />
                  {formatDuration(meeting.durationSec)}
                </span>
                {meeting.participants && (
                  <span className={styles.metaItem}>
                    <Users size={13} />
                    {meeting.participants.length} участников
                  </span>
                )}
                {hasSenti && (
                  <span className="badge badge-amber">
                    <Bot size={11} />
                    Senti-протокол
                  </span>
                )}
                {isProcessing && (
                  <span className="badge badge-blue">
                    <Bot size={11} />
                    Обрабатывается…
                  </span>
                )}
              </div>
            </div>
            {hasSenti && (
              <button
                id="export-pdf-btn"
                className="btn btn-ghost btn-sm"
                onClick={handleExportPDF}
                disabled={exporting}
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {exporting ? (
                  <span className={styles.spinner} style={{ width: 14, height: 14, borderWidth: 1.5, display: 'inline-block' }} />
                ) : (
                  <FileText size={14} />
                )}
                {exporting ? 'Экспорт…' : 'Экспорт в PDF'}
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className={styles.tabs}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ''}`}
              onClick={() => !tab.disabled && setActiveTab(tab.id)}
              disabled={tab.disabled}
              style={tab.disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className={styles.tabContent}>
          {activeTab === 'protocol' && meeting.summary && (
            <ProtocolTab meeting={meeting} formatSec={formatSec} />
          )}

          {activeTab === 'protocol' && !hasSenti && (
            <NoSentiState isProcessing={isProcessing} onUpload={handleUploadAudio} />
          )}

          {activeTab === 'transcript' && (
            <TranscriptTab entries={transcript} formatSec={formatSec} meetingId={id} />
          )}

          {activeTab === 'chat' && hasSenti && (
            <ChatTab meetingId={id} />
          )}
        </div>
      </main>

      {/* Hidden print-only document */}
      {hasSenti && (
        <PrintProtocol
          meeting={meeting}
          transcript={transcript}
          speakerStats={speakerStats}
          totalWords={totalWords}
          totalPhrases={totalPhrases}
          formatDate={formatDate}
          formatDuration={formatDuration}
          formatSec={formatSec}
        />
      )}
    </div>
  )
}

// ─── Protocol Tab ─────────────────────────────────────────────────────────────

function ProtocolTab({
  meeting,
  formatSec,
}: {
  meeting: Meeting
  formatSec: (s: number) => string
}) {
  const s = meeting.summary!

  return (
    <>
      {/* Summary */}
      <div className={styles.protocolCard} style={{ marginBottom: 'var(--space-6)' }}>
        <div className={styles.protocolCardTitle}>
          <Bot size={14} color="var(--color-accent-amber)" />
          Резюме встречи
        </div>
        <p className={styles.summaryText}>{s.summary}</p>
      </div>

      <div className={styles.protocolGrid}>
        {/* Decisions */}
        <div className={styles.protocolCard}>
          <div className={styles.protocolCardTitle}>
            <CheckCircle2 size={14} color="var(--color-success)" />
            Решения ({s.decisions.length})
          </div>
          {s.decisions.length === 0 ? (
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>Решений не зафиксировано</p>
          ) : (
            s.decisions.map((d) => (
              <div key={d.id} className={styles.decisionItem}>
                <div style={{ flexShrink: 0, marginTop: 2 }}>
                  {d.status === 'approved'
                    ? <CheckCircle2 size={16} color="var(--color-success)" />
                    : d.status === 'rejected'
                    ? <Circle size={16} color="var(--color-danger)" />
                    : <Circle size={16} color="var(--color-text-muted)" />
                  }
                </div>
                <div>
                  <div className={styles.decisionText}>{d.text}</div>
                  <div className={styles.decisionMeta}>
                    Инициатор: {d.initiator} ·{' '}
                    <span style={{
                      color: d.status === 'approved'
                        ? 'var(--color-success)'
                        : d.status === 'rejected'
                        ? 'var(--color-danger)'
                        : 'var(--color-text-muted)'
                    }}>
                      {d.status === 'approved' ? 'принято' : d.status === 'rejected' ? 'отклонено' : 'на рассмотрении'}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Tasks */}
        <div className={styles.protocolCard}>
          <div className={styles.protocolCardTitle}>
            <CheckSquare size={14} color="var(--color-accent-amber)" />
            Задачи ({s.tasks.length})
          </div>
          {s.tasks.length === 0 ? (
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>Задач не назначено</p>
          ) : (
            s.tasks.map((t) => (
              <div key={t.id} className={styles.taskItem}>
                <div className={styles.taskCheck} />
                <div className={styles.taskBody}>
                  <div className={styles.taskText}>{t.text}</div>
                  <div className={styles.taskAssignee}>
                    <UserIcon size={11} />
                    {t.assignee}
                    {t.deadline && (
                      <>
                        <span>·</span>
                        <Calendar size={11} />
                        <span className={styles.taskDeadline}>{t.deadline}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Key moments */}
      {s.keyMoments.length > 0 && (
        <div className={styles.protocolCard}>
          <div className={styles.protocolCardTitle}>
            <Zap size={14} color="var(--color-accent-blue)" />
            Ключевые моменты
          </div>
          <div className={styles.keyMoments}>
            {s.keyMoments.map((km, i) => (
              <div key={i} className={styles.keyMoment}>
                <span className={styles.keyMomentTime}>{formatSec(km.sec)}</span>
                <span className={styles.keyMomentLabel}>{km.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// ─── Transcript Tab ───────────────────────────────────────────────────────────

function TranscriptTab({
  entries,
  formatSec,
  meetingId,
}: {
  entries: TranscriptEntry[]
  formatSec: (s: number) => string
  meetingId: string
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<TranscriptEntry[]>(entries)
  const [searching, setSearching] = useState(false)

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults(entries); return }
    setSearching(true)
    const res = await meetingsApi.search(meetingId, q)
    if ('data' in res) setResults(res.data as unknown as TranscriptEntry[])
    setSearching(false)
  }, [entries, meetingId])

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => doSearch(search), 400)
    return () => clearTimeout(t)
  }, [search, doSearch])

  const highlight = (text: string, q: string) => {
    const query = q.trim()
    if (!query) return text
    const splitRegex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const needle = query.toLowerCase()
    return text.split(splitRegex).map((part, i) =>
      part.toLowerCase() === needle ? <mark key={i}>{part}</mark> : part,
    )
  }

  return (
    <>
      <div className={styles.transcriptSearch}>
        <Search size={16} className={styles.transcriptSearchIcon} />
        <input
          id="transcript-search"
          type="search"
          className={styles.transcriptSearchInput}
          placeholder="Поиск по транскрипту…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {searching ? (
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <span>Поиск…</span>
        </div>
      ) : results.length === 0 ? (
        <div className={styles.noSenti}>
          <div className={styles.noSentiIcon}>
            <MessageSquare size={28} color="var(--color-text-muted)" />
          </div>
          <p style={{ color: 'var(--color-text-muted)' }}>
            {search ? 'Ничего не найдено' : 'Транскрипт пуст'}
          </p>
        </div>
      ) : (
        <div className={styles.transcriptList}>
          {results.map((entry) => (
            <div key={entry.id} className={styles.transcriptEntry}>
              <span className={styles.transcriptTimestamp}>
                {formatSec(entry.startSec)}
              </span>
              <div className={styles.transcriptBody}>
                <div className={styles.transcriptSpeaker}>{entry.speakerName}</div>
                <div className={styles.transcriptPhrase}>
                  {highlight(entry.phrase, search)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ─── Chat Tab ─────────────────────────────────────────────────────────────────

function ChatTab({ meetingId }: { meetingId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'intro',
      role: 'senti',
      text: 'Привет! Я Senti. Задайте любой вопрос по этой встрече — кто что сказал, какие решения приняты, кому что поручено.',
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const formatSec = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    const q = input.trim()
    if (!q || loading) return

    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', text: q }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)

    const history = messages
      .filter((m) => m.id !== 'intro')
      .map((m) => ({ role: m.role, text: m.text }))
      .slice(-10)

    const res = await sentiApi.chat(meetingId, q, history)
    setLoading(false)

    if ('data' in res && res.data) {
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'senti',
          text: res.data!.answer,
          references: res.data!.references,
        },
      ])
    } else {
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'senti',
          text: 'Произошла ошибка. Пожалуйста, попробуйте ещё раз.',
        },
      ])
    }
  }

  // TTS
  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const utt = new SpeechSynthesisUtterance(text)
    utt.lang = 'ru-RU'
    utt.rate = 1.05
    window.speechSynthesis.speak(utt)
  }

  return (
    <div className={styles.chatLayout}>
      <div className={styles.chatMessages}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`${styles.chatMsg} ${msg.role === 'user' ? styles.chatMsgUser : ''}`}
          >
            <div className={styles.chatAvatar}>
              {msg.role === 'senti'
                ? <Bot size={16} color="var(--color-accent-amber)" />
                : <UserIcon size={16} color="var(--color-text-muted)" />
              }
            </div>
            <div>
              <div className={`${styles.chatBubble} ${msg.role === 'user' ? styles.chatBubbleUser : styles.chatBubbleSenti}`}>
                {msg.text}

                {/* TTS button for Senti messages */}
                {msg.role === 'senti' && (
                  <button
                    onClick={() => speak(msg.text)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      marginTop: 6,
                      background: 'none',
                      border: 'none',
                      color: 'var(--color-text-muted)',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      padding: 0,
                    }}
                    title="Озвучить"
                  >
                    <Volume2 size={13} />
                    Озвучить
                  </button>
                )}
              </div>

              {/* References */}
              {msg.references && msg.references.length > 0 && (
                <div className={styles.chatReferences}>
                  {msg.references.map((ref, i) => (
                    <div key={i} className={styles.chatRef}>
                      <span className={styles.chatRefTime}>{formatSec(ref.sec)}</span>
                      <div>
                        <div style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 2 }}>
                          {ref.speaker}
                        </div>
                        <div className={styles.chatRefText}>«{ref.quote}»</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {loading && (
          <div className={styles.chatMsg}>
            <div className={styles.chatAvatar}>
              <Bot size={16} color="var(--color-accent-amber)" />
            </div>
            <div className={`${styles.chatBubble} ${styles.chatBubbleSenti}`}>
              <div className={styles.chatTyping}>
                <div className={styles.chatTypingDot} />
                <div className={styles.chatTypingDot} />
                <div className={styles.chatTypingDot} />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <form className={styles.chatForm} onSubmit={sendMessage}>
        <input
          id="senti-chat-input"
          className={styles.chatInput}
          placeholder="Спросите что-нибудь о встрече…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
        <button
          id="senti-chat-send"
          type="submit"
          className={styles.chatSendBtn}
          disabled={!input.trim() || loading}
          aria-label="Отправить"
        >
          <Send size={18} />
        </button>
      </form>
    </div>
  )
}

// ─── No Senti State ───────────────────────────────────────────────────────────

function NoSentiState({ isProcessing, onUpload }: { isProcessing: boolean; onUpload: (file: File) => Promise<void> }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const allowedExtensions = ['.mp3', '.webm', '.ogg', '.wav', '.aac', '.m4a', '.mp4']
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()

    if (!allowedExtensions.includes(ext)) {
      setError('Выберите поддерживаемый аудиофайл (MP3, WebM, Ogg, WAV, AAC, M4A)')
      return
    }

    try {
      setUploading(true)
      setError(null)
      await onUpload(file)
    } catch (err: any) {
      setError(err.message ?? 'Ошибка загрузки файла')
    } finally {
      setUploading(false)
    }
  }

  if (isProcessing) {
    return (
      <div className={styles.processingCard}>
        <div style={{ flexShrink: 0, animation: 'spin 1.2s linear infinite' }}>
          <Bot size={28} color="var(--color-accent-blue)" />
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Senti обрабатывает запись</div>
          <div style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            Обычно занимает 1–3 минуты. Обновите страницу позже.
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className={styles.noSenti}>
      <div className={styles.noSentiIcon}>
        <Bot size={28} color="var(--color-text-muted)" />
      </div>
      <p style={{ fontWeight: 600 }}>Senti-протокол недоступен</p>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem', marginBottom: 'var(--space-4)' }}>
        Запись для этой встречи не была активирована или Senti не смог обработать аудио.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)' }}>
        <label className="btn btn-amber btn-sm" style={{ cursor: 'pointer' }}>
          {uploading ? 'Загрузка...' : 'Загрузить запись (MP3, WebM, Ogg, WAV, M4A)'}
          <input
            type="file"
            accept="audio/mp3,audio/mpeg,audio/webm,audio/ogg,audio/wav,audio/aac,audio/x-m4a,video/mp4"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            disabled={uploading}
          />
        </label>
        {error && (
          <p style={{ color: 'var(--color-danger)', fontSize: '0.75rem', marginTop: 4 }}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────



function Sidebar({ user }: { user: User | null }) {
  return (
    <aside className="sidebar">
      <div style={{ marginBottom: 'var(--space-6)', display: 'flex', justifyContent: 'center' }}>
        <LogoIcon />
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

function PrintProtocol({
  meeting,
  transcript,
  speakerStats,
  totalWords,
  totalPhrases,
  formatDate,
  formatDuration,
  formatSec,
}: {
  meeting: Meeting
  transcript: TranscriptEntry[]
  speakerStats: { name: string; phrases: number; words: number; percentage: number }[]
  totalWords: number
  totalPhrases: number
  formatDate: (iso: string) => string
  formatDuration: (sec?: number) => string
  formatSec: (s: number) => string
}) {
  const s = meeting.summary
  if (!s) return null

  const transcriptSpeakers = Array.from(new Set(transcript.map((t) => t.speakerName).filter(Boolean)))
  const participantNames = meeting.participants && meeting.participants.length > 0
    ? meeting.participants.map((p) => p.name)
    : transcriptSpeakers.length > 0
      ? transcriptSpeakers
      : ['Неизвестно']

  return (
    <div className={styles.printOnlyContainer}>
      {/* Title page / Header */}
      <div className={`pdf-section ${styles.printHeader}`}>
        <div className={styles.printLogo}>
          <svg width="24" height="24" viewBox="0 0 36 36" fill="none">
            <rect x="2" y="10" width="18" height="16" rx="4" fill="#2563EB"/>
            <path d="M20 14L27 10V26L20 22V14Z" fill="#2563EB"/>
            <path d="M31 13C32.5 15 32.5 21 31 23" stroke="#2563EB" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          <span className={styles.printLogoTitle}>Centras Echo</span>
        </div>
        <div className={styles.printDocType}>Официальный протокол встречи</div>
        <h1 className={styles.printTitle}>{meeting.title}</h1>
        
        <div className={styles.printMetaGrid}>
          <div className={styles.printMetaItem}>
            <span className={styles.printMetaLabel}>Дата и время</span>
            <span className={styles.printMetaVal}>{formatDate(meeting.createdAt)}</span>
          </div>
          <div className={styles.printMetaItem}>
            <span className={styles.printMetaLabel}>Длительность</span>
            <span className={styles.printMetaVal}>{formatDuration(meeting.durationSec)}</span>
          </div>
          <div className={styles.printMetaItem}>
            <span className={styles.printMetaLabel}>Организатор</span>
            <span className={styles.printMetaVal}>ID: {meeting.creatorId.substring(0, 8)}</span>
          </div>
          <div className={styles.printMetaItem}>
            <span className={styles.printMetaLabel}>Участников</span>
            <span className={styles.printMetaVal}>{participantNames.length}</span>
          </div>
        </div>

        <div style={{ marginTop: '16px' }}>
          <span className={styles.printMetaLabel}>Список участников</span>
          <div className={styles.printParticipantList}>
            {participantNames.map((name, i) => (
              <span key={i} className={styles.printParticipantBadge}>{name}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Section: Metrics */}
      <div className={`pdf-section ${styles.printSection}`}>
        <h2 className={styles.printSectionTitle}>Метрики встречи</h2>
        <div className={styles.printMetricsGrid}>
          <div className={styles.printMetricCard}>
            <div className={styles.printMetricVal}>{participantNames.length}</div>
            <div className={styles.printMetricLabel}>Участники</div>
          </div>
          <div className={styles.printMetricCard}>
            <div className={styles.printMetricVal}>{formatDuration(meeting.durationSec)}</div>
            <div className={styles.printMetricLabel}>Длительность</div>
          </div>
          <div className={styles.printMetricCard}>
            <div className={styles.printMetricVal}>{totalPhrases}</div>
            <div className={styles.printMetricLabel}>Всего фраз</div>
          </div>
          <div className={styles.printMetricCard}>
            <div className={styles.printMetricVal}>{totalWords}</div>
            <div className={styles.printMetricLabel}>Всего слов</div>
          </div>
          <div className={styles.printMetricCard}>
            <div className={styles.printMetricVal}>{s.decisions.length}</div>
            <div className={styles.printMetricLabel}>Решения</div>
          </div>
          <div className={styles.printMetricCard}>
            <div className={styles.printMetricVal}>{s.tasks.length}</div>
            <div className={styles.printMetricLabel}>Задачи</div>
          </div>
        </div>
      </div>

      {/* Section: Speaker stats */}
      {speakerStats.length > 0 && (
        <>
          <div className={`pdf-section ${styles.printSection}`} style={{ marginBottom: '8px' }}>
            <h2 className={styles.printSectionTitle}>Активность участников во встрече</h2>
            <table className={styles.printTable} style={{ marginBottom: 0 }}>
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>Участник</th>
                  <th style={{ width: '20%' }}>Сказано фраз</th>
                  <th style={{ width: '20%' }}>Сказано слов</th>
                  <th>Доля участия (% фраз)</th>
                </tr>
              </thead>
            </table>
          </div>
          {speakerStats.map((stat, i) => (
            <div key={i} className="pdf-section" style={{ width: '100%' }}>
              <table className={styles.printTable} style={{ marginTop: 0 }}>
                <tbody>
                  <tr>
                    <td style={{ width: '30%' }}>{stat.name}</td>
                    <td style={{ width: '20%' }}>{stat.phrases}</td>
                    <td style={{ width: '20%' }}>{stat.words}</td>
                    <td>
                      <div className={styles.printProgressBarContainer}>
                        <div className={styles.printProgressBar}>
                          <div className={styles.printProgressBarFill} style={{ width: `${stat.percentage}%` }} />
                        </div>
                        <span className={styles.printProgressVal}>{stat.percentage}%</span>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {/* Section: Senti Summary */}
      <div className={`pdf-section ${styles.printSection}`}>
        <h2 className={styles.printSectionTitle}>Резюме встречи (ИИ Senti)</h2>
        <p className={styles.printSummaryText}>{s.summary}</p>
      </div>

      {/* Section: Decisions */}
      {s.decisions.length > 0 && (
        <>
          <div className={`pdf-section ${styles.printSection}`} style={{ marginBottom: '8px' }}>
            <h2 className={styles.printSectionTitle}>Принятые решения ({s.decisions.length})</h2>
            <table className={styles.printTable} style={{ marginBottom: 0 }}>
              <thead>
                <tr>
                  <th style={{ width: '15%' }}>Статус</th>
                  <th style={{ width: '25%' }}>Инициатор</th>
                  <th>Текст решения</th>
                </tr>
              </thead>
            </table>
          </div>
          {s.decisions.map((d) => (
            <div key={d.id} className="pdf-section" style={{ width: '100%' }}>
              <table className={styles.printTable} style={{ marginTop: 0 }}>
                <tbody>
                  <tr>
                    <td style={{ width: '15%' }}>
                      <span className={`${styles.printDecisionStatus} ${
                        d.status === 'approved'
                          ? styles.printDecisionApproved
                          : d.status === 'rejected'
                          ? styles.printDecisionRejected
                          : styles.printDecisionPending
                      }`}>
                        {d.status === 'approved' ? 'Принято' : d.status === 'rejected' ? 'Отклонено' : 'Ожидает'}
                      </span>
                    </td>
                    <td style={{ width: '25%' }}>{d.initiator}</td>
                    <td>{d.text}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {/* Section: Tasks */}
      {s.tasks.length > 0 && (
        <>
          <div className={`pdf-section ${styles.printSection}`} style={{ marginBottom: '8px' }}>
            <h2 className={styles.printSectionTitle}>Задачи и поручения ({s.tasks.length})</h2>
            <table className={styles.printTable} style={{ marginBottom: 0 }}>
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>Исполнитель</th>
                  <th style={{ width: '20%' }}>Срок</th>
                  <th>Описание задачи</th>
                </tr>
              </thead>
            </table>
          </div>
          {s.tasks.map((t) => (
            <div key={t.id} className="pdf-section" style={{ width: '100%' }}>
              <table className={styles.printTable} style={{ marginTop: 0 }}>
                <tbody>
                  <tr>
                    <td style={{ width: '30%' }}><strong>{t.assignee}</strong></td>
                    <td style={{ width: '20%' }}>{t.deadline || '—'}</td>
                    <td>{t.text}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {/* Section: Key Moments */}
      {s.keyMoments.length > 0 && (
        <>
          <div className={`pdf-section ${styles.printSection}`} style={{ marginBottom: '8px' }}>
            <h2 className={styles.printSectionTitle}>Ключевые моменты</h2>
          </div>
          {s.keyMoments.map((km, i) => (
            <div key={i} className={`pdf-section ${styles.printKeyMoment}`} style={{ width: '100%', marginBottom: '6px' }}>
              <span className={styles.printKeyMomentTime}>{formatSec(km.sec)}</span>
              <span className={styles.printKeyMomentLabel}>{km.label}</span>
            </div>
          ))}
        </>
      )}

      {/* Section: Transcript */}
      {transcript.length > 0 && (
        <>
          <div className={`pdf-section ${styles.printSection}`} style={{ marginBottom: '12px' }}>
            <h2 className={styles.printSectionTitle}>Полный транскрипт встречи</h2>
          </div>
          {transcript.map((entry) => (
            <div key={entry.id} className={`pdf-section ${styles.printTranscriptEntry}`}>
              <span className={styles.printTranscriptTime}>{formatSec(entry.startSec)}</span>
              <div style={{ flex: 1 }}>
                <div className={styles.printTranscriptSpeaker}>{entry.speakerName}</div>
                <div className={styles.printTranscriptPhrase}>{entry.phrase}</div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

