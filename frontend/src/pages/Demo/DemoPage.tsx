import { useState, useCallback, useRef, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Package, TruckIcon, FileText, Settings, Bell, Search,
  ChevronDown, Users, ArrowRight, Sparkles, X,
  CheckCircle2, Loader2, AlertCircle, Edit3,
} from 'lucide-react'
import html2canvas from 'html2canvas'
import { GhostCursor } from '../../components/GhostCursor/GhostCursor'
import { StepPanel } from '../../components/Widget/StepPanel'
import { GuardrailOverlay } from '../../components/Widget/GuardrailOverlay'
import { VoiceInterface } from '../../components/Voice/VoiceInterface'
import { useSession } from '../../hooks/useSession'
import { searchSops } from '../../services/api'
import type { SopSummary } from '../../types'

const DEMO_PRODUCT_ID = 'demo-product'
const DEMO_SOP_ID     = 'demo-sop-001'
const DEMO_USER_ID    = 'sarah-demo'

type SopSearchResult = SopSummary & { similarity_score: number }

// ── Fake SaaS dashboard (the "host app") ──────────────────────────────────────

function FreightDashboard({ dashboardRef }: { dashboardRef: React.RefObject<HTMLDivElement | null> }) {
  const [tab, setTab] = useState('shipments')

  return (
    <div
      ref={dashboardRef}
      className="flex h-full bg-[#f8fafc] text-gray-900 rounded-xl overflow-hidden border border-gray-200 shadow-lg"
    >
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
              <TruckIcon className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-sm text-gray-900">FreightOS</span>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {[
            { id: 'shipments', icon: Package,  label: 'Shipments' },
            { id: 'tracking',  icon: TruckIcon, label: 'Tracking' },
            { id: 'invoices',  icon: FileText,  label: 'Invoices' },
            { id: 'settings',  icon: Settings,  label: 'Settings' },
            { id: 'customers', icon: Users,     label: 'Customers' },
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              id={`nav-${id}`}
              onClick={() => setTab(id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                tab === id ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" /> {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-12 bg-white border-b border-gray-200 flex items-center justify-between px-4 flex-shrink-0">
          <div className="flex items-center gap-2 bg-gray-100 rounded-lg px-3 py-1.5 w-56">
            <Search className="w-3.5 h-3.5 text-gray-400" />
            <input
              id="freight-search"
              placeholder="Search shipments..."
              className="bg-transparent text-xs outline-none text-gray-600 w-full"
            />
          </div>
          <div className="flex items-center gap-3">
            <button className="relative p-1.5 rounded-lg hover:bg-gray-100">
              <Bell className="w-4 h-4 text-gray-500" />
              <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-red-500 rounded-full" />
            </button>
            <div className="flex items-center gap-2 text-xs text-gray-600">
              <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-semibold text-xs">
                S
              </div>
              Sarah <ChevronDown className="w-3 h-3" />
            </div>
          </div>
        </header>

        {/* Body */}
        <main className="flex-1 p-5 overflow-auto">
          {tab === 'shipments' ? (
            <div>
              <div className="flex items-center justify-between mb-5">
                <h1 className="font-semibold text-gray-900">New Shipment</h1>
                <button
                  id="submit-dispatch"
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium transition-colors"
                >
                  Submit &amp; Dispatch <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: 'Shipment Type', id: 'shipment-type', type: 'select',
                    opts: ['Select type', 'Air Freight', 'Sea Freight', 'Road Freight'] },
                  { label: 'Origin Port',   id: 'origin-port',  type: 'text', ph: 'e.g. Shanghai' },
                  { label: 'Destination',   id: 'destination',  type: 'text', ph: 'e.g. Los Angeles' },
                  { label: 'Cargo Weight',  id: 'cargo-weight', type: 'text', ph: 'kg' },
                  { label: 'Customer',      id: 'customer',     type: 'text', ph: 'Customer name' },
                  { label: 'Reference No.', id: 'reference',    type: 'text', ph: 'AUTO-GENERATED' },
                ].map((f) => (
                  <div key={f.id}>
                    <label className="block text-xs text-gray-500 mb-1">{f.label}</label>
                    {f.type === 'select' ? (
                      <select
                        id={f.id}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      >
                        {f.opts?.map((o) => <option key={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        id={f.id}
                        placeholder={f.ph}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 text-sm placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400">
              <div className="text-4xl mb-2">📊</div>
              <p className="text-sm">Navigate to the <strong>Shipments</strong> tab to get started.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// ── Autofill confirmation overlay ─────────────────────────────────────────────

function AutofillOverlay({ visible, value, onConfirm, onDismiss }: {
  visible: boolean
  value: string | null
  onConfirm: () => void
  onDismiss: () => void
}) {
  if (!visible) return null
  return (
    <div className="fixed inset-0 z-[9997] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onDismiss} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative z-10 w-full max-w-sm mx-4 rounded-2xl bg-surface-800 border border-brand-500/40 shadow-2xl p-6"
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center flex-shrink-0">
            <Edit3 className="w-5 h-5 text-brand-400" />
          </div>
          <div>
            <h3 className="font-semibold text-white">Autofill Request</h3>
            <p className="text-sm text-slate-400 mt-0.5">HandOff.AI wants to fill in this field for you.</p>
          </div>
        </div>
        {value && (
          <div className="mb-4 px-3 py-2 rounded-xl bg-surface-700 border border-surface-600">
            <p className="text-xs text-slate-400 mb-0.5">Value to fill:</p>
            <p className="text-sm text-white font-mono">{value}</p>
          </div>
        )}
        <div className="flex gap-3">
          <button
            onClick={onDismiss}
            className="flex-1 py-2 rounded-xl border border-surface-600 text-sm text-slate-400 hover:text-white hover:border-surface-500 transition-colors"
          >
            Skip
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors"
          >
            Fill it in
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ── HandOff.AI Widget ─────────────────────────────────────────────────────────

function HandOffWidget({ sessionId, currentStep, totalSteps, onCommand, onClose }: {
  sessionId: string | null
  currentStep: import('../../types').StepPayload | null
  totalSteps: number
  onCommand: (cmd: string) => void
  onClose: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 20, scale: 0.95 }}
      className="fixed bottom-24 right-6 z-[9985] w-64 rounded-2xl border border-brand-500/30 bg-[#0f0f1a]/95 backdrop-blur-md shadow-2xl overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-brand-400" />
          <span className="text-sm font-semibold text-white">HandOff.AI</span>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-700 text-slate-400 cursor-pointer" data-handoff-ignore>
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Step info */}
      {currentStep && (
        <div className="px-4 py-3 border-b border-surface-700">
          <p className="text-xs text-brand-400 mb-1">
            Step {currentStep.step_index + 1} of {totalSteps}
          </p>
          <p className="text-xs text-slate-300 leading-snug">{currentStep.instruction_text}</p>
        </div>
      )}

      {!currentStep && sessionId && (
        <div className="px-4 py-3 border-b border-surface-700">
          <p className="text-xs text-slate-400">Session connected. Waiting for first step…</p>
        </div>
      )}

      {/* Voice */}
      <div className="px-4 py-4" data-handoff-ignore>
        <VoiceInterface
          onCommand={onCommand}
          speakText={currentStep?.instruction_text}
          disabled={!sessionId}
        />
      </div>
    </motion.div>
  )
}

// ── Demo page ─────────────────────────────────────────────────────────────────

export default function DemoPage() {
  const [searchParams] = useSearchParams()
  const session = useSession()

  const [widgetOpen, setWidgetOpen]       = useState(false)
  const [starting, setStarting]           = useState(false)
  const [startError, setStartError]       = useState<string | null>(null)
  const [searchQuery, setSearchQuery]     = useState('')
  const [searching, setSearching]         = useState(false)
  const [searchResults, setSearchResults] = useState<SopSearchResult[]>([])

  const searchTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dashboardRef    = useRef<HTMLDivElement | null>(null)

  // Auto-start if ?sop= query param is present (from Admin Dashboard "Preview" link)
  useEffect(() => {
    const sopId = searchParams.get('sop')
    if (sopId && !session.sessionId && !starting) {
      handleStart(sopId)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const captureScreenshot = useCallback(async (): Promise<string> => {
    const el = dashboardRef.current
    if (!el) return ''
    try {
      const canvas = await html2canvas(el, { useCORS: true, scale: 0.5, logging: false })
      return canvas.toDataURL('image/jpeg', 0.6).split(',')[1] ?? ''
    } catch {
      return ''
    }
  }, [])

  const handleStart = async (sopId = DEMO_SOP_ID) => {
    if (starting) return
    setStarting(true)
    setStartError(null)
    setSearchResults([])
    setSearchQuery('')
    try {
      await session.start(DEMO_USER_ID, DEMO_PRODUCT_ID, sopId)
      setWidgetOpen(true)
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to connect — is the backend running?')
    } finally {
      setStarting(false)
    }
  }

  const handleReopenWidget = () => {
    if (session.sessionId) {
      setWidgetOpen(true)  // re-open existing session — never start a new one
    } else {
      handleStart()
    }
  }

  const handleSearchInput = (value: string) => {
    setSearchQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!value.trim()) { setSearchResults([]); return }
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const results = await searchSops(DEMO_PRODUCT_ID, value)
        setSearchResults(results)
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 350)
  }

  const handleCommand = useCallback(async (cmd: string) => {
    const screenshot = await captureScreenshot()
    session.sendVoiceCommand(cmd, screenshot)
  }, [session, captureScreenshot])

  const handleClose = useCallback(() => {
    session.stop()
    setWidgetOpen(false)
  }, [session])

  return (
    <div className="min-h-screen bg-surface-900 flex flex-col">
      {/* Top nav */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-surface-700" data-handoff-ignore>
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-brand-400" />
          <span className="font-bold text-white text-lg">HandOff.AI</span>
          <span className="ml-2 text-xs text-slate-500 bg-surface-700 px-2 py-0.5 rounded-full">Demo</span>
        </div>
        <a href="/admin" className="text-sm text-slate-400 hover:text-white transition-colors">
          Admin Dashboard →
        </a>
      </header>

      <div className="flex-1 flex flex-col items-center justify-start px-6 py-8 gap-8">
        {/* Intro / search card */}
        <AnimatePresence>
          {!widgetOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="w-full max-w-2xl rounded-2xl border border-brand-500/20 bg-surface-800 p-6 text-center"
              data-handoff-ignore
            >
              <div className="w-12 h-12 rounded-xl bg-brand-500/20 flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-6 h-6 text-brand-400" />
              </div>
              <h2 className="text-xl font-bold text-white mb-2">Experience HandOff.AI</h2>
              <p className="text-sm text-slate-400 mb-5 max-w-md mx-auto">
                Search for any workflow in plain English, or click{' '}
                <strong className="text-white">Start Guided Tour</strong> to watch the Ghost Cursor
                navigate the dashboard and speak each step aloud.
              </p>

              {/* Error banner */}
              {startError && (
                <div className="mb-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-400 text-left">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {startError}
                </div>
              )}

              {/* Semantic search */}
              <div className="relative mb-5">
                <div className="flex items-center gap-2 bg-surface-700 border border-surface-600 rounded-xl px-3 py-2.5 focus-within:border-brand-500/60 transition-colors">
                  {searching
                    ? <Loader2 className="w-4 h-4 text-brand-400 animate-spin flex-shrink-0" />
                    : <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                  <input
                    value={searchQuery}
                    onChange={(e) => handleSearchInput(e.target.value)}
                    placeholder="e.g. how do I create a new shipment?"
                    className="bg-transparent text-sm text-white placeholder-slate-500 outline-none flex-1"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => { setSearchQuery(''); setSearchResults([]) }}
                      className="text-slate-500 hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <AnimatePresence>
                  {searchResults.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className="absolute left-0 right-0 top-full mt-1 bg-surface-700 border border-surface-600 rounded-xl shadow-xl overflow-hidden z-10"
                    >
                      {searchResults.map((r) => (
                        <button
                          key={r.sop_id}
                          onClick={() => handleStart(r.sop_id)}
                          className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-600 transition-colors text-left group"
                        >
                          <div>
                            <p className="text-sm text-white font-medium">{r.name}</p>
                            <p className="text-xs text-slate-400 mt-0.5">{r.total_steps} steps</p>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-400 group-hover:text-brand-400 transition-colors">
                            <span>{Math.round(r.similarity_score * 100)}% match</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </div>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>

                {searchQuery && !searching && searchResults.length === 0 && (
                  <p className="mt-2 text-xs text-slate-500 text-left px-1">
                    No matching workflows found — try a different description.
                  </p>
                )}
              </div>

              <button
                onClick={() => handleStart()}
                disabled={starting}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-medium text-sm transition-colors disabled:opacity-50"
              >
                {starting
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Sparkles className="w-4 h-4" />}
                {starting ? 'Connecting…' : 'Start Guided Tour'}
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Completion banner */}
        <AnimatePresence>
          {session.status === 'completed' && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full max-w-2xl rounded-2xl border border-green-500/30 bg-green-500/10 p-6 text-center"
            >
              <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-3" />
              <h3 className="text-lg font-semibold text-green-300 mb-1">Workflow Complete!</h3>
              <p className="text-sm text-slate-400">
                Sarah processed her first shipment in under 15 minutes. Zero Zoom calls.
              </p>
              <button
                onClick={() => { session.stop(); setWidgetOpen(false) }}
                className="mt-4 px-4 py-2 rounded-xl bg-surface-700 hover:bg-surface-600 text-sm text-slate-300 transition-colors"
              >
                Start over
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* The "host app" (FreightOS demo) */}
        <div className="w-full max-w-4xl h-[520px] relative">
          <FreightDashboard dashboardRef={dashboardRef} />
        </div>
      </div>

      {/* Ghost Cursor — fixed overlay over entire viewport */}
      <GhostCursor sessionId={session.sessionId} />

      {/* Step instruction panel */}
      <StepPanel
        step={session.currentStep}
        totalSteps={session.totalSteps}
        visible={widgetOpen && !!session.currentStep}
      />

      {/* Guardrail warning overlay */}
      <GuardrailOverlay
        visible={session.showGuardrail}
        instructionText={session.currentStep?.instruction_text ?? ''}
        onConfirm={session.confirmGuardrail}
        onDismiss={session.dismissGuardrail}
      />

      {/* Autofill confirmation overlay */}
      <AutofillOverlay
        visible={session.showAutofill}
        value={session.autofillValue}
        onConfirm={session.confirmAutofill}
        onDismiss={() => session.confirmAutofill()}
      />

      {/* Floating HandOff widget */}
      <AnimatePresence>
        {widgetOpen && (
          <HandOffWidget
            sessionId={session.sessionId}
            currentStep={session.currentStep}
            totalSteps={session.totalSteps}
            onCommand={handleCommand}
            onClose={handleClose}
          />
        )}
      </AnimatePresence>

      {/* FAB — re-opens existing session or starts new one */}
      {!widgetOpen && session.status !== 'initialising' && (
        <button
          onClick={handleReopenWidget}
          className="fixed bottom-6 right-6 z-[9980] w-14 h-14 rounded-full bg-brand-600 hover:bg-brand-500 text-white flex items-center justify-center shadow-lg transition-colors"
          data-handoff-ignore
          title="Open HandOff.AI"
        >
          <Sparkles className="w-6 h-6" />
        </button>
      )}
    </div>
  )
}
