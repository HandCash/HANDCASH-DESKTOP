import { useState } from 'react'
import { openSetting, type SettingId } from '../wallet/navStore'
import {
  checkForUpdatesNow,
  setUpdateModeNow,
  useUpdateStatus,
  type UpdateMode,
} from '../wallet/updateStatus'

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
        id: 'change-password',
        label: 'Change password',
        description: 'Update your wallet unlock password',
      },
    ],
  },
]

const UPDATE_MODES: { value: UpdateMode; label: string; description: string }[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Check and download updates automatically',
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Only check when you ask',
  },
  {
    value: 'none',
    label: 'None',
    description: 'Disable updates',
  },
]

function phaseLabel(phase: string): string {
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
      return 'Up to date'
    case 'error':
      return 'Update check failed'
    default:
      return 'Idle'
  }
}

export function settingLabel(id: SettingId): string {
  for (const group of SETTING_GROUPS) {
    const item = group.items.find((entry) => entry.id === id)
    if (item) return item.label
  }
  return 'Setting'
}

export function SettingsPanel() {
  const update = useUpdateStatus()
  const [busy, setBusy] = useState(false)

  async function onModeChange(mode: UpdateMode) {
    setBusy(true)
    try {
      await setUpdateModeNow(mode)
    } finally {
      setBusy(false)
    }
  }

  async function onCheck() {
    setBusy(true)
    try {
      await checkForUpdatesNow()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nav-section-body settings-nav" data-aeon-scope="settings">
      <div className="connected-panel-head">
        <h2>Settings</h2>
      </div>

      {SETTING_GROUPS.map((group) => (
        <section key={group.title} className="settings-group">
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
                    <span className="settings-row-desc">{description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="settings-group">
        <h3 className="settings-group-title">Application</h3>
        <ul className="settings-list">
          <li className="settings-row settings-row-static">
            <label className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">Update Mode</strong>
                <span className="settings-row-desc">
                  {UPDATE_MODES.find((m) => m.value === update.mode)?.description ??
                    'How HandCash Desktop checks for updates'}
                </span>
              </span>
              <select
                className="settings-interval-select"
                value={update.mode}
                disabled={busy || !window.handcash?.setUpdateMode}
                onChange={(e) => void onModeChange(e.target.value as UpdateMode)}
              >
                {UPDATE_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </li>

          <li className="settings-row settings-row-static">
            <div className="settings-update-row">
              <span className="settings-row-body">
                <strong className="settings-row-label">
                  Version {update.currentVersion || '—'}
                </strong>
                <span className="settings-row-desc">
                  {phaseLabel(update.phase)}
                  {update.availableVersion ? ` · ${update.availableVersion}` : ''}
                  {update.phase === 'downloading' && update.percent != null
                    ? ` · ${update.percent}%`
                    : ''}
                  {update.error ? ` · ${update.error}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="ghost settings-check-btn"
                disabled={busy || update.mode === 'none' || !window.handcash?.checkForUpdates}
                onClick={() => void onCheck()}
              >
                {busy && update.phase === 'checking' ? 'Checking…' : 'Check for Updates'}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  )
}
