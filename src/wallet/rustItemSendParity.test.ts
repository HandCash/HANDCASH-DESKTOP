import fs from 'node:fs'
import path from 'node:path'
import { createActor, type AnyStateMachine } from 'xstate'
import { expect, it } from 'vitest'
import { collectableSendMachine } from './collectableSendMachine'
import { collectableSendRunMachine } from './collectableSendRunMachine'
import { itemSendMachine, maySenderBroadcast, isSilentSenderBroadcast, mustDeliverToPeer } from './itemSendMachine'
import { heldCollectableSendPath, chooseSendPath, classifyTipKind } from './collectableTipKind'
import { planCollectableSendRun, classifySendRunFailure, failedSendAttemptActivity } from './collectableSendRun'
import { splitItemMigrateBundle } from './itemMigrateBundle'

it('records item send routes, lifecycle and bulk fault policy from TS', () => {
  const record = (machine: AnyStateMachine, events: Array<Record<string, unknown> & { type: string }>) => {
    const actor = createActor(machine).start()
    const snapshot = () => {
      const snap = actor.getSnapshot()
      return { state: snap.value, context: snap.context }
    }
    const initial = snapshot()
    const steps = events.map(event => { actor.send(event); return { event, ...snapshot() } })
    actor.stop()
    return { initial, steps }
  }
  const collectable = [
    [{ type: 'SUCCESS', txid: 'stale' }, { type: 'START', outpoint: 'tip.0', sendPath: { path: 'p2pkhSend' } }, { type: 'RESET' }, { type: 'SUCCESS', txid: 'signed' }, { type: 'FAIL', error: 'late' }, { type: 'RESET' }],
    [{ type: 'START', outpoint: 'tip.1', sendPath: { path: 'refuse', reason: 'covenant' } }, { type: 'SUCCESS', txid: 'late' }, { type: 'RESET' }],
    [{ type: 'START', outpoint: 'tip.2', sendPath: { path: 'p2pkhSend' } }, { type: 'START', outpoint: 'other', sendPath: { path: 'p2pkhSend' } }, { type: 'FAIL', error: 'locked' }, { type: 'RESET' }],
  ].map(events => record(collectableSendMachine, events))
  const runs = [
    [{ type: 'START', legs: 2 }, { type: 'LEG_SENT', items: 3 }, { type: 'LEG_SENT', items: 2 }, { type: 'LEG_REJECTED', items: 2, reason: 'late' }, { type: 'RESET' }],
    [{ type: 'START', legs: 1 }, { type: 'LEG_REJECTED', items: 5, reason: 'spent' }, { type: 'LEG_SENT', items: 3 }, { type: 'LEG_REJECTED', items: 2, reason: 'spent' }, { type: 'LEG_REJECTED', items: 1, reason: 'spent' }, { type: 'LEG_SENT', items: 1 }, { type: 'RESET' }],
    [{ type: 'LEG_SENT', items: 99 }, { type: 'START', legs: 3 }, { type: 'RESET' }, { type: 'LEG_SENT', items: 1 }, { type: 'RUN_FAULT', remainingItems: 6, reason: 'offline' }, { type: 'LEG_SENT', items: 99 }, { type: 'RESET' }],
    [{ type: 'START', legs: 0 }, { type: 'LEG_SENT', items: 0 }, { type: 'RESET' }],
  ].map(events => record(collectableSendRunMachine, events))
  const items = []
  for (const settlePath of [
    { settle: 'peerDeliver', recipientIdentityKey: '02' + '11'.repeat(32) },
    { settle: 'selfReceive' },
    { settle: 'externalBroadcast', reason: 'no-peer-identity' },
  ]) {
    for (const created of [undefined, '', 'created-tx']) {
      const events = [
        { type: 'SIGNED', txid: 'stale' },
        { type: 'START', outpoint: 'tip.0', settlePath },
        { type: 'RESET' }, { type: 'BUILT' },
        { type: 'CREATED', ...(created === undefined ? {} : { txid: created }) },
        { type: 'SIGNED', txid: 'signed-tx' }, { type: 'SKIPPED' },
        { type: 'BROADCASTED' }, { type: 'FAIL', error: 'late' }, { type: 'RESET' },
      ]
      items.push(record(itemSendMachine, events))
    }
    for (const phase of ['building', 'createAction', 'signing', 'settling']) {
      const events: Array<Record<string, unknown> & { type: string }> = [{ type: 'START', outpoint: 'tip.0', settlePath }]
      if (phase !== 'building') events.push({ type: 'BUILT' })
      if (phase === 'signing' || phase === 'settling') events.push({ type: 'CREATED' })
      if (phase === 'settling') events.push({ type: 'SIGNED', txid: 'signed' })
      events.push({ type: 'FAIL', error: phase }, { type: 'BROADCASTED' }, { type: 'RESET' })
      items.push(record(itemSendMachine, events))
    }
  }
  for (const outcome of ['BROADCASTED', 'SKIPPED', 'FAIL']) {
    items.push(record(itemSendMachine, [
      { type: 'RETRY_BROADCAST', outpoint: 'tip.0', txid: 'already-signed' },
      { type: outcome, error: 'offline' }, { type: 'SIGNED', txid: 'late' }, { type: 'RESET' },
    ]))
  }
  // Observe policy at every stable state without executing any side effect.
  const policies = items.map(trace => [trace.initial, ...trace.steps].map(step => {
    const snapshot = { matches: (state: string) => step.state === state } as Parameters<typeof maySenderBroadcast>[0]
    return { state: step.state, mayBroadcast: maySenderBroadcast(snapshot), silent: isSilentSenderBroadcast(snapshot), mustDeliver: mustDeliverToPeer(snapshot) }
  }))
  const p2pkh = '76a914' + '11'.repeat(20) + '88ac'
  const paths = []
  for (const lockingScript of [undefined, '', ' ', p2pkh, '0X' + p2pkh.toUpperCase(), '0063' + p2pkh + '68', 'f' + p2pkh, 'ab'.repeat(40), 'zz', '51']) {
    for (const proven of [false, true]) for (const covenantLocked of [false, true]) {
      const input = { lockingScript, proven, covenantLocked }
      paths.push({ input, expected: heldCollectableSendPath(input) })
    }
  }
  const choices = []
  for (const script of ['', p2pkh, 'ab'.repeat(40)]) for (const provenTier of ['brc150', 'unproven'] as const) {
    for (const sendReady of [undefined, { ready: true } as const, { ready: false, reason: 'verifying' } as const, { ready: false, reason: 'unproven' } as const]) {
      const input = { tipKind: classifyTipKind(script), provenTier, sendReady }
      choices.push({ input, expected: chooseSendPath(input) })
    }
  }
  const plans = [[], [''], [' AA_0 ', 'aa.0', 'BB.2', 'bb_2'], ['weird_x', 'weird_x'], Array.from({ length: 100 }, (_, i) => 'tip_' + i)]
    .map(input => ({ input, expected: planCollectableSendRun(input), split: splitItemMigrateBundle(input), activity: failedSendAttemptActivity(input.length) }))
  const failures = [
    'wallet locked', 'wallet is locked', 'no wallet', 'not enough BSV', 'insufficient', 'invalid recipient', 'select at least one', 'cancelled', 'canceled',
    'offline', 'no network', 'network', 'fetch failed', 'timed out', 'timeout', 'status 429', 'status 500', 'status 502', 'status 503', 'status 504',
    'ancestry incomplete', 'ancestry_incomplete', 'beef_ancestry_incomplete', 'without create transaction', 'missing source transaction',
    'collectable is no longer in this wallet', 'collectable is no longer unspent', 'collectable utxo is not a 1-sat ordinal', 'is no longer spendable',
    'input already spent', 'already-spent input', 'already spent input', 'double spend', 'doublespend', 'txn-mempool-conflict', 'bad-txns-inputs-missingorspent',
    'novel failure', '', 'NETWORK input already spent', 'wallet locked network', 'missing source transaction double spend',
  ].map(input => ({ input, expected: classifySendRunFailure(new Error(input)) }))
  const fixture = { collectable, runs, items, policies, paths, choices, plans, failures }
  const directory = path.resolve('native-desktop/fixtures/item-send')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'traces.json'), JSON.stringify(fixture, null, 2) + '\n')
  expect(items).toHaveLength(24)
  expect(paths).toHaveLength(40)
})
