import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { BRC29_PROTOCOL } from '../brc29Keys'
import { pubkeyHashHex } from './script'
import {
  deliveryOutputsFor,
  deliveryOutputsFromEntries,
  heldHolderKey,
  holderKeyAsset,
  holderKeyScheme,
  holderPkhFor,
  holderPrivateKey,
  planHolderRemittance,
  provenRecipientPkh,
  readRecipientEntries,
  recipientEntries,
  type HolderRemittance,
} from './holderKeys'

const ASSET = `${'cd'.repeat(32)}_0`
const sender = PrivateKey.fromHex('11'.repeat(32))
const recipient = PrivateKey.fromHex('22'.repeat(32))
const acceptor = PrivateKey.fromHex('33'.repeat(32))
const pub = (k: PrivateKey) => k.toPublicKey().toString()
const pkh = (k: PrivateKey) => pubkeyHashHex(pub(k))

describe('countersigned holder keys', () => {
  const remittance = planHolderRemittance([
    { vout: 0, identityKey: pub(recipient) },
    { vout: 1, identityKey: pub(sender) },
  ])

  it('plans BRC-29 keys', () => {
    expect(holderKeyScheme(remittance)).toBe('brc29')
  })

  it('locks each output to the BRC-29 child any BRC-100 wallet of its holder derives', () => {
    const [payee, change] = remittance.outputs
    const payeePkh = holderPkhFor(sender, ASSET, remittance, payee!)
    expect(payeePkh).not.toBe(pkh(recipient))
    const viaWallet = new KeyDeriver(recipient).derivePrivateKey(
      BRC29_PROTOCOL,
      `${remittance.prefix} ${payee!.derivationSuffix}`,
      pub(sender),
    )
    expect(pubkeyHashHex(pub(viaWallet))).toBe(payeePkh)
    const [row] = deliveryOutputsFor(remittance, pub(recipient))
    const key = holderPrivateKey(recipient, ASSET, { ...row!, senderIdentityKey: pub(sender) }, 'brc29')
    expect(pubkeyHashHex(pub(key))).toBe(payeePkh)
    const own = holderPrivateKey(
      sender,
      ASSET,
      { derivationPrefix: remittance.prefix, derivationSuffix: change!.derivationSuffix, senderIdentityKey: pub(sender) },
      'brc29',
    )
    expect(pubkeyHashHex(pub(own))).toBe(holderPkhFor(sender, ASSET, remittance, change!))
  })

  it('still finds the key of an output an earlier release held under p color', () => {
    const legacy: HolderRemittance = { prefix: remittance.prefix, outputs: remittance.outputs }
    expect(holderKeyScheme(legacy)).toBe('legacy-color')
    const legacyPkh = holderPkhFor(sender, ASSET, legacy, legacy.outputs[0]!)
    expect(legacyPkh).not.toBe(holderPkhFor(sender, ASSET, remittance, remittance.outputs[0]!))
    const row = { derivationPrefix: legacy.prefix, derivationSuffix: legacy.outputs[0]!.derivationSuffix, senderIdentityKey: pub(sender) }
    expect(pubkeyHashHex(pub(heldHolderKey(recipient, ASSET, row, legacyPkh)!))).toBe(legacyPkh)
    expect(heldHolderKey(recipient, ASSET, row, pkh(acceptor))).toBeNull()
  })

  it('proves each holder to the acceptor it was encrypted for, and to nobody else', async () => {
    for (const plan of [remittance, { prefix: remittance.prefix, outputs: remittance.outputs }]) {
      const entries = await recipientEntries(sender, ASSET, plan, pub(acceptor))
      for (const [i, entry] of entries.entries()) {
        expect(provenRecipientPkh(acceptor, pub(sender), ASSET, entry)).toBe(holderPkhFor(sender, ASSET, plan, plan.outputs[i]!))
        expect(provenRecipientPkh(PrivateKey.fromRandom(), pub(sender), ASSET, entry)).toBeNull()
      }
    }
  })

  it('carries the key scheme on the wire', async () => {
    const entries = await recipientEntries(sender, ASSET, remittance, pub(acceptor))
    expect(readRecipientEntries(entries).every((e) => e.keyScheme === 'brc29')).toBe(true)
  })

  it('proves to a local acceptor that is also the sender', async () => {
    const [entry] = await recipientEntries(sender, ASSET, remittance, pub(sender))
    expect(provenRecipientPkh(sender, pub(sender), ASSET, entry!)).toBe(holderPkhFor(sender, ASSET, remittance, remittance.outputs[0]!))
  })

  it('reads an entry without linkage as an identity-key holder', () => {
    const [entry] = readRecipientEntries([{ vout: 0, identityKey: pub(recipient) }, { vout: 0, identityKey: pub(sender) }, { vout: 1 }])
    expect(provenRecipientPkh(acceptor, pub(sender), ASSET, entry!)).toBe(pkh(recipient))
  })

  it('lets an acceptor deliver each recipient only its own rows', async () => {
    const entries = await recipientEntries(sender, ASSET, remittance, pub(acceptor))
    expect(deliveryOutputsFromEntries(entries, pub(recipient)).map((o) => o.vout)).toEqual([0])
    expect(deliveryOutputsFromEntries(entries, pub(acceptor))).toEqual([])
  })

  it('keeps the ISSUE key for a legacy deploy output', () => {
    expect(holderKeyAsset(ASSET, ASSET.replace('_', '.'))).toBe('ISSUE')
    expect(holderKeyAsset(ASSET, `${'ef'.repeat(32)}.1`)).toBe(ASSET)
  })
})
