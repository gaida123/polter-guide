import { useState, useEffect, useRef, useCallback } from 'react'
import type { VoiceState } from '../types'

interface UseVoiceOptions {
  onTranscript: (text: string, isFinal: boolean) => void
  lang?: string
}

// ── Voice picker ─────────────────────────────────────────────────────────────
// Ranks available voices and returns the most human-sounding one.
// Priority: Premium/Enhanced/Neural > Named good voices > any local en-US voice.

const PREFERRED_NAMES = [
  'Samantha',   // macOS — warm, clear
  'Ava',        // macOS — natural female
  'Susan',      // macOS
  'Victoria',   // macOS — clear female
  'Karen',      // macOS Australian — natural
  'Moira',      // macOS Irish — warm
  'Tessa',      // macOS South African
  'Allison',    // macOS
  'Tom',        // macOS male — clear
  'Daniel',     // macOS UK male — natural
  'Google US English',     // Chrome built-in — decent
  'Google UK English Female',
]

function scorevoice(v: SpeechSynthesisVoice): number {
  const n = v.name
  // Highest: macOS/Windows premium/enhanced/neural voices
  if (/enhanced|premium|neural/i.test(n)) return 100
  // Named preferred voices
  const idx = PREFERRED_NAMES.findIndex(p => n.toLowerCase().includes(p.toLowerCase()))
  if (idx !== -1) return 80 - idx
  // Local service en-US (downloaded, better quality than network)
  if (v.localService && v.lang.startsWith('en')) return 40
  // Any en-US
  if (v.lang.startsWith('en')) return 20
  return 0
}

function pickBestVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  if (!voices.length) return null
  const enVoices = voices.filter(v => v.lang.startsWith('en'))
  if (!enVoices.length) return voices[0]
  return enVoices.reduce((best, v) => scorevoice(v) >= scorevoice(best) ? v : best, enVoices[0])
}

// ── Text preprocessing for more natural delivery ──────────────────────────────
// Adds natural-sounding pauses and cleans up robotic patterns.

function humaniseText(text: string): string {
  return text
    // Remove markdown-style emphasis
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    // Spell out common abbreviations naturally
    .replace(/\be\.g\./gi, 'for example,')
    .replace(/\bi\.e\./gi, 'that is,')
    // Add a brief pause before "and" in long sentences
    .replace(/\s+→\s+/g, ', then ')
    // Soften robotic instruction openers
    .replace(/^(Click|Tap|Press|Select|Type|Enter|Go to|Navigate to)/,
      (m) => {
        const softer: Record<string, string> = {
          'Click': 'Click',
          'Tap': 'Tap',
          'Press': 'Press',
          'Select': 'Select',
          'Type': 'Type in',
          'Enter': 'Enter',
          'Go to': 'Head over to',
          'Navigate to': 'Go to',
        }
        return softer[m] ?? m
      })
    .trim()
}


export function useVoice({ onTranscript, lang = 'en-US' }: UseVoiceOptions) {
  const [state, setState]           = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const recognitionRef              = useRef<SpeechRecognition | null>(null)
  const synthRef                    = useRef<SpeechSynthesis | null>(null)
  const voiceRef                    = useRef<SpeechSynthesisVoice | null>(null)

  useEffect(() => {
    synthRef.current = window.speechSynthesis

    // Voices may load asynchronously — pick the best once they're ready
    const loadVoice = () => { voiceRef.current = pickBestVoice() }
    loadVoice()
    window.speechSynthesis.addEventListener('voiceschanged', loadVoice)

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
      onTranscript(text, Boolean(final))
    }

    rec.onstart  = () => setState('listening')
    rec.onend    = () => setState('idle')
    rec.onerror  = () => setState('idle')

    recognitionRef.current = rec
    return () => {
      rec.abort()
      window.speechSynthesis.removeEventListener('voiceschanged', loadVoice)
    }
  }, [lang]) // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!synth) return
    synth.cancel()

    const utt = new SpeechSynthesisUtterance(humaniseText(text))
    utt.lang   = lang

    // Use the best available voice
    if (voiceRef.current) utt.voice = voiceRef.current

    // Tuned for natural delivery:
    // - Slightly slower than default (0.95) so it's clear and unhurried
    // - Normal pitch (1.0) — don't artificially modify it
    // - Full volume
    utt.rate   = 0.92
    utt.pitch  = 1.0
    utt.volume = 1.0

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

  const isSupported = Boolean(
    (window.SpeechRecognition ?? window.webkitSpeechRecognition) &&
    window.speechSynthesis,
  )

  return { state, transcript, startListening, stopListening, speak, cancelSpeech, isSupported }
}
