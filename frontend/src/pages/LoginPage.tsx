import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

const ADMIN_PASSWORD = 'handoff2026'
const AUTH_KEY = 'handoff_auth'

export function setAuth() { localStorage.setItem(AUTH_KEY, '1') }
export function clearAuth() { localStorage.removeItem(AUTH_KEY) }
export function isAuthed() { return localStorage.getItem(AUTH_KEY) === '1' }

export default function LoginPage() {
  const navigate   = useNavigate()
  const inputRef   = useRef<HTMLInputElement>(null)
  const [pw, setPw]           = useState('')
  const [show, setShow]       = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [shake, setShake]     = useState(false)

  const attempt = async () => {
    if (!pw.trim() || loading) return
    setLoading(true)
    setError('')
    // small artificial delay for UX
    await new Promise(r => setTimeout(r, 500))
    if (pw === ADMIN_PASSWORD) {
      setAuth()
      navigate('/admin', { replace: true })
    } else {
      setLoading(false)
      setError('Incorrect password.')
      setShake(true)
      setTimeout(() => setShake(false), 500)
      setPw('')
      inputRef.current?.focus()
    }
  }

  return (
    <div className="min-h-screen bg-[#080808] flex items-center justify-center px-4">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 flex items-start justify-center overflow-hidden">
        <div className="w-[700px] h-[400px] rounded-full bg-white/[0.025] blur-3xl -translate-y-1/4" />
      </div>

      <div className="relative w-full max-w-[360px]">
        {/* Logo */}
        <div className="flex items-center gap-2.5 mb-10 justify-center">
          <div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.5">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
          <span className="text-white font-bold text-[16px] tracking-tight">HandOff AI</span>
        </div>

        {/* Card */}
        <motion.div
          animate={shake ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : {}}
          transition={{ duration: 0.45, ease: 'easeInOut' }}
          className="bg-[#111] border border-white/[0.08] rounded-2xl p-8"
        >
          <h1 className="text-[22px] font-bold text-white tracking-tight mb-1">Admin sign in</h1>
          <p className="text-[13px] text-white/35 mb-7">Enter your admin password to continue.</p>

          <div className="space-y-3">
            <div className="relative">
              <input
                ref={inputRef}
                type={show ? 'text' : 'password'}
                value={pw}
                onChange={e => setPw(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && attempt()}
                autoFocus
                placeholder="Password"
                className="w-full h-11 bg-white/[0.04] border border-white/[0.08] rounded-lg
                           px-3 pr-10 text-[14px] text-white placeholder-white/20
                           focus:outline-none focus:border-white/25 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShow(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/50 transition-colors"
              >
                {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <AnimatePresence>
              {error && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="text-[12px] text-red-400/80 pl-1"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <button
              onClick={attempt}
              disabled={!pw.trim() || loading}
              className="w-full h-11 rounded-lg bg-white text-black text-[14px] font-600
                         disabled:opacity-40 disabled:cursor-not-allowed
                         hover:opacity-85 active:opacity-75 transition-opacity
                         flex items-center justify-center gap-2 font-semibold"
            >
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</> : 'Sign in'}
            </button>
          </div>
        </motion.div>

        <p className="text-center text-[12px] text-white/20 mt-6">
          HandOff AI · Admin Portal
        </p>
      </div>
    </div>
  )
}
