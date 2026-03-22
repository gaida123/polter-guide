import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus, Trash2, Loader2, Sparkles, Copy, Check,
  ChevronDown, ChevronUp, Users, BookOpen, BarChart3,
  CheckCircle2, Clock, AlertCircle, X, Upload, FileText, Zap,
} from 'lucide-react'

const API = 'http://localhost:8080'

interface SopStep { title: string; instruction: string; expected: string }
interface Sop {
  id: string; title: string; role: string; description: string
  steps: SopStep[]; created_at: string; plays?: number; completions?: number
}
interface Session {
  id: string; sop_id: string; sop_title: string; employee_name: string
  employee_email: string; started_at: string; completed_at: string | null
  current_step: number; step_results: { step_index: number; completed_at: string }[]
}
interface FeedEntry {
  id: string; session_id: string; employee_name: string; sop_title: string
  summary: string; steps_done: number; total_steps: number
  duration_s: number | null; created_at: string
}

const ROLES = ['General', 'Engineer', 'Designer', 'Sales', 'Marketing', 'HR', 'Finance', 'Intern']

export default function AdminDashboard() {
  const [sops, setSops]             = useState<Sop[]>([])
  const [sessions, setSessions]     = useState<Session[]>([])
  const [feed, setFeed]             = useState<FeedEntry[]>([])
  const [tab, setTab]               = useState<'sops' | 'sessions' | 'feed'>('sops')
  const [showCreate, setShowCreate] = useState(false)
  const [expandedSop, setExpandedSop] = useState<string | null>(null)
  const [copiedId, setCopiedId]     = useState<string | null>(null)
  const [loading, setLoading]       = useState(true)

  // Create SOP form
  const [title, setTitle]           = useState('')
  const [role, setRole]             = useState('General')
  const [description, setDescription] = useState('')
  const [inputMode, setInputMode]   = useState<'text' | 'file'>('text')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef                = useRef<HTMLInputElement>(null)
  const [generatedSteps, setGeneratedSteps] = useState<SopStep[]>([])
  const [generating, setGenerating] = useState(false)
  const [genStatus,  setGenStatus]  = useState('')
  const [saving, setSaving]         = useState(false)
  const [genError, setGenError]     = useState('')

  const load = async () => {
    setLoading(true)
    const [sopRes, sessionRes, feedRes] = await Promise.all([
      fetch(`${API}/local/sops`).then(r => r.json()).catch(() => []),
      fetch(`${API}/local/sessions`).then(r => r.json()).catch(() => []),
      fetch(`${API}/local/feed`).then(r => r.json()).catch(() => []),
    ])
    setSops(sopRes)
    setSessions(sessionRes)
    setFeed(feedRes)
    setLoading(false)
  }

  useEffect(() => {
    load()
    // Poll the agent feed every 10s so new reports appear automatically
    const interval = setInterval(async () => {
      const feedRes = await fetch(`${API}/local/feed`).then(r => r.json()).catch(() => [])
      setFeed(feedRes)
    }, 10_000)
    return () => clearInterval(interval)
  }, [])

  const handleGenerate = async () => {
    setGenerating(true)
    setGenError('')
    setGeneratedSteps([])

    // Cycle through status messages so it doesn't feel frozen
    const messages = inputMode === 'file'
      ? ['Reading your document…', 'Identifying steps…', 'Structuring the guide…', 'Almost there…']
      : ['Thinking through the workflow…', 'Breaking into steps…', 'Structuring the guide…', 'Almost there…']
    let msgIdx = 0
    setGenStatus(messages[0])
    const msgTimer = setInterval(() => {
      msgIdx = (msgIdx + 1) % messages.length
      setGenStatus(messages[msgIdx])
    }, 2800)

    try {
      let res: Response
      if (inputMode === 'file' && uploadedFile) {
        const form = new FormData()
        form.append('file', uploadedFile)
        res = await fetch(`${API}/local/sops/upload`, { method: 'POST', body: form })
      } else {
        if (!description.trim()) return
        res = await fetch(`${API}/local/sops/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description }),
        })
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Generation failed')
      }
      const steps: SopStep[] = await res.json()
      setGeneratedSteps(steps)
    } catch (e: any) {
      setGenError(e.message || 'AI generation failed. Check the backend is running.')
    } finally {
      clearInterval(msgTimer)
      setGenStatus('')
      setGenerating(false)
    }
  }

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) { setUploadedFile(f); setGeneratedSteps([]) }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) { setUploadedFile(f); setGeneratedSteps([]) }
  }

  const resetCreate = () => {
    setShowCreate(false)
    setTitle(''); setRole('General'); setDescription('')
    setUploadedFile(null); setGeneratedSteps([]); setGenError('')
    setInputMode('text')
  }

  const handleSave = async () => {
    if (!title.trim() || generatedSteps.length === 0) return
    setSaving(true)
    try {
      await fetch(`${API}/local/sops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, role, description: description || uploadedFile?.name || '', steps: generatedSteps }),
      })
      resetCreate()
      await load()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this SOP and all its sessions?')) return
    await fetch(`${API}/local/sops/${id}`, { method: 'DELETE' })
    setSops(s => s.filter(x => x.id !== id))
  }

  const copyLink = (sopId: string) => {
    const url = `${window.location.origin}/start?sop=${sopId}`
    navigator.clipboard.writeText(url)
    setCopiedId(sopId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const updateStep = (i: number, field: keyof SopStep, val: string) => {
    setGeneratedSteps(steps => steps.map((s, idx) => idx === i ? { ...s, [field]: val } : s))
  }

  const totalCompleted = sessions.filter(s => s.completed_at).length
  const avgStepsCompleted = sessions.length
    ? Math.round(sessions.reduce((a, s) => a + s.step_results.length, 0) / sessions.length)
    : 0

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      {/* Header */}
      <div className="border-b border-white/8 px-8 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
            <span className="text-sm font-bold">H</span>
          </div>
          <div>
            <h1 className="text-base font-semibold">HandOff Admin</h1>
            <p className="text-xs text-white/40">Onboarding management</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black text-sm font-medium hover:bg-white/90 transition-colors"
        >
          <Plus className="w-4 h-4" /> New SOP
        </button>
      </div>

      <div className="max-w-5xl mx-auto px-8 py-8">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { icon: BookOpen,   label: 'SOPs',           value: sops.length },
            { icon: Users,      label: 'Employees',       value: sessions.length },
            { icon: CheckCircle2, label: 'Completed',    value: totalCompleted },
            { icon: BarChart3,  label: 'Avg steps done', value: avgStepsCompleted },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="rounded-xl border border-white/8 bg-white/4 p-4">
              <Icon className="w-4 h-4 text-white/40 mb-2" />
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-xs text-white/40 mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-white/4 rounded-lg p-1 w-fit">
          {(['sops', 'sessions', 'feed'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize flex items-center gap-1.5 ${
                tab === t ? 'bg-white text-black' : 'text-white/50 hover:text-white'
              }`}
            >
              {t === 'feed' && <Zap className="w-3.5 h-3.5" />}
              {t === 'sops' ? 'SOPs' : t === 'sessions' ? 'Sessions' : 'Agent Feed'}
              {t === 'feed' && feed.length > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === 'feed' ? 'bg-black/10' : 'bg-violet-500/60 text-white'}`}>
                  {feed.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-white/30">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : tab === 'sops' ? (
          /* ── SOPs tab ── */
          <div className="space-y-3">
            {sops.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-white/10 rounded-2xl">
                <BookOpen className="w-8 h-8 text-white/20 mx-auto mb-3" />
                <p className="text-white/40 mb-4">No SOPs yet. Create your first onboarding guide.</p>
                <button
                  onClick={() => setShowCreate(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black text-sm font-medium"
                >
                  <Plus className="w-4 h-4" /> Create SOP
                </button>
              </div>
            ) : sops.map((sop, i) => (
              <motion.div
                key={sop.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="rounded-xl border border-white/8 bg-white/4 overflow-hidden"
              >
                <div
                  className="flex items-center gap-4 p-4 cursor-pointer hover:bg-white/4 transition-colors"
                  onClick={() => setExpandedSop(expandedSop === sop.id ? null : sop.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium truncate">{sop.title}</p>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-white/8 text-white/50 shrink-0">
                        {sop.role}
                      </span>
                    </div>
                    <p className="text-xs text-white/40 mt-0.5">
                      {sop.steps.length} steps ·{' '}
                      {sessions.filter(s => s.sop_id === sop.id).length} employees ·{' '}
                      {sessions.filter(s => s.sop_id === sop.id && s.completed_at).length} completed
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={e => { e.stopPropagation(); copyLink(sop.id) }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/12 text-xs text-white/70 transition-colors"
                    >
                      {copiedId === sop.id
                        ? <><Check className="w-3 h-3 text-green-400" /> Copied</>
                        : <><Copy className="w-3 h-3" /> Copy link</>}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(sop.id) }}
                      className="p-1.5 rounded-lg hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    {expandedSop === sop.id
                      ? <ChevronUp className="w-4 h-4 text-white/30" />
                      : <ChevronDown className="w-4 h-4 text-white/30" />}
                  </div>
                </div>

                <AnimatePresence>
                  {expandedSop === sop.id && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="border-t border-white/8 px-4 pb-4 overflow-hidden"
                    >
                      <p className="text-xs text-white/30 mt-4 mb-3 uppercase tracking-wider">Steps</p>
                      <div className="space-y-2">
                        {sop.steps.map((step, idx) => (
                          <div key={idx} className="flex gap-3 text-sm">
                            <span className="w-5 h-5 rounded-full bg-white/8 flex items-center justify-center text-xs text-white/40 shrink-0 mt-0.5">
                              {idx + 1}
                            </span>
                            <div>
                              <p className="font-medium text-white/80">{step.title}</p>
                              <p className="text-white/40 text-xs mt-0.5">{step.instruction}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>
        ) : tab === 'sessions' ? (
          /* ── Sessions tab ── */
          <div className="space-y-3">
            {sessions.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-white/10 rounded-2xl">
                <Users className="w-8 h-8 text-white/20 mx-auto mb-3" />
                <p className="text-white/40">No employees have started onboarding yet.</p>
              </div>
            ) : sessions.map((session, i) => {
              const sop = sops.find(s => s.id === session.sop_id)
              const pct = sop ? Math.round(session.step_results.length / sop.steps.length * 100) : 0
              return (
                <motion.div
                  key={session.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="flex items-center gap-4 p-4 rounded-xl border border-white/8 bg-white/4"
                >
                  <div className="w-9 h-9 rounded-full bg-white/8 flex items-center justify-center text-sm font-medium shrink-0">
                    {session.employee_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{session.employee_name}</p>
                      {session.employee_email && (
                        <p className="text-xs text-white/40">{session.employee_email}</p>
                      )}
                    </div>
                    <p className="text-xs text-white/40 mt-0.5">
                      {session.sop_title} · {session.step_results.length}/{sop?.steps.length ?? '?'} steps
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="w-24">
                      <div className="flex justify-between text-xs text-white/40 mb-1">
                        <span>{pct}%</span>
                      </div>
                      <div className="h-1.5 bg-white/8 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            pct === 100 ? 'bg-green-400' : 'bg-white/60'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    {session.completed_at ? (
                      <CheckCircle2 className="w-4 h-4 text-green-400" />
                    ) : (
                      <Clock className="w-4 h-4 text-white/30" />
                    )}
                  </div>
                </motion.div>
              )
            })}
          </div>
        ) : (
          /* ── Agent Feed tab ── */
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 rounded-xl bg-violet-500/10 border border-violet-500/20 text-sm text-violet-300 mb-2">
              <Zap className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-violet-200">Powered by Fetch.ai CompletionAgent</p>
                <p className="text-violet-300/70 text-xs mt-0.5">
                  An autonomous uAgent scans for finished sessions every 10 seconds, generates an AI summary, and posts it here — no manual trigger needed.
                </p>
              </div>
            </div>
            {feed.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-white/10 rounded-2xl">
                <Zap className="w-8 h-8 text-white/20 mx-auto mb-3" />
                <p className="text-white/40">No completions yet — reports appear automatically when employees finish.</p>
                <p className="text-white/20 text-sm mt-1">The Fetch.ai CompletionAgent checks every 10 seconds.</p>
              </div>
            ) : feed.map((entry, i) => {
              const durStr = entry.duration_s != null
                ? (entry.duration_s >= 60
                    ? `${Math.floor(entry.duration_s / 60)}m ${Math.round(entry.duration_s % 60)}s`
                    : `${Math.round(entry.duration_s)}s`)
                : null
              return (
                <motion.div
                  key={entry.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="p-4 rounded-xl border border-white/8 bg-white/4"
                >
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-violet-500/20 flex items-center justify-center text-sm font-semibold text-violet-300 shrink-0">
                        {entry.employee_name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium">{entry.employee_name}</p>
                        <p className="text-xs text-white/40">{entry.sop_title}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-xs text-white/40">
                      {durStr && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{durStr}</span>}
                      <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-400" />{entry.steps_done}/{entry.total_steps} steps</span>
                    </div>
                  </div>
                  <p className="text-sm text-white/70 leading-relaxed border-l-2 border-violet-500/40 pl-3">
                    {entry.summary}
                  </p>
                  <p className="text-xs text-white/25 mt-2">
                    Generated by CompletionAgent · {new Date(entry.created_at + 'Z').toLocaleString()}
                  </p>
                </motion.div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Create SOP modal ── */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={e => e.target === e.currentTarget && setShowCreate(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#111118] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between p-6 border-b border-white/8">
                <h2 className="text-lg font-semibold">Create New SOP</h2>
                <button onClick={resetCreate} className="text-white/40 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-5">
                {/* Title + Role */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-white/50 mb-1.5 block">SOP Title</label>
                    <input
                      value={title}
                      onChange={e => setTitle(e.target.value)}
                      placeholder="e.g. Google Workspace Setup"
                      className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/30"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/50 mb-1.5 block">Role</label>
                    <select
                      value={role}
                      onChange={e => setRole(e.target.value)}
                      className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
                    >
                      {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                </div>

                {/* Input mode toggle */}
                <div>
                  <div className="flex gap-1 bg-white/4 rounded-lg p-1 w-fit mb-4">
                    {(['text', 'file'] as const).map(m => (
                      <button
                        key={m}
                        onClick={() => { setInputMode(m); setGeneratedSteps([]); setGenError('') }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                          inputMode === m ? 'bg-white text-black font-medium' : 'text-white/50 hover:text-white'
                        }`}
                      >
                        {m === 'text'
                          ? <><Sparkles className="w-3.5 h-3.5" /> Describe it</>
                          : <><Upload className="w-3.5 h-3.5" /> Upload file</>}
                      </button>
                    ))}
                  </div>

                  {inputMode === 'text' ? (
                    <textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      rows={4}
                      placeholder="e.g. Set up Google Workspace account, enable 2-step verification, install Slack, request GitHub access, set up the VPN client"
                      className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/30 resize-none"
                    />
                  ) : (
                    /* Drop zone */
                    <div
                      onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleFileDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                        isDragging
                          ? 'border-white/40 bg-white/8'
                          : uploadedFile
                          ? 'border-green-500/40 bg-green-500/6'
                          : 'border-white/12 bg-white/3 hover:bg-white/6 hover:border-white/20'
                      }`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.txt,.docx,.png,.jpg,.jpeg,.webp"
                        className="hidden"
                        onChange={handleFileChange}
                      />
                      {uploadedFile ? (
                        <div className="flex items-center justify-center gap-3">
                          <FileText className="w-6 h-6 text-green-400 shrink-0" />
                          <div className="text-left">
                            <p className="text-sm font-medium text-white">{uploadedFile.name}</p>
                            <p className="text-xs text-white/40 mt-0.5">
                              {(uploadedFile.size / 1024).toFixed(0)} KB · Click to replace
                            </p>
                          </div>
                        </div>
                      ) : (
                        <>
                          <Upload className="w-7 h-7 text-white/20 mx-auto mb-2" />
                          <p className="text-sm text-white/50">
                            Drop your SOP file here, or <span className="text-white/80 underline underline-offset-2">browse</span>
                          </p>
                          <p className="text-xs text-white/25 mt-1.5">
                            PDF, Word (.docx), plain text, or screenshot — up to 20 MB
                          </p>
                        </>
                      )}
                    </div>
                  )}

                  <button
                    onClick={handleGenerate}
                    disabled={
                      generating ||
                      (inputMode === 'text' && !description.trim()) ||
                      (inputMode === 'file' && !uploadedFile)
                    }
                    className="mt-3 flex items-center gap-2 px-4 py-2 rounded-lg bg-white/8 hover:bg-white/12 text-sm text-white/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {generating
                      ? <><Loader2 className="w-4 h-4 animate-spin" /><span>{genStatus}</span></>
                      : <><Sparkles className="w-4 h-4 text-purple-400" /> Generate steps with AI</>}
                  </button>
                  {genError && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                      <AlertCircle className="w-3 h-3 shrink-0" /> {genError}
                    </div>
                  )}
                </div>

                {/* Generated steps (editable) */}
                <AnimatePresence>
                  {generatedSteps.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-3"
                    >
                      <p className="text-xs text-white/50 uppercase tracking-wider">
                        Generated steps — edit if needed
                      </p>
                      {generatedSteps.map((step, i) => (
                        <div key={i} className="flex gap-3 p-3 bg-white/4 rounded-lg border border-white/8">
                          <span className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-xs text-white/50 shrink-0 mt-0.5">
                            {i + 1}
                          </span>
                          <div className="flex-1 space-y-1.5">
                            <input
                              value={step.title}
                              onChange={e => updateStep(i, 'title', e.target.value)}
                              className="w-full bg-transparent text-sm font-medium text-white focus:outline-none"
                            />
                            <input
                              value={step.instruction}
                              onChange={e => updateStep(i, 'instruction', e.target.value)}
                              className="w-full bg-transparent text-xs text-white/50 focus:outline-none"
                            />
                          </div>
                        </div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="flex items-center justify-end gap-3 p-6 border-t border-white/8">
                <button
                  onClick={resetCreate}
                  className="px-4 py-2 rounded-lg text-sm text-white/50 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={!title.trim() || generatedSteps.length === 0 || saving}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/90 transition-colors"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Save SOP
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
