import { useState, useRef, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Mic, MicOff, Volume2, Loader2, X, CheckCircle2,
  AlertTriangle, ChevronLeft, ChevronRight, Zap,
} from 'lucide-react'
import { useSession } from '../hooks/useSession'
import { useVoice } from '../hooks/useVoice'

const LOCAL_API = 'http://localhost:8080'

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
    const res = await fetch('http://localhost:8080/vision/analyze-screen', {
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
function triggerGhostCursor(hint: IdleHint | null) {
  if (!electronAPI?.showGhostCursor) return
  if (hint && hint.target_x != null && hint.target_y != null) {
    // Convert fractional → screen pixels using the real screen size from Electron
    const sw = window.screen.width  * window.devicePixelRatio
    const sh = window.screen.height * window.devicePixelRatio
    electronAPI.showGhostCursor({
      x: Math.round(hint.target_x * sw / window.devicePixelRatio),
      y: Math.round(hint.target_y * sh / window.devicePixelRatio),
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
  const [sessionLoading, setSessionLoading] = useState(!!sessionParam)

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

  // Backend session
  const session = useSession()
  const [backendStarted, setBackendStarted] = useState(false)
  const [query, setQuery] = useState('')

  // ── Load session from backend if ?session= param present ─────────────────
  useEffect(() => {
    if (!sessionParam) return
    setSessionLoading(true)
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
      .finally(() => setSessionLoading(false))
  }, [sessionParam]) // eslint-disable-line

  // ── Transparent body ─────────────────────────────────────────────────────
  useEffect(() => {
    document.body.classList.add('overlay-mode')
    return () => document.body.classList.remove('overlay-mode')
  }, [])

  // ── Tell Electron to expand/collapse window based on content ─────────────
  const isExpanded = demoMode || backendStarted
  useEffect(() => {
    electronAPI?.setExpanded?.(isExpanded)
  }, [isExpanded])

  // ── Voice ────────────────────────────────────────────────────────────────
  const { state: voiceState, startListening, stopListening, speak } = useVoice({
    onTranscript: (text, isFinal) => {
      if (!isFinal || !text.trim()) return
      const lower = text.toLowerCase()
      if (demoMode) {
        if (lower.includes('next') || lower.includes('done')) advanceDemoStep()
        else if (lower.includes('back') || lower.includes('previous')) prevDemoStep()
        else if (lower.includes('stop') || lower.includes('exit')) stopDemo()
      } else {
        setQuery(text.trim())
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
    setQuery('')
    setIdleHint(null)
    setVerifyHint(null)
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
            triggerGhostCursor(hint)
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
          triggerGhostCursor(hint)
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
  }, [demoMode, demoStep]) // eslint-disable-line

  // ── Backend session ──────────────────────────────────────────────────────
  const handleBackendStart = async () => {
    if (!query.trim()) return
    setBackendStarted(true)
    try { await session.start('demo-user', 'freightos', query) }
    catch { setBackendStarted(false) }
  }

  const handleBackendStop = async () => {
    await session.stop(); setBackendStarted(false); setQuery('')
  }

  useEffect(() => {
    if (session.currentStep?.instruction_text) speak(session.currentStep.instruction_text)
  }, [session.currentStep?.step_index]) // eslint-disable-line

  const backendStep = session.currentStep
  const total       = session.totalSteps
  const progress    = backendStep ? ((backendStep.step_index + 1) / Math.max(total, 1)) * 100 : 0

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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={style} className={`z-[9999] select-none ${inElectron ? 'w-full' : 'w-[700px]'}`}>
      <div
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
              <span className="text-[13px] text-white/60">Setup complete</span>
            ) : (
              <button
                onClick={startDemo}
                className="flex items-center gap-1.5 text-[13px] text-white/40 hover:text-white/80
                           transition-colors duration-150"
              >
                <Zap className="w-3 h-3" />
                Start Google Account Setup
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
                disabled={voiceState === 'processing' || voiceState === 'speaking'}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all
                  ${voiceState === 'listening'
                    ? 'bg-white/15 text-white'
                    : 'text-white/25 hover:text-white/60 hover:bg-white/5'
                  }`}
              >
                {voiceState === 'processing' ? <Loader2 className="w-3 h-3 animate-spin" />
                 : voiceState === 'speaking'  ? <Volume2 className="w-3 h-3" />
                 : voiceState === 'listening' ? <MicOff className="w-3 h-3" />
                 : <Mic className="w-3 h-3" />}
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
                onClick={() => session.advance?.()}
                className="flex items-center gap-1 h-7 px-3 rounded-lg
                           bg-white/8 hover:bg-white/12 border border-white/8
                           text-[12px] text-white/70 hover:text-white transition-all"
              >
                <span>Done</span><ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Close */}
            {(demoMode || backendStarted) && (
              <button
                onClick={demoMode ? stopDemo : handleBackendStop}
                className="w-7 h-7 rounded-lg flex items-center justify-center
                           text-white/20 hover:text-white/60 hover:bg-white/5 transition-all"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* ── Expanded content ─────────────────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {(demoMode || backendStarted) && (
            <motion.div
              key="content"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 34 }}
              className="overflow-hidden"
            >
              <div className="border-t border-white/[0.06] px-4 py-3 space-y-3">

                {/* Instruction text */}
                {demoMode && !isComplete && (
                  <p className="text-[13px] text-white/75 leading-relaxed">
                    {activeSteps[demoStep].instruction}
                  </p>
                )}

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
                      Google Workspace account fully configured.
                    </p>
                    <button
                      onClick={stopDemo}
                      className="ml-auto text-[12px] text-white/25 hover:text-white/50 transition-colors"
                    >
                      Restart
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
            </motion.div>
          )}
        </AnimatePresence>

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
