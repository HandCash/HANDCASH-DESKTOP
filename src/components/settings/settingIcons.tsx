import type { ReactNode } from 'react'
import type { SettingId } from '../../wallet/navStore'
import {
  ActivityIcon,
  CloudUploadIcon,
  DevicesIcon,
  DownloadIcon,
  EncryptIcon,
  FileIcon,
  InfoIcon,
  LaunchIcon,
  LockIcon,
  PaletteIcon,
  RefreshIcon,
  ScreenshotIcon,
  SystemUpdateIcon,
  VolumeUpIcon,
  WarningIcon,
} from '../icons'

export type SettingIconTone = 'default' | 'danger'

export type SettingIconSpec = {
  icon: ReactNode
  tone?: SettingIconTone
}

const ICON_SIZE = 20

function iconFor(id: SettingId): SettingIconSpec {
  switch (id) {
    case 'backup':
    case 'backup-phrase':
    case 'split-backup':
      return { icon: <EncryptIcon size={ICON_SIZE} /> }
    case 'history-backup':
      return { icon: <DownloadIcon size={ICON_SIZE} /> }
    case 'device-handoff':
      return { icon: <DevicesIcon size={ICON_SIZE} /> }
    case 'import-phrase':
      return { icon: <RefreshIcon size={ICON_SIZE} /> }
    case 'change-password':
      return { icon: <LockIcon size={ICON_SIZE} /> }
    case 'wipe-wallet':
      return { icon: <WarningIcon size={ICON_SIZE} />, tone: 'danger' }
    case 'about-handcash':
      return { icon: <LaunchIcon size={ICON_SIZE} /> }
    case 'statecharts':
      return { icon: <ActivityIcon size={ICON_SIZE} /> }
    case 'logs':
      return { icon: <FileIcon size={ICON_SIZE} /> }
    case 'wallet-health':
      return { icon: <ActivityIcon size={ICON_SIZE} /> }
    case 'index-packs':
      return { icon: <DownloadIcon size={ICON_SIZE} /> }
    default:
      return { icon: <InfoIcon size={ICON_SIZE} /> }
  }
}

export function settingIconFor(id: SettingId): SettingIconSpec {
  return iconFor(id)
}

export const SETTINGS_APPLICATION_ICONS = {
  appearance: <PaletteIcon size={ICON_SIZE} />,
  sfx: <VolumeUpIcon size={ICON_SIZE} />,
  updates: <SystemUpdateIcon size={ICON_SIZE} />,
  version: <InfoIcon size={ICON_SIZE} />,
  logs: <FileIcon size={ICON_SIZE} />,
  logUpload: <CloudUploadIcon size={ICON_SIZE} />,
  screenshot: <ScreenshotIcon size={ICON_SIZE} />,
} as const

export function SettingsRowIcon({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: SettingIconTone
}) {
  return (
    <span className="settings-row-icon" data-tone={tone} aria-hidden>
      {children}
    </span>
  )
}
