import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { unlockMachine } from '../machines/unlockMachine'
import { createVault, unlockVault, type Chain } from '../wallet/vault'
import { bootWallet, fetchBalanceSats } from '../wallet/session'
import type { WalletProfile } from '../machines/appMachine'

type Props = {
  mode: 'onboarding' | 'locked'
  error: string | null
  onCreated: (profile: WalletProfile, balanceSats: number) => void
  onUnlocked: (profile: WalletProfile, balanceSats: number) => void
  onFail: (error: string) => void
}

export function AuthScreen({ mode, error, onCreated, onUnlocked, onFail }: Props) {
  const [snapshot, send] = useMachine(unlockMachine)
  const chain: Chain = 'main'
  const stateAttr = stateToAttr(snapshot.value)

  const submit = async () => {
    if (snapshot.context.password.length < 8) {
      onFail('Password must be at least 8 characters')
      return
    }
    const password = snapshot.context.password
    send({ type: 'SUBMIT' })
    try {
      if (mode === 'onboarding') {
        const { rootKeyHex, record } = await createVault({
          password,
          chain,
        })
        const active = await bootWallet({
          rootKeyHex,
          handle: record.handle,
          chain: record.chain,
        })
        const balanceSats = await fetchBalanceSats(active.wallet)
        send({ type: 'SUCCESS' })
        onCreated(
          {
            handle: record.handle,
            identityKey: record.identityKey,
            address: record.address,
            chain: record.chain,
          },
          balanceSats,
        )
      } else {
        const { rootKeyHex, record } = await unlockVault(password)
        const active = await bootWallet({
          rootKeyHex,
          handle: record.handle,
          chain: record.chain,
        })
        const balanceSats = await fetchBalanceSats(active.wallet)
        send({ type: 'SUCCESS' })
        onUnlocked(
          {
            handle: record.handle,
            identityKey: record.identityKey,
            address: record.address,
            chain: record.chain,
          },
          balanceSats,
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'FAIL', error: message })
      onFail(message)
    }
  }

  return (
    <section className="hero-panel" data-aeon-scope="auth" data-aeon-state={stateAttr}>
      <div>
        <p className="brand-sub" style={{ marginBottom: 10 }}>
          {mode === 'onboarding' ? 'Create your wallet' : 'Welcome back'}
        </p>
        <h1 className="display">{mode === 'onboarding' ? 'Own your cash.' : 'Unlock HandCash.'}</h1>
        <p className="lede" style={{ marginTop: 14 }}>
          {mode === 'onboarding'
            ? 'Your money stays on this device. Approve apps when they ask to connect.'
            : 'Enter your password to open your wallet on this device.'}
        </p>
      </div>

      <div className="panel" data-aeon-part="form">
        <div className="field" data-aeon-part="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            placeholder="At least 8 characters"
            value={snapshot.context.password}
            onChange={(e) => send({ type: 'CHANGE', password: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            autoComplete={mode === 'onboarding' ? 'new-password' : 'current-password'}
          />
        </div>

        {(error || snapshot.context.error) && (
          <p className="error" role="alert">
            {error || snapshot.context.error}
          </p>
        )}

        <div className="actions">
          <button
            className="btn btn-primary"
            data-aeon-part="trigger"
            data-aeon-state={stateAttr}
            disabled={snapshot.matches('submitting')}
            onClick={() => void submit()}
          >
            {snapshot.matches('submitting')
              ? 'Working…'
              : mode === 'onboarding'
                ? 'Create wallet'
                : 'Unlock'}
          </button>
        </div>
      </div>
    </section>
  )
}
