import { stateToAttr } from '@aeon-ui/core'
import { Button, StatusBanner } from '@aeon-ui/react'
import { useMachine } from '@xstate/react'
import { useEffect, useRef, useState } from 'react'
import { emailRecoveryMachine } from '../machines/emailRecoveryMachine'
import { fetchBrc250Manifest, googleEmailOf, verifiedGoogleProof } from '../wallet/brc250/api'
import {
  beginNewDeviceGoogleLogin,
  finishGoogleLoginProof,
  openApprovedVault,
  pollNewDeviceLogin,
  recoverDelayedVault,
  requestDelayedRecoveryShare,
  revealNewDeviceCode,
  type NewDeviceLogin,
  type VaultTransfer,
} from '../wallet/brc250/login'
import type { EmailRecoveryEnrollment } from '../wallet/brc250/types'
import type { VaultMaster } from '../wallet/vaultMaster'

export type GoogleRecoveredVault = {
  master: VaultMaster
  enrollment: EmailRecoveryEnrollment
  accounts?: VaultTransfer['accounts']
  recoveryKind: 'approved-device' | 'delayed-recovery'
}

type Props = {
  onRecovered: (vault: GoogleRecoveredVault) => void
  onCancel: () => void
}

async function openSystemUrl(url: string): Promise<void> {
  if (window.handcash?.openExternal) return window.handcash.openExternal(url)
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function GoogleLoginPanel({ onRecovered, onCancel }: Props) {
  const [snapshot, send] = useMachine(emailRecoveryMachine)
  const login = useRef<NewDeviceLogin | null>(null)
  const recovery = useRef<Awaited<ReturnType<typeof requestDelayedRecoveryShare>> | null>(null)
  const googleEmail = useRef('')
  const [mailboxCopy, setMailboxCopy] = useState('')

  const start = async () => {
    send({ type: 'LOGIN' })
    try {
      const next = await beginNewDeviceGoogleLogin()
      login.current = next
      await openSystemUrl(next.attempt.openUrl)
      send({ type: 'BROWSER_OPENED' })
    } catch (error) {
      send({ type: 'FAIL', message: messageOf(error) })
    }
  }

  useEffect(() => {
    if (!snapshot.matches({ login: 'waitingForGoogle' })) return
    let cancelled = false
    const poll = async () => {
      const active = login.current
      if (!active) return
      try {
        const proof = await verifiedGoogleProof(active.attempt.binding, active.host, {
          loginKey: active.key.toPublicKey().toString(),
          commitment: active.commitment,
          purpose: 'login',
        })
        if (!proof || cancelled) return
        googleEmail.current = googleEmailOf(proof.idToken)
        const started = await finishGoogleLoginProof(active)
        if (!started || cancelled) return
        if (started.recentDevices.length > 0) {
          send({ type: 'DEVICE_FOUND' })
        } else if (started.releaseAt) {
          send({ type: 'WAIT_FOR_RECOVERY', releaseAt: started.releaseAt })
        } else {
          throw new Error('Recovery host returned no device or delayed-recovery path')
        }
      } catch (error) {
        if (!cancelled) send({ type: 'FAIL', message: messageOf(error) })
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [snapshot.value, send])

  useEffect(() => {
    const polling =
      snapshot.matches({ login: 'waitingForChallenge' }) ||
      snapshot.matches({ login: 'comparing' })
    if (!polling) return
    let cancelled = false
    let revealed = snapshot.matches({ login: 'comparing' })
    const poll = async () => {
      const active = login.current
      if (!active) return
      try {
        const status = await pollNewDeviceLogin(active)
        if (cancelled) return
        if (status.state === 'refused') throw new Error('The existing device refused this login')
        if (status.state === 'challenged' && status.rB && !revealed) {
          revealed = true
          const code = await revealNewDeviceCode(active, status)
          send({ type: 'DEVICE_CHALLENGED', code })
          return
        }
        if (status.state === 'sent' && status.sealedVault) {
          const transfer = openApprovedVault(active, status.sealedVault)
          if (!transfer.enrollment) throw new Error('Approved vault omitted recovery metadata')
          send({ type: 'DEVICE_APPROVED' })
          send({ type: 'RESTORED' })
          onRecovered({
            master: transfer.master,
            enrollment: transfer.enrollment,
            accounts: transfer.accounts,
            recoveryKind: 'approved-device',
          })
        }
      } catch (error) {
        if (!cancelled) send({ type: 'FAIL', message: messageOf(error) })
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [snapshot.value, send, onRecovered])

  useEffect(() => {
    if (!snapshot.matches({ login: 'delayedRecovery' })) return
    const releaseAt = snapshot.context.releaseAt
    if (!releaseAt) return
    let cancelled = false
    const release = async () => {
      if (Date.now() < releaseAt || !login.current) return
      try {
        recovery.current = await requestDelayedRecoveryShare(login.current)
        if (!cancelled) send({ type: 'RECOVERY_RELEASED' })
      } catch (error) {
        if (!cancelled) send({ type: 'FAIL', message: messageOf(error) })
      }
    }
    void release()
    const timer = window.setInterval(() => void release(), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [snapshot.value, snapshot.context.releaseAt, send])

  const restoreDelayed = async () => {
    const active = login.current
    const released = recovery.current
    if (!active || !released || !mailboxCopy.trim()) return
    try {
      const keyHex = recoverDelayedVault(released.hostShare, mailboxCopy)
      const manifest = await fetchBrc250Manifest(active.host)
      const master: VaultMaster =
        released.master.derivation === 'brc-157'
          ? {
              derivation: 'brc-157',
              keyHex,
              entropyLength: released.master.entropyLength,
            }
          : { derivation: 'brc-42', keyHex }
      if (!active.start) throw new Error('Recovery login was not started')
      send({ type: 'CONFIRM_MAILBOX' })
      onRecovered({
        master,
        enrollment: {
          v: 1,
          host: active.host,
          email: googleEmail.current,
          authorityKey: active.start.authorityKey,
          attesterKey: manifest.attesterKey,
          master: released.master,
          mailboxConfirmed: true,
          enrolledAt: Date.now(),
        },
        recoveryKind: 'delayed-recovery',
      })
      send({ type: 'RESTORED' })
    } catch (error) {
      send({ type: 'FAIL', message: messageOf(error) })
    }
  }

  return (
    <div
      data-aeon-scope="google-login"
      data-aeon-state={stateToAttr(snapshot.value)}
      className="wallet-setup-config"
    >
      {snapshot.matches('idle') ? (
        <>
          <h2>Continue with Google</h2>
          <p className="auth-lede">
            Choose the Google account already registered to this vault. HandCash never asks you
            to type the email address.
          </p>
          <div className="actions">
            <Button.Root className="btn btn-primary" onClick={() => void start()}>
              Open Google
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={onCancel}>
              Back
            </Button.Root>
          </div>
        </>
      ) : null}

      {snapshot.matches({ login: 'openingBrowser' }) ||
      snapshot.matches({ login: 'waitingForGoogle' }) ? (
        <StatusBanner.Root tone="info" status="google">
          <StatusBanner.Copy>
            <StatusBanner.Title>Finish in your browser</StatusBanner.Title>
            <StatusBanner.Body>Choose your Google account, then return to HandCash.</StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      {snapshot.matches({ login: 'waitingForChallenge' }) ? (
        <StatusBanner.Root tone="info" status="device">
          <StatusBanner.Copy>
            <StatusBanner.Title>Check your existing device</StatusBanner.Title>
            <StatusBanner.Body>
              HandCash sent a device approval request. No password or email link is needed.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      {snapshot.matches({ login: 'comparing' }) ? (
        <div className="split-backup-shares">
          <h3>Compare this code</h3>
          <p data-aeon-part="comparison-code">{snapshot.context.comparisonCode}</p>
          <p className="settings-hint">
            Approve only if the existing device shows the same eight digits.
          </p>
        </div>
      ) : null}

      {snapshot.matches({ login: 'delayedRecovery' }) ? (
        <StatusBanner.Root tone="warning" status="delay">
          <StatusBanner.Copy>
            <StatusBanner.Title>No registered device is online</StatusBanner.Title>
            <StatusBanner.Body>
              Recovery unlocks after seven days. Any registered device that returns cancels it.
              Ready {snapshot.context.releaseAt ? new Date(snapshot.context.releaseAt).toLocaleString() : 'later'}.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      {snapshot.matches({ login: 'awaitingMailbox' }) ? (
        <>
          <h3>Paste the share from your recovery email</h3>
          <textarea
            className="input"
            rows={4}
            value={mailboxCopy}
            onChange={(event) => setMailboxCopy(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button.Root
            className="btn btn-primary"
            disabled={!mailboxCopy.trim()}
            onClick={() => void restoreDelayed()}
          >
            Restore vault
          </Button.Root>
        </>
      ) : null}

      {snapshot.matches({ login: 'restoring' }) ? (
        <StatusBanner.Root tone="info" status="restoring">
          <StatusBanner.Copy>
            <StatusBanner.Title>Restoring your vault…</StatusBanner.Title>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      {snapshot.matches('failed') ? (
        <StatusBanner.Root tone="danger" status="failed">
          <StatusBanner.Copy>
            <StatusBanner.Title>Google login stopped</StatusBanner.Title>
            <StatusBanner.Body>{snapshot.context.error}</StatusBanner.Body>
          </StatusBanner.Copy>
          <StatusBanner.Action onClick={() => void start()}>Try again</StatusBanner.Action>
        </StatusBanner.Root>
      ) : null}
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
