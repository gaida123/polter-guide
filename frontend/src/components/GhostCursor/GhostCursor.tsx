import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useGhostCursor } from '../../hooks/useGhostCursor'

interface GhostCursorProps {
  sessionId: string | null
}

export function GhostCursor({ sessionId }: GhostCursorProps) {
  const cursor = useGhostCursor(sessionId)
  const [localVisible, setLocalVisible] = useState(false)

  // Mirror cursor.isVisible but auto-hide after 3 s
  useEffect(() => {
    if (!cursor.isVisible) { setLocalVisible(false); return }
    setLocalVisible(true)
    const timer = setTimeout(() => setLocalVisible(false), 3000)
    return () => clearTimeout(timer)
  }, [cursor.isVisible, cursor.x, cursor.y])

  return (
    <AnimatePresence>
      {localVisible && (
        <motion.div
          className="fixed top-0 left-0 pointer-events-none z-[9999]"
          initial={{ opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1, x: cursor.x - 25, y: cursor.y - 44 }}
          exit={{ opacity: 0, scale: 0.3 }}
          transition={{ type: 'spring', stiffness: 180, damping: 22 }}
        >
          {/* Glow ring */}
          <motion.div
            className="absolute rounded-full"
            style={{
              width: 64, height: 64,
              top: -6, left: -7,
              background: cursor.isDestructive
                ? 'radial-gradient(circle, rgba(239,68,68,0.35) 0%, transparent 70%)'
                : 'radial-gradient(circle, rgba(167,139,250,0.35) 0%, transparent 70%)',
            }}
            animate={{ scale: [1, 1.6, 1], opacity: [0.7, 0.15, 0.7] }}
            transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
          />

          <motion.svg
            className="ghost-cursor-svg"
            width="50" height="60"
            viewBox="0 0 40 48"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{
              filter: cursor.isDestructive
                ? 'drop-shadow(0 0 8px rgba(239,68,68,0.9)) drop-shadow(0 0 18px rgba(239,68,68,0.6))'
                : 'drop-shadow(0 0 8px rgba(167,139,250,0.9)) drop-shadow(0 0 18px rgba(139,92,246,0.65))',
            }}
            animate={{ y: [0, -4, 0] }}
            transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
          >
            {/* Ghost body */}
            <path
              d="M20 3 C10 3 4 9 4 19 L4 40 L8 36 L12 40 L16 36 L20 40 L24 36 L28 40 L32 36 L36 40 L36 19 C36 9 30 3 20 3Z"
              fill={cursor.isDestructive ? '#fecaca' : 'white'}
              fillOpacity="0.96"
            />
            <ellipse cx="20" cy="22" rx="13" ry="10"
              fill={cursor.isDestructive ? 'rgba(239,68,68,0.15)' : 'rgba(196,181,253,0.18)'} />

            {/* Eyes */}
            <ellipse cx="14" cy="20" rx="3.5" ry="4.2"
              fill={cursor.isDestructive ? '#7f1d1d' : '#1e1b4b'} />
            <ellipse cx="26" cy="20" rx="3.5" ry="4.2"
              fill={cursor.isDestructive ? '#7f1d1d' : '#1e1b4b'} />
            <circle cx="15.4" cy="18.3" r="1.3" fill="white" />
            <circle cx="27.4" cy="18.3" r="1.3" fill="white" />

            {/* Expression — worried for destructive, smile otherwise */}
            {cursor.isDestructive ? (
              <path d="M15.5 28.5 Q20 25.5 24.5 28.5" stroke="#dc2626" strokeWidth="1.3"
                strokeLinecap="round" fill="none" />
            ) : (
              <path d="M15.5 27.5 Q20 31 24.5 27.5" stroke="#7c3aed" strokeWidth="1.3"
                strokeLinecap="round" fill="none" />
            )}
          </motion.svg>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
