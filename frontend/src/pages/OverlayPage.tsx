import { useState, useRef, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Mic, MicOff, Volume2, Loader2, X, CheckCircle2,
  AlertTriangle, ChevronLeft, ChevronRight, Zap, BookOpen,
  MessageCircle, Send,
} from 'lucide-react'
import { useSession } from '../hooks/useSession'
import { useVoice } from '../hooks/useVoice'

const LOCAL_API = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'
const FORCE_AUTO_CLICK_STORAGE_KEY = 'handoff.forceAutoClick'

// ── Types ─────────────────────────────────────────────────────────────────────
interface IdleHint {
  on_correct_screen:   boolean
  hint:                string
  element_description: string | null
  confidence:          number
  target_x?:           number | null
  target_y?:           number | null
}

// ── Detect Electron ───────────────────────────────────────────────────────────
const inElectron = typeof window !== 'undefined' && !!(window as any).handoff
const electronAPI = inElectron ? (window as any).handoff : null

// ── Demo SOP ──────────────────────────────────────────────────────────────────
const DEMO_STEPS = [
  {
    title:       'Open Gmail',
    instruction: 'Go to gmail.com in your browser and click "Sign in" in the top-right corner.',
    expected:    'A browser showing gmail.com or workspace.google.com with a visible "Sign in" button in the top-right corner',
  },
  {
    title:       'Enter your email',
    instruction: 'Type your new Google Workspace email address (e.g. you@yourcompany.com) and click "Next".',
    expected:    'Google accounts sign-in page at accounts.google.com showing an email address text input field and a "Next" button',
  },
  {
    title:       'Enter your password',
    instruction: 'Type your temporary password provided by your IT admin, then click "Next".',
    expected:    'Google accounts page at accounts.google.com showing a password input field (not the email field)',
  },
  {
    title:       'Accept terms',
    instruction: 'Review the Google Workspace Terms of Service. Click "I agree" to continue.',
    expected:    'Google Terms of Service or Welcome page with an "I agree" or "Accept" button',
  },
  {
    title:       'Set a new password',
    instruction: 'Create a strong password — at least 12 characters with letters, numbers and symbols. Confirm it and click "Change password".',
    expected:    'Google page asking to create or change a password with two password input fields',
  },
  {
    title:       'Enable 2-Step Verification',
    instruction: 'Go to myaccount.google.com → Security → 2-Step Verification. Click "Get started" and follow the prompts.',
    expected:    'Google Account security page at myaccount.google.com showing 2-Step Verification settings',
  },
  {
    title:       'Add a recovery email',
    instruction: 'Still in Security, click "Recovery email" and add a personal email for account recovery.',
    expected:    'Google Account page showing a recovery email input field or the recovery email settings section',
  },
  {
    title:       'Explore Google Drive',
    instruction: 'Navigate to drive.google.com. Click "+ New" and create a test document to confirm your account works.',
    expected:    'Google Drive at drive.google.com showing the main Drive interface with a "+ New" button',
  },
]

// ── Vision API (proxied through Electron IPC, or direct fetch in browser) ─────
async function analyzeScreen(
  screenshotBase64: string,
  stepIndex: number,
  instructionText: string,
  expectedScreen?: string,
): Promise<IdleHint | null> {
  if (electronAPI?.analyzeScreen) {
    try {
      const result = await electronAPI.analyzeScreen({ screenshotBase64, stepIndex, instructionText, expectedScreen })
      if (result?.ok) return result.data as IdleHint
      return null
    } catch (_e) { return null }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(`${LOCAL_API}/vision/analyze-screen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot_base64: screenshotBase64, step_index: stepIndex, instruction_text: instructionText, expected_screen: expectedScreen }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await res.json() as IdleHint
  } catch (_e) { return null }
  finally { clearTimeout(timeout) }
}

// ── Ghost cursor helper ───────────────────────────────────────────────────────
function triggerGhostCursor(
  hint: IdleHint | null,
  options?: { allowAutoClick?: boolean; forceAutoClickMode?: boolean },
) {
  if (!electronAPI?.showGhostCursor) return
  if (hint && hint.target_x != null && hint.target_y != null) {
    const allowAutoClick = Boolean(options?.allowAutoClick)
    const forceAutoClickMode = Boolean(options?.forceAutoClickMode)
    const shouldAutoClick =
      allowAutoClick &&
      (forceAutoClickMode || (!hint.on_correct_screen && hint.confidence >= 0.35))

    electronAPI.showGhostCursor({
      // Keep normalized coords; Electron main process maps to display pixels.
      x: hint.target_x,
      y: hint.target_y,
      normalized: true,
      // Optional OS-level click automation. forceAutoClickMode bypasses confidence.
      autoClick: shouldAutoClick,
      forceAutoClick: forceAutoClickMode,
    })
  } else {
    electronAPI.hideGhostCursor()
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function OverlayPage() {
  // Session from URL param (?session=<id>)
  const urlParams    = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const sessionParam = urlParams.get('session')

  // Live SOP steps: either from backend session or DEMO_STEPS fallback
  const [activeSteps, setActiveSteps] = useState<typeof DEMO_STEPS>(DEMO_STEPS)
  const [sessionId,   setSessionId]   = useState<string | null>(sessionParam)

  // Company SOP picker
  const [availableSops, setAvailableSops] = useState<{id: string; title: string; role: string; steps: any[]}[]>([])
  const [sopPickerOpen, setSopPickerOpen] = useState(false)
  const [pickerSopId,   setPickerSopId]   = useState('')
  const [pickerName,    setPickerName]    = useState('')
  const [startingSession, setStartingSession] = useState(false)
  const [forceAutoClick, setForceAutoClick] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(FORCE_AUTO_CLICK_STORAGE_KEY) === 'true'
  })

  // Demo state
  const [demoMode,    setDemoMode]    = useState(false)
  const [demoStep,    setDemoStep]    = useState(0)
  const [demoChecked, setDemoChecked] = useState<boolean[]>(DEMO_STEPS.map(() => false))

  // Verification state
  const [isVerifying, setIsVerifying] = useState(false)
  const [verifyHint,  setVerifyHint]  = useState<IdleHint | null>(null)

  // Idle hint state
  const [isAnalysing, setIsAnalysing] = useState(false)
  const [idleHint,    setIdleHint]    = useState<IdleHint | null>(null)
  const idleCleanupRef = useRef<(() => void) | null>(null)
  const widgetRef      = useRef<HTMLDivElement>(null)

  // Chat assistant
  const [chatOpen,    setChatOpen]    = useState(false)
  const [chatInput,   setChatInput]   = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'ai'; text: string }[]>([])
  const chatEndRef   = useRef<HTMLDivElement>(null)
  const chatOpenRef  = useRef(false)   // stable ref so onTranscript can read it
  const sendChatRef  = useRef<(msg?: string) => void>(() => {})

  // Backend session
  const session = useSession()
  const [backendStarted, setBackendStarted] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(FORCE_AUTO_CLICK_STORAGE_KEY, String(forceAutoClick))
  }, [forceAutoClick])

  // ── Load session from backend if ?session= param present ─────────────────
  useEffect(() => {
    if (!sessionParam) return
    fetch(`${LOCAL_API}/local/sessions/${sessionParam}`)
      .then(r => r.json())
      .then(data => {
        const sop = data.sop
        if (sop?.steps?.length) {
          setActiveSteps(sop.steps)
          setDemoChecked(sop.steps.map(() => false))
          setSessionId(sessionParam)
        }
        // Auto-start the demo when loaded from a real session
        setDemoMode(true)
        setDemoStep(data.current_step ?? 0)
      })
      .catch(() => {/* fall back to DEMO_STEPS */})
  }, [sessionParam]) // eslint-disable-line

  // ── Fetch company SOPs from backend ──────────────────────────────────────
  useEffect(() => {
    fetch(`${LOCAL_API}/local/sops`)
      .then(r => r.json())
      .then(data => setAvailableSops(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  // ── Start a company-mode session from the widget picker ───────────────────
  const startCompanySession = async () => {
    if (!pickerName.trim() || !pickerSopId) return
    setStartingSession(true)
    try {
      const res = await fetch(`${LOCAL_API}/local/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sop_id: pickerSopId, employee_name: pickerName.trim() }),
      })
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      setSessionId(data.id)
      setActiveSteps(data.sop.steps)
      setDemoChecked(data.sop.steps.map(() => false))
      setSopPickerOpen(false)
      setDemoMode(true)
      setDemoStep(0)
      if (electronAPI) electronAPI.stepStarted(0)
    } catch (_e) { /* silent — stays on picker */ }
    finally { setStartingSession(false) }
  }

  // ── Transparent body ─────────────────────────────────────────────────────
  useEffect(() => {
    document.body.classList.add('overlay-mode')
    return () => document.body.classList.remove('overlay-mode')
  }, [])

  // ResizeObserver fires automatically whenever the widget grows/shrinks,
  // including during Framer Motion spring animations
  useEffect(() => {
    if (!electronAPI?.setExpanded || !widgetRef.current) return
    const el = widgetRef.current
    const send = (h: number) => electronAPI.setExpanded(Math.ceil(h) + 1)

    // Send initial height
    send(el.getBoundingClientRect().height || 52)

    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height
      // Fire on every change — including when height drops back to 52 (collapsed)
      if (h != null) send(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, []) // runs once; ResizeObserver handles all subsequent changes

  // Keep chatOpenRef in sync
  useEffect(() => { chatOpenRef.current = chatOpen }, [chatOpen])

  // Backstop: when the content section fully collapses, snap Electron window to 52 px
  useEffect(() => {
    if (!electronAPI?.setExpanded) return
    if (!demoMode && !backendStarted && !sopPickerOpen) {
      const t = setTimeout(() => electronAPI.setExpanded(52), 350)
      return () => clearTimeout(t)
    }
  }, [demoMode, backendStarted, sopPickerOpen])

  // ── Voice ────────────────────────────────────────────────────────────────
  const { state: voiceState, startListening, stopListening, speak } = useVoice({
    onTranscript: (text, isFinal) => {
      if (!isFinal || !text.trim()) return
      // When chat panel is open, voice goes to the AI assistant
      if (chatOpenRef.current) {
        sendChatRef.current(text.trim())
        return
      }
      const lower = text.toLowerCase()
      if (demoMode) {
        if (lower.includes('next') || lower.includes('done')) advanceDemoStep()
        else if (lower.includes('back') || lower.includes('previous')) prevDemoStep()
        else if (lower.includes('stop') || lower.includes('exit')) stopDemo()
      } else {
        session.sendVoiceCommand(text.trim())
      }
    },
  })

  useEffect(() => {
    if (demoMode && activeSteps[demoStep]) speak(activeSteps[demoStep].instruction)
  }, [demoMode, demoStep]) // eslint-disable-line

  // ── Demo lifecycle ───────────────────────────────────────────────────────
  const startDemo = () => {
    setDemoMode(true)
    setDemoStep(0)
    setDemoChecked(activeSteps.map(() => false))
    setIdleHint(null)
    setVerifyHint(null)
    if (electronAPI) electronAPI.stepStarted(0)
  }

  const stopDemo = () => {
    setDemoMode(false)
    setIdleHint(null)
    setVerifyHint(null)
    setSopPickerOpen(false)
    setPickerSopId('')
    setPickerName('')
    setActiveSteps(DEMO_STEPS)
    setSessionId(null)
    electronAPI?.hideGhostCursor?.()
    if (electronAPI) { electronAPI.sessionEnded(); electronAPI.offIdleAlert?.() }
    idleCleanupRef.current?.()
  }

  const doAdvanceStep = () => {
    setVerifyHint(null)
    setIdleHint(null)
    electronAPI?.hideGhostCursor?.()
    setDemoChecked(prev => { const n = [...prev]; n[demoStep] = true; return n })

    // Report completion to backend session if one is active
    if (sessionId) {
      fetch(`${LOCAL_API}/local/sessions/${sessionId}/steps/${demoStep}/complete`, { method: 'POST' })
        .catch(() => {/* silent */})
    }

    setDemoStep(prev => {
      const next = Math.min(prev + 1, activeSteps.length - 1)
      if (electronAPI) electronAPI.stepStarted(next)
      // Mark session finished when all steps done
      if (next === activeSteps.length - 1 && sessionId) {
        fetch(`${LOCAL_API}/local/sessions/${sessionId}/finish`, { method: 'POST' })
          .catch(() => {/* silent */})
      }
      return next
    })
  }

  const advanceDemoStep = async () => {
    setVerifyHint(null)
    setIdleHint(null)
    if (electronAPI?.captureScreen) {
      setIsVerifying(true)
      try {
        const result = await electronAPI.captureScreen()
        if (result?.ok) {
          const hint = await analyzeScreen(result.data, demoStep, activeSteps[demoStep].instruction, activeSteps[demoStep].expected)
          if (hint === null || hint.confidence === 0) {
            setVerifyHint({
              on_correct_screen: false,
              hint: 'Could not check your screen — backend or AI may be down.',
              element_description: null,
              confidence: 0,
            })
            setIsVerifying(false)
            return
          }
          if (!hint.on_correct_screen) {
            setVerifyHint(hint)
            setIsVerifying(false)
            triggerGhostCursor(hint, { allowAutoClick: true, forceAutoClickMode: forceAutoClick })
            return
          }
        } else {
          setVerifyHint({
            on_correct_screen: false,
            hint: 'Screen capture failed. Grant Screen Recording permission in System Settings → Privacy & Security.',
            element_description: null,
            confidence: 0,
          })
          setIsVerifying(false)
          return
        }
      } catch (_err) { /* proceed */ }
      setIsVerifying(false)
    }
    doAdvanceStep()
  }

  const prevDemoStep = () => {
    setIdleHint(null)
    setVerifyHint(null)
    setDemoStep(prev => {
      const next = Math.max(prev - 1, 0)
      if (electronAPI) electronAPI.stepStarted(next)
      return next
    })
  }

  const isComplete = demoMode && demoStep === activeSteps.length - 1 && demoChecked[activeSteps.length - 1]

  // ── Idle alert ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!demoMode) return
    if (electronAPI?.onIdleAlert) {
      electronAPI.onIdleAlert(async (payload: { stepIndex: number; screenshotData: string | null }) => {
        if (payload.stepIndex !== demoStep) return
        setIsAnalysing(true); setIdleHint(null)
        if (payload.screenshotData) {
          const hint = await analyzeScreen(payload.screenshotData, demoStep, activeSteps[demoStep].instruction, activeSteps[demoStep].expected)
          setIdleHint(hint)
          triggerGhostCursor(hint, { allowAutoClick: true, forceAutoClickMode: forceAutoClick })
        }
        setIsAnalysing(false)
      })
      return () => { electronAPI.offIdleAlert?.() }
    }
    const timer = setTimeout(async () => {
      if (!electronAPI?.captureScreen) return
      setIsAnalysing(true); setIdleHint(null)
      const result = await electronAPI.captureScreen()
      if (result?.ok) {
        const hint = await analyzeScreen(result.data, demoStep, activeSteps[demoStep].instruction, activeSteps[demoStep].expected)
        setIdleHint(hint)
      }
      setIsAnalysing(false)
    }, 20_000)
    idleCleanupRef.current = () => clearTimeout(timer)
    return () => clearTimeout(timer)
  }, [demoMode, demoStep, forceAutoClick]) // eslint-disable-line

  const handleBackendStop = async () => {
    await session.stop(); setBackendStarted(false)
  }

  useEffect(() => {
    if (session.currentStep?.instruction_text) speak(session.currentStep.instruction_text)
  }, [session.currentStep?.step_index]) // eslint-disable-line

  const backendStep = session.currentStep
  const total       = session.totalSteps
  const progress    = backendStep ? ((backendStep.step_index + 1) / Math.max(total, 1)) * 100 : 0

  // ── Chat ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  // Reset chat when step changes
  useEffect(() => {
    setChatMessages([])
    setChatInput('')
  }, [demoStep])

  const sendChat = useCallback(async (voiceMsg?: string) => {
    const msg = (voiceMsg ?? chatInput).trim()
    if (!msg || chatLoading) return
    setChatInput('')
    setChatMessages(prev => [...prev, { role: 'user', text: msg }])
    setChatLoading(true)
    try {
      const step = activeSteps[demoStep]
      const res  = await fetch(`${LOCAL_API}/local/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message:          msg,
          step_title:       step.title,
          step_instruction: step.instruction,
          step_num:         demoStep + 1,
          total_steps:      activeSteps.length,
        }),
      })
      const data = await res.json()
      setChatMessages(prev => [...prev, { role: 'ai', text: data.reply }])
      speak(data.reply)
      if (data.should_advance) {
        setTimeout(() => doAdvanceStep(), 1200)
      }
    } catch {
      setChatMessages(prev => [...prev, { role: 'ai', text: "Sorry, I couldn't reach the assistant. Please try again." }])
    } finally {
      setChatLoading(false)
    }
  }, [chatInput, chatLoading, activeSteps, demoStep]) // eslint-disable-line

  // Keep sendChatRef current so onTranscript can call it without stale closure
  useEffect(() => { sendChatRef.current = sendChat }, [sendChat])

  // ── Dragging (web mode only) ─────────────────────────────────────────────
  const posRef = useRef({ startX: 0, startY: 0 })
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if (inElectron) return
    posRef.current = { startX: e.clientX - (pos?.x ?? 0), startY: e.clientY - (pos?.y ?? 0) }
    const onMove = (ev: MouseEvent) => setPos({ x: ev.clientX - posRef.current.startX, y: ev.clientY - posRef.current.startY })
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [pos])

  // In Electron the window itself is positioned by main.js — just fill it from (0,0)
  // In browser, center the bar near the top
  const style = inElectron
    ? { position: 'fixed' as const, top: 0, left: 0, right: 0 }
    : pos
      ? { position: 'fixed' as const, left: pos.x, top: pos.y }
      : { position: 'fixed' as const, top: 28, left: '50%', transform: 'translateX(-50%)' }

  const activeHint = verifyHint || idleHint

  const forceClickCurrentTarget = useCallback(async () => {
    if (!electronAPI?.captureScreen) return

    // If we already have a target, click immediately.
    if (activeHint?.target_x != null && activeHint.target_y != null) {
      triggerGhostCursor(activeHint, { allowAutoClick: true, forceAutoClickMode: true })
      return
    }

    const instructionText = demoMode
      ? activeSteps[demoStep]?.instruction
      : backendStep?.instruction_text
    if (!instructionText) return

    const expectedScreen = demoMode ? activeSteps[demoStep]?.expected : undefined
    setIsVerifying(true)
    try {
      const result = await electronAPI.captureScreen()
      if (!result?.ok) return
      const hint = await analyzeScreen(
        result.data,
        demoMode ? demoStep : (backendStep?.step_index ?? 0),
        instructionText,
        expectedScreen,
      )
      if (!hint) return
      setVerifyHint(hint)
      triggerGhostCursor(hint, { allowAutoClick: true, forceAutoClickMode: true })
    } finally {
      setIsVerifying(false)
    }
  }, [activeHint, activeSteps, backendStep, demoMode, demoStep])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={style} className={`z-[9999] select-none ${inElectron ? 'w-full' : 'w-[700px]'}`}>
      <div
        ref={widgetRef}
        className="w-full overflow-hidden rounded-2xl
                   border border-white/[0.07]
                   bg-[#111111]/95 backdrop-blur-2xl
                   shadow-[0_8px_40px_rgba(0,0,0,0.6)]"
        style={{ WebkitAppRegion: inElectron ? 'no-drag' : undefined } as any}
      >

        {/* ── Command bar ──────────────────────────────────────────────────── */}
        <div
          onMouseDown={onDragStart}
          className="flex items-center h-[52px] px-4 gap-3"
          style={{ WebkitAppRegion: inElectron ? 'drag' : undefined } as any}
        >
          {/* Logo dot + wordmark */}
          <div
            className="flex items-center gap-2 flex-shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as any}
          >
            <div className="w-[7px] h-[7px] rounded-full bg-white" />
            <span className="text-[13px] font-semibold text-white tracking-tight">HandOff</span>
          </div>

          <div className="w-px h-[18px] bg-white/10 flex-shrink-0" />

          {/* Center — step info or idle prompt */}
          <div className="flex-1 min-w-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
            {demoMode && !isComplete ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[12px] text-white/30 flex-shrink-0 tabular-nums">
                  {demoStep + 1}/{activeSteps.length}
                </span>
                <span className="text-[13px] text-white/80 truncate">
                  {activeSteps[demoStep].title}
                </span>
              </div>
            ) : backendStarted && backendStep ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[12px] text-white/30 flex-shrink-0 tabular-nums">
                  {backendStep.step_index + 1}/{total}
                </span>
                <span className="text-[13px] text-white/80 truncate">
                  {backendStep.instruction_text}
                </span>
              </div>
            ) : isComplete ? (
              <span className="text-[13px] text-white/60">All done — great work!</span>
            ) : sopPickerOpen ? (
              <span className="text-[13px] text-white/50">Choose your onboarding guide</span>
            ) : (
              <button
                onClick={() => setSopPickerOpen(true)}
                className="flex items-center gap-1.5 text-[13px] text-white/40 hover:text-white/80
                           transition-colors duration-150"
              >
                {availableSops.length > 0
                  ? <><BookOpen className="w-3 h-3" /> Start onboarding</>
                  : <><Zap className="w-3 h-3" /> Start Google Account Setup</>}
              </button>
            )}
          </div>

          {/* Right controls */}
          <div
            className="flex items-center gap-1 flex-shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as any}
          >
            {/* Voice mic */}
            {(demoMode || backendStarted) && !isComplete && (
              <button
                onClick={voiceState === 'listening' ? stopListening : startListening}
                disabled={voiceState === 'processing'}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all
                  ${voiceState === 'listening'
                    ? 'bg-white/15 text-white'
                    : voiceState === 'speaking'
                      ? 'text-white/40 hover:text-white/70 hover:bg-white/5'
                      : 'text-white/25 hover:text-white/60 hover:bg-white/5'
                  }`}
              >
                {voiceState === 'processing' ? <Loader2 className="w-3 h-3 animate-spin" />
                 : voiceState === 'speaking'  ? <Volume2 className="w-3 h-3" />
                 : voiceState === 'listening' ? <MicOff className="w-3 h-3" />
                 : <Mic className="w-3 h-3" />}
              </button>
            )}

            {/* Chat toggle */}
            {demoMode && !isComplete && (
              <button
                onClick={() => setChatOpen(o => !o)}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all
                  ${chatOpen
                    ? 'bg-white/15 text-white'
                    : 'text-white/25 hover:text-white/60 hover:bg-white/5'
                  }`}
                title="Ask a question or say you've already done this"
              >
                <MessageCircle className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Back / Next */}
            {demoMode && !isComplete && (
              <>
                <button
                  onClick={prevDemoStep}
                  disabled={demoStep === 0 || isVerifying}
                  className="w-7 h-7 rounded-lg flex items-center justify-center
                             text-white/25 hover:text-white/70 hover:bg-white/5
                             disabled:opacity-20 disabled:pointer-events-none transition-all"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={advanceDemoStep}
                  disabled={isVerifying}
                  className="flex items-center gap-1 h-7 px-3 rounded-lg
                             bg-white/8 hover:bg-white/12 border border-white/8
                             text-[12px] text-white/70 hover:text-white
                             disabled:opacity-40 disabled:pointer-events-none transition-all"
                >
                  {isVerifying ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /><span>Checking</span></>
                  ) : (
                    <><span>Done</span><ChevronRight className="w-3.5 h-3.5" /></>
                  )}
                </button>
              </>
            )}

            {/* Backend nav */}
            {backendStarted && backendStep && (
              <button
                onClick={() => session.sendVoiceCommand('next step')}
                className="flex items-center gap-1 h-7 px-3 rounded-lg
                           bg-white/8 hover:bg-white/12 border border-white/8
                           text-[12px] text-white/70 hover:text-white transition-all"
              >
                <span>Done</span><ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Close */}
            {(demoMode || backendStarted || sopPickerOpen) && (
              <button
                onClick={demoMode ? stopDemo : backendStarted ? handleBackendStop : () => setSopPickerOpen(false)}
                className="w-7 h-7 rounded-lg flex items-center justify-center
                           text-white/20 hover:text-white/60 hover:bg-white/5 transition-all"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* ── Expanded content ─────────────────────────────────────────────── */}
        {/* CSS grid-rows trick: no inline height style → ResizeObserver always fires */}
        <div
          style={{
            display: 'grid',
            gridTemplateRows: (demoMode || backendStarted || sopPickerOpen) ? '1fr' : '0fr',
            transition: 'grid-template-rows 260ms cubic-bezier(0.4,0,0.2,1)',
          }}
        >
          <div className="overflow-hidden">
            <div
              className="border-t border-white/[0.06] px-4 py-3 space-y-3"
              style={{
                opacity: (demoMode || backendStarted || sopPickerOpen) ? 1 : 0,
                transition: 'opacity 200ms ease',
              }}
            >

                {/* ── SOP picker ─────────────────────────────────────────── */}
                {sopPickerOpen && !demoMode && (
                  <div className="space-y-2.5">
                    {/* Company SOPs */}
                    {availableSops.length > 0 && (
                      <div className="space-y-1.5">
                        {availableSops.map(sop => (
                          <button
                            key={sop.id}
                            onClick={() => setPickerSopId(sop.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-all ${
                              pickerSopId === sop.id
                                ? 'bg-white/12 border border-white/20'
                                : 'bg-white/4 border border-white/8 hover:bg-white/8'
                            }`}
                          >
                            <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-all ${
                              pickerSopId === sop.id ? 'border-white bg-white' : 'border-white/25'
                            }`} />
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] text-white/80 truncate">{sop.title}</p>
                              <p className="text-[11px] text-white/30">{sop.role} · {sop.steps.length} steps</p>
                            </div>
                          </button>
                        ))}
                        {/* Divider + demo option */}
                        <div className="flex items-center gap-2 py-0.5">
                          <div className="flex-1 h-px bg-white/6" />
                          <span className="text-[10px] text-white/20 uppercase tracking-wider">or</span>
                          <div className="flex-1 h-px bg-white/6" />
                        </div>
                        <button
                          onClick={() => { setSopPickerOpen(false); startDemo() }}
                          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-all
                            bg-white/4 border border-white/8 hover:bg-white/8`}
                        >
                          <div className="w-3.5 h-3.5 rounded-full border-2 border-white/25 shrink-0" />
                          <div>
                            <p className="text-[13px] text-white/50">Demo — Google Workspace Setup</p>
                            <p className="text-[11px] text-white/25">8 steps · for testing only</p>
                          </div>
                        </button>
                      </div>
                    )}

                    {/* No SOPs — just show demo */}
                    {availableSops.length === 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] text-white/30 px-1">No company guides yet. Using demo:</p>
                        <button
                          onClick={() => { setSopPickerOpen(false); startDemo() }}
                          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left bg-white/4 border border-white/8 hover:bg-white/8 transition-all"
                        >
                          <Zap className="w-3.5 h-3.5 text-white/30" />
                          <div>
                            <p className="text-[13px] text-white/60">Demo — Google Workspace Setup</p>
                            <p className="text-[11px] text-white/25">8 steps</p>
                          </div>
                        </button>
                      </div>
                    )}

                    {/* Name input — appears when a company SOP is selected */}
                    <AnimatePresence>
                      {pickerSopId && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="space-y-2 overflow-hidden"
                        >
                          <input
                            autoFocus
                            value={pickerName}
                            onChange={e => setPickerName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && startCompanySession()}
                            placeholder="Your name to track progress…"
                            className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2
                                       text-[13px] text-white placeholder-white/25
                                       focus:outline-none focus:border-white/30"
                          />
                          <button
                            onClick={startCompanySession}
                            disabled={!pickerName.trim() || startingSession}
                            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg
                                       bg-white text-black text-[13px] font-medium
                                       disabled:opacity-40 disabled:cursor-not-allowed
                                       hover:bg-white/90 transition-colors"
                          >
                            {startingSession
                              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting…</>
                              : 'Start →'}
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Instruction text */}
                {demoMode && !isComplete && (
                  <p className="text-[13px] text-white/75 leading-relaxed">
                    {activeSteps[demoStep].instruction}
                  </p>
                )}

                {/* ── Chat panel ─────────────────────────────────────────── */}
                <AnimatePresence>
                  {demoMode && !isComplete && chatOpen && (
                    <motion.div
                      key="chat"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                      className="overflow-hidden"
                    >
                      <div className="border border-white/[0.07] rounded-xl overflow-hidden">
                        {/* Message history */}
                        {chatMessages.length > 0 && (
                          <div className="max-h-[160px] overflow-y-auto px-3 pt-3 space-y-2 scroll-smooth">
                            {chatMessages.map((m, i) => (
                              <div
                                key={i}
                                className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                              >
                                <div className={`max-w-[85%] px-2.5 py-1.5 rounded-xl text-[12px] leading-relaxed ${
                                  m.role === 'user'
                                    ? 'bg-white/10 text-white/80'
                                    : 'bg-white/5 text-white/60'
                                }`}>
                                  {m.text}
                                </div>
                              </div>
                            ))}
                            {chatLoading && (
                              <div className="flex gap-2 justify-start">
                                <div className="px-2.5 py-1.5 rounded-xl bg-white/5">
                                  <Loader2 className="w-3 h-3 text-white/30 animate-spin" />
                                </div>
                              </div>
                            )}
                            <div ref={chatEndRef} />
                          </div>
                        )}

                        {/* Input row */}
                        <div className="flex items-center gap-2 px-3 py-2">
                          {voiceState === 'listening' ? (
                            <p className="flex-1 text-[12px] text-white/40 italic animate-pulse">
                              Listening… speak now
                            </p>
                          ) : (
                            <input
                              value={chatInput}
                              onChange={e => setChatInput(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendChat()}
                              placeholder={chatMessages.length === 0
                                ? 'Type or tap 🎤 to speak…'
                                : 'Reply…'}
                              disabled={chatLoading}
                              autoFocus
                              className="flex-1 bg-transparent text-[12px] text-white/70 placeholder-white/20
                                         focus:outline-none disabled:opacity-40"
                            />
                          )}
                          {/* Mic button */}
                          <button
                            onClick={voiceState === 'listening' ? stopListening : startListening}
                            disabled={voiceState === 'processing' || chatLoading}
                            className={`w-6 h-6 flex items-center justify-center rounded-lg transition-all
                              ${voiceState === 'listening'
                                ? 'text-white bg-white/15'
                                : 'text-white/25 hover:text-white/60 hover:bg-white/8'
                              } disabled:opacity-20 disabled:pointer-events-none`}
                          >
                            {voiceState === 'processing'
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : voiceState === 'listening'
                                ? <MicOff className="w-3 h-3" />
                                : <Mic className="w-3 h-3" />}
                          </button>
                          {/* Send button */}
                          <button
                            onClick={() => sendChat()}
                            disabled={!chatInput.trim() || chatLoading || voiceState === 'listening'}
                            className="w-6 h-6 flex items-center justify-center rounded-lg
                                       text-white/30 hover:text-white/70 hover:bg-white/8
                                       disabled:opacity-20 disabled:pointer-events-none transition-all"
                          >
                            <Send className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Backend instruction */}
                {backendStarted && backendStep && (
                  <p className="text-[13px] text-white/75 leading-relaxed">
                    {backendStep.instruction_text}
                  </p>
                )}

                {/* Complete */}
                {isComplete && (
                  <div className="flex items-center gap-2 py-1">
                    <CheckCircle2 className="w-4 h-4 text-white/60 flex-shrink-0" />
                    <p className="text-[13px] text-white/60">
                      All steps complete — you're all set!
                    </p>
                    <button
                      onClick={stopDemo}
                      className="ml-auto text-[12px] text-white/25 hover:text-white/50 transition-colors"
                    >
                      Done
                    </button>
                  </div>
                )}

                {/* Progress bar */}
                {demoMode && !isComplete && (
                  <div className="flex gap-[3px]">
                    {activeSteps.map((_, i) => (
                      <div
                        key={i}
                        className={`h-[2px] flex-1 rounded-full transition-all duration-300 ${
                          demoChecked[i] ? 'bg-white/70'
                          : i === demoStep  ? 'bg-white/40'
                          : 'bg-white/10'
                        }`}
                      />
                    ))}
                  </div>
                )}

                {backendStarted && (
                  <div className="h-[2px] bg-white/10 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-white/50 rounded-full"
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.4, ease: 'easeOut' }}
                    />
                  </div>
                )}

                {(demoMode || backendStarted) && inElectron && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-white/3 px-3 py-2">
                    <button
                      onClick={() => setForceAutoClick((v) => !v)}
                      className={`text-[11px] px-2 py-1 rounded-md transition-colors ${
                        forceAutoClick
                          ? 'bg-amber-400/20 text-amber-300'
                          : 'bg-white/6 text-white/45 hover:text-white/70'
                      }`}
                    >
                      Force auto-click: {forceAutoClick ? 'ON' : 'OFF'}
                    </button>
                    <button
                      onClick={forceClickCurrentTarget}
                      disabled={isVerifying || isAnalysing}
                      className="text-[11px] px-2 py-1 rounded-md bg-white/8 text-white/70 hover:bg-white/12 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                    >
                      Click target now
                    </button>
                  </div>
                )}

                {/* Hint panel (verify / idle) */}
                <AnimatePresence>
                  {isVerifying && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                      className="flex items-center gap-2"
                    >
                      <Loader2 className="w-3 h-3 text-white/40 animate-spin flex-shrink-0" />
                      <p className="text-[12px] text-white/40">Checking your screen…</p>
                    </motion.div>
                  )}

                  {isAnalysing && !isVerifying && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                      className="flex items-center gap-2"
                    >
                      <Loader2 className="w-3 h-3 text-white/40 animate-spin flex-shrink-0" />
                      <p className="text-[12px] text-white/40">Analysing your screen…</p>
                    </motion.div>
                  )}

                  {activeHint && !isVerifying && !isAnalysing && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                      className="flex items-start gap-2.5"
                    >
                      <AlertTriangle className={`w-3.5 h-3.5 mt-[1px] flex-shrink-0 ${
                        activeHint.on_correct_screen ? 'text-white/40' : 'text-amber-400/80'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] text-white/60 leading-relaxed">
                          {activeHint.hint}
                        </p>
                        {activeHint.element_description && (
                          <p className="text-[11px] text-white/30 mt-0.5 leading-relaxed">
                            {activeHint.element_description}
                          </p>
                        )}
                        <div className="flex items-center gap-3 mt-1.5">
                          {!activeHint.on_correct_screen && verifyHint && (
                            <button
                              onClick={doAdvanceStep}
                              className="text-[11px] text-white/30 hover:text-white/60 transition-colors"
                            >
                              Advance anyway →
                            </button>
                          )}
                          <button
                            onClick={() => { setVerifyHint(null); setIdleHint(null) }}
                            className="text-[11px] text-white/20 hover:text-white/40 transition-colors"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Guardrail (backend) */}
                {session.showGuardrail && (
                  <motion.div
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="flex items-center gap-3 pt-1"
                  >
                    <p className="text-[12px] text-white/50 flex-1">
                      This step can't be undone. Proceed?
                    </p>
                    <button onClick={session.dismissGuardrail}
                      className="text-[12px] text-white/30 hover:text-white/60 transition-colors">
                      Cancel
                    </button>
                    <button onClick={session.confirmGuardrail}
                      className="text-[12px] text-white/70 hover:text-white transition-colors">
                      Proceed
                    </button>
                  </motion.div>
                )}

                {/* Error */}
                {session.error && (
                  <p className="text-[12px] text-red-400/70">{session.error}</p>
                )}
              </div>
            </div>
          </div>

        {/* ── Idle state — no session ──────────────────────────────────────── */}
        {!demoMode && !backendStarted && (
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            />
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
