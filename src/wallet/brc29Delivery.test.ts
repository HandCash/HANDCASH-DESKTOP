import { describe, expect, it } from 'vitest'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import {
  brc29PrivateKey,
  heldP2pkhSigningKey,
  remittanceFromInstructions,
  remittanceFromTags,
  remittanceTag,
  selfP2pkhOutput,
  type Remittance,
} from './brc29Keys'
import { heldItemRow, itemDeliveryRemittance, planItemRecipientKey } from './itemRecipientKey'
import { lockHolder } from './token/tipKeys'
import { shouldRejectSendForMissingLiveTip } from './collectableOwnership'
import { settlementReceiptPreimage, type MarketSettlementReceipt } from './marketListing'
import type { ActiveWallet } from './session'

function wallet(): ActiveWallet & { root: PrivateKey } {
  const root = PrivateKey.fromRandom()
  return {
    root,
    rootKeyHex: root.toHex(),
    identityKey: root.toPublicKey().toString(),
    address: root.toAddress(),
    chain: 'main',
  } as unknown as ActiveWallet & { root: PrivateKey }
}

const lockOf = (address: string) => new P2PKH().lock(address).toHex()

describe('BRC-29 remittance tags', () => {
  it('round-trips through the lower-casing toolbox tag store', () => {
    const remittance: Remittance = {
      derivationPrefix: 'AbC+/=',
      derivationSuffix: 'XyZ09',
      senderIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    }
    const tag = remittanceTag(remittance)!
    expect(tag).toBe(tag.toLowerCase())
    expect(remittanceFromTags(['ordinal', tag.toLowerCase()])).toEqual(remittance)
    expect(remittanceFromTags(['ordinal'])).toBeNull()
  })

  it('omits the tag rather than truncating a remittance too long for one', () => {
    const remittance: Remittance = {
      derivationPrefix: 'p'.repeat(128),
      derivationSuffix: 's'.repeat(128),
      senderIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    }
    expect(remittanceTag(remittance)).toBeNull()
  })
})

describe('held P2PKH rows (pads, fee coins, anchors)', () => {
  it('a fresh row sits on a BRC-29 child it records twice, never the identity address', () => {
    const active = wallet()
    const row = selfP2pkhOutput(active, ['market-pad'])
    expect(row.lockingScript).not.toBe(lockOf(active.address))
    expect(row.tags[0]).toBe('market-pad')
    const fromTag = remittanceFromTags(row.tags)!
    expect(remittanceFromInstructions(row.customInstructions)).toEqual(fromTag)
    expect(lockOf(brc29PrivateKey(active.root, fromTag).toAddress())).toBe(row.lockingScript)
  })

  it('signs a child row with its child, an identity-address row with the root, and nothing else', () => {
    const active = wallet()
    const row = selfP2pkhOutput(active, [])
    const child = heldP2pkhSigningKey(active, row)!
    expect(lockOf(child.toAddress())).toBe(row.lockingScript)
    expect(child.toHex()).not.toBe(active.root.toHex())

    const fromInstructionsOnly = heldP2pkhSigningKey(active, { ...row, tags: [] })!
    expect(fromInstructionsOnly.toHex()).toBe(child.toHex())

    expect(heldP2pkhSigningKey(active, { lockingScript: lockOf(active.address) })!.toHex()).toBe(active.root.toHex())
    expect(heldP2pkhSigningKey(active, { lockingScript: lockOf(PrivateKey.fromRandom().toAddress()) })).toBeNull()
    expect(heldP2pkhSigningKey(active, { ...row, lockingScript: lockOf(PrivateKey.fromRandom().toAddress()) })).toBeNull()
  })
})

describe('item recipient keys', () => {
  it('pays a peer identity at a BRC-29 child only that peer can derive from the envelope remittance', () => {
    const sender = wallet()
    const peer = wallet()
    const key = planItemRecipientKey(sender, { kind: 'identity', identityKey: peer.identityKey })
    expect(key.kind).toBe('peer')
    if (key.kind !== 'peer') return
    expect(key.address).not.toBe(peer.address)

    const delivery = itemDeliveryRemittance(sender.identityKey, [{ vout: 0, key }])!
    expect(delivery.outputs).toEqual([
      { vout: 0, derivationPrefix: key.remittance.derivationPrefix, derivationSuffix: key.remittance.derivationSuffix },
    ])
    const derivedByPeer = brc29PrivateKey(peer.root, {
      derivationPrefix: delivery.outputs[0]!.derivationPrefix,
      derivationSuffix: delivery.outputs[0]!.derivationSuffix,
      senderIdentityKey: delivery.senderIdentityKey,
    })
    expect(derivedByPeer.toAddress()).toBe(key.address)
  })

  it('keeps a self send on a remembered self child and a bare address as given', () => {
    const active = wallet()
    const self = planItemRecipientKey(active, { kind: 'identity', identityKey: active.identityKey })
    expect(self.kind).toBe('self')
    expect(self.address).not.toBe(active.address)
    expect(lockHolder(active, lockOf(self.address))).toBe('derived')
    expect(itemDeliveryRemittance(active.identityKey, [{ vout: 0, key: self }])).toBeUndefined()

    const elsewhere = PrivateKey.fromRandom().toAddress()
    expect(planItemRecipientKey(active, { kind: 'address', address: elsewhere })).toEqual({
      kind: 'address',
      address: elsewhere,
    })
  })

  it('prefers a known identity over the address it resolved to', () => {
    const sender = wallet()
    const peer = wallet()
    const key = planItemRecipientKey(sender, { kind: 'address', address: peer.address }, {
      recipientIdentityKey: peer.identityKey,
    })
    expect(key.kind).toBe('peer')
  })

  it('writes the remittance into both customInstructions and a single brc29 tag', () => {
    const active = wallet()
    const self = planItemRecipientKey(active, { kind: 'identity', identityKey: active.identityKey })
    if (self.kind !== 'self') throw new Error('expected self')
    const row = heldItemRow({ customInstructions: '{"origin":"x"}', tags: ['ordinal', 'brc29:stale'] }, self.remittance)
    expect(JSON.parse(row.customInstructions)).toMatchObject({ origin: 'x', ...self.remittance })
    expect(row.tags.filter((t) => t.startsWith('brc29:'))).toHaveLength(1)
    expect(remittanceFromTags(row.tags)).toEqual(self.remittance)
  })
})

describe('ownership of BRC-29 tips', () => {
  it('classifies identity-address, derived and foreign locks', () => {
    const active = wallet()
    expect(lockHolder(active, lockOf(active.address))).toBe('address')
    expect(lockHolder(active, lockOf(PrivateKey.fromRandom().toAddress()))).toBe('other')
    expect(lockHolder(active, null)).toBe('unknown')
  })

  it('never rejects a send because a derived tip is missing from the address scan', () => {
    const base = {
      outpoint: `${'a'.repeat(64)}.0`,
      inLiveSet: false,
      firstSeenAt: 0,
      liveScanAt: 10_000_000,
      now: 20_000_000,
      lockingScriptHex: lockOf(PrivateKey.fromRandom().toAddress()),
    }
    expect(shouldRejectSendForMissingLiveTip({ ...base, holder: 'derived' })).toBe(false)
  })
})

describe('settlement receipt buyer address', () => {
  const receipt: Omit<MarketSettlementReceipt, 'signature'> = {
    receiptId: 'e'.repeat(32),
    intentId: 'd'.repeat(32),
    outpoint: `${'a'.repeat(64)}_0`,
    buyer: PrivateKey.fromRandom().toPublicKey().toString(),
    seller: PrivateKey.fromRandom().toPublicKey().toString(),
    settlementTxid: 'f'.repeat(64),
    sellerOutputIndex: 1,
    feeOutputIndex: 2,
    settledAt: 1,
  }

  it('signs the buyer child address as a last line, and leaves older receipts unchanged', () => {
    const child = PrivateKey.fromRandom().toAddress()
    const legacy = settlementReceiptPreimage(receipt)
    expect(settlementReceiptPreimage({ ...receipt, buyerAddress: child })).toBe(`${legacy}\n${child}`)
    expect(legacy.split('\n')).toHaveLength(10)
  })
})
