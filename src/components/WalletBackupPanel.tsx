import { useEffect, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import { revealMnemonic, revealRootKeyHex, readVaultMeta } from '../wallet/vault'
import {
  canConfirmKeysBackup,
  clearKeysHandoffEvidence,
  getKeysSplitHandoffProgress,
  markKeysBackupConfirmed,
  noteKeysBackupHandoff,
  subscribeBackupConfirmed,
} from '../wallet/backupStatus'
import {
  BRC140_DEFAULT_THRESHOLD,
  BRC140_DEFAULT_TOTAL,
  createBrc140Shares,
  shareDownloadFilename,
  type Brc140ShareSet,
} from '../wallet/brc140Backup'
import { playWalletSound } from '../wallet/soundService'
import { copyText } from '../wallet/clipboard'
import { openSetting } from '../wallet/navStore'
import { toastError, toastSuccess } from '../wallet/toast'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
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
  total: number,
  integrity: string,
  destination: string,
): Promise<void> {
  const subject = `HandCash key slice ${index + 1} of ${total}`
  const body = [
    `HandCash key slice ${index + 1}/${total}`,
    `Suggested place: ${destination}`,
    `Integrity: ${integrity}`,
    '',
    share,
    '',
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sessionPassword, setSessionPassword] = useState<string | null>(null)
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [rootKey, setRootKey] = useState<string | null>(null)
  const [shareSet, setShareSet] = useState<Brc140ShareSet | null>(null)
  const [rotatePromptOpen, setRotatePromptOpen] = useState(false)
  const [, setStatusTick] = useState(0)

  useEffect(() => subscribeBackupConfirmed(() => setStatusTick((n) => n + 1)), [])

  const revealed = Boolean(mnemonic || rootKey || shareSet)
  const singleSelected = kind === 'phrase' || kind === 'key'
  const canConfirm = canConfirmKeysBackup(kind)
  const splitProgress = getKeysSplitHandoffProgress(shareSet?.threshold ?? 2)

  const clearReveal = () => {
    setMnemonic(null)
    setRootKey(null)
    setShareSet(null)
    setSessionPassword(null)
    setError(null)
  }

  const selectKind = (next: BackupKind) => {
    if (revealed) clearReveal()
    setKind(next)
  }

  const revealWithPassword = async (password: string) => {
    setError(null)
    setBusy(true)
    setMnemonic(null)
    setRootKey(null)
    setShareSet(null)
    try {
      setSessionPassword(password)
      if (kind === 'phrase') {
        if (!hasPhrase) throw new Error('This wallet has no recovery phrase.')
        setMnemonic(await revealMnemonic(password))
      } else if (kind === 'key') {
        setRootKey(await revealRootKeyHex(password))
      } else {
        clearKeysHandoffEvidence()
        const rootKeyHex = await revealRootKeyHex(password)
        setShareSet(
          createBrc140Shares(rootKeyHex, BRC140_DEFAULT_THRESHOLD, BRC140_DEFAULT_TOTAL),
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSessionPassword(null)
      throw err
    } finally {
      setBusy(false)
    }
  }

  const rotateShares = async () => {
    if (!sessionPassword) {
      toastError('Unlock again', 'Confirm your password to rotate slices.')
      return
    }
    setBusy(true)
    setRotatePromptOpen(false)
    try {
      clearKeysHandoffEvidence()
      const rootKeyHex = await revealRootKeyHex(sessionPassword)
      const next = createBrc140Shares(
        rootKeyHex,
        BRC140_DEFAULT_THRESHOLD,
        BRC140_DEFAULT_TOTAL,
      )
      setShareSet(next)
      playWalletSound('soft')
      toastSuccess(
        'New slice set',
        `Integrity ${next.integrity} — old slices from the previous set will not combine with these.`,
      )
    } catch (err) {
      playWalletSound('error')
      toastError('Rotate failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
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
      if (method === 'email') {
        await emailShareToSelf(
          share,
          index,
          shareSet.totalShares,
          shareSet.integrity,
          destination,
        )
        playWalletSound('soft')
        toastSuccess('Opened email', destination)
      } else if (method === 'copy') {
        const ok = await copyText(share, { label: `slice ${index + 1}` })
        if (!ok) return
        toastSuccess('Copied', destination)
      } else {
        downloadShare(
          shareDownloadFilename(index, shareSet.totalShares, shareSet.integrity),
          `# ${destination}\n# integrity ${shareSet.integrity}\n${share}\n`,
        )
        playWalletSound('soft')
        toastSuccess('Slice saved', destination)
      }
      noteKeysBackupHandoff(index)
    } catch (err) {
      playWalletSound('error')
      toastError('Couldn’t save slice', err instanceof Error ? err.message : undefined)
    }
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
          ? 'Hand off at least two different slices (email, copy, or save file).'
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
        Split your key into movable slices, assign each a destination, then hand them off. Prefer
        cloud deposit?{' '}
        <button
          type="button"
          className="settings-inline-link"
          onClick={() => {
            playWalletSound('soft')
            openSetting('trustholder-backup')
          }}
        >
          Cloud key backup
        </button>
        {!hasPhrase ? ' · This wallet has no phrase — use slices or emergency hex.' : null}
      </p>

      <div className="backup-choice-list" role="radiogroup" aria-label="Key backup method">
        <button
          type="button"
          role="radio"
          aria-checked={kind === 'split'}
          className="backup-choice"
          data-aeon-state={kind === 'split' ? 'selected' : 'idle'}
          onClick={() => selectKind('split')}
        >
          <span className="backup-choice-title">
            Key slices
            <span className="backup-choice-badge">Recommended</span>
          </span>
          <span className="backup-choice-desc">
            {BRC140_DEFAULT_THRESHOLD}-of-{BRC140_DEFAULT_TOTAL} · cycle destinations · rotate anytime
          </span>
        </button>

        <div
          className="backup-choice backup-choice-group"
          data-aeon-state={singleSelected ? 'selected' : 'idle'}
        >
          <button
            type="button"
            className="backup-choice-group-head"
            onClick={() => selectKind(hasPhrase ? 'phrase' : 'key')}
          >
            <span className="backup-choice-title">Single secret</span>
            <span className="backup-choice-desc">Less flexible · one secret unlocks everything</span>
          </button>
          <div className="backup-subchoice-list" role="group" aria-label="Single secret options">
            <button
              type="button"
              role="radio"
              aria-checked={kind === 'phrase'}
              className="backup-subchoice"
              data-aeon-state={kind === 'phrase' ? 'selected' : 'idle'}
              disabled={!hasPhrase}
              onClick={() => selectKind('phrase')}
            >
              <span className="backup-choice-title">Phrase</span>
              <span className="backup-choice-desc">
                {hasPhrase ? '12 words' : 'Not on this wallet'}
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kind === 'key'}
              className="backup-subchoice"
              data-aeon-state={kind === 'key' ? 'selected' : 'idle'}
              onClick={() => selectKind('key')}
            >
              <span className="backup-choice-title">Key</span>
              <span className="backup-choice-desc">Emergency hex</span>
            </button>
          </div>
        </div>
      </div>

      {!revealed ? (
        <ConfirmPasswordGate
          key={kind}
          id="wallet-backup-password"
          title="Confirm it’s you"
          lede="Enter your unlock password to reveal recovery material on this device."
          actionLabel={
            busy
              ? 'Unlocking…'
              : kind === 'split'
                ? 'Show slices'
                : kind === 'phrase'
                  ? 'Show phrase'
                  : 'Show key'
          }
          onVerified={revealWithPassword}
        />
      ) : null}

      {error && !revealed ? (
        <p className="error" role="alert">
          {error}
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
            savedIndices={splitProgress.savedIndices}
            onHandoff={handoff}
            onRotateShares={() => setRotatePromptOpen(true)}
            rotateBusy={busy}
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

      <Prompt.Root
        open={rotatePromptOpen}
        status={rotatePromptOpen ? 'pending' : 'dismissed'}
        onOpenChange={(open) => {
          if (!open) setRotatePromptOpen(false)
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            <Prompt.Content className="panel modal permission-modal">
              <Prompt.Title>Rotate all slices?</Prompt.Title>
              <Prompt.Description>
                This creates a brand-new {BRC140_DEFAULT_THRESHOLD}-of-{BRC140_DEFAULT_TOTAL} set
                with a new integrity tag. Slices from the previous set will not combine with these —
                deposit or save the new ones before discarding the old.
              </Prompt.Description>
              <Prompt.Actions className="actions">
                <Prompt.Secondary
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setRotatePromptOpen(false)
                    playWalletSound('soft')
                  }}
                >
                  Keep current
                </Prompt.Secondary>
                <Prompt.Primary
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void rotateShares()}
                >
                  Rotate
                </Prompt.Primary>
              </Prompt.Actions>
            </Prompt.Content>
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>

      <SettingsFeatureAbout tags={['BRC-140', 'BRC-75']}>
        Cycle destinations so each slice lives somewhere different. Rotate when a place is
        compromised — never mix integrity tags across sets.
      </SettingsFeatureAbout>
    </div>
  )
}
