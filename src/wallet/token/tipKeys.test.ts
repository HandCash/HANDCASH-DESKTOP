import { P2PKH, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import type { ActiveWallet } from '../session'
import { colorPrivateKey, readDeliveryRemittance } from '../colorKeys'
import { encodeBsv21Binary } from './decode162'
import {
  ownsTokenLock,
  peerColorOutput,
  planColorOutputs,
  primeTipKeys,
  rememberTipKey,
  selfColorOutput,
  tipSigningKey,
} from './tipKeys'

const TOKEN = `${'ab'.repeat(32)}_0`

function walletOf(root: PrivateKey, rows: { customInstructions?: string }[] = []): ActiveWallet {
  return {
    rootKeyHex: root.toHex(),
    identityKey: root.toPublicKey().toString(),
    address: root.toAddress(),
    wallet: { listOutputs: async () => ({ outputs: rows, totalOutputs: rows.length }) },
  } as unknown as ActiveWallet
}

function tokenLock(address: string): string {
  return encodeBsv21Binary({ tokenId: TOKEN, amount: 10n, rest: new P2PKH().lock(address) }).toHex()
}

const alice = PrivateKey.fromHex('11'.repeat(32))
const bob = PrivateKey.fromHex('22'.repeat(32))

describe('p color tip keys', () => {
  it('rebuilds a self child from its remittance', () => {
    const out = selfColorOutput(walletOf(alice), TOKEN)
    expect(out.remittance.senderIdentityKey).toBe(alice.toPublicKey().toString())
    expect(colorPrivateKey(alice, TOKEN, out.remittance).toHex()).toBe(out.key.toHex())
    expect(out.address).not.toBe(alice.toAddress())
  })

  it('pays a peer child only that peer can derive', () => {
    const out = peerColorOutput(walletOf(alice), TOKEN, bob.toPublicKey().toString())
    expect(colorPrivateKey(bob, TOKEN, out.remittance).toAddress()).toBe(out.address)
    expect(colorPrivateKey(alice, TOKEN, out.remittance).toAddress()).not.toBe(out.address)
  })

  it('plans one prefix per transfer and keeps a bare address when no peer key is known', () => {
    const delivered = planColorOutputs({
      wallet: walletOf(alice),
      tokenId: TOKEN,
      payeeIsSelf: false,
      peerKey: bob.toPublicKey().toString(),
      hasChange: true,
    })
    expect(delivered.payee?.remittance.derivationPrefix).toBe(delivered.change?.remittance.derivationPrefix)
    expect(delivered.payee?.remittance.derivationSuffix).not.toBe(delivered.change?.remittance.derivationSuffix)
    expect(delivered.held.map((k) => k.toAddress())).toEqual([delivered.change?.address])

    const bare = planColorOutputs({ wallet: walletOf(alice), tokenId: TOKEN, payeeIsSelf: false, peerKey: null, hasChange: false })
    expect(bare).toEqual({ payee: null, change: null, held: [] })

    const self = planColorOutputs({ wallet: walletOf(alice), tokenId: TOKEN, payeeIsSelf: true, peerKey: null, hasChange: true })
    expect(self.held).toHaveLength(2)
  })

  it('signs identity locks with the root key and derived locks with their child', async () => {
    const wallet = walletOf(alice)
    expect((await tipSigningKey(wallet, tokenLock(alice.toAddress()))).toHex()).toBe(alice.toHex())
    const child = selfColorOutput(wallet, TOKEN)
    rememberTipKey(wallet, child.key)
    expect((await tipSigningKey(wallet, tokenLock(child.address))).toHex()).toBe(child.key.toHex())
    expect(ownsTokenLock(wallet, tokenLock(child.address))).toBe(true)
    expect(ownsTokenLock(wallet, tokenLock(bob.toAddress()))).toBe(false)
  })

  it('finds a derived key from the filings when the cache has not seen it', async () => {
    const child = selfColorOutput(walletOf(alice), TOKEN)
    const wallet = walletOf(alice, [{ customInstructions: JSON.stringify({ id: TOKEN, ...child.remittance }) }])
    // A different identity resets the cache, so the first lookup for alice starts cold.
    ownsTokenLock(walletOf(bob), undefined)
    expect(ownsTokenLock(wallet, tokenLock(child.address))).toBe(false)
    expect((await tipSigningKey(wallet, tokenLock(child.address))).toHex()).toBe(child.key.toHex())
    ownsTokenLock(walletOf(bob), undefined)
    await primeTipKeys(wallet)
    expect(ownsTokenLock(wallet, tokenLock(child.address))).toBe(true)
  })
})

describe('readDeliveryRemittance', () => {
  const sender = alice.toPublicKey().toString()

  it('keys each well-formed output by vout and drops the rest', () => {
    const rows = readDeliveryRemittance({
      senderIdentityKey: sender,
      outputs: [
        { vout: 0, derivationPrefix: 'p', derivationSuffix: 's0' },
        { vout: -1, derivationPrefix: 'p', derivationSuffix: 's1' },
        { vout: 2, derivationPrefix: 'has space', derivationSuffix: 's2' },
        { vout: 3, derivationPrefix: 'p', derivationSuffix: 's3' },
      ],
    })
    expect([...rows.keys()]).toEqual([0, 3])
    expect(rows.get(3)).toEqual({ derivationPrefix: 'p', derivationSuffix: 's3', senderIdentityKey: sender })
  })

  it('reads nothing without a valid sender', () => {
    expect(readDeliveryRemittance({ senderIdentityKey: 'nope', outputs: [{ vout: 0, derivationPrefix: 'p', derivationSuffix: 's' }] }).size).toBe(0)
    expect(readDeliveryRemittance(null).size).toBe(0)
  })
})
