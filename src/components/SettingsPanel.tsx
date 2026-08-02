import { useEffect, useRef, useState } from 'react'
import { APP_VERSION } from '../version'
import { openSetting, type SettingId } from '../wallet/navStore'
import { useUpdate } from '../wallet/updateProvider'
import type { UpdateMode } from '../machines/updateMachine'
import {
  isWalletSfxEnabled,
  setWalletSfxEnabled,
  subscribeWalletSfx,
} from '../wallet/soundPrefs'
import { getLogUploadUrl, setLogUploadUrl } from '../wallet/logUploadPrefs'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'

type SettingItem = {
  id: SettingId
  label: string
  description: string
  tag?: string
}

type SettingGroup = {
  title: string
  items: SettingItem[]
}

const SETTING_GROUPS: SettingGroup[] = [
  {
    title: 'Security',
    items: [
      {
        id: 'backup',
        label: 'Keys',
        description: 'Split or phrase',
        tag: 'BRC-140',
      },
      {
        id: 'history-backup',
        label: 'History',
        description: 'Required for recovery',
        tag: 'BRC-39',
      },
      {
        id: 'backup-services',
        label: 'Backup services',
        description: 'Optional recovery slices',
      },
      {
        id: 'change-password',
        label: 'Password',
        description: '',
      },
    ],
  },
  {
    title: 'Danger zone',
    items: [
      {
        id: 'wipe-wallet',
        label: 'Wipe wallet',
        description: 'Remove from this device',
      },
    ],
  },
]

const UPDATE_MODES: { value: UpdateMode; label: string; description: string }[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Automatic checks',
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Check when asked',
  },
  {
    value: 'none',
    label: 'None',
    description: 'Updates off',
  },
]

function phaseLabel(phase: string, error: string | null): string {
  switch (phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return 'Update available'
    case 'downloading':
      return 'Downloading update…'
    case 'ready':
      return 'Ready to restart'
    case 'not-available':
    case 'notAvailable':
      // Missing platform artifacts land here with a soft note — not “Up to date”.
      if (error) return error
      return 'Up to date'
    case 'error':
      return 'Update check failed'
    default:
      return 'Idle'
  }
}

export function settingLabel(id: SettingId): string {
  if (id === 'about-handcash') return 'HandCash'
  if (id === 'statecharts') return 'Statecharts'
  if (id === 'backup' || id === 'backup-phrase' || id === 'split-backup') return 'Keys'
  if (id === 'history-backup') return 'History'
  if (id === 'backup-services') return 'Backup services'
  for (const group of SETTING_GROUPS) {
    const item = group.items.find((entry) => entry.id === id)
    if (item) return item.label
  }
  return 'Setting'
}

export function SettingsPanel() {
  const update = useUpdate()
  const { context, check, setMode, stateAttr } = update
  const checking = context.phase === 'checking'
  const rootRef = useRef<HTMLDivElement>(null)
  const [sfxEnabled, setSfxEnabled] = useState(() => isWalletSfxEnabled())
  const [logPath, setLogPath] = useState<string | null>(null)
  const [logUploadUrl, setLogUploadUrlState] = useState(() => getLogUploadUrl())
  const [uploadingLogs, setUploadingLogs] = useState(false)
  // Bundled semver — do not rely on updater IPC race (was briefly 0.0.0).
  const runningVersion =
    context.currentVersion && context.currentVersion !== '0.0.0'
      ? context.currentVersion
      : APP_VERSION

  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'start' })
    const stage = rootRef.current?.closest('.wallet-nav-stage')
    if (stage instanceof HTMLElement) stage.scrollTop = 0
  }, [])

  useEffect(() => subscribeWalletSfx(setSfxEnabled), [])

  useEffect(() => {
    let cancelled = false
    void window.handcash?.getLogInfo?.().then((info) => {
      if (cancelled) return
      setLogPath(info?.file ?? info?.dir ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className="nav-section-body settings-nav settings-scroll"
      data-aeon-scope="settings"
      data-aeon-state={stateAttr}
    >
      <div className="connected-panel-head">
        <h2>Settings</h2>
      </div>

      {SETTING_GROUPS.map((group) => (
        <section key={group.title} className="settings-group" data-settings-group={group.title}>
          <h3 className="settings-group-title">{group.title}</h3>
          <ul className="settings-list">
            {group.items.map(({ id, label, description, tag }) => (
              <li key={id} className="settings-row">
                <button
                  type="button"
                  className="settings-row-main"
                  onClick={() => {
                    playWalletSound('soft')
                    openSetting(id)
                  }}
                >
                  <span className="settings-row-body">
                    <strong className="settings-row-label">
                      {label}
                      {tag ? <span className="spec-tag">{tag}</span> : null}
                    </strong>
                    {description ? (
                      <span className="settings-row-desc">{description}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="settings-group" data-aeon-part="application">
        <h3 className="settings-group-title">Application</h3>
        <ul className="settings-list">
          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <label className="settings-row-label" htmlFor="settings-sfx-enabled">
                  Sound effects
                </label>
              </span>
              <label className="settings-sfx-toggle">
                <input
                  id="settings-sfx-enabled"
                  type="checkbox"
                  checked={sfxEnabled}
                  data-aeon-part="sfx-enabled"
                  data-aeon-state={sfxEnabled ? 'on' : 'off'}
                  onChange={(e) => {
                    const next = e.target.checked
                    setWalletSfxEnabled(next)
                    setSfxEnabled(next)
                    if (next) playWalletSound('receive', { force: true })
                  }}
                />
                <span>{sfxEnabled ? 'On' : 'Off'}</span>
              </label>
            </div>
          </li>

          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <label className="settings-row-label" htmlFor="settings-update-mode">
                  Updates
                </label>
              </span>
              <select
                id="settings-update-mode"
                className="settings-interval-select"
                value={context.mode}
                data-aeon-part="update-mode"
                data-aeon-state={context.mode}
                onChange={(e) => {
                  playWalletSound('soft')
                  void setMode(e.target.value as UpdateMode)
                }}
              >
                {UPDATE_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </li>

          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">Version {runningVersion}</strong>
                <span className="settings-row-desc">
                  {phaseLabel(context.phase, context.error)}
                  {context.availableVersion && context.availableVersion !== runningVersion
                    ? ` · ${context.availableVersion} available`
                    : ''}
                  {context.phase === 'downloading' && context.percent != null
                    ? ` · ${context.percent}%`
                    : ''}
                  {context.phase === 'error' && context.error ? ` · ${context.error}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-ghost settings-check-btn"
                disabled={checking || context.mode === 'none'}
                data-aeon-part="check-updates"
                data-aeon-state={checking ? 'checking' : context.mode}
                onClick={() => {
                  playWalletSound('soft')
                  void check()
                }}
              >
                {checking ? 'Checking…' : 'Check'}
              </button>
            </div>
          </li>
        </ul>
      </section>

      <section className="settings-group" data-aeon-part="logs" data-settings-group="Logs">
        <h3 className="settings-group-title">Logs</h3>
        <ul className="settings-list">
          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">App logs</strong>
                <span className="settings-row-desc">Share with support if something breaks</span>
                {logPath ? (
                  <span className="settings-row-desc settings-log-path mono" title={logPath}>
                    {logPath}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="btn btn-ghost settings-check-btn"
                data-aeon-part="open-logs"
                disabled={!window.handcash?.openLogs}
                onClick={() => {
                  playWalletSound('soft')
                  void window.handcash?.openLogs?.().then((result) => {
                    if (result && !result.ok) {
                      playWalletSound('error')
                    }
                  })
                }}
              >
                Open
              </button>
            </div>
          </li>
          <li className="settings-row settings-row-static">
            <div className="settings-log-upload">
              <label className="settings-row-label" htmlFor="settings-log-upload-url">
                Upload URL
              </label>
              <span className="settings-row-desc">
                POST the current log file to this http(s) endpoint
              </span>
              <div className="settings-log-upload-row">
                <input
                  id="settings-log-upload-url"
                  className="settings-log-upload-input"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://…"
                  value={logUploadUrl}
                  data-aeon-part="log-upload-url"
                  onChange={(e) => setLogUploadUrlState(e.target.value)}
                  onBlur={() => setLogUploadUrl(logUploadUrl)}
                />
                <button
                  type="button"
                  className="btn btn-ghost settings-check-btn"
                  data-aeon-part="upload-logs"
                  disabled={uploadingLogs || !window.handcash?.uploadLogs}
                  onClick={() => {
                    playWalletSound('soft')
                    const url = setLogUploadUrl(logUploadUrl)
                    setLogUploadUrlState(url)
                    if (!url) {
                      toastError('Set an upload URL first')
                      return
                    }
                    if (!window.handcash?.uploadLogs) {
                      toastError('Log upload unavailable')
                      return
                    }
                    setUploadingLogs(true)
                    void window.handcash
                      .uploadLogs(url)
                      .then((result) => {
                        if (!result.ok) {
                          playWalletSound('error')
                          toastError('Upload failed', result.error)
                          return
                        }
                        toastSuccess('Logs sent', `${result.bytes} bytes`)
                      })
                      .finally(() => setUploadingLogs(false))
                  }}
                >
                  {uploadingLogs ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section className="settings-group" data-aeon-part="about" data-settings-group="About">
        <h3 className="settings-group-title">About</h3>
        <ul className="settings-list">
          <li className="settings-row">
            <button
              type="button"
              className="settings-row-main"
              onClick={() => {
                playWalletSound('soft')
                openSetting('about-handcash')
              }}
            >
              <span className="settings-row-body">
                <strong className="settings-row-label">
                  HandCash
                  <span className="spec-tag">BRC-100</span>
                </strong>
                <span className="settings-row-desc">Desktop wallet</span>
              </span>
            </button>
          </li>
          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">Screenshot</strong>
                <span className="settings-row-desc">
                  {window.handcash?.platform === 'darwin' ? '⌘⇧S' : 'Ctrl+Shift+S'}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-ghost settings-check-btn"
                data-aeon-part="copy-screenshot"
                onClick={() => void window.handcash?.copyScreenshot?.()}
              >
                Copy
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  )
}
