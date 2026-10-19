import { LockingScript, PrivateKey, Spend, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { fromHex, ltcTxid, parseLtcTx, serializeLtcTx, toHex, type LtcTx } from '../ltc/litecoin'
import type { SwapAsset } from './assets'
import { feeLockScripts, feePayoutScript, judgeFeeLock, parseFeeLockReport, signFeeClaim, type FeeChainReader, type FeeLockReport } from './feeClaim'
import { sha256, signHtlcSpend } from './htlc'

const feeKey = PrivateKey.fromString('44'.repeat(32), 'hex')
const FEE_PUB = feeKey.toPublicKey().toString()
const payer = PrivateKey.fromString('55'.repeat(32), 'hex')
const payee = PrivateKey.fromString('66'.repeat(32), 'hex')
const secret = fromHex('ab'.repeat(32))
const NOW_S = 1_800_000_000
const payTo = fromHex('76a914' + '00'.repeat(20) + '88ac')

/** The fee leg's lock: swap output at 0, fee output at 1. */
function lockTx(chain: SwapAsset, base: Omit<FeeLockReport, 'txid'>): { tx: LtcTx; report: FeeLockReport } {
  const partial = { ...base, txid: '00'.repeat(32) }
  const outs = feeLockScripts(partial, FEE_PUB)
  const tx: LtcTx = {
    version: chain === 'bsv' ? 1 : 2,
    inputs: [{ txid: 'ee'.repeat(32), vout: 0, script: new Uint8Array(), sequence: 0xffffffff, witness: [] }],
    outputs: [
      { value: 1_000_000n, script: outs.main.scriptPubKey },
      { value: BigInt(base.amount), script: outs.fee.scriptPubKey },
    ],
    locktime: 0,
  }
  return { tx, report: { ...base, txid: ltcTxid(tx) } }
}

const reportBase = (chain: SwapAsset, amount = '5000'): Omit<FeeLockReport, 'txid'> => ({
  v: 1,
  chain,
  vout: 1,
  mainVout: 0,
  amount,
  hash: toHex(sha256(secret)),
  payerPub: payer.toPublicKey().toString(),
  payeePub: payee.toPublicKey().toString(),
  locktime: NOW_S + 36 * 3600,
})

function fakeChain(txs: LtcTx[], spenders: Record<string, LtcTx> = {}): FeeChainReader & { sent: string[] } {
  const sent: string[] = []
  const hexOf = (tx: LtcTx) => toHex(serializeLtcTx(tx))
  return {
    sent,
    txHex: async (txid) => {
      const tx = txs.find((t) => ltcTxid(t) === txid)
      return tx ? hexOf(tx) : null
    },
    spenderHex: async (o) => (spenders[`${o.txid}:${o.vout}`] ? hexOf(spenders[`${o.txid}:${o.vout}`]!) : null),
    broadcast: async (hex) => void sent.push(hex),
    feeRate: async () => 2,
  }
}

function claimMain(chain: SwapAsset, lock: LtcTx, report: FeeLockReport, preimage = secret): LtcTx {
  const { main } = feeLockScripts(report, FEE_PUB)
  return signHtlcSpend(chain, { coins: [{ txid: report.txid, vout: 0, amount: lock.outputs[0]!.value, script: main.script }], to: payTo, key: payee, path: { kind: 'claim', preimage } }).tx
}

describe('fee lock reports', () => {
  it('takes what a wallet sends and refuses the rest', () => {
    const { report } = lockTx('bsv', reportBase('bsv'))
    expect(parseFeeLockReport(report, NOW_S)).toEqual(report)
    expect(parseFeeLockReport({ ...report, vout: 0 }, NOW_S)).toBeNull()
    expect(parseFeeLockReport({ ...report, amount: '999' }, NOW_S)).toBeNull()
    expect(parseFeeLockReport({ ...report, payeePub: report.payerPub }, NOW_S)).toBeNull()
    expect(parseFeeLockReport({ ...report, locktime: NOW_S + 30 * 24 * 3600 }, NOW_S)).toBeNull()
    expect(parseFeeLockReport({ ...report, chain: 'eth' }, NOW_S)).toBeNull()
  })
})

describe('judgeFeeLock', () => {
  it('waits for the lock, then for the swap output to be claimed', async () => {
    const { tx, report } = lockTx('ltc', reportBase('ltc', '20000'))
    expect((await judgeFeeLock(report, fakeChain([]), FEE_PUB)).kind).toBe('pending')
    expect(await judgeFeeLock(report, fakeChain([tx]), FEE_PUB)).toEqual({ kind: 'pending', detail: 'the swap output is not claimed yet' })
  })

  it('refuses a lock that does not hold the reported outputs', async () => {
    const { tx, report } = lockTx('ltc', reportBase('ltc', '20000'))
    expect((await judgeFeeLock({ ...report, amount: '20001' }, fakeChain([tx]), FEE_PUB)).kind).toBe('invalid')
    expect((await judgeFeeLock(report, fakeChain([tx]), '02' + '77'.repeat(32))).kind).toBe('invalid')
  })

  it('reads the secret from the swap claim, then claims the fee output with it', async () => {
    for (const chain of ['ltc', 'btc', 'bch', 'doge'] as const) {
      const amount = chain === 'doge' ? '3000000' : '60000'
      const { tx, report } = lockTx(chain, reportBase(chain, amount))
      const verdict = await judgeFeeLock(report, fakeChain([tx], { [`${report.txid}:0`]: claimMain(chain, tx, report) }), FEE_PUB)
      expect(verdict).toEqual({ kind: 'claim', secret })
      const payout = feePayoutScript(chain, FEE_PUB)
      const claim = signFeeClaim(report, secret, feeKey.toHex(), payout, 2, FEE_PUB)
      const spent = parseLtcTx(fromHex(claim.hex))
      expect(spent.inputs[0]).toMatchObject({ txid: report.txid, vout: 1 })
      expect(toHex(spent.outputs[0]!.script)).toBe(toHex(payout))
      expect(claim.value < BigInt(amount)).toBe(true)
    }
  })

  it('a BSV fee claim passes the script interpreter', async () => {
    const { tx, report } = lockTx('bsv', reportBase('bsv'))
    expect(await judgeFeeLock(report, fakeChain([tx], { [`${report.txid}:0`]: claimMain('bsv', tx, report) }), FEE_PUB)).toEqual({ kind: 'claim', secret })
    const claim = signFeeClaim(report, secret, feeKey.toHex(), feePayoutScript('bsv', FEE_PUB), 0.1, FEE_PUB)
    const spend = Transaction.fromHex(claim.hex)
    const { fee } = feeLockScripts(report, FEE_PUB)
    const ok = new Spend({
      sourceTXID: report.txid,
      sourceOutputIndex: 1,
      sourceSatoshis: 5000,
      lockingScript: LockingScript.fromBinary(Array.from(fee.script)),
      transactionVersion: spend.version,
      otherInputs: [],
      outputs: spend.outputs,
      inputIndex: 0,
      unlockingScript: UnlockingScript.fromBinary(spend.inputs[0]!.unlockingScript!.toBinary()),
      inputSequence: spend.inputs[0]!.sequence!,
      lockTime: spend.lockTime,
    }).validate()
    expect(ok).toBe(true)
  })

  it('stops when the swap output went back to its payer, or the fee output is already spent', async () => {
    const { tx, report } = lockTx('ltc', reportBase('ltc', '20000'))
    const { main, fee } = feeLockScripts(report, FEE_PUB)
    const refundMain = signHtlcSpend('ltc', { coins: [{ txid: report.txid, vout: 0, amount: 1_000_000n, script: main.script }], to: payTo, key: payer, path: { kind: 'refund', locktime: report.locktime } }).tx
    expect((await judgeFeeLock(report, fakeChain([tx], { [`${report.txid}:0`]: refundMain }), FEE_PUB)).kind).toBe('refunded')
    const claimed = signHtlcSpend('ltc', { coins: [{ txid: report.txid, vout: 1, amount: 20_000n, script: fee.script }], to: payTo, key: feeKey, path: { kind: 'claim', preimage: secret } }).tx
    expect(await judgeFeeLock(report, fakeChain([tx], { [`${report.txid}:1`]: claimed }), FEE_PUB)).toEqual({ kind: 'spent', txid: ltcTxid(claimed), claimed: true })
  })

  it('pays a named address, or the fee key\'s own', () => {
    expect(toHex(feePayoutScript('bsv', FEE_PUB, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH'))).toBe('76a914751e76e8199196d454941c45d1b3a323f1433bd688ac')
    expect(toHex(feePayoutScript('ltc', FEE_PUB)).startsWith('0014')).toBe(true)
    expect(() => signFeeClaim(lockTx('bsv', reportBase('bsv')).report, secret, payer.toHex(), payTo, 1, FEE_PUB)).toThrow(/does not match/)
  })
})

