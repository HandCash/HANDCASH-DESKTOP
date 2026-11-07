import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveWallet } from './session'
import { captureSigningIntent } from './signingIntent'
import { disposeWalletRuntime, installWalletRuntime, resetWalletRuntimeForTests } from './walletRuntime'

const holding = vi.hoisted(() => ({ refusal: null as string | null }))
vi.mock('./vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => holding.refusal }))

const account = { identityKey: 'account-a', accountIndex: 0, chain: 'main' } as ActiveWallet

beforeEach(() => {
  resetWalletRuntimeForTests()
  holding.refusal = null
})

describe('signing intent runtime fence', () => {
  it('refuses capture while locked', () => {
    expect(captureSigningIntent).toThrow('WALLET_LOCKED')
  })

  it('captures the account without moving it and checks holding only at the signing boundary', () => {
    installWalletRuntime(account)
    holding.refusal = 'held elsewhere'
    const intent = captureSigningIntent()
    expect(intent.account).toBe(account)
    expect(intent.assertCurrent).not.toThrow()
    expect(intent.assertHeld).toThrow('held elsewhere')
    holding.refusal = null
    expect(intent.assertHeld).not.toThrow()
  })

  it('rejects after lock', () => {
    installWalletRuntime(account)
    const intent = captureSigningIntent()
    disposeWalletRuntime('locked')
    expect(intent.assertCurrent).toThrow('Wallet runtime disposed')
    expect(intent.assertHeld).toThrow('Wallet runtime disposed')
  })

  it('rejects after the same account is reopened', () => {
    installWalletRuntime(account)
    const intent = captureSigningIntent()
    installWalletRuntime(account)
    expect(intent.assertHeld).toThrow('Wallet runtime disposed')
  })

  it('rejects after switching identities', () => {
    installWalletRuntime(account)
    const intent = captureSigningIntent()
    installWalletRuntime({ ...account, identityKey: 'account-b', accountIndex: 1 })
    expect(intent.assertHeld).toThrow('Wallet runtime disposed')
  })
})
