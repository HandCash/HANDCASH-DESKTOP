import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { buildBsv21ValueLock } from './token'
import {
  chooseTokenSwapCancelPath,
  chooseTokenSwapClaimPath,
  chooseTokenSwapMakePath,
  chooseTokenSwapTakePath,
  parseTokenSwapOffer,
  TOKEN_SWAP_MAKER_SIGHASH_BYTE,
  TOKEN_SWAP_PROTOCOL,
  TOKEN_SWAP_VERSION,
  type TokenSwapOffer,
  type TokenSwapWant,
} from './tokenSwapPath'
import { unlockSighashByte } from './marketSettlementLayout'
import { mayAbortTokenSwap, tokenSwapMachine } from '../machines/tokenSwapMachine'

vi.mock('./session', () => ({
  getActiveWallet: () => null,
  bumpBalanceAfterHeal: () => {},
}))

const { signTokenSwapMakerInput, tokenSwapMakerUnlockValid, tokenSwapWantOutput } = await import(
  './tokenSwap'
)

const giveTokenId = `${'ab'.repeat(32)}_0`
const wantTokenId = `${'cd'.repeat(32)}_1`
const maker = PrivateKey.fromRandom()
const makerAddress = maker.toAddress()
const taker = PrivateKey.fromRandom()

function escrowTx(amount = 40n): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: 'ee'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  })
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(
      buildBsv21ValueLock({ layout: 'brc162', tokenId: giveTokenId, amount, address: makerAddress }),
    ),
  })
  return tx
}

/** The taker's transaction: give at input 0, want at output 0, then anything. */
function takeTx(giveTx: Transaction, wantOut: { lockingScript: string; satoshis: number }, extras = true) {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: String(giveTx.id('hex')),
    sourceOutputIndex: 0,
    sourceTransaction: giveTx,
    sequence: 0xffffffff,
  })
  if (extras) {
    tx.addInput({
      sourceTXID: 'ff'.repeat(32),
      sourceOutputIndex: 2,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff,
    })
  }
  tx.addOutput({ satoshis: wantOut.satoshis, lockingScript: LockingScript.fromHex(wantOut.lockingScript) })
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(
      buildBsv21ValueLock({ layout: 'brc162', tokenId: giveTokenId, amount: 40n, address: taker.toAddress() }),
    ),
  })
  if (extras) tx.addOutput({ satoshis: 900, lockingScript: new P2PKH().lock(taker.toAddress()) })
  return tx
}

async function signed(want: TokenSwapWant) {
  const giveTx = escrowTx()
  const makerUnlockingScript = await signTokenSwapMakerInput({
    giveTx,
    giveVout: 0,
    want,
    payTo: makerAddress,
    privateKey: maker,
  })
  return { giveTx, makerUnlockingScript }
}

function valid(tx: Transaction, giveTx: Transaction, makerUnlockingScript: string): boolean {
  return tokenSwapMakerUnlockValid({
    tx,
    giveSatoshis: 1,
    giveLockingScript: giveTx.outputs[0]!.lockingScript.toHex(),
    makerUnlockingScript,
  })
}

function offerFixture(overrides: Partial<TokenSwapOffer> = {}): TokenSwapOffer {
  return {
    protocol: TOKEN_SWAP_PROTOCOL,
    v: TOKEN_SWAP_VERSION,
    offerId: `${'aa'.repeat(32)}.0`,
    maker: maker.toPublicKey().toString(),
    payTo: makerAddress,
    give: { tokenId: giveTokenId, amount: '40', dec: 0, lockingScript: 'ab' },
    want: { kind: 'sats', sats: 5_000 },
    makerUnlockingScript: '47' + '30'.padEnd(140, '0') + 'c3' + '21' + '02'.padEnd(66, '0'),
    beefB64: 'AA==',
    createdAt: 1,
    ...overrides,
  }
}

describe('token swap maker signature', () => {
  it('signs SINGLE|ANYONECANPAY', async () => {
    const { makerUnlockingScript } = await signed({ kind: 'sats', sats: 5_000 })
    expect(unlockSighashByte(makerUnlockingScript)).toBe(TOKEN_SWAP_MAKER_SIGHASH_BYTE)
  })

  it('unlocks a take that pays output 0 exactly, whatever else the taker adds', async () => {
    const want: TokenSwapWant = { kind: 'sats', sats: 5_000 }
    const { giveTx, makerUnlockingScript } = await signed(want)
    const out = tokenSwapWantOutput({ want, payTo: makerAddress })
    expect(valid(takeTx(giveTx, out), giveTx, makerUnlockingScript)).toBe(true)
    expect(valid(takeTx(giveTx, out, false), giveTx, makerUnlockingScript)).toBe(true)
  })

  it('refuses a take that underpays or redirects output 0', async () => {
    const want: TokenSwapWant = { kind: 'sats', sats: 5_000 }
    const { giveTx, makerUnlockingScript } = await signed(want)
    const out = tokenSwapWantOutput({ want, payTo: makerAddress })
    expect(valid(takeTx(giveTx, { ...out, satoshis: 4_999 }), giveTx, makerUnlockingScript)).toBe(false)
    const thief = tokenSwapWantOutput({ want, payTo: taker.toAddress() })
    expect(valid(takeTx(giveTx, thief), giveTx, makerUnlockingScript)).toBe(false)
  })

  it('binds a token want to the exact id, amount and maker address', async () => {
    const want: TokenSwapWant = { kind: 'token', tokenId: wantTokenId, amount: '7', layout: 'brc162' }
    const { giveTx, makerUnlockingScript } = await signed(want)
    const out = tokenSwapWantOutput({ want, payTo: makerAddress })
    expect(valid(takeTx(giveTx, out), giveTx, makerUnlockingScript)).toBe(true)
    const short = tokenSwapWantOutput({ want: { ...want, amount: '6' }, payTo: makerAddress })
    expect(valid(takeTx(giveTx, short), giveTx, makerUnlockingScript)).toBe(false)
    const otherId = tokenSwapWantOutput({
      want: { ...want, tokenId: `${'ef'.repeat(32)}_0` },
      payTo: makerAddress,
    })
    expect(valid(takeTx(giveTx, otherId), giveTx, makerUnlockingScript)).toBe(false)
  })

  it('does not unlock a different lot', async () => {
    const want: TokenSwapWant = { kind: 'sats', sats: 5_000 }
    const { giveTx, makerUnlockingScript } = await signed(want)
    const otherLot = escrowTx(41n)
    const out = tokenSwapWantOutput({ want, payTo: makerAddress })
    expect(valid(takeTx(otherLot, out), otherLot, makerUnlockingScript)).toBe(false)
    expect(valid(takeTx(giveTx, out), giveTx, makerUnlockingScript)).toBe(true)
  })
})

describe('token swap paths', () => {
  it('names every make refusal', () => {
    const want = { kind: 'sats', sats: 10 }
    expect(chooseTokenSwapMakePath({ tokenId: 'x', amount: 1, want, cosigned: false })).toMatchObject({
      path: 'refuse',
      reason: 'invalid-offer',
    })
    expect(chooseTokenSwapMakePath({ tokenId: giveTokenId, amount: 0, want, cosigned: false })).toMatchObject({
      reason: 'bad-amount',
    })
    expect(
      chooseTokenSwapMakePath({
        tokenId: giveTokenId,
        amount: 5,
        want: { kind: 'token', tokenId: giveTokenId, amount: '1' },
        cosigned: false,
      }),
    ).toMatchObject({ reason: 'same-token' })
    expect(chooseTokenSwapMakePath({ tokenId: giveTokenId, amount: 5, want, cosigned: true })).toMatchObject({
      reason: 'cosigned-token',
    })
    expect(chooseTokenSwapMakePath({ tokenId: giveTokenId, amount: 5, want, cosigned: false })).toMatchObject({
      path: 'make',
      amount: 5n,
      want: { kind: 'sats', sats: 10 },
    })
  })

  it('takes only a parsed offer with a bound signature, and knows a self-swap', () => {
    const offer = offerFixture()
    expect(parseTokenSwapOffer(offer)?.offerId).toBe(offer.offerId)
    expect(chooseTokenSwapTakePath({ offer: { ...offer, v: 0 }, takerIdentityKey: 'x' })).toMatchObject({
      reason: 'invalid-offer',
    })
    expect(
      chooseTokenSwapTakePath({
        offer: { ...offer, makerUnlockingScript: offer.makerUnlockingScript.replace('c321', '4121') },
        takerIdentityKey: 'x',
      }),
    ).toMatchObject({ reason: 'unbound-signature' })
    expect(chooseTokenSwapTakePath({ offer, takerIdentityKey: taker.toPublicKey().toString() })).toMatchObject({
      path: 'take',
      settle: 'peerClaim',
    })
    expect(chooseTokenSwapTakePath({ offer, takerIdentityKey: offer.maker.toUpperCase() })).toMatchObject({
      settle: 'selfClaim',
    })
  })

  it('claims and cancels only as the maker, from the right state', () => {
    const offer = offerFixture()
    const me = offer.maker
    const txid = 'bb'.repeat(32)
    expect(chooseTokenSwapClaimPath({ offer, state: 'taken', makerIdentityKey: 'x', txid })).toMatchObject({
      reason: 'not-maker',
    })
    expect(chooseTokenSwapClaimPath({ offer, state: 'open', makerIdentityKey: me, txid: '' })).toMatchObject({
      reason: 'offer-not-taken',
    })
    expect(chooseTokenSwapClaimPath({ offer, state: 'claimed', makerIdentityKey: me, txid })).toMatchObject({
      reason: 'offer-not-open',
    })
    expect(chooseTokenSwapClaimPath({ offer, state: 'taken', makerIdentityKey: me, txid })).toMatchObject({
      path: 'claim',
      proceeds: 'sats',
    })
    expect(
      chooseTokenSwapCancelPath({ offer, state: 'open', makerIdentityKey: me, spent: 'spent' }),
    ).toMatchObject({ reason: 'offer-already-taken' })
    expect(
      chooseTokenSwapCancelPath({ offer, state: 'taken', makerIdentityKey: me, spent: null }),
    ).toMatchObject({ reason: 'offer-not-open' })
    expect(
      chooseTokenSwapCancelPath({ offer, state: 'open', makerIdentityKey: me, spent: 'unknown' }),
    ).toMatchObject({ path: 'cancel' })
  })
})

describe('tokenSwapMachine', () => {
  it('fails a refused path without staging', () => {
    const actor = createActor(tokenSwapMachine).start()
    actor.send({ type: 'MAKE', path: { path: 'refuse', reason: 'same-token', message: 'x' } })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context.error).toBe('same-token')
  })

  it('claims through ingesting, never staging a transaction', () => {
    const actor = createActor(tokenSwapMachine).start()
    actor.send({
      type: 'CLAIM',
      path: { path: 'claim', proceeds: 'token', offerId: 'a.0', txid: 'b'.repeat(64) },
    })
    expect(actor.getSnapshot().value).toBe('ingesting')
    actor.send({ type: 'INGESTED' })
    expect(actor.getSnapshot().value).toBe('committed')
  })

  it('stops allowing abort once the cheque is broadcast', () => {
    const actor = createActor(tokenSwapMachine).start()
    actor.send({ type: 'TAKE', path: { path: 'take', settle: 'peerClaim', offer: offerFixture() } })
    actor.send({ type: 'STAGED', reference: 'r' })
    expect(mayAbortTokenSwap(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SIGNED_UNKNOWN' })
    expect(mayAbortTokenSwap(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'BROADCASTED', txid: 'c'.repeat(64) })
    expect(mayAbortTokenSwap(actor.getSnapshot())).toBe(false)
    actor.send({ type: 'COMMITTED' })
    expect(actor.getSnapshot().value).toBe('committed')
  })
})
