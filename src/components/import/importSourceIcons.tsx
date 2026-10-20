import type { ReactNode } from 'react'
import type { ImportSourceKind } from '../../wallet/import'
import { handcashBrand } from '../../assets/brand'
import twetchMark from '../../assets/brand/wallets/twetch.svg?url'
import yoursMark from '../../assets/brand/wallets/yours.png'
import { DeferredImage } from '../DeferredImage'
import { KeyIcon, PhraseIcon } from '../icons'
import { SettingsRowIcon } from '../settings/settingIcons'

const BRAND_MARKS: Partial<Record<ImportSourceKind, string>> = {
  handcash: handcashBrand.markGreenPng,
  twetch: twetchMark,
  yours: yoursMark,
}

const GLYPHS: Partial<Record<ImportSourceKind, (size: number) => ReactNode>> = {
  phrase: (size) => <PhraseIcon size={size} />,
  wif: (size) => <KeyIcon size={size} />,
}

/**
 * The tile a saved or new import source wears: the wallet's own mark for named
 * wallets, a Settings glyph for bare phrases and keys.
 */
export function ImportSourceIcon({ kind, size = 'md' }: { kind: ImportSourceKind; size?: 'md' | 'lg' }) {
  const mark = BRAND_MARKS[kind]
  if (mark) {
    return (
      <span className="import-source-mark" data-kind={kind} data-size={size} aria-hidden>
        <DeferredImage
          src={mark}
          alt=""
          draggable={false}
          retainDecoded
          skeletonWidth="100%"
          skeletonHeight="100%"
          skeletonRadius={0}
        />
      </span>
    )
  }
  return (
    <span className="import-source-glyph" data-size={size}>
      <SettingsRowIcon>{GLYPHS[kind]?.(size === 'lg' ? 24 : 20)}</SettingsRowIcon>
    </span>
  )
}
