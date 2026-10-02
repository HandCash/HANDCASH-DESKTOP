import { useEffect, useState } from 'react'
import { revealMnemonic, revealRootKeyHex, readVaultMeta } from '../wallet/vault'
import {
  canConfirmKeysBackup,
  clearKeysHandoffEvidence,
  getKeysSplitHandoffProgress,
  markKeysBackupConfirmed,
  noteKeysBackupHandoff,
  subscribeBackupConfirmed,
} from '../wallet/backupStatus'
import { BRC140_DEFAULT_THRESHOLD, BRC140_DEFAULT_TOTAL, shareDownloadFilename } from '../wallet/brc140Backup'
import {
  loadOrIssueBrc140Set,
  rotateBrc140Set,
  sliceSetLabel,
  type Brc140IssuedSet,
} from '../wallet/brc140IssuedSet'
import { shareKeySlice } from '../wallet/keySliceShare'
import { playWalletSound } from '../wallet/soundService'
import { copyText } from '../wallet/clipboard'
import { openSetting } from '../wallet/navStore'
import { toastError, toastSuccess } from '../wallet/toast'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { AsyncActionPrompt } from './AsyncActionPrompt'
import { KeySliceList, type SliceHandoffMethod } from './KeySliceList'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

type BackupKind = 'split' | 'phrase' | 'key'

function downloadShare(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function emailShareToSelf(
  share: string,
  index: number,
  set: Brc140IssuedSet,
  destination: string,
): Promise<void> {
  const subject = `HandCash key slice ${index + 1} of ${set.totalShares}`
  const body = [
    `HandCash key slice ${index + 1}/${set.totalShares}`,
    `Suggested place: ${destination}`,
    `Integrity: ${set.integrity}`,
    sliceSetLabel(set.issuedAt),
    '',
    share,
    '',
    'Only slices from the same set combine.',
  ].join('\n')
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  if (window.handcash?.openExternal) {
    await window.handcash.openExternal(mailto)
  } else {
    window.location.href = mailto
  }
}

export function WalletBackupPanel() {
  const meta = readVaultMeta()
  const hasPhrase = Boolean(meta?.hasMnemonic)
  const [kind, setKind] = useState<BackupKind>('split')
  /** One exclusive key-material operation; `rotate` confirms first. */
  const backup = useAsyncAction<'reveal' | 'rotate'>()
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [rootKey, setRootKey] = useState<string | null>(null)
  const [shareSet, setShareSet] = useState<Brc140IssuedSet | null>(null)
  const [, setStatusTick] = useState(0)

  useEffect(() => subscribeBackupConfirmed(() => setStatusTick((n) => n + 1)), [])

  const revealed = Boolean(mnemonic || rootKey || shareSet)
  const canConfirm = canConfirmKeysBackup(kind)
  const splitProgress = getKeysSplitHandoffProgress(shareSet?.threshold ?? 2)

  const clearReveal = () => {
    setMnemonic(null)
    setRootKey(null)
    setShareSet(null)
    backup.reset()
  }

  const selectKind = (next: BackupKind) => {
    if (revealed) clearReveal()
    setKind(next)
  }

  /** Recovery material from the unlocked session — never asks for HandCash password. */
  const revealRecovery = async () => {
    setMnemonic(null)
    setRootKey(null)
    setShareSet(null)
    const outcome = await backup.run('reveal', async () => {
      if (kind === 'phrase') {
        if (!hasPhrase) throw new Error('This wallet has no recovery phrase.')
        setMnemonic(await revealMnemonic())
      } else if (kind === 'key') {
        setRootKey(await revealRootKeyHex())
      } else {
        clearKeysHandoffEvidence()
        setShareSet(await loadOrIssueBrc140Set(await revealRootKeyHex()))
      }
    })
    if (!outcome.ok && outcome.error !== null) playWalletSound('error')
  }

  const rotateShares = async () => {
    const outcome = await backup.run(
      'rotate',
      async () => {
        clearKeysHandoffEvidence()
        const next = await rotateBrc140Set(await revealRootKeyHex())
        setShareSet(next)
        playWalletSound('soft')
        toastSuccess(
          'New slice set',
          `${sliceSetLabel(next.issuedAt)} — slices from the previous set will not combine with these.`,
        )
      },
      {
        confirm: {
          title: 'Rotate all slices?',
          body: `This creates a brand-new ${BRC140_DEFAULT_THRESHOLD}-of-${BRC140_DEFAULT_TOTAL} set. The integrity tag stays the same — it names the wallet, not the set — but slices from the previous set will not combine with these. Save the new ones before discarding the old.`,
          confirmLabel: 'Rotate',
          cancelLabel: 'Keep current',
        },
      },
    )
    if (!outcome.ok && outcome.error !== null) {
      playWalletSound('error')
      toastError('Rotate failed', outcome.error)
    }
  }

  const handoff = async (
    index: number,
    method: SliceHandoffMethod,
    destination: string,
  ) => {
    if (!shareSet?.shares[index]) return
    const share = shareSet.shares[index]!
    try {
      if (method === 'share') {
        const outcome = await shareKeySlice({
          share,
          index,
          total: shareSet.totalShares,
          integrity: shareSet.integrity,
          issuedAt: shareSet.issuedAt,
        })
        if (outcome === 'cancelled') return
        if (outcome === 'unavailable') {
          await emailShareToSelf(share, index, shareSet, destination)
          toastSuccess('Opened email', 'This device has no native share sheet.')
        } else {
          playWalletSound('soft')
          toastSuccess('Share sheet opened', 'Choose an account or app you control.')
        }
      } else if (method === 'email') {
        await emailShareToSelf(share, index, shareSet, destination)
        playWalletSound('soft')
        toastSuccess('Opened email', destination)
      } else if (method === 'copy') {
        const ok = await copyText(share, { label: `slice ${index + 1}` })
        if (!ok) return
        toastSuccess('Copied', destination)
      } else {
        downloadShare(
          shareDownloadFilename(index, shareSet.totalShares, shareSet.integrity),
          `# ${destination}\n# integrity ${shareSet.integrity}\n# ${sliceSetLabel(shareSet.issuedAt)}\n${share}\n`,
        )
        playWalletSound('soft')
        toastSuccess('Slice saved', destination)
      }
    } catch (err) {
      playWalletSound('error')
      toastError('Couldn’t save slice', err instanceof Error ? err.message : undefined)
    }
  }

  const confirmSliceSaved = (index: number) => {
    noteKeysBackupHandoff(index)
    playWalletSound('soft')
    toastSuccess(`Slice ${index + 1} confirmed`, 'Keep it separate from your other slice.')
  }

  const copySingle = async (text: string, label: string) => {
    const ok = await copyText(text, { label })
    if (!ok) return
    noteKeysBackupHandoff()
  }

  const confirmKeys = () => {
    if (!markKeysBackupConfirmed(kind)) {
      toastError(
        'Backup not complete',
        kind === 'split'
          ? 'Share or save two different slices, then confirm each one.'
          : 'Copy your secret first.',
      )
      playWalletSound('deny')
      return
    }
    clearReveal()
    playWalletSound('success')
    toastSuccess('Keys backup saved', 'History backup is next if you have not done it yet.')
    openSetting('history-backup')
  }

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="wallet-backup"
      data-aeon-state={revealed ? 'revealed' : 'idle'}
    >
      <p className="settings-hint">
        Share any two of three slices to separate accounts or apps you control. HandCash does not
        receive them.
      </p>

      <div className="actions backup-alternate-actions" aria-label="Recovery formats">
        <button
          type="button"
          className={kind === 'split' ? 'btn btn-primary' : 'btn btn-ghost'}
          onClick={() => selectKind('split')}
        >
          Key slices
        </button>
        <button
          type="button"
          className={kind === 'phrase' ? 'btn btn-primary' : 'btn btn-ghost'}
          disabled={!hasPhrase}
          onClick={() => selectKind('phrase')}
        >
          Recovery phrase
        </button>
        <button
          type="button"
          className={kind === 'key' ? 'btn btn-primary' : 'btn btn-ghost'}
          onClick={() => selectKind('key')}
        >
          Emergency key
        </button>
      </div>

      {!revealed ? (
        <div className="confirm-password-gate" data-aeon-scope="reveal-recovery">
          <div className="confirm-password-copy">
            <h3 className="confirm-password-title">Show recovery material</h3>
            <p className="confirm-password-lede">
              Your wallet is unlocked — phrase and slices are not locked behind a HandCash password.
            </p>
          </div>
          <div className="actions" data-aeon-part="reveal-actions" data-aeon-state={backup.stateAttr}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={backup.busy}
              onClick={() => void revealRecovery()}
            >
              {backup.running('reveal')
                ? 'Opening…'
                : kind === 'split'
                  ? 'Show slices'
                  : kind === 'phrase'
                    ? 'Show phrase'
                    : 'Show key'}
            </button>
          </div>
        </div>
      ) : null}

      {backup.error && !revealed ? (
        <p className="error" role="alert">
          {backup.error}
        </p>
      ) : null}

      {mnemonic ? (
        <div className="split-backup-shares">
          <p className="settings-hint">Keep these words private.</p>
          <ol className="recovery-phrase-grid">
            {mnemonic.split(/\s+/).map((word, i) => (
              <li key={`${i}-${word}`}>
                <span className="recovery-phrase-index">{i + 1}.</span> {word}
              </li>
            ))}
          </ol>
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void copySingle(mnemonic, 'phrase')}
            >
              Copy
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmKeys}
              disabled={!canConfirm}
            >
              I’ve saved my phrase
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                clearReveal()
                playWalletSound('deny')
              }}
            >
              Hide
            </button>
          </div>
        </div>
      ) : null}

      {rootKey ? (
        <div className="split-backup-shares">
          <p className="settings-hint">Keep this key private.</p>
          <p className="mono" style={{ wordBreak: 'break-all' }}>
            {rootKey}
          </p>
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void copySingle(rootKey, 'key')}
            >
              Copy
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmKeys}
              disabled={!canConfirm}
            >
              I’ve saved my key
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                clearReveal()
                playWalletSound('deny')
              }}
            >
              Hide
            </button>
          </div>
        </div>
      ) : null}

      {shareSet ? (
        <div className="split-backup-shares">
          <KeySliceList
            shares={shareSet.shares}
            threshold={shareSet.threshold}
            integrity={shareSet.integrity}
            issuedAt={shareSet.issuedAt}
            savedIndices={splitProgress.savedIndices}
            onHandoff={handoff}
            onConfirmSaved={confirmSliceSaved}
            onRotateShares={() => void rotateShares()}
            rotateBusy={backup.busy}
          />
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmKeys}
              disabled={!canConfirm}
              title={
                canConfirm
                  ? 'Mark keys backup complete on this device'
                  : `Hand off ${Math.max(0, splitProgress.need - splitProgress.saved)} more distinct slice(s) first`
              }
            >
              Done — slices saved
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                clearReveal()
                playWalletSound('deny')
              }}
            >
              Hide
            </button>
          </div>
        </div>
      ) : null}

      <AsyncActionPrompt action={backup} />

      <SettingsFeatureAbout tags={['BRC-140', 'BRC-75']}>
        Any two slices from the same set restore the wallet. Showing slices again shows the same
        set; only Replace slice set makes a new one. Use Share to put them in separate accounts or
        apps; no HandCash server is involved.
      </SettingsFeatureAbout>
    </div>
  )
}
