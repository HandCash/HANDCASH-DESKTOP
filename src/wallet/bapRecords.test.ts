import { BigNumber, BSM, ECDSA, OP, PrivateKey, Script, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  BAP_BASKET,
  BAP_BITCOM_ADDRESS,
  BAP_KEY_ID,
  BAP_PROTOCOL_ID,
  bapAliasScript,
  bapIdFor,
  bapIdForAddress,
  bapIdScript,
  bapKey,
  bFileScript,
  parseBapRecord,
  parseBFile,
} from './bapRecords'

const master = PrivateKey.fromHex('11'.repeat(32))

/** An ID record exactly as the v1.3.261 ID-panel compose signed it: wallet signature over the magic hash, made compact. */
function legacyComposeIdScript(bapId: string, address: string, signer: PrivateKey): string {
  const script = new Script()
  script.writeOpCode(OP.OP_FALSE)
  script.writeOpCode(OP.OP_RETURN)
  for (const field of [BAP_BITCOM_ADDRESS, 'ID', bapId, address]) script.writeBin(Utils.toArray(field, 'utf8'))
  const message = [OP.OP_RETURN, ...[BAP_BITCOM_ADDRESS, 'ID', bapId, address].flatMap((f) => Utils.toArray(f, 'utf8')), 0x7c]
  const hash = BSM.magicHash(message)
  const signature = ECDSA.sign(new BigNumber(hash), signer, true)
  const recovery = signature.CalculateRecoveryFactor(signer.toPublicKey(), new BigNumber(hash))
  for (const field of ['|', '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva', 'BITCOIN_ECDSA', signer.toAddress()])
    script.writeBin(Utils.toArray(field, 'utf8'))
  script.writeBin(Utils.toArray(signature.toCompact(recovery, true, 'base64') as string, 'base64'))
  return script.toHex()
}

describe('BAP records', () => {
  it('uses the 1Sat / Yours BAP key path and ID', () => {
    expect(BAP_PROTOCOL_ID).toEqual([1, 'sigma'])
    expect(BAP_KEY_ID).toBe('identity')
    expect(BAP_BASKET).toBe('bap')
    expect(BAP_BITCOM_ADDRESS).toBe('1BAPSuaPnfGnSBM3GLV9yhxUdYe4vGbdMT')
    expect(bapIdFor(master)).toBe(bapIdForAddress(bapKey(master, 0).toAddress()))
    expect(bapKey(master, 1).toHex()).not.toBe(bapKey(master, 0).toHex())
    expect(() => bapKey(master, -1)).toThrow(/sequence/)
  })

  it('round-trips signed ID and ALIAS records', () => {
    const bapId = bapIdFor(master)
    const root = bapKey(master, 0)
    const first = bapKey(master, 1)
    expect(parseBapRecord(bapIdScript({ bapId, address: first.toAddress(), signer: root }))).toEqual({
      kind: 'id',
      bapId,
      address: first.toAddress(),
      signer: root.toAddress(),
    })
    const profile = { '@type': 'Person', name: 'Studio' }
    expect(parseBapRecord(bapAliasScript({ bapId, profile, signer: first }))).toEqual({
      kind: 'alias',
      bapId,
      profile,
      signer: first.toAddress(),
    })
  })

  it('reads records the earlier ID-panel compose wrote', () => {
    const bapId = bapIdFor(master)
    const root = bapKey(master, 0)
    const legacy = legacyComposeIdScript(bapId, bapKey(master, 1).toAddress(), root)
    expect(legacy).toBe(bapIdScript({ bapId, address: bapKey(master, 1).toAddress(), signer: root }))
  })

  it('refuses a record whose signature does not cover its fields', () => {
    const bapId = bapIdFor(master)
    const genuine = bapIdScript({ bapId, address: bapKey(master, 1).toAddress(), signer: bapKey(master, 0) })
    const forged = genuine.replace(
      Utils.toHex(Utils.toArray(bapKey(master, 1).toAddress(), 'utf8')),
      Utils.toHex(Utils.toArray(bapKey(master, 2).toAddress(), 'utf8')),
    )
    expect(forged).not.toBe(genuine)
    expect(parseBapRecord(forged)).toBeNull()
    expect(parseBapRecord(bFileScript({ bytes: Uint8Array.of(1), contentType: 'image/png' }))).toBeNull()
  })

  it('round-trips a B:// file within its cap', () => {
    const script = bFileScript({ bytes: Uint8Array.of(1, 2, 3), contentType: 'image/PNG' })
    expect(parseBFile(script, 3)).toEqual({ bytes: Uint8Array.of(1, 2, 3), contentType: 'image/png' })
    expect(parseBFile(script, 2)).toBeNull()
  })
})
