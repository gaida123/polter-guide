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

  // Auto-disappear after 3 s whenever the ghost becomes visible
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => setVisible(false), 3000)
    return () => clearTimeout(timer)
  }, [visible])

  return (
    // Full window, centred — keeps everything inside the 160×160 boundary
    <div className="fixed inset-0 pointer-events-none flex items-center justify-center">
      <AnimatePresence>
        {visible && (
          <motion.div
            key="ghost"
            className="relative pointer-events-none"
            initial={{ opacity: 0, scale: 0.4, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.3, y: 8 }}
            transition={{ type: 'spring', stiffness: 280, damping: 18 }}
          >
            {/* Glow — a blurred div behind the ghost (avoids Chromium's
                rectangular drop-shadow clipping on transparent windows) */}
            <div
              className="absolute pointer-events-none"
              style={{
                width: 80,
                height: 80,
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                background:
                  'radial-gradient(circle, rgba(167,139,250,0.85) 0%, rgba(139,92,246,0.4) 40%, transparent 70%)',
                borderRadius: '50%',
                filter: 'blur(16px)',
              }}
            />

            {/* Ghost SVG — no filter here to keep edges crisp */}
            <motion.svg
              width="72" height="88"
              viewBox="0 0 40 48"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              animate={{ y: [0, -5, 0] }}
              transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
            >
              {/* Ghost body */}
              <path
                d="M20 3 C10 3 4 9 4 19 L4 40 L8 36 L12 40 L16 36 L20 40 L24 36 L28 40 L32 36 L36 40 L36 19 C36 9 30 3 20 3Z"
                fill="white"
                fillOpacity="0.96"
              />
              {/* Inner volume shading */}
              <ellipse cx="20" cy="22" rx="13" ry="10" fill="rgba(196,181,253,0.18)" />

              {/* Left eye */}
              <ellipse cx="14" cy="20" rx="3.5" ry="4.2" fill="#1e1b4b" />
              {/* Right eye */}
              <ellipse cx="26" cy="20" rx="3.5" ry="4.2" fill="#1e1b4b" />
              {/* Eye shines */}
              <circle cx="15.4" cy="18.3" r="1.3" fill="white" />
              <circle cx="27.4" cy="18.3" r="1.3" fill="white" />

              {/* Smile */}
              <path
                d="M15.5 27.5 Q20 31 24.5 27.5"
                stroke="#7c3aed"
                strokeWidth="1.3"
                strokeLinecap="round"
                fill="none"
              />
            </motion.svg>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
