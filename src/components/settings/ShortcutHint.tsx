type Props = {
  /** Individual keys in press order, e.g. `['⌘', '⇧', 'S']`. */
  keys: string[]
  className?: string
}

/**
 * Compact OS-style keycaps for settings / chrome hints.
 * Keep glyphs short (⌘ ⇧ Ctrl) so the row stays one line.
 */
export function ShortcutHint({ keys, className }: Props) {
  if (keys.length === 0) return null
  return (
    <span
      className={['shortcut-hint', className].filter(Boolean).join(' ')}
      aria-label={keys.join(' + ')}
    >
      {keys.map((key, index) => (
        <kbd key={`${key}-${index}`} className="shortcut-key">
          {key}
        </kbd>
      ))}
    </span>
  )
}

/** Accelerator matching View → Copy Screenshot (`CommandOrControl+Shift+S`). */
export function screenshotShortcutKeys(platform: string | undefined): string[] {
  return platform === 'darwin' ? ['⌘', '⇧', 'S'] : ['Ctrl', 'Shift', 'S']
}
