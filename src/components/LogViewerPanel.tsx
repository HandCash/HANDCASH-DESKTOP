import { useEffect, useMemo, useState } from 'react'
import {
  clearAppLogs,
  formatAppLogs,
  getAppLogs,
  subscribeAppLogs,
  type AppLogEntry,
} from '../wallet/appLog'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'

async function loadElectronTail(): Promise<string | null> {
  try {
    const result = await window.handcash?.readLogs?.({ maxBytes: 256_000 })
    if (result && result.ok) return result.text
  } catch {
    // fall through
  }
  return null
}

export function LogViewerPanel() {
  const [entries, setEntries] = useState<AppLogEntry[]>(() => getAppLogs())
  const [fileTail, setFileTail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => subscribeAppLogs(setEntries), [])

  useEffect(() => {
    void loadElectronTail().then(setFileTail)
  }, [])

  const text = useMemo(() => {
    const ring = formatAppLogs(entries)
    const combined = fileTail
      ? `${fileTail.trim()}\n\n—— renderer ——\n${ring}`
      : ring
    if (!filter.trim()) return combined || 'No log lines yet.'
    const q = filter.trim().toLowerCase()
    return (
      combined
        .split('\n')
        .filter((line) => line.toLowerCase().includes(q))
        .join('\n') || 'No matching lines.'
    )
  }, [entries, fileTail, filter])

  const refresh = async () => {
    setBusy(true)
    playWalletSound('soft')
    try {
      setFileTail(await loadElectronTail())
      setEntries(getAppLogs())
    } finally {
      setBusy(false)
    }
  }

  const copyAll = async () => {
    playWalletSound('soft')
    try {
      if (window.handcash?.clipboardWrite) await window.handcash.clipboardWrite(text)
      else await navigator.clipboard.writeText(text)
      toastSuccess('Logs copied')
    } catch (err) {
      toastError('Copy failed', err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="log-viewer">
      <p className="settings-hint">
        Live wallet log. Use this when cloud backup or sync misbehaves — copy and share the
        relevant lines.
      </p>

      <div className="settings-form settings-form-compact">
        <div className="field">
          <label htmlFor="log-filter">Filter</label>
          <input
            id="log-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="cloud-backup, sync, error…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void copyAll()}>
            Copy
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              playWalletSound('soft')
              clearAppLogs()
              setEntries([])
            }}
          >
            Clear ring
          </button>
        </div>
      </div>

      <pre className="log-viewer-pre" tabIndex={0} aria-label="Log output">
        {text}
      </pre>
    </div>
  )
}
