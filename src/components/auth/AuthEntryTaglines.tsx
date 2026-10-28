/**
 * Discord-loading-style ambient lines under the entry CTAs — one coherent
 * positive thought each, rotating; never a fixed product subtitle. Themes:
 * abstract capabilities (peer exchange, defining your business) — never
 * commerce slots or technical stack language.
 */
import { useEffect, useState } from 'react'

export const AUTH_ENTRY_TAGLINES = [
  'Exchange directly with peers.',
  'Value that moves between people.',
  'Settle with anyone, anywhere.',
  'Send and receive as equals.',
  'Define your own business.',
  'Shape how your business appears.',
  'Set the terms of your trade.',
  'Present your business your way.',
] as const

const ROTATE_MS = 4200

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function AuthEntryTaglines() {
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(true)
  const [rotates, setRotates] = useState(true)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setRotates(false)
      return
    }
    let fadeTimer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      setVisible(false)
      fadeTimer = setTimeout(() => {
        setIndex((i) => (i + 1) % AUTH_ENTRY_TAGLINES.length)
        setVisible(true)
      }, 380)
    }
    const id = setInterval(tick, ROTATE_MS)
    return () => {
      clearInterval(id)
      if (fadeTimer) clearTimeout(fadeTimer)
    }
  }, [])

  const line = AUTH_ENTRY_TAGLINES[index] ?? AUTH_ENTRY_TAGLINES[0]

  return (
    <p
      className={`auth-entry-tagline${visible || !rotates ? ' is-in' : ' is-out'}`}
      data-aeon-part="entry-tagline"
      aria-live="polite"
    >
      {line}
    </p>
  )
}
