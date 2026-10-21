import { Button } from '@aeon-ui/react'
import { useCallback, useEffect, useState } from 'react'
import {
  SELF_BACKUPS,
  selfBackupStatus,
  signedInDeviceRows,
  type RelayDevices,
  type SignedInDeviceRow,
} from '../features/recovery'
import { listAddedDevices, noteDeviceRemoved, subscribeAddedDevices } from '../wallet/addedDevices'
import { openBackupFormat, savedBackupFormats, subscribeBackupFormats } from '../wallet/backupFormats'
import {
  listSigninDevices,
  removeSigninDevice,
  signinErrorText,
  walletSigninKeyHex,
} from '../wallet/deviceSignin'
import { localDeviceLabel } from '../wallet/deviceTransfer'
import { getOrCreateDeviceId } from '../wallet/deviceWallets'
import { openScanFlow, openSetting } from '../wallet/navStore'
import { readVaultMeta } from '../wallet/vault'
import { SettingsNavRow, SettingsSection, settingIconFor } from './settings'

function useSignedInDevices() {
  const [relay, setRelay] = useState<RelayDevices | null>(null)
  const [added, setAdded] = useState(() => listAddedDevices())
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setRelay(await listSigninDevices(walletSigninKeyHex()))
    } catch {
      setRelay(null)
    }
  }, [])

  useEffect(() => subscribeAddedDevices(() => setAdded(listAddedDevices())), [])
  useEffect(() => {
    void reload()
  }, [reload, added])

  const remove = async (row: SignedInDeviceRow) => {
    if (!row.remove) return
    setError(null)
    try {
      if (row.remove.kind === 'relay') {
        await removeSigninDevice(walletSigninKeyHex(), row.remove.deviceId)
        noteDeviceRemoved(row.label)
        await reload()
      } else {
        noteDeviceRemoved(row.label, row.remove.id)
      }
    } catch (cause) {
      setError(signinErrorText(cause))
    }
  }

  const rows = signedInDeviceRows({
    thisDeviceId: getOrCreateDeviceId(),
    thisLabel: localDeviceLabel(),
    relay,
    added,
  })
  return { rows, remove, error }
}

/**
 * HandCash Recovery: the wallet signed in on more than one device is the
 * backup. Backing up another wallet and self-kept copies are the fallbacks.
 */
export function HandCashRecoveryPanel() {
  const devices = useSignedInDevices()
  const [saved, setSaved] = useState(() => savedBackupFormats())
  useEffect(() => subscribeBackupFormats(() => setSaved(savedBackupFormats())), [])
  const hasPhrase = Boolean(readVaultMeta()?.hasMnemonic)

  return (
    <div data-aeon-scope="handcash-recovery" className="split-backup-shares">
      <section data-aeon-part="recovery-devices">
        <div className="actions">
          <Button.Root variant="solid" className="btn btn-primary" onClick={() => openScanFlow()}>
            <Button.Label>Back this up on another device</Button.Label>
          </Button.Root>
        </div>
        <p className="settings-hint">
          Use this wallet on your phone or another computer. Each device keeps a full copy, so
          losing one doesn&rsquo;t lose your wallet.
        </p>
        <p className="settings-hint">
          On the other device, open HandCash and choose Sign in, then scan its code here.
        </p>
        <ul className="recovery-methods" aria-label="Signed-in devices">
          {devices.rows.map((row) => (
            <li
              key={row.key}
              className="recovery-method"
              data-aeon-part="recovery-device"
              data-aeon-state={row.status.tone}
            >
              <div className="recovery-method-head">
                <strong>{row.label}</strong>
                <span className="recovery-method-status">{row.status.text}</span>
              </div>
              {row.remove ? (
                <div className="actions">
                  <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => void devices.remove(row)}>
                    <Button.Label>Remove</Button.Label>
                  </Button.Root>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {devices.error ? (
          <p className="signin-error" role="alert">
            {devices.error}
          </p>
        ) : null}
        <p className="settings-hint">
          Removing a device stops it approving sign-ins. It keeps the wallet it already has, so if a
          device is lost, move your funds to a new wallet.
        </p>
      </section>

      <section data-aeon-part="recovery-other-wallet">
        <ul className="settings-list">
          <SettingsNavRow
            label="Back up a different wallet"
            description="Keep another wallet’s copy here, or this one’s on someone else’s device"
            icon={settingIconFor('device-handoff').icon}
            onClick={() => openSetting('device-handoff')}
          />
        </ul>
      </section>

      <SettingsSection title="Save a backup yourself" part="recovery-self">
        <p className="settings-hint">For when you can&rsquo;t sign in on another device.</p>
        <ul className="settings-list">
          {SELF_BACKUPS.map(({ format, title }) => {
            const status = selfBackupStatus(format, saved, hasPhrase)
            return (
              <SettingsNavRow
                key={format}
                label={title}
                status={status.text}
                statusTone={status.tone}
                icon={settingIconFor('backup').icon}
                onClick={() => openBackupFormat(format)}
              />
            )
          })}
        </ul>
      </SettingsSection>

      <p className="settings-hint" data-aeon-part="recovery-enclave">
        Secure enclave recovery is coming.
      </p>
    </div>
  )
}
