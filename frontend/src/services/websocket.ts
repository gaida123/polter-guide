import type { WsMessage, WsMessageType } from '../types'

type MessageHandler = (msg: WsMessage) => void

export class HandOffWebSocket {
  private ws: WebSocket | null = null
  private sessionId: string
  private handlers: Map<WsMessageType, MessageHandler[]> = new Map()
  private onClose?: () => void
  private reconnectTimer?: ReturnType<typeof setTimeout>

  constructor(sessionId: string, onClose?: () => void) {
    this.sessionId  = sessionId
    this.onClose    = onClose
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://localhost:8080/ws/${this.sessionId}`
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        this.send('START_SESSION', {})
        resolve()
      }

      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage
          const handlers = this.handlers.get(msg.type) ?? []
          handlers.forEach((h) => h(msg))
        } catch { /* malformed message — ignore */ }
      }

      this.ws.onerror = () => reject(new Error('WebSocket connection failed'))

      this.ws.onclose = () => {
        this.onClose?.()
      }
    })
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
    clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
