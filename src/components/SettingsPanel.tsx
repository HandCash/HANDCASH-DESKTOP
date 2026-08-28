import { useEffect, useRef, useState } from 'react'
import { Switch } from '@aeon-ui/ui'
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
import {
  BlockIcon,
  DarkModeIcon,
  LightModeIcon,
  MonitorIcon,
  RepeatIcon,
  TouchAppIcon,
} from './icons'
import { subscribeBackupConfirmed } from '../wallet/backupStatus'
import { subscribeDeviceWallets } from '../wallet/deviceWallets'
import { subscribeDeviceKeyBackups } from '../wallet/deviceKeyBackup'
import {
  SettingsNavRow,
  SettingsControlRow,
  SettingsIconToggle,
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

function checkButtonStatus(
  checking: boolean,
  mode: UpdateMode,
): 'idle' | 'pending' | 'disabled' {
  if (mode === 'none') return 'disabled'
  if (checking) return 'pending'
  return 'idle'
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
          >
            <SettingsIconToggle
              ariaLabel="Appearance"
              value={appearance}
              onChange={(pref) => {
                playWalletSound('soft')
                setAppearancePreference(pref)
                setAppearance(pref)
              }}
              options={[
                { value: 'system', label: 'System', icon: <MonitorIcon size={16} /> },
                { value: 'dark', label: 'Dark', icon: <DarkModeIcon size={16} /> },
                { value: 'light', label: 'Light', icon: <LightModeIcon size={16} /> },
              ]}
            />
          </SettingsControlRow>

          <SettingsControlRow
            icon={SETTINGS_APPLICATION_ICONS.sfx}
            label="Sound effects"
          >
            <Switch.Root
              checked={sfxEnabled}
              onCheckedChange={(next) => {
                setWalletSfxEnabled(next)
                setSfxEnabled(next)
                if (next) playWalletSound('receive', { force: true })
              }}
            />
          </SettingsControlRow>

          {isDesktop ? (
            <>
              <SettingsControlRow
                icon={SETTINGS_APPLICATION_ICONS.updates}
                label="Updates"
              >
                <SettingsIconToggle
                  ariaLabel="Updates"
                  value={context.mode}
                  onChange={(next) => {
                    playWalletSound('soft')
                    void setMode(next)
                  }}
                  options={[
                    { value: 'default', label: 'Automatic', icon: <RepeatIcon size={16} /> },
                    { value: 'manual', label: 'Manual', icon: <TouchAppIcon size={16} /> },
                    { value: 'none', label: 'Off', icon: <BlockIcon size={16} /> },
                  ]}
                />
              </SettingsControlRow>

              <SettingsControlRow
                icon={SETTINGS_APPLICATION_ICONS.version}
                label={`Version ${runningVersion}`}
                description={versionDetail || undefined}
              >
                <button
                  type="button"
                  className="btn btn-primary settings-action-btn"
                  disabled={checkButtonStatus(checking, context.mode) !== 'idle'}
                  onClick={() => {
                    playWalletSound('soft')
                    void check()
                  }}
                >
                  {checking ? 'Checking…' : 'Check update'}
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
              description="Copy this window to the clipboard"
            >
              <span className="settings-action-stack">
                <button
                  type="button"
                  className="btn btn-primary settings-action-btn"
                  onClick={() => {
                    playWalletSound('soft')
                    void window.handcash?.copyScreenshot?.()
                  }}
                >
                  Take screenshot
                </button>
                <ShortcutHint
                  className="settings-shortcut-hint"
                  keys={screenshotShortcutKeys(window.handcash?.platform)}
                />
              </span>
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
