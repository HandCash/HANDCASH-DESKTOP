import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))
const legacyBeef = vi.hoisted(() => ({ buildLegacyInputBeef: vi.fn() }))
vi.mock('./legacyBeef', () => legacyBeef)
const importGuard = vi.hoisted(() => ({ markOneSatImported: vi.fn() }))
vi.mock('./oneSatImportGuard', () => importGuard)

import {
  buildMneeSweep,
  chooseMneeTip,
  cosignedMatches,
  mneeSweepSplit,
  parseMneeConfig,
  sweepMneeFromKey,
  type MneeConfig,
} from './mnee'
import {
  MNEE_TOKEN_ID,
  cosignedOwnerHash,
  formatMnee,
  isMneeItem,
  isMneeTokenId,
  mneeOutputScriptHex,
  parseMneeTip,
} from './mneeTip'
import type { ActiveWallet } from './session'

const APPROVER = PrivateKey.fromRandom().toPublicKey().toString()
const FEE_ADDRESS = PrivateKey.fromRandom().toPublicKey().toAddress()
const FEES = [
  { min: 0, max: 1_000_000, fee: 100 },
  { min: 1_000_001, max: Number.MAX_SAFE_INTEGER, fee: 1_000 },
]
const CONFIG: MneeConfig = {
  approver: APPROVER,
  feeAddress: FEE_ADDRESS,
  tokenId: MNEE_TOKEN_ID,
  decimals: 5,
  fees: FEES,
}

function sourceTx(outputs: Array<{ script: string; satoshis?: number }>): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  })
  for (const o of outputs) tx.addOutput({ satoshis: o.satoshis ?? 1, lockingScript: LockingScript.fromHex(o.script) })
  return tx
}

/** What MNEE's cosigner returns: our tx with its signature pushed first on every input. */
function cosign(signed: Transaction): Transaction {
  const tx = Transaction.fromHex(signed.toHex())
  for (const input of tx.inputs) {
    input.unlockingScript = UnlockingScript.fromHex(`47${'30'.repeat(71)}${input.unlockingScript!.toHex()}`)
  }
  return tx
}

describe('mneeTip', () => {
  it('round-trips an MNEE output script and reads the owner, approver and amount', () => {
    const key = PrivateKey.fromRandom()
    const script = mneeOutputScriptHex(key.toPublicKey().toAddress(), 1_234_500n, APPROVER)
    expect(parseMneeTip(script)).toEqual({
      ownerHash: key.toPublicKey().toHash('hex'),
      approver: APPROVER,
      amt: 1_234_500n,
    })
    expect(cosignedOwnerHash(script)).toBe(key.toPublicKey().toHash('hex'))
  })

  it('reads nothing from a plain lock, a bare cosign lock or another token', () => {
    const key = PrivateKey.fromRandom()
    const hash = key.toPublicKey().toHash('hex') as string
    expect(parseMneeTip(new P2PKH().lock(key.toPublicKey().toAddress()).toHex())).toBeNull()
    expect(parseMneeTip(`76a914${hash}88ad21${APPROVER}ac`)).toBeNull()
    const other = mneeOutputScriptHex(key.toPublicKey().toAddress(), 5n, APPROVER).replace(
      Utils.toHex(Utils.toArray(MNEE_TOKEN_ID, 'utf8')),
      Utils.toHex(Utils.toArray(`${'cd'.repeat(32)}_0`, 'utf8')),
    )
    expect(parseMneeTip(other)).toBeNull()
    expect(cosignedOwnerHash(new P2PKH().lock(key.toPublicKey().toAddress()).toHex())).toBeNull()
  })

  it('names MNEE by id, tag or collection', () => {
    expect(isMneeTokenId(MNEE_TOKEN_ID.replace('_', '.'))).toBe(true)
    expect(isMneeTokenId(`${'cd'.repeat(32)}_0`)).toBe(false)
    expect(isMneeItem({ tags: ['ordinal', 'mnee'] })).toBe(true)
    expect(isMneeItem({ collectionId: 'mnee' })).toBe(true)
    expect(isMneeItem({ tags: ['ordinal'], collectionId: 'other' })).toBe(false)
  })

  it('formats base units with five decimals', () => {
    expect(formatMnee(1_234_500n)).toBe('12.345')
    expect(formatMnee(100_000n)).toBe('1')
    expect(formatMnee(7n)).toBe('0.00007')
  })
})

describe('mneeSweepSplit', () => {
  it('pays the tier of the amount that arrives', () => {
    expect(mneeSweepSplit(500_000n, FEES)).toEqual({ amount: 499_900n, fee: 100n })
    expect(mneeSweepSplit(1_000_050n, FEES)).toEqual({ amount: 999_050n, fee: 1_000n })
    expect(mneeSweepSplit(5_000_000n, FEES)).toEqual({ amount: 4_999_000n, fee: 1_000n })
  })

  it('refuses when nothing would arrive or no tier covers the amount', () => {
    expect(mneeSweepSplit(100n, FEES)).toBeNull()
    expect(mneeSweepSplit(50n, [{ min: 100, max: 200, fee: 1 }])).toBeNull()
  })
})

describe('parseMneeConfig', () => {
  const raw = { approver: APPROVER.toUpperCase(), feeAddress: FEE_ADDRESS, tokenId: MNEE_TOKEN_ID, decimals: 5, fees: FEES }

  it('accepts the published MNEE terms', () => {
    expect(parseMneeConfig(raw)).toEqual(CONFIG)
  })

  it('refuses terms for another token, a bad approver, a bad fee address or no fees', () => {
    expect(parseMneeConfig({ ...raw, tokenId: `${'cd'.repeat(32)}_0` })).toBeNull()
    expect(parseMneeConfig({ ...raw, approver: '04' + 'ab'.repeat(32) })).toBeNull()
    expect(parseMneeConfig({ ...raw, feeAddress: 'not-an-address' })).toBeNull()
    expect(parseMneeConfig({ ...raw, decimals: 8 })).toBeNull()
    expect(parseMneeConfig({ ...raw, fees: [] })).toBeNull()
    expect(parseMneeConfig({ ...raw, fees: [{ min: 0, max: 1, fee: -1 }] })).toBeNull()
  })
})

describe('chooseMneeTip', () => {
  const key = PrivateKey.fromRandom()
  const address = key.toPublicKey().toAddress()
  const ownerHash = key.toPublicKey().toHash('hex') as string
  const row = { txid: 'ab'.repeat(32), vout: 0, amt: 500n }

  it('spends a tip whose script names this key, this cosigner and the listed amount', () => {
    const tx = sourceTx([{ script: mneeOutputScriptHex(address, 500n, APPROVER) }])
    const decision = chooseMneeTip({ row, sourceTransaction: tx, ownerHash, approver: APPROVER })
    expect(decision).toMatchObject({ kind: 'spend', tip: { amt: 500n, vout: 0 } })
  })

  it('holds every tip the script does not back', () => {
    const other = PrivateKey.fromRandom().toPublicKey()
    const cases: Array<[Transaction | null, string]> = [
      [null, 'unreadable'],
      [sourceTx([{ script: mneeOutputScriptHex(address, 500n, APPROVER), satoshis: 2 }]), 'unreadable'],
      [sourceTx([{ script: new P2PKH().lock(address).toHex() }]), 'unreadable'],
      [sourceTx([{ script: mneeOutputScriptHex(other.toAddress(), 500n, APPROVER) }]), 'foreign'],
      [sourceTx([{ script: mneeOutputScriptHex(address, 500n, other.toString()) }]), 'cosigner'],
      [sourceTx([{ script: mneeOutputScriptHex(address, 499n, APPROVER) }]), 'amount'],
    ]
    for (const [tx, reason] of cases) {
      expect(chooseMneeTip({ row, sourceTransaction: tx, ownerHash, approver: APPROVER })).toEqual({
        kind: 'hold',
        reason,
      })
    }
  })
})

describe('buildMneeSweep', () => {
  it('spends every tip to the recipient less the fee, signed by the owner alone', async () => {
    const key = PrivateKey.fromRandom()
    const address = key.toPublicKey().toAddress()
    const recipient = PrivateKey.fromRandom().toPublicKey().toAddress()
    const tx = sourceTx([
      { script: mneeOutputScriptHex(address, 300_000n, APPROVER) },
      { script: mneeOutputScriptHex(address, 200_000n, APPROVER) },
    ])
    const built = await buildMneeSweep({
      key,
      recipient,
      config: CONFIG,
      tips: [
        { txid: tx.id('hex'), vout: 0, amt: 300_000n, sourceTransaction: tx },
        { txid: tx.id('hex'), vout: 1, amt: 200_000n, sourceTransaction: tx },
      ],
    })
    expect(built).toMatchObject({ amount: 499_900n, fee: 100n })
    expect(built.tx.inputs).toHaveLength(2)
    expect(built.tx.outputs.map((o) => [o.satoshis, parseMneeTip(o.lockingScript.toHex())?.amt])).toEqual([
      [1, 499_900n],
      [1, 100n],
    ])
    expect(cosignedOwnerHash(built.tx.outputs[0]!.lockingScript.toHex())).toBe(
      Utils.toHex(Utils.fromBase58Check(recipient).data as number[]),
    )
    for (const input of built.tx.inputs) {
      const chunks = input.unlockingScript!.chunks
      expect(chunks).toHaveLength(2)
      expect(Utils.toHex(chunks[1]!.data!)).toBe(key.toPublicKey().toString())
    }
  })

  it('refuses a balance below the fee', async () => {
    const key = PrivateKey.fromRandom()
    const tx = sourceTx([{ script: mneeOutputScriptHex(key.toPublicKey().toAddress(), 50n, APPROVER) }])
    await expect(
      buildMneeSweep({
        key,
        recipient: key.toPublicKey().toAddress(),
        config: CONFIG,
        tips: [{ txid: tx.id('hex'), vout: 0, amt: 50n, sourceTransaction: tx }],
      }),
    ).rejects.toThrow(/below the cosigner fee/)
  })
})

describe('cosignedMatches', () => {
  it('accepts the cosigner adding signatures and nothing else', async () => {
    const key = PrivateKey.fromRandom()
    const tx = sourceTx([{ script: mneeOutputScriptHex(key.toPublicKey().toAddress(), 500_000n, APPROVER) }])
    const built = await buildMneeSweep({
      key,
      recipient: key.toPublicKey().toAddress(),
      config: CONFIG,
      tips: [{ txid: tx.id('hex'), vout: 0, amt: 500_000n, sourceTransaction: tx }],
    })
    const cosigned = cosign(built.tx)
    expect(cosigned.id('hex')).not.toBe(built.tx.id('hex'))
    expect(cosignedMatches(built.tx, cosigned)).toBe(true)

    const rerouted = cosign(built.tx)
    rerouted.outputs[0]!.lockingScript = LockingScript.fromHex(
      mneeOutputScriptHex(FEE_ADDRESS, 499_900n, APPROVER),
    )
    expect(cosignedMatches(built.tx, rerouted)).toBe(false)

    const extra = cosign(built.tx)
    extra.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(FEE_ADDRESS) })
    expect(cosignedMatches(built.tx, extra)).toBe(false)
  })
})

describe('sweepMneeFromKey', () => {
  const key = PrivateKey.fromRandom()
  const address = key.toPublicKey().toAddress()
  const recipient = PrivateKey.fromRandom().toPublicKey().toAddress()
  const source = sourceTx([
    { script: mneeOutputScriptHex(address, 300_000n, APPROVER) },
    { script: mneeOutputScriptHex(address, 200_000n, APPROVER) },
  ])
  const txid = source.id('hex')

  beforeEach(() => {
    vi.clearAllMocks()
    const beef = new Beef()
    beef.mergeTransaction(source)
    legacyBeef.buildLegacyInputBeef.mockResolvedValue({
      beef: beef.toBinary(),
      ready: [`${txid}.0`, `${txid}.1`],
      failures: [],
    })
  })

  function fakeMnee(opts: { tamper?: boolean; ticketStatus?: string } = {}) {
    const submitted: Transaction[] = []
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const u = new URL(input)
      expect(u.searchParams.get('auth_token')).toBe('92982ec1c0975f31979da515d46bae9f')
      if (u.pathname === '/v1/config') return Response.json({ ...CONFIG, fees: FEES })
      if (u.pathname === '/v2/utxos') {
        expect(JSON.parse(String(init?.body))).toEqual([address])
        return Response.json([
          { txid, vout: 0, owners: [address], data: { bsv21: { op: 'transfer', id: MNEE_TOKEN_ID, amt: 300_000 } } },
          { txid, vout: 1, owners: [address], data: { bsv21: { op: 'transfer', id: MNEE_TOKEN_ID, amt: 200_000 } } },
        ])
      }
      if (u.pathname === '/v2/transfer') {
        const { rawtx } = JSON.parse(String(init?.body)) as { rawtx: string }
        submitted.push(Transaction.fromBinary(Utils.toArray(rawtx, 'base64')))
        return new Response('"ticket-1"')
      }
      if (u.pathname === '/v2/ticket') {
        const final = cosign(submitted[0]!)
        if (opts.tamper) final.outputs[0]!.lockingScript = LockingScript.fromHex(mneeOutputScriptHex(FEE_ADDRESS, 499_900n, APPROVER))
        return Response.json({ status: opts.ticketStatus ?? 'SUCCESS', tx_id: final.id('hex'), tx_hex: final.toHex(), errors: opts.ticketStatus === 'FAILED' ? 'rejected' : null })
      }
      throw new Error(`unexpected ${u.pathname}`)
    })
    return { fetchImpl, submitted }
  }

  function wallet(chain: 'main' | 'test' = 'main') {
    const internalizeAction = vi.fn(async () => ({ accepted: true }))
    const active = {
      chain,
      address: recipient,
      services: { getRawTx: vi.fn() },
      wallet: { internalizeAction },
    } as unknown as ActiveWallet
    return { active, internalizeAction }
  }

  it('moves the whole balance through the cosigner and files it in Collect', async () => {
    const { fetchImpl, submitted } = fakeMnee()
    const { active, internalizeAction } = wallet()
    const result = await sweepMneeFromKey({ active, key, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} })
    expect(result).toMatchObject({ kind: 'moved', amount: 499_900n, fee: 100n, filed: true, unfinished: null })
    expect(submitted).toHaveLength(1)
    const final = cosign(submitted[0]!).id('hex')
    expect(result.kind === 'moved' && result.txid).toBe(final)
    expect(internalizeAction).toHaveBeenCalledTimes(1)
    const args = (internalizeAction.mock.calls[0] as unknown as [Record<string, any>])[0]
    expect(args.outputs).toHaveLength(1)
    expect(args.outputs[0]).toMatchObject({ outputIndex: 0, protocol: 'basket insertion' })
    expect(args.outputs[0].insertionRemittance.basket).toBe('1sat')
    expect(args.outputs[0].insertionRemittance.tags).toEqual(
      expect.arrayContaining(['ordinal', 'mnee', `origin:${final}.0`, 'collection:mnee', 'name:4.999 MNEE']),
    )
    expect(Beef.fromBinary(args.tx).atomicTxid).toBe(final)
    expect(importGuard.markOneSatImported).toHaveBeenCalledWith([`${final}.0`])
  })

  it('does not file a transaction the cosigner changed', async () => {
    const { fetchImpl } = fakeMnee({ tamper: true })
    const { active, internalizeAction } = wallet()
    const result = await sweepMneeFromKey({ active, key, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} })
    expect(result).toMatchObject({ kind: 'moved', filed: false })
    expect(internalizeAction).not.toHaveBeenCalled()
  })

  it('fails at the ticket when the cosigner rejects, filing nothing', async () => {
    const { fetchImpl } = fakeMnee({ ticketStatus: 'FAILED' })
    const { active, internalizeAction } = wallet()
    const result = await sweepMneeFromKey({ active, key, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} })
    expect(result).toEqual({ kind: 'failed', stage: 'ticket', message: 'rejected' })
    expect(internalizeAction).not.toHaveBeenCalled()
  })

  it('refuses off mainnet without calling MNEE', async () => {
    const { fetchImpl } = fakeMnee()
    const { active } = wallet('test')
    const result = await sweepMneeFromKey({ active, key, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toMatchObject({ kind: 'refused', reason: 'chain' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
