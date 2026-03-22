import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export default function GhostCursorPage() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    document.body.classList.add('overlay-mode')
    document.documentElement.style.background = 'transparent'
    const api = (window as any).handoff
    if (!api?.onGhostCursor) return
    api.onGhostCursor((payload: { x: number; y: number }) => {
      setVisible(payload.x !== -1)
    })
    return () => api.offGhostCursor?.()
  }, [])

  return (
    <div className="fixed inset-0 pointer-events-none">
      <AnimatePresence>
        {visible && (
          <motion.div
            key="cursor"
            className="absolute top-0 left-0 pointer-events-none"
            initial={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.3 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          >
            {/* Pulse rings */}
            <motion.div
              className="absolute rounded-full border-2 border-white/60"
              style={{ width: 44, height: 44, top: -8, left: -8 }}
              animate={{ scale: [1, 2], opacity: [0.7, 0] }}
              transition={{ repeat: Infinity, duration: 1.1, ease: 'easeOut' }}
            />
            <motion.div
              className="absolute rounded-full border border-white/40"
              style={{ width: 44, height: 44, top: -8, left: -8 }}
              animate={{ scale: [1, 1.6], opacity: [0.5, 0] }}
              transition={{ repeat: Infinity, duration: 1.1, ease: 'easeOut', delay: 0.25 }}
            />
            {/* Cursor SVG */}
            <svg
              width="28" height="36" viewBox="0 0 28 36"
              fill="none" xmlns="http://www.w3.org/2000/svg"
              style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.8))' }}
            >
              <path
                d="M4 2L4 24L9 18.5L12.5 26L15.5 24.5L12 17L18 17L4 2Z"
                fill="white"
                stroke="rgba(0,0,0,0.35)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
