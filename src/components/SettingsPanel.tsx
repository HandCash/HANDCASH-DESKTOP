import { useEffect, useRef } from 'react'
import { APP_VERSION } from '../version'
import { openSetting, type SettingId } from '../wallet/navStore'
import { useUpdate } from '../wallet/updateProvider'
import type { UpdateMode } from '../machines/updateMachine'

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
        label: 'Backup recovery phrase',
        description: 'Show your 12-word phrase (password required)',
      },
      {
        id: 'change-password',
        label: 'Change password',
        description: 'Update the unlock password on this device',
      },
    ],
  },
  {
    title: 'Danger zone',
    items: [
      {
        id: 'wipe-wallet',
        label: 'Wipe wallet data',
        description: 'Factory-reset this device (needs phrase to restore)',
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
                  onClick={() => openSetting(id)}
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

      <section className="settings-group" data-aeon-part="application">
        <h3 className="settings-group-title">Application</h3>
        <ul className="settings-list">
          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <label className="settings-row-label" htmlFor="settings-update-mode">
                  Update Mode
                </label>
                <span className="settings-row-desc">
                  {UPDATE_MODES.find((m) => m.value === context.mode)?.description ??
                    'How HandCash Desktop checks for updates'}
                </span>
              </span>
              <select
                id="settings-update-mode"
                className="settings-interval-select"
                value={context.mode}
                data-aeon-part="update-mode"
                data-aeon-state={context.mode}
                onChange={(e) => void setMode(e.target.value as UpdateMode)}
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
                onClick={() => void check()}
              >
                {checking ? 'Checking…' : 'Check for Updates'}
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
                <span className="settings-row-desc">
                  Self-custodial BRC-100 wallet · UI = f(state)
                </span>
              </span>
              <button
                type="button"
                className="btn btn-primary settings-check-btn"
                data-aeon-part="view-statecharts"
                onClick={() => openSetting('statecharts')}
              >
                View statecharts
              </button>
            </div>
          </li>
          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">Screenshot</strong>
                <span className="settings-row-desc">
                  Copy the app window (with v{runningVersion} BETA badge) ·{' '}
                  {window.handcash?.platform === 'darwin' ? '⌘⇧S' : 'Ctrl+Shift+S'}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-ghost settings-check-btn"
                data-aeon-part="copy-screenshot"
                onClick={() => void window.handcash?.copyScreenshot?.()}
              >
                Copy now
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  )
}
