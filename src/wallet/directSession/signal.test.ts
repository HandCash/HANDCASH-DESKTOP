import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { ReplayCache, openSignal, sealSignal, SIGNALING_PROTOCOL_ID, fromBase64, utf8Decode } from '@bsv/webrtpay'
import { describe, expect, it } from 'vitest'
import { keepsOwnDialOnGlare, newSid, openMessageSignal, sealMessageSignal } from './signal'

function party() {
  const root = PrivateKey.fromRandom()
  return { wallet: new ProtoWallet(root), key: root.toPublicKey().toString() }
}

const mac = party()
const phone = party()

function knock(over: Partial<Parameters<typeof sealMessageSignal>[1]> = {}) {
  return {
    kind: 'knock' as const,
    sid: newSid(),
    from: mac.key,
    to: phone.key,
    ts: Date.now(),
    fromDevice: 'mac',
    toDevice: '',
    chain: 'main',
    ...over,
  }
}

const opts = (device = 'phone', me = phone.key) => ({ me, device, replay: new ReplayCache() })

describe('draft BRC-246 signals', () => {
  it('are webrtpay/1 envelopes whose plaintext has purpose messages and both devices', async () => {
    const p = knock()
    const envelope = await sealMessageSignal(mac.wallet, p)
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'sid', 'v'])
    expect(envelope.sid).toBe(p.sid)
    const { plaintext } = await phone.wallet.decrypt({
      ciphertext: Array.from(fromBase64(envelope.ciphertext)),
      protocolID: SIGNALING_PROTOCOL_ID,
      keyID: p.sid,
      counterparty: mac.key,
    })
    expect(JSON.parse(utf8Decode(Uint8Array.from(plaintext)))).toEqual({ v: 1, purpose: 'messages', ...p })
    expect(await openMessageSignal(phone.wallet, mac.key, envelope, opts())).toEqual({
      status: 'signal',
      signal: { v: 1, purpose: 'messages', ...p },
    })
  })

  it('never cross between purposes: a payment wallet refuses them, and they refuse payment signals', async () => {
    const ours = await sealMessageSignal(mac.wallet, knock())
    await expect(openSignal(phone.wallet, mac.key, ours, { me: phone.key, replay: new ReplayCache() })).rejects.toMatchObject({ code: 'invalid_signal' })
    const payment = await sealSignal(mac.wallet, { v: 1, kind: 'knock', sid: newSid(), from: mac.key, to: phone.key, ts: Date.now(), purpose: 'payment' })
    expect(await openMessageSignal(phone.wallet, mac.key, payment, opts())).toEqual({ status: 'invalid' })
  })

  it('leave a signal for another install unopened, and mark this install\u2019s own', async () => {
    const root = PrivateKey.fromRandom()
    const me = { wallet: new ProtoWallet(root), key: root.toPublicKey().toString() }
    const toPhone = await sealMessageSignal(me.wallet, knock({ from: me.key, to: me.key, toDevice: 'phone' }))
    expect(await openMessageSignal(me.wallet, me.key, toPhone, opts('tablet', me.key))).toEqual({ status: 'not-mine' })
    expect(await openMessageSignal(me.wallet, me.key, toPhone, opts('mac', me.key))).toEqual({ status: 'own' })
    expect((await openMessageSignal(me.wallet, me.key, toPhone, opts('phone', me.key))).status).toBe('signal')
  })

  it('require a device wherever the spec does', async () => {
    await expect(sealMessageSignal(mac.wallet, knock({ to: mac.key }))).rejects.toThrow(/devices/)
    await expect(sealMessageSignal(mac.wallet, knock({ to: mac.key, toDevice: 'mac' }))).rejects.toThrow(/devices/)
    await expect(sealMessageSignal(mac.wallet, knock({ kind: 'ring' }))).rejects.toThrow(/devices/)
    await expect(sealMessageSignal(mac.wallet, knock({ fromDevice: 'bad device' }))).rejects.toThrow(/devices/)
    await expect(sealMessageSignal(mac.wallet, knock({ chain: 'Main' }))).rejects.toThrow(/chain/)
  })

  it('refuse a forged sender, a stale clock, a replay, and an unwanted reply', async () => {
    const envelope = await sealMessageSignal(mac.wallet, knock())
    expect(await openMessageSignal(phone.wallet, party().key, envelope, opts())).toEqual({ status: 'invalid' })
    const stale = await sealMessageSignal(mac.wallet, knock({ ts: Date.now() - 121_000 }))
    expect(await openMessageSignal(phone.wallet, mac.key, stale, opts())).toEqual({ status: 'invalid' })
    const o = opts()
    expect((await openMessageSignal(phone.wallet, mac.key, envelope, o)).status).toBe('signal')
    expect(await openMessageSignal(phone.wallet, mac.key, envelope, o)).toEqual({ status: 'invalid' })
    const ring = await sealMessageSignal(mac.wallet, knock({ kind: 'ring', toDevice: 'phone' }))
    const fresh = opts()
    expect(await openMessageSignal(phone.wallet, mac.key, ring, { ...fresh, wanted: () => false })).toEqual({ status: 'invalid' })
    expect((await openMessageSignal(phone.wallet, mac.key, ring, fresh)).status).toBe('signal')
  })

  it('resolve glare by identity key, then device', () => {
    expect(keepsOwnDialOnGlare({ identityKey: '02aa', device: 'z' }, { identityKey: '03aa', device: 'a' })).toBe(true)
    expect(keepsOwnDialOnGlare({ identityKey: '02aa', device: 'phone' }, { identityKey: '02aa', device: 'mac' })).toBe(false)
  })
})
