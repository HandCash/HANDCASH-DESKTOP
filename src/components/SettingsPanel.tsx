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
import { shipAppLogs } from '../wallet/logShip'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { subscribeBackupConfirmed } from '../wallet/backupStatus'
import { subscribeDeviceWallets } from '../wallet/deviceWallets'
import { SettingsNavRow, SettingsSection, statusForSetting } from './settings'

type SettingItem = {
  id: SettingId
  label: string
  description: string
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
        id: 'trustholder-backup',
        label: 'Cloud key backup',
        description: 'Independent providers · recommend two',
      },
      {
        id: 'backup',
        label: 'Key slices',
        description: '2-of-3 · email · offline copies',
      },
      {
        id: 'history-backup',
        label: 'History',
        description: 'Required for recovery',
      },
      {
        id: 'device-handoff',
        label: 'Use on another device',
        description: 'Same identity + History URL',
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
  if (id === 'logs') return 'Logs'
  if (id === 'backup' || id === 'backup-phrase' || id === 'split-backup') return 'Key slices'
  if (id === 'trustholder-backup') return 'Cloud key backup'
  if (id === 'device-handoff') return 'Use on another device'
  if (id === 'history-backup') return 'History'
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
  const [, setStatusTick] = useState(0)
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
    const bump = () => setStatusTick((n) => n + 1)
    const unsubBackup = subscribeBackupConfirmed(bump)
    const unsubDevices = subscribeDeviceWallets(() => bump())
    return () => {
      unsubBackup()
      unsubDevices()
    }
  }, [])

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
        <SettingsSection key={group.title} title={group.title}>
          <ul className="settings-list">
            {group.items.map(({ id, label, description }) => {
              const status = statusForSetting(id)
              return (
                <SettingsNavRow
                  key={id}
                  label={label}
                  description={description}
                  status={status?.text}
                  statusTone={status?.tone}
                  onClick={() => openSetting(id)}
                />
              )
            })}
          </ul>
        </SettingsSection>
      ))}

      <SettingsSection title="Application" part="application">
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
      </SettingsSection>

      <SettingsSection title="Logs" part="logs">
        <ul className="settings-list">
          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">App logs</strong>
                <span className="settings-row-desc">In-wallet viewer · share with support</span>
                {logPath ? (
                  <span className="settings-row-desc settings-log-path mono" title={logPath}>
                    {logPath}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="btn btn-ghost settings-check-btn"
                data-aeon-part="view-logs"
                onClick={() => {
                  playWalletSound('soft')
                  openSetting('logs')
                }}
              >
                View
              </button>
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
                POST the current log file to BRC-CLOUD (auto-set on first launch)
              </span>
              <div className="settings-log-upload-row">
                <input
                  id="settings-log-upload-url"
                  className="settings-log-upload-input"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://brc-cloud…/v1/logs/hc-…"
                  value={logUploadUrl}
                  data-aeon-part="log-upload-url"
                  onChange={(e) => setLogUploadUrlState(e.target.value)}
                  onBlur={() => setLogUploadUrl(logUploadUrl)}
                />
                <button
                  type="button"
                  className="btn btn-ghost settings-check-btn"
                  data-aeon-part="upload-logs"
                  disabled={uploadingLogs}
                  onClick={() => {
                    playWalletSound('soft')
                    const url = setLogUploadUrl(logUploadUrl)
                    setLogUploadUrlState(url)
                    if (!url) {
                      toastError('Set an upload URL first')
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
                        toastSuccess('Logs sent', 'bytes' in result ? `${result.bytes} bytes` : '')
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
      </SettingsSection>

      <SettingsSection title="About" part="about">
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
                <strong className="settings-row-label">HandCash</strong>
                <span className="settings-row-desc">
                  {window.handcash?.platform === 'android' ||
                  window.handcash?.platform === 'ios'
                    ? 'Mobile wallet'
                    : 'Desktop wallet'}
                </span>
              </span>
            </button>
          </li>
          {window.handcash?.platform !== 'android' && window.handcash?.platform !== 'ios' ? (
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
          ) : null}
        </ul>
      </SettingsSection>
    </div>
  )
}
