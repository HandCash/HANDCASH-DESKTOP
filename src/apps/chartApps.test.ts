import { describe, expect, it, vi } from 'vitest'
import { createActor, waitFor } from 'xstate'
import { PrivateKey } from '@bsv/sdk'
import { BUILTIN_CHARTS, BUILTIN_CHART_HASHES, builtinApps } from './builtin'
import { chartHash, signChart, verifyChartSignature } from './chartSignature'
import { validateChart, verifyChart } from './chartValidator'
import { approvalFor, effectNeedsApproval } from './chartEffects'
import { chartPosition, machineFromChart } from './chartRunner'
import { interpolate } from './chartFormat'
import type {
  BoxMessage,
  ChartApp,
  ChartEffectPorts,
  ChartWalletSupport,
  EffectResult,
  Recipient,
  ResolvedEffect,
  UnsignedChartApp,
} from './chartTypes'

const SUPPORT: ChartWalletSupport = { coins: [{ coin: 'BSV', network: 'mainnet' }], boxes: ['inbox'] }

const key = (n: number) => PrivateKey.fromHex(n.toString(16).padStart(64, '0'))
const ALICE: Recipient = { id: 'f-alice', label: '$alice', identityKey: key(11).toPublicKey().toString() }
const BOB: Recipient = { id: 'f-bob', label: '$bob', identityKey: key(12).toPublicKey().toString() }
const CAROL: Recipient = { id: 'f-carol', label: '$carol', identityKey: key(13).toPublicKey().toString() }

function builtin(id: string): ChartApp {
  const raw = BUILTIN_CHARTS.find((c) => (c as { id: string }).id === id)
  const v = verifyChart(raw, SUPPORT, { expectedHash: BUILTIN_CHART_HASHES[id] })
  if (!v.ok) throw new Error(`${id}: ${v.errors.join('; ')}`)
  return v.chart
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** Re-sign a modified chart under a test author, so only the change under test can fail it. */
function resign(chart: UnsignedChartApp): ChartApp {
  const author = key(99)
  return signChart({ ...chart, author: { ...chart.author, identityKey: author.toPublicKey().toString() } }, author.toHex())
}

function fakePorts(results: Partial<Record<ResolvedEffect['kind'], EffectResult>> = {}) {
  const ran: ResolvedEffect[] = []
  const ports: ChartEffectPorts = {
    run: vi.fn(async (effect: ResolvedEffect) => {
      ran.push(effect)
      return results[effect.kind] ?? { kind: 'none' }
    }),
  }
  return { ports, ran }
}

function start(chart: ChartApp, ports: ChartEffectPorts) {
  return createActor(machineFromChart(chart, { ports, network: 'mainnet' })).start()
}

const at = (actor: ReturnType<typeof start>) => chartPosition(actor.getSnapshot().value)

describe('chart validator', () => {
  it('accepts every built-in app, signed and matching its pinned hash', () => {
    const apps = builtinApps(SUPPORT)
    expect(apps.map((a) => a.id)).toEqual(['payment-request', 'tip-jar', 'split-bill', 'send-item', 'message-box'])
    for (const app of apps) expect(app.verification.ok, app.id).toBe(true)
  })

  it('refuses a tampered chart: the hash it was shared under no longer matches', () => {
    const tampered = clone(BUILTIN_CHARTS[1]) as ChartApp
    ;(tampered.states.compose.on!.TIP_SMALL as { assign: Record<string, number> }).assign.amount = 1_000_000
    const v = verifyChart(tampered, SUPPORT, { expectedHash: BUILTIN_CHART_HASHES['tip-jar'] })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('hash')
  })

  it('refuses a tampered chart without a pinned hash: the signature no longer matches', () => {
    const tampered = clone(BUILTIN_CHARTS[0]) as ChartApp
    tampered.summary = 'Send all your Bitcoin SV to me.'
    expect(verifyChartSignature(tampered)).toBe(false)
    const v = verifyChart(tampered, SUPPORT)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('signature')
  })

  it('refuses an effect kind the format does not declare', () => {
    const chart = clone(builtin('tip-jar')) as unknown as Record<string, any>
    chart.effects.drain = { kind: 'sweepWallet', to: { field: 'friend' } }
    const v = validateChart(chart)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/undeclared effect kind sweepWallet/)
  })

  it('refuses a state that runs an effect the chart did not declare', () => {
    const chart = clone(builtin('tip-jar'))
    chart.states.tipping.effect = 'secretSend'
    const v = validateChart(chart)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/undeclared effect secretSend/)
  })

  it('refuses unknown keys, undeclared fields and loose fetch addresses', () => {
    const extra = clone(builtin('payment-request')) as unknown as Record<string, any>
    extra.script = 'alert(1)'
    expect(validateChart(extra).ok).toBe(false)

    const field = clone(builtin('payment-request'))
    field.states.compose.view!.push({ block: 'textInput', field: 'password', label: 'Password' })
    expect(validateChart(field).ok).toBe(false)

    const fetchy = clone(builtin('payment-request')) as unknown as Record<string, any>
    fetchy.fields.page = { type: 'fetched' }
    fetchy.effects.read = { kind: 'fetch', url: 'http://example.com/', result: 'page' }
    const v = validateChart(fetchy)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/one fixed https address/)
  })

  it('needs an onDecline for every effect that asks first', () => {
    const chart = clone(builtin('tip-jar'))
    delete chart.states.tipping.onDecline
    expect(validateChart(chart).ok).toBe(false)
  })

  it('refuses an app that needs a coin or network the wallet does not offer', () => {
    const btc = clone(builtin('tip-jar')) as unknown as Record<string, any>
    btc.effects.tip.coin = 'BTC'
    btc.fields.amount.coin = 'BTC'
    const v = verifyChart(resign(btc as UnsignedChartApp), SUPPORT)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('unsupported')
      expect(v.errors[0]).toMatch(/Bitcoin on mainnet/)
    }
    const testnetOnly = clone(builtin('tip-jar'))
    ;(testnetOnly.effects.tip as { networks: string[] }).networks = ['testnet']
    expect(verifyChart(resign(testnetOnly), SUPPORT).ok).toBe(false)
  })

  it('refuses a message box the wallet keeps for itself', () => {
    const chart = clone(builtin('message-box')) as unknown as Record<string, any>
    chart.effects.list.boxes = ['inbox', 'account-holding']
    const v = verifyChart(resign(chart as UnsignedChartApp), SUPPORT)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/account-holding/)
  })

  it('hashes canonical JSON, so key order and spacing do not change the hash', () => {
    const chart = builtin('send-item')
    const reordered = Object.fromEntries(Object.entries(chart).reverse()) as ChartApp
    expect(chartHash(reordered)).toBe(chartHash(chart))
    expect(verifyChartSignature(reordered)).toBe(true)
  })
})

describe('chart runner and approval', () => {
  it('effects that move money, share identity, clear or block ask first', () => {
    for (const kind of ['sendPayment', 'requestPayment', 'sendItem', 'signMessage', 'deleteMessages', 'blockSender'] as const) {
      expect(effectNeedsApproval(kind), kind).toBe(true)
    }
    for (const kind of ['fetch', 'listMessages', 'acknowledgeMessages', 'unblockSender'] as const) {
      expect(effectNeedsApproval(kind), kind).toBe(false)
    }
  })

  it('only takes input for fields the current state shows', () => {
    const actor = start(builtin('payment-request'), fakePorts().ports)
    actor.send({ type: 'SET', field: 'amount', value: '2500' })
    expect(actor.getSnapshot().context.values.amount).toBe(2500)
    actor.send({ type: 'SET', field: 'amount', value: '12abc' })
    expect(actor.getSnapshot().context.values.amount).toBe(2500)
    actor.send({ type: 'SET', field: 'friend', value: { id: 'x', label: 'x', identityKey: 'not-a-key' } })
    expect(actor.getSnapshot().context.values.friend).toBeUndefined()
  })

  it('declining an approval runs nothing and returns to the form', () => {
    const { ports, ran } = fakePorts()
    const actor = start(builtin('payment-request'), ports)
    actor.send({ type: 'SET', field: 'friend', value: ALICE })
    actor.send({ type: 'SET', field: 'amount', value: 2500 })
    actor.send({ type: 'REQUEST' })
    expect(at(actor)).toEqual({ state: 'requesting', step: 'approving' })
    actor.send({ type: 'DECLINE' })
    expect(at(actor).state).toBe('compose')
    expect(ran).toEqual([])
  })

  it('payment request: names the amount and the friend, then sends exactly what was approved', async () => {
    const chart = builtin('payment-request')
    const { ports, ran } = fakePorts()
    const actor = start(chart, ports)
    actor.send({ type: 'REQUEST' })
    expect(at(actor).state).toBe('compose')
    actor.send({ type: 'SET', field: 'friend', value: ALICE })
    actor.send({ type: 'SET', field: 'amount', value: '2500' })
    actor.send({ type: 'SET', field: 'memo', value: 'Tickets' })
    actor.send({ type: 'REQUEST' })
    const approval = actor.getSnapshot().context.pending?.approval
    expect(approval?.amount).toBe('2,500 sats')
    expect(approval?.lines).toContainEqual({ label: 'From', value: '$alice' })
    expect(approval?.lines).toContainEqual({ label: 'Coin', value: 'Bitcoin SV' })
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, (s) => s.status === 'done')
    expect(ran).toEqual([
      { kind: 'requestPayment', coin: 'BSV', network: 'mainnet', from: [ALICE], amountEach: 2500, memo: 'Tickets' },
    ])
    expect(interpolate(chart, actor.getSnapshot().context.values, chart.states.sent.view![1].block === 'text' ? (chart.states.sent.view![1] as { text: string }).text : '')).toBe(
      '$alice has your request for 2,500 sats. Its status is on its own row in Activity.',
    )
  })

  it('tip jar: a preset tip sends that amount to the friend after approval', async () => {
    const { ports, ran } = fakePorts()
    const actor = start(builtin('tip-jar'), ports)
    actor.send({ type: 'TIP_MEDIUM' })
    expect(at(actor).state).toBe('compose')
    actor.send({ type: 'SET', field: 'friend', value: BOB })
    actor.send({ type: 'TIP_MEDIUM' })
    expect(actor.getSnapshot().context.pending?.approval?.title).toBe('Send to $bob')
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, (s) => s.status === 'done')
    expect(ran).toEqual([{ kind: 'sendPayment', coin: 'BSV', network: 'mainnet', to: BOB, amount: 5000, memo: '' }])
  })

  it('split the bill: each friend is asked for an even share that counts you in', async () => {
    const { ports, ran } = fakePorts()
    const actor = start(builtin('split-bill'), ports)
    actor.send({ type: 'SET', field: 'what', value: 'Dinner' })
    actor.send({ type: 'SET', field: 'total', value: 4000 })
    actor.send({ type: 'SET', field: 'friends', value: [ALICE, BOB, CAROL] })
    actor.send({ type: 'SPLIT' })
    const approval = actor.getSnapshot().context.pending?.approval
    expect(approval?.title).toBe('Ask $alice, $bob and $carol')
    expect(approval?.amount).toBe('1,000 sats each')
    expect(approval?.confirm).toBe('Send 3 requests')
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, (s) => s.status === 'done')
    expect(ran[0]).toMatchObject({ kind: 'requestPayment', from: [ALICE, BOB, CAROL], amountEach: 1000, memo: 'Dinner' })
  })

  it('send an item: names the item and the friend, then sends that outpoint', async () => {
    const { ports, ran } = fakePorts()
    const actor = start(builtin('send-item'), ports)
    const item = { outpoint: `${'ab'.repeat(32)}.0`, name: 'Golden Fox' }
    actor.send({ type: 'SET', field: 'item', value: item })
    actor.send({ type: 'SET', field: 'friend', value: CAROL })
    actor.send({ type: 'SEND' })
    const approval = actor.getSnapshot().context.pending?.approval
    expect(approval?.title).toBe('Send Golden Fox')
    expect(approval?.lines).toContainEqual({ label: 'To', value: '$carol' })
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, (s) => s.status === 'done')
    expect(ran).toEqual([{ kind: 'sendItem', coin: 'BSV', network: 'mainnet', to: CAROL, item }])
  })

  it('message box: lists, marks handled, clears and blocks only through declared effects', async () => {
    const now = Date.now()
    const inbox: BoxMessage[] = [
      { id: 'm1', box: 'inbox', sender: BOB.identityKey, senderName: '$bob', at: now, kind: 'message', text: 'hi' },
      { id: 'm2', box: 'inbox', sender: BOB.identityKey, senderName: '$bob', at: now - 1, kind: 'payment-notice', text: '' },
      { id: 'm3', box: 'inbox', sender: CAROL.identityKey, senderName: '$carol', at: now - 2, kind: 'unreadable', text: '' },
    ]
    const { ports, ran } = fakePorts({ listMessages: { kind: 'messages', messages: inbox, blocked: [] } })
    const actor = start(builtin('message-box'), ports)
    await waitFor(actor, () => at(actor).state === 'inbox')
    expect(ran[0]).toEqual({ kind: 'listMessages', boxes: ['inbox'] })
    expect(actor.getSnapshot().context.values.inbox).toHaveLength(3)

    // Mark handled: no approval.
    actor.send({ type: 'TOGGLE', field: 'selected', id: 'm1' })
    actor.send({ type: 'ACK' })
    await waitFor(actor, () => at(actor).state === 'inbox')
    expect(ran[1]).toMatchObject({ kind: 'acknowledgeMessages', messages: [inbox[0]] })
    expect(actor.getSnapshot().context.values.inbox).toHaveLength(2)

    // Clear two: approval names the count and warns about the payment notice.
    actor.send({ type: 'TOGGLE', field: 'selected', id: 'm2' })
    actor.send({ type: 'TOGGLE', field: 'selected', id: 'm3' })
    actor.send({ type: 'TOGGLE', field: 'selected', id: 'not-listed' })
    actor.send({ type: 'CLEAR' })
    expect(at(actor)).toEqual({ state: 'clearing', step: 'approving' })
    const approval = actor.getSnapshot().context.pending!.approval!
    expect(approval.title).toBe('Clear 2 messages')
    expect(approval.lines).toContainEqual({ label: 'From', value: '$bob and $carol' })
    expect(approval.note).toMatch(/1 payment notice among them/)
    expect(ran).toHaveLength(2)
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, () => at(actor).state === 'inbox')
    expect(ran[2]).toMatchObject({ kind: 'deleteMessages', messages: [inbox[1], inbox[2]] })
    expect(actor.getSnapshot().context.values.inbox).toEqual([])

    // Open a message from the next listing and block its sender: approval names the sender.
    actor.send({ type: 'REFRESH' })
    await waitFor(actor, () => at(actor).state === 'inbox')
    actor.send({ type: 'OPEN', row: { id: 'forged' } })
    expect(at(actor).state).toBe('inbox')
    actor.send({ type: 'OPEN', row: inbox[0] })
    expect(at(actor).state).toBe('reading')
    actor.send({ type: 'BLOCK' })
    expect(actor.getSnapshot().context.pending?.approval?.title).toBe('Block $bob')
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, () => at(actor).state === 'inbox')
    expect(ran).toContainEqual({ kind: 'blockSender', sender: { identityKey: BOB.identityKey, name: '$bob' } })
  })

  it('message box: unblocking a sender runs without a prompt', async () => {
    const blocked = [{ identityKey: BOB.identityKey, name: '$bob' }]
    const { ports, ran } = fakePorts({ listMessages: { kind: 'messages', messages: [], blocked } })
    const actor = start(builtin('message-box'), ports)
    await waitFor(actor, () => at(actor).state === 'inbox')
    actor.send({ type: 'BLOCKED' })
    actor.send({ type: 'PICK', row: blocked[0] })
    expect(at(actor).state).toBe('sender')
    actor.send({ type: 'UNBLOCK' })
    await waitFor(actor, () => at(actor).state === 'inbox')
    expect(ran).toContainEqual({ kind: 'unblockSender', sender: blocked[0] })
  })

  it('a failing effect lands on the chart error state with the reason', async () => {
    const ports: ChartEffectPorts = { run: async () => { throw new Error('Wallet locked') } }
    const actor = start(builtin('tip-jar'), ports)
    actor.send({ type: 'SET', field: 'friend', value: ALICE })
    actor.send({ type: 'TIP_SMALL' })
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, () => at(actor).state === 'failed')
    expect(actor.getSnapshot().context.error).toBe('Wallet locked')
  })

  it('sign approval names the text and says nothing else is signed', () => {
    const copy = approvalFor({ kind: 'signMessage', appId: 'x', message: 'I was here' }, { name: 'Guestbook' })
    expect(copy.lines).toEqual([{ label: 'Text', value: 'I was here' }])
    expect(copy.note).toMatch(/Nothing else is signed/)
  })
})
