import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createActor, waitFor } from 'xstate'

vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => ({ instance: { chain: 'main' } }) }))
vi.mock('../paymentPolicy', () => ({ assertOnlineForPayment: vi.fn() }))
vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./store', () => ({ loadImportedSources: vi.fn(), updateImportedSource: vi.fn() }))
vi.mock('./importSource', () => ({ keyDeriverFor: vi.fn(() => ({ templates: [], fixed: [] })) }))
vi.mock('./discovery', () => ({
  discoverAddresses: vi.fn(),
  wocHistoryLookup: vi.fn(() => 'history'),
  gorillaItemsLookup: vi.fn(() => 'items'),
}))
vi.mock('./holdings', () => ({ inspectHoldings: vi.fn(), emptyHoldings: vi.fn(), addCashOutput: vi.fn() }))
vi.mock('./items', () => ({ knownAddresses: vi.fn(), checkUtxoSetItems: vi.fn() }))
vi.mock('./handcashUtxoSet', () => ({
  fetchHandCashUtxoSet: vi.fn(), verifyUtxoSet: vi.fn(), readUnspentOnChain: vi.fn(),
}))

import { scanImportedSource, AddressWalkAvailableError } from './scan'
import { loadImportedSources, updateImportedSource, type ImportedSource } from './store'
import { fetchHandCashUtxoSet, verifyUtxoSet, readUnspentOnChain } from './handcashUtxoSet'
import { checkUtxoSetItems } from './items'
import { discoverAddresses } from './discovery'
import { inspectHoldings } from './holdings'
import { legacyImportMachine } from '../../machines/legacyImportMachine'
import { appendAppLog } from '../appLog'

const source = { id: 'saved', secret: { kind: 'handcash', first: 'one', second: 'two' } } as ImportedSource

describe('explicit HandCash address walk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadImportedSources).mockResolvedValue([source])
    vi.mocked(updateImportedSource).mockImplementation(async (_id, patch) => ({ ...source, ...patch }))
    vi.mocked(discoverAddresses).mockResolvedValue({ addresses: [], checked: 5, complete: true })
    vi.mocked(inspectHoldings).mockResolvedValue([])
  })

  it.each(['refused', 'failed', 'underived'] as const)('stops on %s, including with a gap override, until the user requests a walk', async (reason) => {
    if (reason === 'failed') vi.mocked(fetchHandCashUtxoSet).mockRejectedValue(new Error('offline'))
    else vi.mocked(fetchHandCashUtxoSet).mockResolvedValue(reason === 'refused'
      ? { kind: 'refused', reason: 'unavailable' }
      : { kind: 'fetched', utxos: [] })
    vi.mocked(verifyUtxoSet).mockResolvedValue({
      rejected: 1,
      rejectedBy: { path: 0, address: 0, script: 0 },
      addresses: [],
      cashOutputs: new Map(),
      itemOutpoints: new Map(),
      readAddresses: new Set(),
      unsupported: 0
    } as Awaited<ReturnType<typeof verifyUtxoSet>>)

    await expect(scanImportedSource({ sourceId: source.id, gap: 5 })).rejects.toBeInstanceOf(AddressWalkAvailableError)
    expect(discoverAddresses).not.toHaveBeenCalled()
    expect(inspectHoldings).not.toHaveBeenCalled()
    expect(updateImportedSource).not.toHaveBeenCalled()

    const actor = createActor(legacyImportMachine).start()
    actor.send({ type: 'LOADED' })
    actor.send({ type: 'OPEN', sourceId: source.id })
    actor.send({ type: 'WALK_ADDRESSES' })
    expect(actor.getSnapshot().matches({ source: 'viewing' })).toBe(true)
    actor.send({ type: 'RESCAN' })
    actor.send({ type: 'FAIL', error: 'UTXO service unavailable', addressWalkAvailable: true })
    await waitFor(actor, (s) => s.matches({ source: 'viewing' }))
    expect(actor.getSnapshot().context.addressWalkAvailable).toBe(true)
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().matches({ source: 'viewing' })).toBe(true)

    actor.send({ type: 'WALK_ADDRESSES' })
    await waitFor(actor, (s) => s.matches({ source: 'scanning' }))
    const result = await scanImportedSource({ sourceId: source.id, addressWalk: true })
    expect(fetchHandCashUtxoSet).toHaveBeenCalledTimes(1)
    expect(discoverAddresses).toHaveBeenCalledWith(expect.objectContaining({ history: 'history', items: 'items' }))
    expect(inspectHoldings).toHaveBeenCalledWith(expect.objectContaining({ addresses: [] }))
    expect(result.scan).toMatchObject({ checked: 5, complete: true })
    actor.send({ type: 'SCANNED' })
    expect(actor.getSnapshot().context.addressWalkAvailable).toBe(false)
    actor.stop()
  })
})

describe('address walk refusal reason', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadImportedSources).mockResolvedValue([source])
    vi.mocked(inspectHoldings).mockResolvedValue([])
  })

  it.each([
    ['unknown-keys', 'HandCash has no account for these keys'],
    ['unavailable', 'the HandCash service did not answer'],
    ['bad-response', 'the HandCash answer did not open or parse'],
    ['stopped', 'the scan was stopped'],
  ] as const)('shows the %s reason to the user and in the app log', async (reason, text) => {
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({ kind: 'refused', reason, detail: `${reason}-detail` })

    const failure = await scanImportedSource({ sourceId: source.id, gap: 5 }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AddressWalkAvailableError)
    expect((failure as AddressWalkAvailableError).refusal).toEqual({ reason, detail: `${reason}-detail` })
    expect((failure as Error).message).toContain(`Reason: ${text} (${reason}-detail).`)
    expect(appendAppLog).toHaveBeenCalledWith('warn', expect.stringContaining(`utxo scan refused reason=${reason} detail=${reason}-detail`))
    expect(discoverAddresses).not.toHaveBeenCalled()
  })

  it('shows an underived refusal to the user and in the app log when no rows derive', async () => {
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({ kind: 'fetched', utxos: [] })
    vi.mocked(verifyUtxoSet).mockResolvedValue({
      rejected: 2,
      rejectedBy: { path: 0, address: 0, script: 2 },
      addresses: [],
      cashOutputs: new Map(),
      itemOutpoints: new Map(),
      readAddresses: new Set(),
      unsupported: 0
    } as Awaited<ReturnType<typeof verifyUtxoSet>>)

    const failure = await scanImportedSource({ sourceId: source.id, gap: 5 }).catch((e: unknown) => e)
    expect((failure as AddressWalkAvailableError).refusal).toEqual({ reason: 'underived', detail: 'rejected=2 (script=2)' })
    expect((failure as Error).message).toContain('Reason: no rows could be derived to these keys (rejected=2 (script=2)).')
    expect(appendAppLog).toHaveBeenCalledWith('warn', expect.stringContaining('utxo set rejected 2 rows breakdown=script=2'))
  })

  it('scans derived rows even when some rows are rejected', async () => {
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({ kind: 'fetched', utxos: [] })
    vi.mocked(verifyUtxoSet).mockResolvedValue({
      rejected: 2,
      rejectedBy: { path: 0, address: 0, script: 2 },
      addresses: [{ path: "m/0/0", address: "1Test", label: "HandCash", wallets: "HandCash" }],
      cashOutputs: new Map([["1Test", [{ outpoint: "abc_0", txid: "abc", vout: 0, satoshis: 1000 }]]]),
      itemOutpoints: new Map(),
      readAddresses: new Set(),
      unsupported: 0
    } as Awaited<ReturnType<typeof verifyUtxoSet>>)
    vi.mocked(readUnspentOnChain).mockResolvedValue({ unspent: new Set(["abc_0"]), unknown: new Set(), stopped: false })
    vi.mocked(checkUtxoSetItems).mockResolvedValue({ unspent: new Set(), failed: 0, stopped: false })
    vi.mocked(inspectHoldings).mockResolvedValue([{ address: "1Test", path: "m/0/0", label: "HandCash", balance: 1000, itemCount: 0, error: undefined }])

    const result = await scanImportedSource({ sourceId: source.id, gap: 5 })
    expect(result.scan).toBeDefined()
    expect(result.scan?.addresses).toHaveLength(1)
    expect(result.scan?.holdings).toHaveLength(1)
    expect(updateImportedSource).toHaveBeenCalled()
    expect(appendAppLog).toHaveBeenCalledWith('warn', expect.stringContaining('utxo set rejected 2 rows breakdown=script=2'))
  })

  it('shows a thrown scan error as the reason instead of hiding it', async () => {
    vi.mocked(fetchHandCashUtxoSet).mockRejectedValue(new Error('offline'))

    const failure = await scanImportedSource({ sourceId: source.id, gap: 5 }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AddressWalkAvailableError)
    expect((failure as AddressWalkAvailableError).refusal).toEqual({ reason: 'error', detail: 'offline' })
    expect((failure as Error).message).toContain('Reason: the scan failed (offline).')
  })
})
