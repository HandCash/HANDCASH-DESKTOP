import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  SESSION_OFFER_TTL_MS,
  acceptableSessionSdp,
  decodeSessionSignal,
  encodeSessionSignal,
  isLegacySessionOffer,
  keepsOwnOfferOnGlare,
  signSessionSignal,
  verifySessionAnswer,
  verifySessionOffer,
} from './protocol'
import { fakeSdp } from './fakeRtc.fixture'

const FP_A = Array.from({ length: 32 }, () => 'AA').join(':')
const FP_B = Array.from({ length: 32 }, () => 'BB').join(':')

function pair() {
  const a = PrivateKey.fromRandom()
  const b = PrivateKey.fromRandom()
  return { a, b, aKey: a.toPublicKey().toString(), bKey: b.toPublicKey().toString() }
}

describe('BRC-246 v2 signalling', () => {
  it('verifies an offer only for its named recipient, before expiry', () => {
    const { a, b, aKey, bKey } = pair()
    const now = 1_000_000
    const offer = signSessionSignal({ rootKeyHex: a.toHex(), t: 'offer', fromDevice: 'mac', to: bKey, toDevice: '', sdp: fakeSdp(FP_A), now })
    expect(verifySessionOffer(offer, { identityKey: bKey, device: 'phone', now })).toBe(true)
    expect(verifySessionOffer(offer, { identityKey: aKey, device: 'phone', now })).toBe(false)
    expect(verifySessionOffer(offer, { identityKey: bKey, device: 'phone', now: now + SESSION_OFFER_TTL_MS + 6_000 })).toBe(false)
    expect(b).toBeTruthy()
  })

  it('binds the whole description: an altered fingerprint breaks the signature', () => {
    const { a, bKey } = pair()
    const offer = signSessionSignal({ rootKeyHex: a.toHex(), t: 'offer', fromDevice: 'mac', to: bKey, toDevice: '', sdp: fakeSdp(FP_A) })
    const swapped = { ...offer, sdp: fakeSdp(FP_B) }
    expect(verifySessionOffer(swapped, { identityKey: bKey, device: 'phone' })).toBe(false)
  })

  it('refuses descriptions with media, a second fingerprint, or no data channel', () => {
    expect(acceptableSessionSdp(fakeSdp(FP_A))).toBe(true)
    expect(acceptableSessionSdp(fakeSdp(FP_A, ['m=audio 9 UDP/TLS/RTP/SAVPF 111']))).toBe(false)
    expect(acceptableSessionSdp(fakeSdp(FP_A, [`a=fingerprint:sha-256 ${FP_B}`]))).toBe(false)
    expect(acceptableSessionSdp(fakeSdp(FP_A).replace('sha-256', 'sha-1'))).toBe(false)
    expect(acceptableSessionSdp(fakeSdp(FP_A).replace('webrtc-datachannel', 'other'))).toBe(false)
  })

  it('addresses installs of one identity by device and never itself', () => {
    const { a, aKey } = pair()
    expect(() => signSessionSignal({ rootKeyHex: a.toHex(), t: 'offer', fromDevice: 'mac', to: aKey, toDevice: '', sdp: fakeSdp(FP_A) })).toThrow(/another install/)
    expect(() => signSessionSignal({ rootKeyHex: a.toHex(), t: 'offer', fromDevice: 'mac', to: aKey, toDevice: 'mac', sdp: fakeSdp(FP_A) })).toThrow(/another install/)
    const offer = signSessionSignal({ rootKeyHex: a.toHex(), t: 'offer', fromDevice: 'mac', to: aKey, toDevice: 'phone', sdp: fakeSdp(FP_A) })
    expect(verifySessionOffer(offer, { identityKey: aKey, device: 'phone' })).toBe(true)
    expect(verifySessionOffer(offer, { identityKey: aKey, device: 'mac' })).toBe(false)
    expect(verifySessionOffer(offer, { identityKey: aKey, device: 'tablet' })).toBe(false)
  })

  it('binds an answer to its offer nonce, devices and expiry', () => {
    const { a, b, aKey, bKey } = pair()
    const offer = signSessionSignal({ rootKeyHex: a.toHex(), t: 'offer', fromDevice: 'mac', to: bKey, toDevice: '', sdp: fakeSdp(FP_A) })
    const answer = signSessionSignal({
      rootKeyHex: b.toHex(), t: 'answer', fromDevice: 'phone', to: aKey, toDevice: 'mac',
      offerNonce: offer.nonce, sdp: fakeSdp(FP_B), expiresAt: offer.expiresAt,
    })
    expect(verifySessionAnswer(answer, { offer })).toBe(true)
    const other = signSessionSignal({ rootKeyHex: a.toHex(), t: 'offer', fromDevice: 'mac', to: bKey, toDevice: '', sdp: fakeSdp(FP_A) })
    expect(verifySessionAnswer(answer, { offer: other })).toBe(false)
    const wrongDevice = signSessionSignal({
      rootKeyHex: b.toHex(), t: 'answer', fromDevice: 'phone', to: aKey, toDevice: 'laptop',
      offerNonce: offer.nonce, sdp: fakeSdp(FP_B), expiresAt: offer.expiresAt,
    })
    expect(verifySessionAnswer(wrongDevice, { offer })).toBe(false)
    const impostor = signSessionSignal({
      rootKeyHex: PrivateKey.fromRandom().toHex(), t: 'answer', fromDevice: 'phone', to: aKey, toDevice: 'mac',
      offerNonce: offer.nonce, sdp: fakeSdp(FP_B), expiresAt: offer.expiresAt,
    })
    expect(verifySessionAnswer(impostor, { offer })).toBe(false)
  })

  it('round-trips through the wire form and rejects malformed bodies', () => {
    const { a, bKey } = pair()
    const offer = signSessionSignal({ rootKeyHex: a.toHex(), t: 'offer', fromDevice: 'mac', to: bKey, toDevice: '', sdp: fakeSdp(FP_A) })
    expect(decodeSessionSignal(encodeSessionSignal(offer))).toEqual(offer)
    expect(decodeSessionSignal('{"v":1}')).toBeNull()
    expect(decodeSessionSignal(encodeSessionSignal({ ...offer, fromDevice: 'bad device' }))).toBeNull()
    expect(decodeSessionSignal('not json')).toBeNull()
  })

  it('resolves glare by identity then device, and recognises v1 offers', () => {
    const low = { identityKey: '02' + '00'.repeat(32), device: 'z' }
    const high = { identityKey: '03' + '00'.repeat(32), device: 'a' }
    expect(keepsOwnOfferOnGlare(low, high)).toBe(true)
    expect(keepsOwnOfferOnGlare(high, low)).toBe(false)
    expect(keepsOwnOfferOnGlare({ ...low, device: 'a' }, low)).toBe(true)
    expect(isLegacySessionOffer('handcash-session-offer:{"v":1}')).toBe(true)
    expect(isLegacySessionOffer('hello')).toBe(false)
  })
})
