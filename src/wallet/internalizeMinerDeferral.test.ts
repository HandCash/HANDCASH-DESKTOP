import { describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import type { Services, Wallet } from '@bsv/wallet-toolbox-client'
import {
  directPostBeef,
  installInternalizeMinerDeferral,
  internalizeSubject,
  isInternalizeMinerDeferred,
} from './internalizeMinerDeferral'

async function atomicFixture(): Promise<{ txid: string; atomic: number[] }> {
  const key = PrivateKey.fromRandom()
  const parent = new Transaction()
  parent.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 1_000 })
  const child = new Transaction()
  child.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  child.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 900 })
  await child.sign()
  const txid = child.id('hex')
  return { txid, atomic: Array.from(child.toAtomicBEEF()) }
}

function harness() {
  const original = vi.fn(async (_beef: Beef, txids: string[]) => [
    { name: 'ArcadeBeef', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) },
  ])
  const services = { postBeef: original } as unknown as Services
  // Mirrors the toolbox: a new txid posts in-line and refuses on a miss.
  const wallet = {
    async internalizeAction(args: { tx: number[] }) {
      const txid = Transaction.fromAtomicBEEF(Uint8Array.from(args.tx)).id('hex')
      const results = await services.postBeef(Beef.fromBinary(args.tx), [txid])
      const ok = results.some((r) => r.txidResults?.some((t) => t.status === 'success'))
      if (!ok) throw new Error('provider miss refused the payment')
      return { accepted: true, txid }
    },
  } as unknown as Wallet
  const broadcast = vi.fn(async () => true)
  installInternalizeMinerDeferral(wallet, services, broadcast)
  return { services, wallet, original, broadcast }
}

describe('internalizeMinerDeferral', () => {
  it('credits from the BEEF and posts to miners after the reply', async () => {
    const { services, wallet, original, broadcast } = harness()
    const { txid, atomic } = await atomicFixture()
    original.mockImplementationOnce(async () => {
      throw new Error('Arcade is down')
    })

    const result = await wallet.internalizeAction({ tx: atomic, description: 'x', outputs: [] } as never)

    expect(result).toMatchObject({ accepted: true, txid })
    expect(original).not.toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith(txid, atomic)
    expect(isInternalizeMinerDeferred(services, txid)).toBe(false)
  })

  it('does not intercept miner rounds for other subjects', async () => {
    const { services, original } = harness()
    const { txid, atomic } = await atomicFixture()
    await services.postBeef(Beef.fromBinary(atomic), [txid])
    expect(original).toHaveBeenCalledTimes(1)
  })

  it("keeps the wallet's own miner submit on the configured service", async () => {
    const { services, wallet, original } = harness()
    const { txid, atomic } = await atomicFixture()
    let sawDirect = false
    original.mockImplementation(async (_beef, txids) => {
      sawDirect = true
      return [{ name: 'ArcadeBeef', status: 'success', txidResults: txids.map((t) => ({ txid: t, status: 'success' })) }]
    })
    const inFlight = wallet.internalizeAction({ tx: atomic, description: 'x', outputs: [] } as never)
    // Same subject, wallet-owned round: must reach the miner even mid-internalize.
    await directPostBeef(services)(Beef.fromBinary(atomic), [txid])
    await inFlight
    expect(sawDirect).toBe(true)
  })

  it('passes malformed requests straight through', async () => {
    const { wallet, broadcast } = harness()
    await expect(wallet.internalizeAction({ tx: [1, 2, 3] } as never)).rejects.toThrow()
    expect(broadcast).not.toHaveBeenCalled()
    expect(internalizeSubject({ tx: 'nope' })).toBeNull()
  })

  it('installs once per services instance', () => {
    const { services, wallet } = harness()
    const before = services.postBeef
    installInternalizeMinerDeferral(wallet, services)
    expect(services.postBeef).toBe(before)
  })
})
