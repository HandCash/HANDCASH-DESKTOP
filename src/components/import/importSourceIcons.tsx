import type { ReactNode } from 'react'
import type { ImportSourceKind } from '../../wallet/import'
import { FileIcon, HandCashMarkIcon, KeyIcon, MessagesIcon, PhraseIcon } from '../icons'
import { SettingsRowIcon } from '../settings/settingIcons'

const ICON_SIZE = 20

const ICONS: Readonly<Record<ImportSourceKind, ReactNode>> = {
  handcash: <HandCashMarkIcon size={ICON_SIZE} />,
  phrase: <PhraseIcon size={ICON_SIZE} />,
  twetch: <MessagesIcon size={ICON_SIZE} />,
  yours: <FileIcon size={ICON_SIZE} />,
  wif: <KeyIcon size={ICON_SIZE} />,
}

/** The tile a saved or new import source wears, in Settings' icon style. */
export function ImportSourceIcon({ kind }: { kind: ImportSourceKind }) {
  return <SettingsRowIcon>{ICONS[kind]}</SettingsRowIcon>
}
