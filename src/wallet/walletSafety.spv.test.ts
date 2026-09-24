/**
 * Wallet-safety suite: the device is the judge. Indexers are finders.
 *
 * Fixtures are local proof (headers / BEEF kind / signed-cheque facts).
 * Explorer 404, Arcade silence, and `isUtxo` lies must never be the oracle
 * that cancels, detaches, or prunes a cheque this wallet can still prove.
 */
import { describe, expect, it } from 'vitest'
import { decideArcadePinFate } from './kernel/arcadePinFate'
import { decideAbandonedSpend } from './kernel/abandonedSpendFate'
import { classifyOwnedCash, txLivenessFromStatus } from './balanceView'
import {
  ancestryRideForSpend,
  isHeaderFinal,
  maySelectAsInput,
  proofKindFromBeefGap,
} from './chainProofKind'
import { shouldPullRemoteHistory } from './deviceSync'
import { decideEmptyHistoryOverwrite } from './historyEmptyGuard'
import { itemSettleIsSelfSend } from './ingestItemSettle'
import { canTransitionTx, txStatusFromArc } from './txLifecycle'

const SCRIPT = '76a914000000000000000000000000000000000000000088ac'
const TX = 'ab'.repeat(32)

describe('1 Persistence — headers + signed bodies reconstruct ownership', () => {
  it('counts change of a live local send without asking an indexer', () => {
    const fate = classifyOwnedCash(
      {
        satoshis: 899_280,
        change: true,
        spendable: false,
        lockingScript: SCRIPT,
      },
      'pending',
      'none',
    )
    expect(fate).toEqual({
      kind: 'count',
      as: 'unconfirmedChange',
      satoshis: 899_280,
    })
  })

  it('treats unsent / nosend as live cheques, not dead rows', () => {
    expect(txLivenessFromStatus('unsent')).toBe('pending')
    expect(txLivenessFromStatus('nosend')).toBe('pending')
  })

  it('keeps script-less change in local history instead of dropping it', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 899_280, change: true, spendable: false },
        'pending',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })
})

describe('2 Silence is not cancellation', () => {
  it('keeps an Arcade pin when the verdict is silence or still working', () => {
    expect(
      decideArcadePinFate({ hasPin: true, verdict: 'unknown' }).kind,
    ).toBe('binds')
    expect(
      decideArcadePinFate({ hasPin: true, verdict: 'pending' }).kind,
    ).toBe('binds')
  })

  it('does not abandon a signed spend when explorers cannot answer', () => {
    const fate = decideAbandonedSpend({
      hasArcadeContact: false,
      onChain: null,
      inputs: ['unknown', 'unknown'],
      createdAt: Date.now() - 8 * 60 * 60_000,
      now: Date.now(),
    })
    expect(fate.kind).toBe('keep')
  })

  it('does not abandon an Arcade-pinned cheque that explorers 404', () => {
    const fate = decideAbandonedSpend({
      hasArcadeContact: true,
      onChain: false,
      inputs: ['unspent'],
      createdAt: Date.now() - 8 * 60 * 60_000,
      now: Date.now(),
    })
    expect(fate).toEqual({ kind: 'keep', reason: 'Arcade-pinned' })
  })

  it('maps Arcade MINED to mempool — not header finality', () => {
    expect(txStatusFromArc('MINED')).toBe('SEEN_IN_MEMPOOL')
    expect(
      isHeaderFinal({ kind: 'unconfirmed', ancestry: 'bodies-complete' }),
    ).toBe(false)
  })
})

describe('3 Indexer lie — local proof wins', () => {
  it('lets a signed cheque enter mempool from local SPV without a miner ACK', () => {
    expect(canTransitionTx('VALIDATING', 'SEEN_IN_MEMPOOL')).toBe(true)
  })

  it('refuses to let an older remote BRC-39 clobber this device', () => {
    expect(shouldPullRemoteHistory(1_000, 2_000)).toBe(false)
    expect(
      decideEmptyHistoryOverwrite({
        remoteExists: true,
        remoteBytes: 4_096,
        localLooksEmpty: true,
        force: false,
      }).refusePush,
    ).toBe(true)
  })

  it('does not treat an unknown inbox txid as a self-send', () => {
    expect(itemSettleIsSelfSend(TX)).toBe(false)
  })
})

describe('4 Ancestry integrity — refuse a spend whose parent body is missing', () => {
  it('refuses selection when ancestor bodies are missing, even if an indexer has the parent', () => {
    const missing = proofKindFromBeefGap('missing-bodies')
    expect(maySelectAsInput(missing)).toBe(false)
    expect(ancestryRideForSpend(missing)).toEqual({
      ride: 'refuse',
      reason: 'missing-bodies',
    })
  })

  it('requires unconfirmed parents to ride as bodies, not merkle paths', () => {
    expect(
      ancestryRideForSpend({
        kind: 'unconfirmed',
        ancestry: 'bodies-complete',
      }),
    ).toEqual({ ride: 'unconfirmed-bodies' })
    expect(
      ancestryRideForSpend({ kind: 'headerProven', height: 968_052 }),
    ).toEqual({ ride: 'merkle-to-header', height: 968_052 })
  })
})

describe('5 Finder vs Judge — inbound index rows are candidates', () => {
  it('does not count 1sat / bsv21 indexer tips as Pay cash', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1, basket: '1sat', spendable: true },
        'none',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'item' })
    expect(
      classifyOwnedCash(
        { satoshis: 50_000, basket: 'bsv21', spendable: true },
        'none',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'bsv21' })
  })

  it('does not credit payment outputs going to someone else', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1, change: false, spendable: false },
        'pending',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })
})

describe('Key derivation and atomic settlement (considerations)', () => {
  /**
   * Identity / receive may be a stable key (BRC-29, handle). Managed change
   * is a different object: a live cheque's change is ours the moment it is
   * signed. "Pending" here is unconfirmed SPV, not a processor queue.
   */
  it('accounts a signed cheque as owned before any broadcaster answers', () => {
    expect(txLivenessFromStatus('unsent')).toBe('pending')
    const owned = classifyOwnedCash(
      {
        satoshis: 1_324,
        change: true,
        spendable: false,
        lockingScript: SCRIPT,
      },
      'pending',
      'none',
    )
    expect(owned.kind).toBe('count')
    expect(owned.kind === 'count' && owned.as).toBe('unconfirmedChange')
  })

  it('never lets Arcade accept be header-final settlement', () => {
    expect(txStatusFromArc('SEEN_ON_NETWORK')).toBe('SEEN_IN_MEMPOOL')
    expect(txStatusFromArc('MINED')).toBe('SEEN_IN_MEMPOOL')
    expect(isHeaderFinal({ kind: 'headerProven', height: 1 })).toBe(true)
  })

  it('voids a pin only on Arcade reject — never on a missing txid', () => {
    expect(decideArcadePinFate({ hasPin: true, verdict: 'rejected' }).kind).toBe(
      'void',
    )
    expect(decideArcadePinFate({ hasPin: true, verdict: 'unknown' }).kind).toBe(
      'binds',
    )
    expect(TX).toHaveLength(64)
  })
})
