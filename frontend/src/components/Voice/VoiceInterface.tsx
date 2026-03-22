import { motion, AnimatePresence } from 'framer-motion'
import { Mic, MicOff, Volume2, Loader2 } from 'lucide-react'
import { useVoice } from '../../hooks/useVoice'
import { useEffect, useCallback } from 'react'
import type { VoiceState } from '../../types'

interface VoiceInterfaceProps {
  onCommand: (text: string) => void
  /** New step instruction to speak aloud via TTS */
  speakText?: string
  disabled?: boolean
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle:       'Say "next step" or click to speak',
  listening:  'Listening…',
  processing: 'Processing your command…',
  speaking:   'Speaking…',
}

const STATE_COLOR: Record<VoiceState, string> = {
  idle:       'bg-surface-700 hover:bg-surface-600 text-slate-300',
  listening:  'bg-brand-600 text-white ring-4 ring-brand-500/30',
  processing: 'bg-amber-900/60 text-amber-300',
  speaking:   'bg-indigo-900 text-brand-300',
}

export function VoiceInterface({ onCommand, speakText, disabled }: VoiceInterfaceProps) {
  const { state, transcript, startListening, stopListening, speak, doneProcessing, isSupported } =
    useVoice({
      onTranscript: useCallback(
        (text: string, isFinal: boolean) => {
          if (isFinal && text.trim()) {
            onCommand(text.trim())
            // Reset processing state after handing command off
            setTimeout(doneProcessing, 800)
          }
        },
        [onCommand, doneProcessing],
      ),
    })

  // Auto-speak new step instructions when they arrive
  useEffect(() => {
    if (speakText) speak(speakText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakText])

  if (!isSupported) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-700/50 text-xs text-slate-500">
        <MicOff className="w-4 h-4" />
        Voice not supported in this browser
      </div>
    )
  }

  const isListening  = state === 'listening'
  const isProcessing = state === 'processing'
  const isSpeaking   = state === 'speaking'

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Mic / status button */}
      <motion.button
        type="button"
        disabled={disabled || isProcessing || isSpeaking}
        onClick={isListening ? stopListening : startListening}
        className={`relative w-14 h-14 rounded-full flex items-center justify-center transition-all cursor-pointer ${STATE_COLOR[state]}`}
        whileTap={{ scale: 0.93 }}
        title={STATE_LABEL[state]}
      >
        {/* Pulse rings when listening */}
        {isListening && (
          <>
            <motion.span
              className="absolute inset-0 rounded-full border-2 border-brand-400"
              animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
              transition={{ repeat: Infinity, duration: 1.2, ease: 'easeOut' }}
            />
            <motion.span
              className="absolute inset-0 rounded-full border-2 border-brand-400"
              animate={{ scale: [1, 1.9], opacity: [0.4, 0] }}
              transition={{ repeat: Infinity, duration: 1.2, ease: 'easeOut', delay: 0.3 }}
            />
          </>
        )}

        {isProcessing ? (
          <Loader2 className="w-6 h-6 animate-spin" />
        ) : isSpeaking ? (
          <Volume2 className="w-6 h-6" />
        ) : isListening ? (
          <Mic className="w-6 h-6 animate-pulse" />
        ) : (
          <Mic className="w-6 h-6" />
        )}
      </motion.button>

      {/* Status label */}
      <p className="text-xs text-slate-400 text-center">{STATE_LABEL[state]}</p>

      {/* Live transcript bubble */}
      <AnimatePresence>
        {transcript && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="w-full max-w-xs px-3 py-2 rounded-xl bg-surface-700 border border-surface-500 text-sm text-slate-300 text-center"
          >
            "{transcript}"
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
