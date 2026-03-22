import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Play, Eye, EyeOff, Trash2, Circle, CheckCircle2, Sparkles, Loader2 } from 'lucide-react'
import { listSops, publishSop, deleteSop } from '../../services/api'
import type { SopSummary } from '../../types'

const DEMO_PRODUCT_ID = 'demo-product'

async function seedDemo() {
  const res = await fetch('/api/admin/seed-demo', { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export default function AdminDashboard() {
  const navigate = useNavigate()
  const [sops, setSops]         = useState<SopSummary[]>([])
  const [loading, setLoading]   = useState(true)
  const [seeding, setSeeding]   = useState(false)
  const [seedMsg, setSeedMsg]   = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    const data = await listSops(DEMO_PRODUCT_ID).catch(() => [])
    setSops(data)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handlePublish = async (sopId: string, current: boolean) => {
    try {
      await publishSop(sopId)
      setSops((s) => s.map((x) => x.sop_id === sopId ? { ...x, published: !current } : x))
    } catch { /* ignore */ }
  }

  const handleDelete = async (sopId: string) => {
    if (!confirm('Delete this SOP? This cannot be undone.')) return
    try {
      await deleteSop(sopId)
      setSops((s) => s.filter((x) => x.sop_id !== sopId))
    } catch { /* ignore */ }
  }

  const handleSeedDemo = async () => {
    setSeeding(true)
    setSeedMsg(null)
    try {
      const result = await seedDemo()
      setSeedMsg(`Demo SOP seeded (${result.steps} steps). Ready to preview!`)
      await load()
    } catch (e) {
      setSeedMsg(e instanceof Error ? e.message : 'Seed failed')
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-900 text-white p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5 text-brand-400" />
            <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
          </div>
          <p className="text-sm text-slate-400">Manage your SOPs and onboarding flows</p>
        </div>
        <div className="flex gap-3 flex-wrap justify-end">
          <button
            onClick={handleSeedDemo}
            disabled={seeding}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-700 border border-brand-500/30 text-sm text-brand-300 hover:bg-surface-600 transition-colors disabled:opacity-50"
            title="Create the FreightOS demo SOP in Firebase"
          >
            {seeding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Seed Demo SOP
          </button>
          <Link
            to="/admin/record"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-700 border border-surface-500 text-sm text-slate-300 hover:bg-surface-600 transition-colors"
          >
            <Circle className="w-4 h-4 text-red-400" /> Record Mode
          </Link>
          <Link
            to="/admin/sop/new"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-sm text-white transition-colors"
          >
            <Plus className="w-4 h-4" /> New SOP
          </Link>
        </div>
      </div>

      {/* Seed feedback */}
      <AnimatePresence>
        {seedMsg && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mb-6 flex items-center justify-between px-4 py-3 rounded-xl bg-brand-500/10 border border-brand-500/30 text-sm text-brand-300"
          >
            <span>{seedMsg}</span>
            <button
              onClick={() => navigate('/demo')}
              className="ml-4 flex items-center gap-1 px-3 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-medium transition-colors"
            >
              <Play className="w-3 h-3" /> Try it now
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: 'Total SOPs',  value: sops.length },
          { label: 'Published',   value: sops.filter((s) => s.published).length },
          { label: 'Total Plays', value: sops.reduce((a, s) => a + s.total_plays, 0) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl bg-surface-800 border border-surface-600 p-4">
            <p className="text-xs text-slate-400 mb-1">{stat.label}</p>
            <p className="text-2xl font-bold text-white">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* SOP table */}
      {loading ? (
        <div className="flex items-center justify-center py-20 gap-3 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading SOPs…
        </div>
      ) : sops.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-surface-600 rounded-2xl">
          <p className="text-slate-400 mb-2">No SOPs yet.</p>
          <p className="text-xs text-slate-500 mb-5">
            Click <strong className="text-brand-300">Seed Demo SOP</strong> to load the FreightOS demo,
            or use <strong className="text-slate-300">Record Mode</strong> to create your own.
          </p>
          <div className="flex justify-center gap-3">
            <button
              onClick={handleSeedDemo}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-600 text-white text-sm hover:bg-brand-500 transition-colors"
            >
              <Sparkles className="w-4 h-4" /> Seed Demo
            </button>
            <Link
              to="/admin/record"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-700 text-slate-300 text-sm hover:bg-surface-600 transition-colors"
            >
              <Circle className="w-4 h-4 text-red-300" /> Start Recording
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {sops.map((sop, i) => (
            <motion.div
              key={sop.sop_id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              className="flex items-center gap-4 p-4 rounded-xl bg-surface-800 border border-surface-600 hover:border-surface-500 transition-colors"
            >
              <div className="flex-shrink-0">
                {sop.published
                  ? <CheckCircle2 className="w-5 h-5 text-green-400" />
                  : <Circle className="w-5 h-5 text-slate-500" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-white truncate">{sop.name}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {sop.total_steps} steps · {sop.total_plays} plays · {sop.completion_count} completions
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Link
                  to={`/demo?sop=${sop.sop_id}`}
                  className="p-2 rounded-lg hover:bg-surface-600 text-slate-400 hover:text-green-400 transition-colors"
                  title="Preview in demo"
                >
                  <Play className="w-4 h-4" />
                </Link>
                <button
                  onClick={() => handlePublish(sop.sop_id, sop.published)}
                  className="p-2 rounded-lg hover:bg-surface-600 text-slate-400 hover:text-brand-400 transition-colors"
                  title={sop.published ? 'Unpublish' : 'Publish'}
                >
                  {sop.published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => handleDelete(sop.sop_id)}
                  className="p-2 rounded-lg hover:bg-surface-600 text-slate-400 hover:text-red-400 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}
