import { useState, useEffect, useRef, useCallback } from 'react'
import type { VoiceState } from '../types'

interface UseVoiceOptions {
  onTranscript: (text: string, isFinal: boolean) => void
  lang?: string
}

export function useVoice({ onTranscript, lang = 'en-US' }: UseVoiceOptions) {
  const [state, setState]           = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const recognitionRef              = useRef<SpeechRecognition | null>(null)
  const synthRef                    = useRef<SpeechSynthesis | null>(null)
  // Stable ref so recognition callbacks always call the latest onTranscript
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  useEffect(() => {
    synthRef.current = window.speechSynthesis
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) return

    const rec = new SR()
    rec.continuous      = false
    rec.interimResults  = true
    rec.lang            = lang
    rec.maxAlternatives = 1

    rec.onresult = (ev) => {
      let interim = ''
      let final   = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript
        ev.results[i].isFinal ? (final += t) : (interim += t)
      }
      const text = final || interim
      setTranscript(text)
      onTranscriptRef.current(text, Boolean(final))
      if (final) setState('processing')  // transition through processing after final transcript
    }

    rec.onstart  = () => setState('listening')
    rec.onend    = () => setState((s) => s === 'processing' ? 'processing' : 'idle')
    rec.onerror  = (ev) => {
      console.warn('[Voice] recognition error:', ev.error)
      setState('idle')
    }

    recognitionRef.current = rec
    return () => rec.abort()
  }, [lang])

  const startListening = useCallback(() => {
    if (state !== 'idle') return
    setTranscript('')
    recognitionRef.current?.start()
  }, [state])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  const speak = useCallback((text: string, onEnd?: () => void) => {
    const synth = synthRef.current
    if (!synth || !text.trim()) return
    // Stop any active recognition so TTS doesn't feed back into the mic
    recognitionRef.current?.abort()
    synth.cancel()
    const utt   = new SpeechSynthesisUtterance(text)
    utt.lang    = lang
    utt.rate    = 0.95
    utt.pitch   = 1
    utt.onstart = () => setState('speaking')
    utt.onend   = () => { setState('idle'); onEnd?.() }
    utt.onerror = () => setState('idle')
    setState('speaking')
    synth.speak(utt)
  }, [lang])

  const cancelSpeech = useCallback(() => {
    synthRef.current?.cancel()
    setState('idle')
  }, [])

  // Called by consumers once they've sent the processed command so we can reset
  const doneProcessing = useCallback(() => {
    setState((s) => (s === 'processing' ? 'idle' : s))
    setTranscript('')
  }, [])

  const isSupported = Boolean(
    (window.SpeechRecognition ?? window.webkitSpeechRecognition) &&
    window.speechSynthesis,
  )

  return { state, transcript, startListening, stopListening, speak, cancelSpeech, doneProcessing, isSupported }
}
