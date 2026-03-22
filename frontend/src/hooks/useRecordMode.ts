import { useState, useRef, useCallback, useEffect } from 'react'
import { startRecording, appendEvents, finaliseRecording } from '../services/api'
import type { RecordedEvent } from '../types'

// Attribute applied to the admin UI shell so we can ignore clicks on the recorder itself
export const HANDOFF_IGNORE_ATTR = 'data-handoff-ignore'

function getCssSelector(el: Element): string {
  if (el.id) return `#${el.id}`
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur !== document.body) {
    let seg = cur.tagName.toLowerCase()
    if (cur.className && typeof cur.className === 'string') {
      seg += '.' + [...cur.classList].slice(0, 2).join('.')
    }
    parts.unshift(seg)
    cur = cur.parentElement
  }
  return parts.join(' > ').slice(-100) // cap length
}

function getLabel(el: Element): string {
  return (
    (el as HTMLElement).getAttribute('aria-label') ??
    (el as HTMLInputElement).placeholder ??
    (el as HTMLElement).innerText?.slice(0, 40) ??
    el.tagName
  )
}

/** Returns true if the element (or any ancestor) is marked as HandOff admin UI — skip recording it */
function isAdminUiElement(el: Element | null): boolean {
  let cur = el
  while (cur) {
    if (cur.hasAttribute(HANDOFF_IGNORE_ATTR)) return true
    cur = cur.parentElement
  }
  return false
}

export function useRecordMode(productId: string) {
  const [isRecording, setIsRecording]   = useState(false)
  const [recordingId, setRecordingId]   = useState<string | null>(null)
  const [eventCount, setEventCount]     = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const eventsRef  = useRef<RecordedEvent[]>([])
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const ridRef     = useRef<string | null>(null)  // stable ref so callbacks don't go stale

  const flushEvents = useCallback(async (id: string) => {
    const batch = eventsRef.current.splice(0)
    if (batch.length === 0 || !id) return
    await appendEvents(id, batch).catch(() => {})
    setEventCount((c) => c + batch.length)
  }, [])

  const handleClick = useCallback((ev: MouseEvent) => {
    const el = ev.target as Element
    if (isAdminUiElement(el)) return  // skip recorder UI itself
    eventsRef.current.push({
      event_type:       'click',
      timestamp:        new Date().toISOString(),
      selector:         getCssSelector(el),
      element_tag:      el.tagName.toLowerCase(),
      element_label:    getLabel(el),
      is_password_field: false,
      page_url:         window.location.href,
    })
  }, [])

  const handleInput = useCallback((ev: Event) => {
    const el   = ev.target as HTMLInputElement
    if (isAdminUiElement(el)) return  // skip recorder UI itself
    const isPwd = el.type === 'password'
    eventsRef.current.push({
      event_type:       'input',
      timestamp:        new Date().toISOString(),
      selector:         getCssSelector(el),
      element_tag:      el.tagName.toLowerCase(),
      element_label:    getLabel(el),
      input_value:      isPwd ? undefined : el.value,
      is_password_field: isPwd,
      page_url:         window.location.href,
    })
  }, [])

  const start = useCallback(async () => {
    try {
      setError(null)
      const { recording_id } = await startRecording(productId)
      ridRef.current = recording_id
      setRecordingId(recording_id)
      setEventCount(0)
      eventsRef.current = []
      document.addEventListener('click',  handleClick, true)
      document.addEventListener('change', handleInput, true)
      flushTimer.current = setInterval(() => {
        if (ridRef.current) flushEvents(ridRef.current)
      }, 5000)
      setIsRecording(true)
      return recording_id
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start recording')
      throw e
    }
  }, [productId, handleClick, handleInput, flushEvents])

  const stop = useCallback(async (sopName: string): Promise<string | null> => {
    document.removeEventListener('click',  handleClick, true)
    document.removeEventListener('change', handleInput, true)
    if (flushTimer.current) clearInterval(flushTimer.current)
    setIsRecording(false)

    const id = ridRef.current
    if (!id) return null

    try {
      setError(null)
      await flushEvents(id)
      setIsProcessing(true)
      const result = await finaliseRecording(id, sopName)
      setIsProcessing(false)
      setRecordingId(null)
      ridRef.current = null
      return (result as { sop_id?: string })?.sop_id ?? null
    } catch (e) {
      setIsProcessing(false)
      setError(e instanceof Error ? e.message : 'Failed to finalise recording')
      throw e
    }
  }, [handleClick, handleInput, flushEvents])

  useEffect(() => () => {
    document.removeEventListener('click',  handleClick, true)
    document.removeEventListener('change', handleInput, true)
    if (flushTimer.current) clearInterval(flushTimer.current)
  }, [handleClick, handleInput])

  return { isRecording, recordingId, eventCount, isProcessing, error, start, stop }
}
