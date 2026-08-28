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
import {
  getAppearancePreference,
  setAppearancePreference,
  subscribeAppearance,
  type AppearancePreference,
} from '../wallet/themePrefs'
import { playWalletSound } from '../wallet/soundService'
import { subscribeBackupConfirmed } from '../wallet/backupStatus'
import { subscribeDeviceWallets } from '../wallet/deviceWallets'
import { subscribeDeviceKeyBackups } from '../wallet/deviceKeyBackup'
import {
  SettingsNavRow,
  SettingsControlRow,
  SettingsSection,
  statusForSetting,
  settingIconFor,
  SETTINGS_APPLICATION_ICONS,
  ShortcutHint,
  screenshotShortcutKeys,
} from './settings'

type SettingItem = {
  id: SettingId
  label: string
  description: string
}

const SECURITY_ITEMS: SettingItem[] = [
  {
    id: 'backup',
    label: 'Recovery backup',
    description: 'Phrase or key slices — Settings nags until done',
  },
  {
    id: 'history-backup',
    label: 'History',
    description: 'Required for recovery',
  },
  {
    id: 'device-handoff',
    label: 'Device backup',
    description: 'Keep a copy on your other device',
  },
  {
    id: 'import-phrase',
    label: 'Sweep',
    description: 'Move another wallet in here',
  },
  {
    id: 'change-password',
    label: 'Unlock',
    description: 'Device lock or HandCash password',
  },
  {
    id: 'wipe-wallet',
    label: 'Wipe wallet',
    description: 'Remove from this device',
  },
]

const UPDATE_MODES: { value: UpdateMode; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'manual', label: 'Manual' },
  { value: 'none', label: 'Off' },
]

const APPEARANCE_OPTIONS: { value: AppearancePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function phaseLabel(phase: string, error: string | null): string {
  switch (phase) {
    case 'checking':
      return 'Checking…'
    case 'available':
      return 'Update available'
    case 'downloading':
      return 'Downloading…'
    case 'ready':
      return 'Ready to restart'
    case 'not-available':
    case 'notAvailable':
      return error ? error : 'Up to date'
    case 'error':
      return error ?? 'Check failed'
    default:
      return ''
  }
}

function walletKindLabel(): string {
  return window.handcash?.platform === 'android' || window.handcash?.platform === 'ios'
    ? 'Mobile wallet'
    : 'Desktop wallet'
}

export function settingLabel(id: SettingId): string {
  if (id === 'about-handcash') return 'HandCash'
  if (id === 'statecharts') return 'Statecharts'
  if (id === 'logs') return 'Session logs'
  if (id === 'backup' || id === 'backup-phrase' || id === 'split-backup') return 'Recovery backup'
  if (id === 'device-handoff') return 'Device backup'
  if (id === 'change-password') return 'Unlock'
  const item = SECURITY_ITEMS.find((entry) => entry.id === id)
  if (item) return item.label
  return 'Setting'
}

function SecurityRows() {
  return (
    <ul className="settings-list">
      {SECURITY_ITEMS.map(({ id, label, description }) => {
        const status = statusForSetting(id)
        const { icon, tone } = settingIconFor(id)
        return (
          <SettingsNavRow
            key={id}
            label={label}
            description={description}
            status={status?.text}
            statusTone={status?.tone}
            icon={icon}
            iconTone={tone}
            onClick={() => openSetting(id)}
          />
        )
      })}
    </ul>
  )
}

export function SettingsPanel() {
  const update = useUpdate()
  const { context, check, setMode } = update
  const checking = context.phase === 'checking'
  const rootRef = useRef<HTMLDivElement>(null)
  const [sfxEnabled, setSfxEnabled] = useState(() => isWalletSfxEnabled())
  const [appearance, setAppearance] = useState<AppearancePreference>(() => getAppearancePreference())
  const [, setStatusTick] = useState(0)
  const isDesktop =
    window.handcash?.platform !== 'android' && window.handcash?.platform !== 'ios'
  const runningVersion =
    context.currentVersion && context.currentVersion !== '0.0.0'
      ? context.currentVersion
      : APP_VERSION
  const versionDetail = [
    phaseLabel(context.phase, context.error),
    context.availableVersion && context.availableVersion !== runningVersion
      ? `${context.availableVersion} available`
      : '',
    context.phase === 'downloading' && context.percent != null ? `${context.percent}%` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'start' })
    const stage = rootRef.current?.closest('.wallet-nav-stage')
    if (stage instanceof HTMLElement) stage.scrollTop = 0
  }, [])

  useEffect(() => subscribeWalletSfx(setSfxEnabled), [])

  useEffect(
    () =>
      subscribeAppearance((pref) => {
        setAppearance(pref)
      }),
    [],
  )

  useEffect(() => {
    const bump = () => setStatusTick((n) => n + 1)
    const unsubBackup = subscribeBackupConfirmed(bump)
    const unsubDevices = subscribeDeviceWallets(() => bump())
    const unsubSpares = subscribeDeviceKeyBackups(() => bump())
    return () => {
      unsubBackup()
      unsubDevices()
      unsubSpares()
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className="nav-section-body settings-nav"
      data-aeon-scope="settings"
    >
      <div className="connected-panel-head settings-panel-head">
        <h2>Settings</h2>
      </div>

      <SettingsSection title="Security" part="security">
        <SecurityRows />
      </SettingsSection>

      <SettingsSection title="Preferences" part="preferences">
        <ul className="settings-list">
          <SettingsControlRow
            icon={SETTINGS_APPLICATION_ICONS.appearance}
            label="Appearance"
            labelFor="settings-appearance"
          >
            <select
              id="settings-appearance"
              className="settings-control-input"
              value={appearance}
              data-aeon-part="appearance"
              data-aeon-state={appearance}
              onChange={(e) => {
                playWalletSound('soft')
                const next = e.target.value as AppearancePreference
                setAppearancePreference(next)
                setAppearance(next)
              }}
            >
              {APPEARANCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </SettingsControlRow>

          <SettingsControlRow
            icon={SETTINGS_APPLICATION_ICONS.sfx}
            label="Sound effects"
            labelFor="settings-sfx-enabled"
          >
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
          </SettingsControlRow>

          {isDesktop ? (
            <>
              <SettingsControlRow
                icon={SETTINGS_APPLICATION_ICONS.updates}
                label="Updates"
                labelFor="settings-update-mode"
              >
                <select
                  id="settings-update-mode"
                  className="settings-control-input"
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
              </SettingsControlRow>

              <SettingsControlRow
                icon={SETTINGS_APPLICATION_ICONS.version}
                label={`Version ${runningVersion}`}
                description={versionDetail || undefined}
              >
                <button
                  type="button"
                  className="btn btn-ghost settings-action-btn"
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
              </SettingsControlRow>
            </>
          ) : null}
        </ul>
      </SettingsSection>

      <SettingsSection title="Support" part="support">
        <ul className="settings-list">
          <SettingsNavRow
            label="Session logs"
            description="View, copy, and upload"
            icon={SETTINGS_APPLICATION_ICONS.logs}
            onClick={() => openSetting('logs')}
          />
          {isDesktop ? (
            <SettingsControlRow
              icon={SETTINGS_APPLICATION_ICONS.screenshot}
              label="Screenshot"
              description={
                <>
                  Copy this window to the clipboard
                  <ShortcutHint
                    className="settings-shortcut-hint"
                    keys={screenshotShortcutKeys(window.handcash?.platform)}
                  />
                </>
              }
            >
              <button
                type="button"
                className="btn btn-ghost settings-action-btn"
                data-aeon-part="copy-screenshot"
                onClick={() => {
                  playWalletSound('soft')
                  void window.handcash?.copyScreenshot?.()
                }}
              >
                Copy
              </button>
            </SettingsControlRow>
          ) : null}
        </ul>
      </SettingsSection>

      <SettingsSection title="About" part="about">
        <ul className="settings-list">
          <SettingsNavRow
            label="HandCash"
            description={walletKindLabel()}
            icon={settingIconFor('about-handcash').icon}
            onClick={() => openSetting('about-handcash')}
          />
        </ul>
      </SettingsSection>
    </div>
  )
}
