import type { WsMessage, WsMessageType } from '../types'

type MessageHandler = (msg: WsMessage) => void

// Derive WebSocket URL from the current page host so the Vite proxy (/ws → ws://localhost:8080)
// is used automatically, and production deployments don't need code changes.
function wsUrl(sessionId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host  = window.location.host  // e.g. "localhost:5173" in dev, real host in prod
  return `${proto}//${host}/ws/${sessionId}`
}

const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_DELAY_MS     = 2000

export class HandOffWebSocket {
  private ws: WebSocket | null = null
  private sessionId: string
  private handlers: Map<WsMessageType, MessageHandler[]> = new Map()
  private onClose?: () => void
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempts = 0

  constructor(sessionId: string, onClose?: () => void) {
    this.sessionId = sessionId
    this.onClose   = onClose
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._open(resolve, reject)
    })
  }

  private _open(resolve?: () => void, reject?: (e: Error) => void): void {
    const url = wsUrl(this.sessionId)
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      this.send('START_SESSION', {})
      resolve?.()
    }

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsMessage
        const handlers = this.handlers.get(msg.type) ?? []
        handlers.forEach((h) => h(msg))
      } catch { /* malformed message — ignore */ }
    }

    this.ws.onerror = () => reject?.(new Error('WebSocket connection failed'))

    this.ws.onclose = () => {
      this.onClose?.()
      // Auto-reconnect on unexpected close
      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++
        this.reconnectTimer = setTimeout(() => this._open(), RECONNECT_DELAY_MS)
      }
    }
  }

  on(type: WsMessageType, handler: MessageHandler): () => void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
    return () => {
      this.handlers.set(type, list.filter((h) => h !== handler))
    }
  }

  send(type: WsMessageType, payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, session_id: this.sessionId, payload }))
    }
  }

  disconnect(): void {
    this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS // prevent reconnect after explicit close
    clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
