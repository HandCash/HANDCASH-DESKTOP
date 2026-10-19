import { MerklePath, type ChainTracker } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let services: unknown = null
vi.mock('./session', () => ({ getActiveWallet: () => (services ? { services } : null) }))

const { verifyBumpFinality } = await import('./spvFinality')

const TXID = 'ab'.repeat(32)
const SIBLING = 'cd'.repeat(32)
const HEIGHT = 971_737
const path = new MerklePath(HEIGHT, [
  [
    { offset: 0, hash: SIBLING },
    { offset: 1, hash: TXID, txid: true },
  ],
])
const root = path.computeRoot(TXID)
const tracker = (valid: boolean | 'root'): ChainTracker => ({
  isValidRootForHeight: async (r, h) => (valid === 'root' ? r === root && h === HEIGHT : valid),
  currentHeight: async () => HEIGHT + 1,
})

/** The toolbox `Services` shape: a result carrying the path, and the tracker behind a method. */
const servicesWith = (merklePath: MerklePath | undefined, chainTracker: ChainTracker) => ({
  getMerklePath: vi.fn(async () => ({ notes: [], ...(merklePath ? { merklePath } : {}) })),
  getChainTracker: vi.fn(async () => chainTracker),
})

beforeEach(() => {
  services = null
})

describe('verifyBumpFinality', () => {
  it('is final once the path from the services result verifies against the chain tracker', async () => {
    services = servicesWith(path, tracker('root'))
    expect(await verifyBumpFinality(TXID)).toEqual({ ok: true, height: HEIGHT })
  })

  it('refuses a path whose root the chain does not hold', async () => {
    services = servicesWith(path, tracker(false))
    expect(await verifyBumpFinality(TXID)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('has no proof while no provider holds a path (still in the mempool)', async () => {
    services = servicesWith(undefined, tracker('root'))
    expect(await verifyBumpFinality(TXID)).toEqual({ ok: false, reason: 'no_proof' })
  })

  it('says why it cannot judge: no wallet, or services without the calls', async () => {
    expect(await verifyBumpFinality(TXID)).toEqual({ ok: false, reason: 'no_wallet' })
    services = { getMerklePath: async () => ({ merklePath: path }) }
    expect(await verifyBumpFinality(TXID)).toMatchObject({ ok: false, reason: 'unknown', detail: 'merkle/chainTracker unavailable' })
  })
})
