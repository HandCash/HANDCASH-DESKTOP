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
import { playWalletSound } from '../wallet/soundService'

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
        id: 'backup-phrase',
        label: 'Recovery phrase',
        description: 'Password required',
      },
      {
        id: 'change-password',
        label: 'Change password',
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
        description: 'Needs phrase to restore',
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
  if (id === 'statecharts') return 'Statecharts'
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
            {group.items.map(({ id, label, description }) => (
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
                    <strong className="settings-row-label">{label}</strong>
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

      <section className="settings-group" data-aeon-part="lab" data-settings-group="Lab">
        <h3 className="settings-group-title">Lab</h3>
        <ul className="settings-list">
          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">Statecharts</strong>
              </span>
              <button
                type="button"
                className="btn btn-ghost settings-check-btn"
                data-aeon-part="view-statecharts"
                onClick={() => {
                  playWalletSound('soft')
                  openSetting('statecharts')
                }}
              >
                View
              </button>
            </div>
          </li>
        </ul>
      </section>

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

      <section className="settings-group" data-aeon-part="about">
        <h3 className="settings-group-title">About</h3>
        <ul className="settings-list">
          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">HandCash Desktop</strong>
                <span className="settings-row-desc">Self-custodial BRC-100 wallet</span>
              </span>
            </div>
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
