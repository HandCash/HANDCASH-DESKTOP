import { Button, Field } from '@aeon-ui/react'
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
import { useAsyncAction } from '../hooks/useAsyncAction'
import { SettingsSection } from './settings'

const DISPLAY_LINES = 300

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
  /** One exclusive log operation: refresh the tail or ship the session. */
  const logs = useAsyncAction<'refresh' | 'upload'>()
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let latest = getAppLogs()
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeAppLogs((next) => {
      latest = next
      if (timer) return
      // Diagnostics must not become workload: a sync storm can append dozens
      // of lines per second, and formatting/repainting the full ring per line
      // produced an idle long task while support was collecting logs.
      timer = setTimeout(() => {
        timer = null
        setEntries(latest)
      }, 500)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])

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

  const displayedText = useMemo(() => {
    const lines = text.split('\n')
    if (lines.length <= DISPLAY_LINES) return text
    return `… ${lines.length - DISPLAY_LINES} earlier line(s) hidden; Copy and Upload still include all …\n${lines
      .slice(-DISPLAY_LINES)
      .join('\n')}`
  }, [text])

  const refresh = async () => {
    playWalletSound('soft')
    await logs.run('refresh', async () => {
      setFileTail(await loadElectronTail())
      setEntries(getAppLogs())
    })
  }

  const upload = async () => {
    playWalletSound('soft')
    const url = setLogUploadUrl(logUploadUrl)
    setLogUploadUrlState(url)
    if (!url) {
      toastError('Set a log upload URL first')
      return
    }
    const outcome = await logs.run('upload', async () => {
      const result = await shipAppLogs(url)
      if (!result.ok) throw new Error(result.error)
      toastSuccess('Logs uploaded', 'bytes' in result ? `${result.bytes} bytes` : '')
    })
    if (!outcome.ok && outcome.error !== null) {
      playWalletSound('error')
      toastError('Upload failed', outcome.error)
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

      <SettingsSection title="Send to support" part="upload">
        <div className="settings-form settings-form-compact log-viewer-tools">
          <Field.Root className="field">
            <Field.Label htmlFor="log-upload-url">Upload URL</Field.Label>
            <Field.Control
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
            <Field.Hint className="field-hint">
              Filled in automatically. Change it only if support gave you another.
            </Field.Hint>
          </Field.Root>
          <div className="actions" data-aeon-state={logs.stateAttr}>
            <Button.Root
              variant="solid"
              className="btn btn-primary"
              data-aeon-part="upload-logs"
              disabled={logs.busy}
              onClick={() => void upload()}
            >
              <Button.Label>{logs.running('upload') ? 'Uploading…' : 'Upload session'}</Button.Label>
            </Button.Root>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="This session" part="session">
        <div className="settings-form settings-form-compact log-viewer-tools">
          <Field.Root className="field">
            <Field.Label htmlFor="log-filter">Filter</Field.Label>
            <Field.Control
              id="log-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="cloud-backup, sync, error…"
              autoComplete="off"
              spellCheck={false}
            />
          </Field.Root>
          <div
            className="actions log-viewer-actions"
            data-aeon-part="log-actions"
            data-aeon-state={logs.stateAttr}
          >
            <Button.Root
              variant="ghost"
              className="btn btn-ghost"
              disabled={logs.busy}
              data-aeon-part="refresh-logs"
              onClick={() => void refresh()}
            >
              <Button.Label>{logs.running('refresh') ? 'Refreshing…' : 'Refresh'}</Button.Label>
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => void copyAll()}>
              <Button.Label>Copy</Button.Label>
            </Button.Root>
              {window.handcash?.openLogs ? (
                <Button.Root variant="ghost"
                  className="btn btn-ghost"
                  data-aeon-part="open-logs"
                  onClick={() => {
                    playWalletSound('soft')
                    void window.handcash?.openLogs?.().then((result) => {
                      if (result && !result.ok) playWalletSound('error')
                    })
                  }}
                >
                  <Button.Label>Open folder</Button.Label>
                </Button.Root>
              ) : null}
              <Button.Root variant="ghost"
                className="btn btn-ghost"
                onClick={() => {
                  playWalletSound('soft')
                  clearAppLogs()
                  clearPreviousSessionLogs()
                  setEntries([])
                  setPrevious([])
                }}
              >
                <Button.Label>Clear ring</Button.Label>
              </Button.Root>
          </div>
        </div>
      </SettingsSection>

      {logPath ? (
        <p className="settings-log-path mono" title={logPath}>
          {logPath}
        </p>
      ) : null}

      <pre className="log-viewer-pre" tabIndex={0} aria-label="Log output">
        {displayedText}
      </pre>
    </div>
  )
}
