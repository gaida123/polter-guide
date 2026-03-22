import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Loader2, ArrowRight, BookOpen, AlertCircle } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'

const API = 'http://localhost:8080'

interface SopStep { title: string; instruction: string; expected: string }
interface Sop {
  id: string; title: string; role: string; description: string; steps: SopStep[]
}

export default function StartPage() {
  const [params] = useSearchParams()
  const preselectedSopId = params.get('sop')

  const [sops, setSops]     = useState<Sop[]>([])
  const [selectedSop, setSelectedSop] = useState<string>(preselectedSopId ?? '')
  const [name, setName]     = useState('')
  const [email, setEmail]   = useState('')
  const [loading, setLoading]   = useState(false)
  const [fetching, setFetching] = useState(true)
  const [error, setError]       = useState('')
  const [launched, setLaunched] = useState(false)

  useEffect(() => {
    fetch(`${API}/local/sops`)
      .then(r => r.json())
      .then(data => {
        setSops(data)
        if (preselectedSopId && data.find((s: Sop) => s.id === preselectedSopId)) {
          setSelectedSop(preselectedSopId)
        } else if (data.length === 1) {
          setSelectedSop(data[0].id)
        }
      })
      .catch(() => setError('Could not load SOPs. Is the backend running?'))
      .finally(() => setFetching(false))
  }, [preselectedSopId])

  const currentSop = sops.find(s => s.id === selectedSop)

  const handleStart = async () => {
    if (!name.trim() || !selectedSop) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API}/local/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sop_id: selectedSop, employee_name: name.trim(), employee_email: email.trim() }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      const data = await res.json()
      const sessionId = data.id

      // In Electron, navigate the overlay window to load this session
      const electronAPI = (window as any).handoff
      if (electronAPI?.navigate) {
        electronAPI.navigate(`/overlay?session=${sessionId}`)
      } else {
        // Browser fallback — open overlay in new tab/window
        window.open(`/overlay?session=${sessionId}`, '_blank')
      }
      setLaunched(true)
    } catch {
      setError('Failed to start session. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (launched) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center"
        >
          <div className="w-16 h-16 rounded-2xl bg-green-500/20 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <BookOpen className="w-7 h-7 text-green-400" />
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Your guide is ready!</h2>
          <p className="text-white/50 text-sm max-w-xs">
            The HandOff widget will now walk you through each step. Follow the instructions and click "Done" when each step is complete.
          </p>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-white/8 border border-white/10 flex items-center justify-center mx-auto mb-4">
            <span className="text-lg font-bold text-white">H</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Welcome to HandOff</h1>
          <p className="text-white/40 text-sm mt-1">Your AI-guided onboarding assistant</p>
        </div>

        <div className="bg-white/4 border border-white/8 rounded-2xl p-6 space-y-5">
          {fetching ? (
            <div className="flex items-center justify-center py-8 text-white/30">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          ) : (
            <>
              {/* Name */}
              <div>
                <label className="text-xs text-white/50 mb-1.5 block">Your name</label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Alex Johnson"
                  className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder-white/25 focus:outline-none focus:border-white/30"
                />
              </div>

              {/* Email (optional) */}
              <div>
                <label className="text-xs text-white/50 mb-1.5 block">Work email <span className="text-white/25">(optional)</span></label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="alex@company.com"
                  className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder-white/25 focus:outline-none focus:border-white/30"
                />
              </div>

              {/* SOP select (only if not preselected) */}
              {!preselectedSopId && (
                <div>
                  <label className="text-xs text-white/50 mb-1.5 block">Onboarding guide</label>
                  {sops.length === 0 ? (
                    <p className="text-xs text-white/30 py-2">No onboarding guides available yet.</p>
                  ) : (
                    <select
                      value={selectedSop}
                      onChange={e => setSelectedSop(e.target.value)}
                      className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-white/30"
                    >
                      <option value="">Select a guide…</option>
                      {sops.map(s => (
                        <option key={s.id} value={s.id}>{s.title} ({s.role})</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Selected SOP preview */}
              {currentSop && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="bg-white/4 rounded-lg p-3 border border-white/8"
                >
                  <p className="text-xs text-white/40 mb-2">{currentSop.steps.length} steps in this guide</p>
                  <div className="space-y-1.5">
                    {currentSop.steps.slice(0, 4).map((step, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="w-4 h-4 rounded-full bg-white/8 flex items-center justify-center text-white/30 shrink-0">
                          {i + 1}
                        </span>
                        <span className="text-white/60 truncate">{step.title}</span>
                      </div>
                    ))}
                    {currentSop.steps.length > 4 && (
                      <p className="text-xs text-white/25 pl-6">+{currentSop.steps.length - 4} more steps</p>
                    )}
                  </div>
                </motion.div>
              )}

              {error && (
                <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
                </div>
              )}

              <button
                onClick={handleStart}
                disabled={!name.trim() || !selectedSop || loading}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/90 transition-colors"
              >
                {loading
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</>
                  : <><ArrowRight className="w-4 h-4" /> Start Onboarding</>}
              </button>
            </>
          )}
        </div>

        <p className="text-center text-xs text-white/20 mt-4">
          Guided by HandOff AI · Your progress is saved automatically
        </p>
      </motion.div>
    </div>
  )
}
