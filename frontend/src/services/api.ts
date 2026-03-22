import type { SopDocument, SopSummary, SopStep } from '../types'

const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail ?? 'Request failed')
  }
  return res.json()
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export const createSession = (userId: string, productId: string, sopId: string) =>
  request<{ session_id: string; ws_url: string; firebase_path: string }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, product_id: productId, sop_id: sopId }),
  })

export const endSession = (sessionId: string) =>
  request<void>(`/sessions/${sessionId}`, { method: 'DELETE' })

// ── SOPs ──────────────────────────────────────────────────────────────────────

export const listSops = (productId: string) =>
  request<SopSummary[]>(`/sops?product_id=${productId}`)

export const searchSops = (productId: string, query: string, limit = 5) =>
  request<(SopSummary & { similarity_score: number })[]>(
    `/sops/search?product_id=${encodeURIComponent(productId)}&q=${encodeURIComponent(query)}&limit=${limit}`,
  )

export const getSop = (sopId: string) =>
  request<SopDocument>(`/sops/${sopId}`)

export const createSop = (productId: string, name: string, description?: string, token = 'dev') =>
  request<SopDocument>('/sops', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ product_id: productId, name, description }),
  })

export const publishSop = (sopId: string, token = 'dev') =>
  request<{ published: boolean }>(`/sops/${sopId}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

export const deleteSop = (sopId: string, token = 'dev') =>
  request<void>(`/sops/${sopId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

export const addStep = (
  sopId: string,
  step: Omit<SopStep, 'step_index'>,
  token = 'dev',
) =>
  request<SopDocument>(`/sops/${sopId}/steps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(step),
  })

// ── Record Mode ───────────────────────────────────────────────────────────────

export const startRecording = (productId: string, token = 'dev') =>
  request<{ recording_id: string }>(`/sops/record/start?product_id=${productId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

export const appendEvents = (recordingId: string, events: unknown[], token = 'dev') =>
  request<{ appended: number }>(`/sops/record/${recordingId}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(events),
  })

export const finaliseRecording = (recordingId: string, sopName: string, token = 'dev') =>
  request<SopDocument>(`/sops/record/${recordingId}/finalise?sop_name=${encodeURIComponent(sopName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

// ── Admin ─────────────────────────────────────────────────────────────────────

export const getProductAnalytics = (productId: string, token = 'dev') =>
  request<Record<string, unknown>>(`/admin/analytics/${productId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
