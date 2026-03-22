import { useState, useRef, useCallback } from 'react'
import { HandOffWebSocket } from '../services/websocket'
import { createSession, endSession } from '../services/api'
import type { StepPayload, SessionStatus } from '../types'

interface SessionState {
  sessionId:    string | null
  status:       SessionStatus
  currentStep:  StepPayload | null
  totalSteps:   number
  showGuardrail: boolean
  showAutofill:  boolean
  autofillValue: string | null
  error:         string | null
}

const INITIAL: SessionState = {
  sessionId: null, status: 'initialising', currentStep: null,
  totalSteps: 0, showGuardrail: false, showAutofill: false,
  autofillValue: null, error: null,
}

export function useSession() {
  const [state, setState] = useState<SessionState>(INITIAL)
  const wsRef             = useRef<HandOffWebSocket | null>(null)

  const start = useCallback(async (userId: string, productId: string, sopId: string) => {
    const { session_id } = await createSession(userId, productId, sopId)
    const ws = new HandOffWebSocket(session_id, () =>
      setState((s) => ({ ...s, status: 'paused' }))
    )

    ws.on('STEP_UPDATE', (msg) => {
      const step = msg.payload as unknown as StepPayload
      setState((s) => ({
        ...s, status: 'active', currentStep: step,
        totalSteps: step.total_steps, showGuardrail: false, error: null,
      }))
    })
    ws.on('GUARDRAIL_WARNING', (msg) => {
      const step = (msg.payload as Record<string, unknown>).step_data as StepPayload
      setState((s) => ({ ...s, showGuardrail: true, currentStep: step }))
    })
    ws.on('AUTOFILL_REQUEST', (msg) => {
      const p = msg.payload as Record<string, unknown>
      setState((s) => ({ ...s, showAutofill: true, autofillValue: p.autofill_value as string }))
    })
    ws.on('SESSION_COMPLETE', () => {
      setState((s) => ({ ...s, status: 'completed', showGuardrail: false, showAutofill: false }))
    })
    ws.on('ERROR', (msg) => {
      const detail = (msg.payload as Record<string, unknown>).detail as string
      setState((s) => ({ ...s, error: detail, status: 'error' }))
    })

    await ws.connect()
    wsRef.current = ws
    setState((s) => ({ ...s, sessionId: session_id, status: 'active' }))
    return session_id
  }, [])

  const sendVoiceCommand = useCallback((command: string, screenshotBase64 = '') => {
    wsRef.current?.send('VOICE_COMMAND', { voice_command: command, screenshot_base64: screenshotBase64 })
  }, [])

  const confirmAutofill = useCallback(() => {
    const step = state.currentStep
    wsRef.current?.send('AUTOFILL_CONFIRM', { step_index: step?.step_index })
    setState((s) => ({ ...s, showAutofill: false }))
  }, [state.currentStep])

  const confirmGuardrail = useCallback(() => {
    // After user confirms a destructive step, send a VOICE_COMMAND with "confirm"
    // so the backend runs the workflow and advances the step.
    setState((s) => ({ ...s, showGuardrail: false }))
    wsRef.current?.send('VOICE_COMMAND', {
      voice_command: 'confirm',
      screenshot_base64: '',
    })
  }, [])

  const dismissGuardrail = useCallback(() => {
    setState((s) => ({ ...s, showGuardrail: false }))
  }, [])

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }))
  }, [])

  const stop = useCallback(async () => {
    if (state.sessionId) {
      wsRef.current?.disconnect()
      await endSession(state.sessionId).catch(() => {})
    }
    setState(INITIAL)
    wsRef.current = null
  }, [state.sessionId])

  return {
    ...state,
    start,
    sendVoiceCommand,
    confirmAutofill,
    confirmGuardrail,
    dismissGuardrail,
    clearError,
    stop,
  }
}
