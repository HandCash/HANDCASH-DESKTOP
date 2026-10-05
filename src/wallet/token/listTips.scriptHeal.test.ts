import { LockingScript, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBsv21ValueLock } from './sendPlan'

const TOKEN = `${'ab'.repeat(32)}_0`
const ADDR = PrivateKey.fromRandom().toAddress()

function tipTx(seed: string, amount: bigint): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: seed.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(ADDR) })
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(buildBsv21ValueLock({ tokenId: TOKEN, amount, address: ADDR })),
  })
  return tx
}

const local = tipTx('11', 900n)
const onChain = tipTx('22', 100n)
const forged = tipTx('33', 5000n)
const LOCAL_ID = local.id('hex')
const CHAIN_ID = onChain.id('hex')
const FORGED_ID = '44'.repeat(32)

const updateOutput = vi.fn(async (_id: number, _update: { lockingScript: number[] }) => 1)
const listFungibles = vi.fn(async () => [])
const outputIds: Record<string, number> = {
  [`${LOCAL_ID}:1`]: 7,
  [`${CHAIN_ID}:1`]: 8,
  [`${FORGED_ID}:1`]: 9,
}

const wallet = {
  chain: 'main',
  identityKey: '03' + 'aa'.repeat(32),
  address: ADDR,
  wallet: {
    listOutputs: async () => ({
      totalOutputs: 3,
      outputs: [LOCAL_ID, CHAIN_ID, FORGED_ID].map((txid) => ({
        outpoint: `${txid}.1`,
        satoshis: 1,
        tags: [`bsv21:${TOKEN}`],
        customInstructions: JSON.stringify({ id: TOKEN, amt: '1', op: 'transfer' }),
      })),
    }),
    storage: {
      runAsStorageProvider: async <T,>(fn: (sp: unknown) => Promise<T>) =>
        fn({
          findUserByIdentityKey: async () => ({ userId: 1 }),
          findOutputs: async ({ partial }: { partial: { txid: string; vout: number } }) => {
            const id = outputIds[`${partial.txid}:${partial.vout}`]
            return id ? [{ outputId: id }] : []
          },
          updateOutput,
        }),
    },
  },
}

vi.mock('../session', () => ({ getActiveWallet: () => wallet }))
vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => ({ instance: wallet }) }))

vi.mock('../beefCache', async (importActual) => ({
  ...(await importActual<typeof import('../beefCache')>()),
  getLocalTxForTxid: async (_wallet: unknown, txid: string) => (txid === LOCAL_ID ? local : null),
}))

vi.mock('../oneSatImport', () => ({
  fetchRawTxHex: async (txid: string) => {
    if (txid === CHAIN_ID) return onChain.toHex()
    // An answer whose body does not hash to the asked txid.
    if (txid === FORGED_ID) return forged.toHex()
    return null
  },
}))

vi.mock('./list', () => ({ listFungibles: () => listFungibles() }))

describe('token rows storage lists without their lock', () => {
  beforeEach(() => {
    updateOutput.mockClear()
    listFungibles.mockClear()
  })

  it('takes the lock from the transaction body — local inline, chain after — and writes it back', async () => {
    const { listHeldFungibleTips } = await import('./listTips')
    const tips = await listHeldFungibleTips(wallet as never)

    expect(tips.map((t) => [t.outpoint, t.amt, t.encoding])).toEqual([
      [`${LOCAL_ID}_1`, '900', 'brc162'],
    ])

    await vi.waitFor(() => expect(listFungibles).toHaveBeenCalled())
    const written = new Map(updateOutput.mock.calls.map(([id, u]) => [id, u.lockingScript]))
    expect([...written.keys()].sort()).toEqual([7, 8])
    expect(Buffer.from(written.get(8)!).toString('hex')).toBe(onChain.outputs[1]!.lockingScript.toHex())
  })
})
