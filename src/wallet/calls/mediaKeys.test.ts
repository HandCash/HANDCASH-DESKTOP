import { describe, expect, it } from 'vitest'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { openFrame, sealFrame } from './frameCrypto'
import { callKeys, callSecret, safetyCode } from './mediaKeys'

async function person() {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return { wallet, key: publicKey }
}

const CALL = '0123456789abcdef01234567'
const FRAME = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12]).buffer

describe('media keys between two identities', () => {
  it('both sides derive the same secret, and nobody else does', async () => {
    const alice = await person()
    const bob = await person()
    const mallory = await person()
    const a = await callSecret(alice.wallet, bob.key, CALL)
    const b = await callSecret(bob.wallet, alice.key, CALL)
    expect(a).toHaveLength(32)
    expect(b).toEqual(a)
    expect(await callSecret(mallory.wallet, alice.key, CALL)).not.toEqual(a)
    expect(await callSecret(alice.wallet, bob.key, 'another call')).not.toEqual(a)
  })

  it('what one side seals only the other side opens, each direction under its own key', async () => {
    const alice = await person()
    const bob = await person()
    const secret = await callSecret(alice.wallet, bob.key, CALL)
    const aliceKeys = await callKeys(secret, alice.key, bob.key, CALL)
    const bobKeys = await callKeys(secret, bob.key, alice.key, CALL)
    const sealed = await sealFrame(aliceKeys.send, FRAME, 3)
    expect(new Uint8Array(await openFrame(bobKeys.receive, sealed) as ArrayBuffer)).toEqual(new Uint8Array(FRAME))
    expect(await openFrame(bobKeys.send, sealed)).toBeNull()
    expect(await openFrame(aliceKeys.receive, sealed)).toBeNull()
  })

  it('the safety code matches on both sides and changes if anything got in between', async () => {
    const alice = await person()
    const bob = await person()
    const secret = await callSecret(alice.wallet, bob.key, CALL)
    const onAlice = await safetyCode(secret, CALL, ['AA:01', 'bb:02'])
    const onBob = await safetyCode(secret, CALL, ['BB:02', 'aa:01'])
    expect(onAlice).toMatch(/^\d{4} \d{4} \d{4}$/)
    expect(onBob).toBe(onAlice)
    expect(await safetyCode(secret, CALL, ['aa:01', 'cc:03'])).not.toBe(onAlice)
    const other = await callSecret(alice.wallet, (await person()).key, CALL)
    expect(await safetyCode(other, CALL, ['aa:01', 'bb:02'])).not.toBe(onAlice)
  })
})
