import { useEffect, useMemo, useState } from 'react'
import {
  clearAppLogs,
  clearPreviousSessionLogs,
  formatAppLogs,
  getAppLogs,
  getPreviousSessionLogs,
  subscribeAppLogs,
  type AppLogEntry,
} from '../wallet/appLog'
import { getLogUploadUrl, setLogUploadUrl } from '../wallet/logUploadPrefs'
import { shipAppLogs } from '../wallet/logShip'
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
  const [previous, setPrevious] = useState<AppLogEntry[]>(() => getPreviousSessionLogs())
  const [fileTail, setFileTail] = useState<string | null>(null)
  const [logPath, setLogPath] = useState<string | null>(null)
  const [logUploadUrl, setLogUploadUrlState] = useState(() => getLogUploadUrl())
  const [uploadingLogs, setUploadingLogs] = useState(false)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => subscribeAppLogs(setEntries), [])

  useEffect(() => {
    void loadElectronTail().then(setFileTail)
    let cancelled = false
    void window.handcash?.getLogInfo?.().then((info) => {
      if (cancelled) return
      setLogPath(info?.file ?? info?.dir ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const text = useMemo(() => {
    const ring = formatAppLogs(entries)
    const prior =
      previous.length > 0
        ? `—— previous session (ended without a clean exit) ——\n${formatAppLogs(previous)}\n\n`
        : ''
    const combined = fileTail
      ? `${prior}${fileTail.trim()}\n\n—— renderer ——\n${ring}`
      : `${prior}${ring}`
    if (!filter.trim()) return combined || 'No log lines yet.'
    const q = filter.trim().toLowerCase()
    return (
      combined
        .split('\n')
        .filter((line) => line.toLowerCase().includes(q))
        .join('\n') || 'No matching lines.'
    )
  }, [entries, fileTail, filter, previous])

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
    <div className="nav-section-body settings-scroll log-viewer" data-aeon-scope="log-viewer">
      <p className="settings-hint">
        Copy lines for support, or upload the full session when asked. If the app closed
        unexpectedly, the previous session appears at the top.
      </p>

      <div className="settings-form settings-form-compact log-viewer-tools">
        <div className="field">
          <label htmlFor="log-upload-url">Upload URL</label>
          <input
            id="log-upload-url"
            className="settings-control-input settings-control-input-block"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://…/v1/logs/hc-…"
            value={logUploadUrl}
            data-aeon-part="log-upload-url"
            onChange={(e) => setLogUploadUrlState(e.target.value)}
            onBlur={() => setLogUploadUrl(logUploadUrl)}
          />
          <p className="field-hint">Filled in automatically — change only if support gave you another.</p>
        </div>
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
        <div className="actions log-viewer-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            data-aeon-part="refresh-logs"
            onClick={() => void refresh()}
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void copyAll()}>
            Copy
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-aeon-part="upload-logs"
            disabled={uploadingLogs}
            onClick={() => {
              playWalletSound('soft')
              const url = setLogUploadUrl(logUploadUrl)
              setLogUploadUrlState(url)
              if (!url) {
                toastError('Set a log upload URL first')
                return
              }
              setUploadingLogs(true)
              void shipAppLogs(url)
                .then((result) => {
                  if (!result.ok) {
                    playWalletSound('error')
                    toastError('Upload failed', result.error)
                    return
                  }
                  toastSuccess(
                    'Logs uploaded',
                    'bytes' in result ? `${result.bytes} bytes` : '',
                  )
                })
                .finally(() => setUploadingLogs(false))
            }}
          >
            {uploadingLogs ? 'Uploading…' : 'Upload'}
          </button>
          {window.handcash?.openLogs ? (
            <button
              type="button"
              className="btn btn-ghost"
              data-aeon-part="open-logs"
              onClick={() => {
                playWalletSound('soft')
                void window.handcash?.openLogs?.().then((result) => {
                  if (result && !result.ok) playWalletSound('error')
                })
              }}
            >
              Open folder
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              playWalletSound('soft')
              clearAppLogs()
              clearPreviousSessionLogs()
              setEntries([])
              setPrevious([])
            }}
          >
            Clear ring
          </button>
        </div>
      </div>

      {logPath ? (
        <p className="settings-log-path mono" title={logPath}>
          {logPath}
        </p>
      ) : null}

      <pre className="log-viewer-pre" tabIndex={0} aria-label="Log output">
        {text}
      </pre>
    </div>
  )
}
