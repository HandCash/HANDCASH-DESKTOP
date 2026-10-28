import { Button } from '@aeon-ui/react'
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
import { saveBackupFile } from '../wallet/backupFileSave'
import { shareKeySlice } from '../wallet/keySliceShare'
import { playWalletSound } from '../wallet/soundService'
import { copyText } from '../wallet/clipboard'
import { toastError, toastSuccess } from '../wallet/toast'
import { KeySliceList, type SliceHandoffMethod } from './KeySliceList'
import { markBackupFormatSaved } from '../wallet/backupFormats'

type Props = {
  mnemonic: string
  rootKeyHex: string
  onDone: () => void
}

type Kind = 'phrase' | 'split'

/**
 * Mandatory post-create backup. Phrase and slices come from the live create
 * result — never gated on a HandCash password.
 */
export function CreateKeysBackupPanel({ mnemonic, rootKeyHex, onDone }: Props) {
  const [kind, setKind] = useState<Kind>('phrase')
  const [shareSet, setShareSet] = useState<Brc140IssuedSet | null>(null)
  const [, setTick] = useState(0)

  const canConfirm = canConfirmKeysBackup(kind)
  const splitProgress = getKeysSplitHandoffProgress(shareSet?.threshold ?? 2)
  const words = mnemonic.trim().split(/\s+/).filter(Boolean)

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
        const saved = await saveBackupFile(
          shareDownloadFilename(index, shareSet.totalShares, shareSet.integrity),
          `# ${destination}\n# integrity ${shareSet.integrity}\n# ${sliceSetLabel(shareSet.issuedAt)}\n${share}\n`,
        )
        if (!saved.saved) return
        noteKeysBackupHandoff(index)
        setTick((n) => n + 1)
        playWalletSound('soft')
        toastSuccess(`Slice ${index + 1} saved`, saved.path)
        return
      }
      playWalletSound('soft')
      toastSuccess('Slice handed off', destination)
    } catch (err) {
      playWalletSound('error')
      toastError('Couldn’t save slice', err instanceof Error ? err.message : undefined)
    }
  }

  const confirm = () => {
    if (!markKeysBackupConfirmed(kind)) {
      toastError(
        'Save a backup first',
        kind === 'split'
          ? 'Hand off two different slices and confirm each one.'
          : 'Copy your phrase first.',
      )
      playWalletSound('deny')
      return
    }
    markBackupFormatSaved(kind)
    playWalletSound('success')
    toastSuccess('Recovery backup saved')
    onDone()
  }

  return (
    <div className="wallet-setup-config keys-backup" data-aeon-scope="create-keys-backup">
      <header className="keys-backup-head">
        <h2>Save recovery backup</h2>
        <div className="keys-backup-tabs" role="tablist" aria-label="Backup kind">
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'phrase'}
            className={kind === 'phrase' ? 'btn btn-primary keys-backup-tab' : 'btn btn-ghost keys-backup-tab'}
            onClick={() => {
              setKind('phrase')
              setShareSet(null)
              clearKeysHandoffEvidence()
              setTick((n) => n + 1)
            }}
          >
            Phrase
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={kind === 'split'}
            className={kind === 'split' ? 'btn btn-primary keys-backup-tab' : 'btn btn-ghost keys-backup-tab'}
            onClick={() => void showSlices(false)}
          >
            Key slices
          </button>
        </div>
      </header>

      <div className="keys-backup-body" data-aeon-scroll="hover">
        {kind === 'phrase' ? (
          <div className="split-backup-shares">
            <ol className="recovery-phrase-grid" data-words={words.length}>
              {words.map((word, i) => (
                <li key={`${i}-${word}`}>
                  <span className="recovery-phrase-index">{i + 1}</span>
                  <span className="recovery-phrase-word">{word}</span>
                </li>
              ))}
            </ol>
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
      </div>

      <footer className="keys-backup-foot">
        {kind === 'phrase' ? (
          <Button.Root
            variant="ghost"
            className="btn btn-ghost"
            onClick={() => {
              void copyText(mnemonic, { label: 'phrase' }).then((ok) => {
                if (!ok) return
                noteKeysBackupHandoff()
                setTick((n) => n + 1)
              })
            }}
          >
            <Button.Label>Copy phrase</Button.Label>
          </Button.Root>
        ) : null}
        <Button.Root variant="solid" className="btn btn-primary" disabled={!canConfirm} onClick={confirm}>
          <Button.Label>I’ve saved it — continue</Button.Label>
        </Button.Root>
        <Button.Root
          variant="ghost"
          className="btn btn-ghost"
          data-aeon-part="backup-later"
          onClick={() => {
            markKeysBackupDeferred()
            playWalletSound('soft')
            onDone()
          }}
        >
          <Button.Label>I’ll do this later</Button.Label>
        </Button.Root>
      </footer>
    </div>
  )
}
