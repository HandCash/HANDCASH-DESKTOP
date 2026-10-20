import { Button, Field } from '@aeon-ui/react'
import { Switch } from '@aeon-ui/ui'
import { useEffect, useState } from 'react'
import {
  getHistoryBackupPrefs,
  setHistoryBackupPrefs,
} from '../../wallet/historyBackupPrefs'
import { getWalletConfigPrefs } from '../../wallet/walletConfig'
import {
  HANDCASH_HISTORY_HOST_LABEL,
  ensureHandCashServiceDefaults,
  handCashHistoryUrl,
} from '../../wallet/walletSetupApply'
import { playWalletSound } from '../../wallet/soundService'
import { toastSuccess } from '../../wallet/toast'
import { CloudUploadIcon } from '../icons'
import { SettingsControlRow } from './SettingsControlRow'

type Props = {
  id?: string
  label?: string
  /** Show Save / Use HandCash actions (default true). */
  showActions?: boolean
  onSaved?: (baseUrl: string) => void
}

function isHandCashUrl(url: string): boolean {
  const a = url.trim().replace(/\/+$/, '')
  const b = handCashHistoryUrl()
  return Boolean(a) && a === b
}

/**
 * History backup host. HandCash is the default; a custom URL is opt-in.
 * Does not persist HandCash when the user chose "no backup" at setup.
 */
export function HistoryBackupUrlField({
  id = 'history-backup-url',
  label = 'History host',
  showActions = true,
  onSaved,
}: Props) {
  const [customHost, setCustomHost] = useState(() => {
    const url = getHistoryBackupPrefs().baseUrl
    return Boolean(url.trim()) && !isHandCashUrl(url)
  })
  const [draft, setDraft] = useState(() => getHistoryBackupPrefs().baseUrl || handCashHistoryUrl())
  const optedOut = getWalletConfigPrefs().mode === 'none'
  useEffect(() => {
    if (!optedOut) {
      try {
        ensureHandCashServiceDefaults()
      } catch {
        /* ignore */
      }
    }
    const url = getHistoryBackupPrefs().baseUrl.trim()
    if (url && !isHandCashUrl(url)) {
      setCustomHost(true)
      setDraft(url)
    } else {
      setDraft(url || handCashHistoryUrl())
    }
  }, [optedOut])

  const save = (url: string) => {
    const next = setHistoryBackupPrefs({ baseUrl: url })
    setDraft(next.baseUrl || handCashHistoryUrl())
    playWalletSound('soft')
    toastSuccess(
      next.baseUrl
        ? isHandCashUrl(next.baseUrl)
          ? 'Using HandCash history'
          : 'Custom history host saved'
        : 'History host cleared',
    )
    onSaved?.(next.baseUrl)
  }

  return (
    <div className="settings-form settings-form-compact" data-aeon-part="history-url-field">
      <ul className="settings-list">
        <SettingsControlRow
          label="Custom history host"
          icon={<CloudUploadIcon size={20} />}
          description={
            customHost
              ? 'Backups go to the URL below'
              : optedOut
                ? 'Off · you chose no backup host during setup'
                : `Off · backups go to ${HANDCASH_HISTORY_HOST_LABEL}`
          }
        >
          <Switch.Root
            checked={customHost}
            aria-label="Custom history host"
            onCheckedChange={(on) => {
              setCustomHost(on)
              if (!on && !optedOut) save(handCashHistoryUrl())
            }}
          />
        </SettingsControlRow>
      </ul>

      {customHost ? (
        <Field.Root className="field">
          <Field.Label htmlFor={id}>{label}</Field.Label>
          <Field.Control
            id={id}
            type="url"
            placeholder={handCashHistoryUrl()}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field.Root>
      ) : null}

      {showActions && customHost ? (
        <div className="actions">
          <Button.Root variant="solid" className="btn btn-primary" onClick={() => save(draft)}>
            <Button.Label>Save URL</Button.Label>
          </Button.Root>
          <Button.Root variant="ghost"
            className="btn btn-ghost"
            onClick={() => {
              setCustomHost(false)
              save(handCashHistoryUrl())
            }}
          >
            <Button.Label>Use HandCash</Button.Label>
          </Button.Root>
        </div>
      ) : null}
    </div>
  )
}
