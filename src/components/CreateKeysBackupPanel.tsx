import { useState } from 'react'
import {
  canConfirmKeysBackup,
  clearKeysHandoffEvidence,
  getKeysSplitHandoffProgress,
  markKeysBackupConfirmed,
  markKeysBackupDeferred,
  noteKeysBackupHandoff,
} from '../wallet/backupStatus'
import { shareDownloadFilename } from '../wallet/brc140Backup'
import {
  loadOrIssueBrc140Set,
  rotateBrc140Set,
  sliceSetLabel,
  type Brc140IssuedSet,
} from '../wallet/brc140IssuedSet'
import { shareKeySlice } from '../wallet/keySliceShare'
import { playWalletSound } from '../wallet/soundService'
import { copyText } from '../wallet/clipboard'
import { toastError, toastSuccess } from '../wallet/toast'
import { KeySliceList, type SliceHandoffMethod } from './KeySliceList'

type Props = {
  mnemonic: string
  rootKeyHex: string
  onDone: () => void
}

type Kind = 'phrase' | 'split'

function downloadShare(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Mandatory post-create backup. Phrase and slices come from the live create
 * result — never gated on a HandCash password.
 */
export function CreateKeysBackupPanel({ mnemonic, rootKeyHex, onDone }: Props) {
  const [kind, setKind] = useState<Kind>('phrase')
  const [shareSet, setShareSet] = useState<Brc140IssuedSet | null>(null)
  const [, setTick] = useState(0)

  const canConfirm = canConfirmKeysBackup(kind === 'phrase' ? 'phrase' : 'split')
  const splitProgress = getKeysSplitHandoffProgress(shareSet?.threshold ?? 2)

  const showSlices = async (rotate: boolean) => {
    try {
      const next = rotate
        ? await rotateBrc140Set(rootKeyHex)
        : await loadOrIssueBrc140Set(rootKeyHex)
      clearKeysHandoffEvidence()
      setShareSet(next)
      setKind('split')
      setTick((n) => n + 1)
    } catch (err) {
      playWalletSound('error')
      toastError('Couldn’t prepare slices', err instanceof Error ? err.message : undefined)
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
      } else if (method === 'copy') {
        const ok = await copyText(share, { label: `slice ${index + 1}` })
        if (!ok) return
      } else if (method === 'download') {
        downloadShare(
          shareDownloadFilename(index, shareSet.totalShares, shareSet.integrity),
          `# ${destination}\n# integrity ${shareSet.integrity}\n# ${sliceSetLabel(shareSet.issuedAt)}\n${share}\n`,
        )
      }
      playWalletSound('soft')
      toastSuccess('Slice handed off', destination)
    } catch (err) {
      playWalletSound('error')
      toastError('Couldn’t save slice', err instanceof Error ? err.message : undefined)
    }
  }

  const confirm = () => {
    if (!markKeysBackupConfirmed(kind === 'phrase' ? 'phrase' : 'split')) {
      toastError(
        'Save a backup first',
        kind === 'split'
          ? 'Hand off two different slices and confirm each one.'
          : 'Copy your phrase first.',
      )
      playWalletSound('deny')
      return
    }
    playWalletSound('success')
    toastSuccess('Recovery backup saved')
    onDone()
  }

  return (
    <div className="wallet-setup-config" data-aeon-scope="create-keys-backup">
      <h2>Save your recovery backup</h2>
      <p className="auth-lede">
        Recommended now. Write your recovery phrase or save two key slices. You can use the wallet
        first — Settings will keep reminding you until this is done.
      </p>

      <div className="actions" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={kind === 'phrase' ? 'btn btn-primary' : 'btn btn-ghost'}
          onClick={() => {
            setKind('phrase')
            setShareSet(null)
            clearKeysHandoffEvidence()
            setTick((n) => n + 1)
          }}
        >
          Recovery phrase
        </button>
        <button
          type="button"
          className={kind === 'split' ? 'btn btn-primary' : 'btn btn-ghost'}
          onClick={() => void showSlices(false)}
        >
          Key slices
        </button>
      </div>

      {kind === 'phrase' ? (
        <div className="split-backup-shares">
          <p className="settings-hint">
            Write these words down offline. Anyone with them controls the wallet.
          </p>
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
              onClick={() => {
                void copyText(mnemonic, { label: 'phrase' }).then((ok) => {
                  if (!ok) return
                  noteKeysBackupHandoff()
                  setTick((n) => n + 1)
                })
              }}
            >
              Copy phrase
            </button>
          </div>
        </div>
      ) : null}

      {kind === 'split' && shareSet ? (
        <div className="split-backup-shares">
          <KeySliceList
            shares={shareSet.shares}
            threshold={shareSet.threshold}
            integrity={shareSet.integrity}
            issuedAt={shareSet.issuedAt}
            savedIndices={splitProgress.savedIndices}
            onHandoff={handoff}
            onConfirmSaved={(index) => {
              noteKeysBackupHandoff(index)
              setTick((n) => n + 1)
              playWalletSound('soft')
              toastSuccess(`Slice ${index + 1} confirmed`)
            }}
            onRotateShares={() => showSlices(true)}
          />
        </div>
      ) : null}

      <div className="actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={confirm}>
          I’ve saved my backup — continue
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          data-aeon-part="backup-later"
          onClick={() => {
            markKeysBackupDeferred()
            playWalletSound('soft')
            onDone()
          }}
        >
          I’ll do this later
        </button>
      </div>
      <p className="auth-lede" style={{ marginTop: 8 }}>
        Later is fine. Don’t skip forever — this is the only way back if the device is wiped.
      </p>
    </div>
  )
}
