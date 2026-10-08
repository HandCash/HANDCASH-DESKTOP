import { describe, expect, it } from 'vitest'
import {
  decideLanding,
  QUEUED_EVIDENCE_AFTER_MS,
  withArcadeConflict,
  type LandingEvidence,
} from './landingFate'

const SPENDER = '59a99dc737b29920c847f583ec1022023dad7583790dbdabe253c5c0868f85d5'
const PARENT = '95936498eda958249c465029dc10d75f02fbfdeefb0ac48f282cfb9aba160198'
const stalled = {
  kind: 'stalled' as const,
  status: 'PENDING_RETRY',
  reason: 'failed to validate transaction',
}
const none: LandingEvidence = { onChain: false, spentElsewhere: [], rejectedParents: [] }

describe('decideLanding', () => {
  it('is landed once a node holds it', () => {
    expect(
      decideLanding({ arcade: { kind: 'landed', status: 'SEEN_ON_NETWORK' }, elapsedMs: 5_000 }).kind,
    ).toBe('landed')
  })

  it('waits on a fresh 202 without asking the chain', () => {
    expect(
      decideLanding({ arcade: { kind: 'queued', status: 'RECEIVED' }, elapsedMs: 5_000 }).kind,
    ).toBe('waiting')
  })

  it('asks the chain when Arcade stalls or a 202 goes quiet', () => {
    expect(decideLanding({ arcade: stalled, elapsedMs: 5_000 }).kind).toBe('gatherEvidence')
    expect(
      decideLanding({
        arcade: { kind: 'queued', status: 'STORED' },
        elapsedMs: QUEUED_EVIDENCE_AFTER_MS,
      }).kind,
    ).toBe('gatherEvidence')
    expect(decideLanding({ arcade: { kind: 'rejected', reason: 'x' }, elapsedMs: 0 }).kind).toBe(
      'gatherEvidence',
    )
  })

  it('declares a stalled cheque dead when a confirmed foreign tx spent an input', () => {
    const fate = decideLanding({
      arcade: stalled,
      elapsedMs: 30_000,
      evidence: { ...none, spentElsewhere: [{ outpoint: 'd4c1.7', spender: SPENDER }] },
    })
    expect(fate).toMatchObject({ kind: 'dead', cause: 'input-spent-elsewhere' })
  })

  it('declares a cheque dead when it spends change of a dead parent', () => {
    const fate = decideLanding({
      arcade: stalled,
      elapsedMs: 30_000,
      evidence: { ...none, rejectedParents: [PARENT] },
    })
    expect(fate).toMatchObject({ kind: 'dead', cause: 'parent-rejected' })
  })

  it('never kills a stalled cheque on silence alone', () => {
    expect(decideLanding({ arcade: stalled, elapsedMs: 30 * 60_000, evidence: none }).kind).toBe(
      'waiting',
    )
    expect(
      decideLanding({
        arcade: stalled,
        elapsedMs: 30_000,
        evidence: { ...none, onChain: null },
      }).kind,
    ).toBe('waiting')
  })

  it('treats anything on chain as landed, whatever Arcade says', () => {
    expect(
      decideLanding({
        arcade: { kind: 'rejected', reason: 'DOUBLE_SPEND_ATTEMPTED' },
        elapsedMs: 30_000,
        evidence: {
          onChain: true,
          spentElsewhere: [{ outpoint: 'x.0', spender: SPENDER }],
          rejectedParents: [],
        },
      }).kind,
    ).toBe('landed')
  })

  it('takes an Arcade rejection as dead once the chain has been asked', () => {
    expect(
      decideLanding({
        arcade: { kind: 'rejected', reason: 'UTXO_SPENT' },
        elapsedMs: 30_000,
        evidence: none,
      }),
    ).toMatchObject({ kind: 'dead', cause: 'arcade-rejected' })
  })

  it('names the spender an Arcade 466 carries even when the probes were silent', () => {
    const conflict = { outpoint: `${PARENT}.1`, spender: SPENDER }
    const arcade = { kind: 'rejected' as const, reason: 'UTXO_SPENT (70)', conflict }
    expect(withArcadeConflict(none, arcade).spentElsewhere).toEqual([conflict])
    expect(
      withArcadeConflict({ ...none, spentElsewhere: [conflict] }, arcade).spentElsewhere,
    ).toHaveLength(1)
    expect(decideLanding({ arcade, elapsedMs: 30_000, evidence: none })).toMatchObject({
      kind: 'dead',
      cause: 'input-spent-elsewhere',
    })
  })

  it('waits out an Arcade give-up the same as any stall', () => {
    const gaveUp = {
      kind: 'stalled' as const,
      status: 'REJECTED',
      reason: 'no network verdict after 288 durable retry attempts: giving up',
    }
    expect(decideLanding({ arcade: gaveUp, elapsedMs: 0 }).kind).toBe('gatherEvidence')
    expect(decideLanding({ arcade: gaveUp, elapsedMs: 0, evidence: none }).kind).toBe('waiting')
  })
})
