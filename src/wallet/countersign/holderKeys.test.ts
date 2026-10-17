import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { pubkeyHashHex } from './script'
import {
  deliveryOutputsFor,
  deliveryOutputsFromEntries,
  holderKeyAsset,
  holderPkhFor,
  holderPrivateKey,
  planHolderRemittance,
  provenRecipientPkh,
  readRecipientEntries,
  recipientEntries,
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

  it('locks each output to a child its holder derives from the delivery', () => {
    const [payee, change] = remittance.outputs
    const payeePkh = holderPkhFor(sender, ASSET, remittance.prefix, payee!)
    expect(payeePkh).not.toBe(pkh(recipient))
    const [row] = deliveryOutputsFor(remittance, pub(recipient))
    const key = holderPrivateKey(recipient, ASSET, { ...row!, senderIdentityKey: pub(sender) })
    expect(pubkeyHashHex(pub(key))).toBe(payeePkh)
    const own = holderPrivateKey(sender, ASSET, {
      derivationPrefix: remittance.prefix,
      derivationSuffix: change!.derivationSuffix,
      senderIdentityKey: pub(sender),
    })
    expect(pubkeyHashHex(pub(own))).toBe(holderPkhFor(sender, ASSET, remittance.prefix, change!))
  })

  it('proves each holder to the acceptor it was encrypted for, and to nobody else', async () => {
    const entries = await recipientEntries(sender, ASSET, remittance, pub(acceptor))
    for (const [i, entry] of entries.entries()) {
      expect(provenRecipientPkh(acceptor, pub(sender), ASSET, entry)).toBe(
        holderPkhFor(sender, ASSET, remittance.prefix, remittance.outputs[i]!),
      )
      expect(provenRecipientPkh(PrivateKey.fromRandom(), pub(sender), ASSET, entry)).toBeNull()
    }
  })

  it('proves to a local acceptor that is also the sender', async () => {
    const [entry] = await recipientEntries(sender, ASSET, remittance, pub(sender))
    expect(provenRecipientPkh(sender, pub(sender), ASSET, entry!)).toBe(
      holderPkhFor(sender, ASSET, remittance.prefix, remittance.outputs[0]!),
    )
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

  it('keeps the ISSUE key for a deploy output', () => {
    expect(holderKeyAsset(ASSET, ASSET.replace('_', '.'))).toBe('ISSUE')
    expect(holderKeyAsset(ASSET, `${'ef'.repeat(32)}.1`)).toBe(ASSET)
  })
})
