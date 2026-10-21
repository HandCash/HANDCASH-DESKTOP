import {
  CHART_APP_FORMAT,
  COIN_NAMES,
  type ChartApp,
  type ChartBlock,
  type ChartEffect,
  type ChartFieldType,
  type ChartState,
  type ChartWalletSupport,
} from './chartTypes'
import { canonicalJson, chartHash, verifyChartSignature } from './chartSignature'
import { effectNeedsApproval } from './chartEffects'

export const CHART_MAX_BYTES = 32 * 1024
export const RESERVED_EVENTS = ['SET', 'TOGGLE', 'APPROVE', 'DECLINE'] as const

const NAME = /^[a-z][a-zA-Z0-9]{0,31}$/
const EVENT = /^[A-Z][A-Z0-9_]{0,31}$/
const APP_ID = /^[a-z][a-z0-9-]{1,39}$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/
const BOX = /^[a-z0-9_-]{1,40}$/
const PLACEHOLDER = /\{([^{}]*)\}/g
const NETWORKS = ['mainnet', 'testnet']
const FIELD_TYPES: ChartFieldType[] = [
  'amount', 'text', 'friend', 'friends', 'item', 'messages', 'senders',
  'selection', 'message', 'sender', 'signature', 'fetched',
]

/** Sub-keys a text block may read from a field, by field type. */
const PLACEHOLDER_KEYS: Record<ChartFieldType, readonly string[]> = {
  amount: [],
  text: [],
  friend: [],
  friends: ['count'],
  item: [],
  messages: ['count'],
  senders: ['count'],
  selection: ['count'],
  message: ['sender', 'box', 'kind', 'time', 'text'],
  sender: [],
  signature: ['signature', 'identityKey'],
  fetched: ['status', 'text'],
}

const EFFECT_KEYS: Record<ChartEffect['kind'], { required: string[]; optional: string[] }> = {
  requestPayment: { required: ['kind', 'coin', 'networks', 'from', 'amount'], optional: ['memo'] },
  sendPayment: { required: ['kind', 'coin', 'networks', 'to', 'amount'], optional: ['memo'] },
  sendItem: { required: ['kind', 'coin', 'networks', 'to', 'item'], optional: [] },
  signMessage: { required: ['kind', 'message', 'result'], optional: [] },
  fetch: { required: ['kind', 'url', 'result'], optional: [] },
  listMessages: { required: ['kind', 'boxes', 'result'], optional: ['blocked'] },
  acknowledgeMessages: { required: ['kind', 'messages'], optional: [] },
  deleteMessages: { required: ['kind', 'messages'], optional: [] },
  blockSender: { required: ['kind', 'sender'], optional: [] },
  unblockSender: { required: ['kind', 'sender'], optional: [] },
}

const BLOCK_KEYS: Record<ChartBlock['block'], { required: string[]; optional: string[] }> = {
  heading: { required: ['block', 'text'], optional: [] },
  text: { required: ['block', 'text'], optional: [] },
  amountInput: { required: ['block', 'field', 'label'], optional: [] },
  textInput: { required: ['block', 'field', 'label'], optional: ['placeholder'] },
  friendPicker: { required: ['block', 'field', 'label'], optional: [] },
  itemPicker: { required: ['block', 'field', 'label'], optional: [] },
  list: { required: ['block', 'field'], optional: ['label', 'select', 'open', 'empty'] },
  primaryButton: { required: ['block', 'label', 'event'], optional: [] },
  secondaryButton: { required: ['block', 'label', 'event'], optional: [] },
}

export type ChartValidation =
  | { ok: true; chart: ChartApp }
  | { ok: false; errors: string[] }

export type ChartVerification =
  | { ok: true; chart: ChartApp; hash: string }
  | { ok: false; reason: 'invalid' | 'hash' | 'signature' | 'unsupported'; errors: string[] }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max
}

/**
 * Strict structural check. Anything the format does not name is an error:
 * unknown keys, undeclared fields, effects or states, mismatched field types.
 */
export function validateChart(raw: unknown): ChartValidation {
  const errors: string[] = []
  const fail = (msg: string) => {
    errors.push(msg)
  }
  const exactKeys = (obj: Record<string, unknown>, where: string, required: string[], optional: string[]) => {
    for (const key of required) if (!(key in obj)) fail(`${where}: missing ${key}`)
    for (const key of Object.keys(obj)) {
      if (!required.includes(key) && !optional.includes(key)) fail(`${where}: unknown key ${key}`)
    }
  }

  if (!isObject(raw)) return { ok: false, errors: ['Chart is not an object'] }
  try {
    if (new TextEncoder().encode(canonicalJson(raw)).length > CHART_MAX_BYTES) {
      return { ok: false, errors: [`Chart is over ${CHART_MAX_BYTES} bytes`] }
    }
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  }

  exactKeys(
    raw,
    'chart',
    ['format', 'id', 'name', 'summary', 'version', 'author', 'initial', 'fields', 'effects', 'states', 'signature'],
    [],
  )
  if (raw.format !== CHART_APP_FORMAT) fail(`chart: format must be ${CHART_APP_FORMAT}`)
  if (typeof raw.id !== 'string' || !APP_ID.test(raw.id)) fail('chart: id must be lowercase letters, digits and dashes')
  if (!text(raw.name, 40)) fail('chart: name must be 1 to 40 characters')
  if (!text(raw.summary, 140)) fail('chart: summary must be 1 to 140 characters')
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) fail('chart: version must be major.minor.patch')
  if (typeof raw.signature !== 'string' || !/^[0-9a-f]{16,200}$/.test(raw.signature)) fail('chart: signature must be hex')
  if (isObject(raw.author)) {
    exactKeys(raw.author, 'author', ['identityKey', 'name'], [])
    if (typeof raw.author.identityKey !== 'string' || !IDENTITY_KEY.test(raw.author.identityKey)) {
      fail('author: identityKey must be a compressed public key in lowercase hex')
    }
    if (!text(raw.author.name, 40)) fail('author: name must be 1 to 40 characters')
  } else fail('chart: author must be an object')

  // Fields
  const fieldTypes = new Map<string, ChartFieldType>()
  if (isObject(raw.fields)) {
    for (const [name, def] of Object.entries(raw.fields)) {
      const where = `field ${name}`
      if (!NAME.test(name)) fail(`${where}: bad name`)
      if (!isObject(def)) {
        fail(`${where}: must be an object`)
        continue
      }
      exactKeys(def, where, ['type'], ['maxLength', 'coin'])
      const type = def.type as ChartFieldType
      if (!FIELD_TYPES.includes(type)) {
        fail(`${where}: unknown type ${String(def.type)}`)
        continue
      }
      fieldTypes.set(name, type)
      if ('maxLength' in def) {
        if (type !== 'text') fail(`${where}: maxLength is for text fields`)
        else if (!Number.isSafeInteger(def.maxLength) || (def.maxLength as number) < 1 || (def.maxLength as number) > 500) {
          fail(`${where}: maxLength must be 1 to 500`)
        }
      }
      if (type === 'amount') {
        if (typeof def.coin !== 'string' || !(def.coin in COIN_NAMES)) fail(`${where}: amount fields name their coin`)
      } else if ('coin' in def) fail(`${where}: coin is for amount fields`)
    }
  } else fail('chart: fields must be an object')

  const fieldOf = (where: string, name: unknown, allowed: ChartFieldType[]): void => {
    if (typeof name !== 'string' || !fieldTypes.has(name)) {
      fail(`${where}: undeclared field ${String(name)}`)
      return
    }
    const type = fieldTypes.get(name)!
    if (!allowed.includes(type)) fail(`${where}: field ${name} is ${type}, needs ${allowed.join(' or ')}`)
  }
  const refOf = (where: string, ref: unknown, allowed: ChartFieldType[], extra: string[] = []): void => {
    if (!isObject(ref)) {
      fail(`${where}: must be { field }`)
      return
    }
    exactKeys(ref, where, ['field'], extra)
    fieldOf(where, ref.field, allowed)
  }

  // Effects
  const effectKinds = new Map<string, ChartEffect>()
  if (isObject(raw.effects)) {
    for (const [id, def] of Object.entries(raw.effects)) {
      const where = `effect ${id}`
      if (!NAME.test(id)) fail(`${where}: bad id`)
      if (!isObject(def) || typeof def.kind !== 'string' || !(def.kind in EFFECT_KEYS)) {
        fail(`${where}: undeclared effect kind ${isObject(def) ? String(def.kind) : ''}`.trim())
        continue
      }
      const kind = def.kind as ChartEffect['kind']
      exactKeys(def, where, EFFECT_KEYS[kind].required, EFFECT_KEYS[kind].optional)
      effectKinds.set(id, def as ChartEffect)
      if (kind === 'requestPayment' || kind === 'sendPayment' || kind === 'sendItem') {
        if (typeof def.coin !== 'string' || !(def.coin in COIN_NAMES)) fail(`${where}: unknown coin ${String(def.coin)}`)
        const nets = def.networks
        if (
          !Array.isArray(nets) ||
          nets.length === 0 ||
          new Set(nets).size !== nets.length ||
          nets.some((n) => !NETWORKS.includes(n as string))
        ) {
          fail(`${where}: networks must list mainnet and/or testnet`)
        }
      }
      if (kind === 'requestPayment' || kind === 'sendPayment') {
        const amount = def.amount
        refOf(`${where} amount`, amount, ['amount'], ['divideBy'])
        if (isObject(amount) && typeof amount.field === 'string' && fieldTypes.get(amount.field) === 'amount') {
          const declaredCoin = (raw.fields as Record<string, { coin?: string }>)[amount.field]?.coin
          if (declaredCoin !== def.coin) fail(`${where}: amount field coin must match the effect coin`)
        }
        if (isObject(amount) && 'divideBy' in amount) {
          const by = amount.divideBy
          if (!isObject(by)) fail(`${where}: divideBy must be an object`)
          else {
            exactKeys(by, `${where} divideBy`, ['countOf'], ['plus'])
            fieldOf(`${where} divideBy`, by.countOf, ['friends'])
            if ('plus' in by && (!Number.isSafeInteger(by.plus) || (by.plus as number) < 0 || (by.plus as number) > 10)) {
              fail(`${where}: divideBy.plus must be 0 to 10`)
            }
          }
        }
        if ('memo' in def) refOf(`${where} memo`, def.memo, ['text'])
      }
      if (kind === 'requestPayment') refOf(`${where} from`, def.from, ['friend', 'friends'])
      if (kind === 'sendPayment') refOf(`${where} to`, def.to, ['friend'])
      if (kind === 'sendItem') {
        refOf(`${where} to`, def.to, ['friend'])
        refOf(`${where} item`, def.item, ['item'])
      }
      if (kind === 'signMessage') {
        refOf(`${where} message`, def.message, ['text'])
        fieldOf(`${where} result`, def.result, ['signature'])
      }
      if (kind === 'fetch') {
        let url: URL | null = null
        try {
          url = typeof def.url === 'string' ? new URL(def.url) : null
        } catch {
          url = null
        }
        if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== def.url) {
          fail(`${where}: url must be one fixed https address`)
        }
        fieldOf(`${where} result`, def.result, ['fetched'])
      }
      if (kind === 'listMessages') {
        const boxes = def.boxes
        if (
          !Array.isArray(boxes) ||
          boxes.length === 0 ||
          new Set(boxes).size !== boxes.length ||
          boxes.some((b) => typeof b !== 'string' || !BOX.test(b))
        ) {
          fail(`${where}: boxes must name one or more message boxes`)
        }
        fieldOf(`${where} result`, def.result, ['messages'])
        if ('blocked' in def) fieldOf(`${where} blocked`, def.blocked, ['senders'])
      }
      if (kind === 'acknowledgeMessages' || kind === 'deleteMessages') {
        refOf(`${where} messages`, def.messages, ['selection', 'message'])
      }
      if (kind === 'blockSender' || kind === 'unblockSender') {
        refOf(`${where} sender`, def.sender, ['message', 'sender'])
      }
    }
  } else fail('chart: effects must be an object')

  // States
  const stateNames = isObject(raw.states) ? Object.keys(raw.states) : []
  if (!isObject(raw.states) || stateNames.length === 0) fail('chart: states must name at least one state')
  if (typeof raw.initial !== 'string' || !stateNames.includes(raw.initial)) fail('chart: initial must name a state')
  const target = (where: string, name: unknown) => {
    if (typeof name !== 'string' || !stateNames.includes(name)) fail(`${where}: undeclared state ${String(name)}`)
  }
  const placeholders = (where: string, value: string) => {
    for (const match of value.matchAll(PLACEHOLDER)) {
      const [root, sub, ...rest] = match[1].split('.')
      const type = fieldTypes.get(root)
      if (!type || rest.length > 0) {
        fail(`${where}: placeholder {${match[1]}} names no field`)
        continue
      }
      if (sub !== undefined && !PLACEHOLDER_KEYS[type].includes(sub)) {
        fail(`${where}: placeholder {${match[1]}} reads nothing a ${type} field has`)
      }
    }
  }

  for (const name of stateNames) {
    const state = (raw.states as Record<string, unknown>)[name]
    const where = `state ${name}`
    if (!NAME.test(name)) fail(`${where}: bad name`)
    if (!isObject(state)) {
      fail(`${where}: must be an object`)
      continue
    }
    exactKeys(state, where, [], ['view', 'on', 'effect', 'onDone', 'onError', 'onDecline', 'final'])
    const s = state as ChartState
    if ('final' in state && state.final !== true) fail(`${where}: final must be true when set`)

    if (s.effect !== undefined) {
      if (s.view || s.on || s.final) fail(`${where}: an effect state has no view, events or final`)
      const effect = typeof s.effect === 'string' ? effectKinds.get(s.effect) : undefined
      if (!effect) fail(`${where}: undeclared effect ${String(s.effect)}`)
      target(`${where} onDone`, s.onDone)
      target(`${where} onError`, s.onError)
      if (effect && effectNeedsApproval(effect.kind)) target(`${where} onDecline`, s.onDecline)
      else if ('onDecline' in state) fail(`${where}: onDecline is only for effects that need approval`)
      continue
    }
    for (const key of ['onDone', 'onError', 'onDecline'] as const) {
      if (key in state) fail(`${where}: ${key} is only for effect states`)
    }
    if (!Array.isArray(s.view) || s.view.length === 0) {
      fail(`${where}: needs a view or an effect`)
      continue
    }
    if (s.final && s.on) fail(`${where}: a final state takes no events`)

    const emitted = new Set<string>()
    s.view.forEach((block, i) => {
      const at = `${where} block ${i}`
      if (!isObject(block) || typeof block.block !== 'string' || !(block.block in BLOCK_KEYS)) {
        fail(`${at}: unknown block ${isObject(block) ? String(block.block) : ''}`.trim())
        return
      }
      const kind = block.block as ChartBlock['block']
      exactKeys(block, at, BLOCK_KEYS[kind].required, BLOCK_KEYS[kind].optional)
      const b = block as Record<string, unknown>
      for (const key of ['text', 'label', 'placeholder', 'empty']) {
        if (key in b) {
          if (!text(b[key], key === 'text' ? 400 : 60)) fail(`${at}: ${key} must be short text`)
          else placeholders(at, b[key] as string)
        }
      }
      if (kind === 'amountInput') fieldOf(at, b.field, ['amount'])
      if (kind === 'textInput') fieldOf(at, b.field, ['text'])
      if (kind === 'friendPicker') fieldOf(at, b.field, ['friend', 'friends'])
      if (kind === 'itemPicker') fieldOf(at, b.field, ['item'])
      if (kind === 'list') {
        fieldOf(at, b.field, ['messages', 'senders'])
        const listType = typeof b.field === 'string' ? fieldTypes.get(b.field) : undefined
        if ('select' in b) fieldOf(`${at} select`, b.select, ['selection'])
        if ('open' in b) {
          const open = b.open
          if (!isObject(open)) fail(`${at}: open must be { event, field }`)
          else {
            exactKeys(open, `${at} open`, ['event', 'field'], [])
            fieldOf(`${at} open`, open.field, [listType === 'senders' ? 'sender' : 'message'])
            if (typeof open.event === 'string') emitted.add(open.event)
            else fail(`${at}: open.event must be an event name`)
          }
        }
      }
      if (kind === 'primaryButton' || kind === 'secondaryButton') {
        if (typeof b.event === 'string') emitted.add(b.event)
        else fail(`${at}: event must be an event name`)
      }
    })

    const on = s.on ?? {}
    if (!isObject(on)) {
      fail(`${where}: on must be an object`)
      continue
    }
    for (const event of emitted) {
      if (!EVENT.test(event) || (RESERVED_EVENTS as readonly string[]).includes(event)) {
        fail(`${where}: bad event name ${event}`)
      } else if (!(event in on)) fail(`${where}: event ${event} has no transition`)
    }
    for (const [event, transition] of Object.entries(on)) {
      const at = `${where} on ${event}`
      if (!emitted.has(event)) fail(`${at}: no block sends this event`)
      if (typeof transition === 'string') {
        target(at, transition)
        continue
      }
      if (!isObject(transition)) {
        fail(`${at}: must be a state name or { target }`)
        continue
      }
      exactKeys(transition, at, ['target'], ['requires', 'assign'])
      target(at, transition.target)
      if ('requires' in transition) {
        if (!Array.isArray(transition.requires)) fail(`${at}: requires must list fields`)
        else for (const f of transition.requires) fieldOf(`${at} requires`, f, FIELD_TYPES)
      }
      if ('assign' in transition) {
        if (!isObject(transition.assign)) fail(`${at}: assign must be an object`)
        else {
          for (const [f, value] of Object.entries(transition.assign)) {
            const type = fieldTypes.get(f)
            if (type === 'amount') {
              if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(`${at}: assign ${f} must be a positive integer`)
            } else if (type === 'text') {
              if (typeof value !== 'string' || value.length > 500) fail(`${at}: assign ${f} must be text`)
            } else fail(`${at}: assign may only set amount or text fields`)
          }
        }
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, chart: raw as unknown as ChartApp }
}

/** Coins and boxes a chart needs that the wallet does not offer. */
export function unsupportedNeeds(chart: ChartApp, support: ChartWalletSupport): string[] {
  const missing: string[] = []
  for (const [id, effect] of Object.entries(chart.effects)) {
    if (effect.kind === 'requestPayment' || effect.kind === 'sendPayment' || effect.kind === 'sendItem') {
      const offered = support.coins.some((c) => c.coin === effect.coin && effect.networks.includes(c.network))
      if (!offered) missing.push(`${id}: ${COIN_NAMES[effect.coin]} on ${effect.networks.join(' or ')}`)
    }
    if (effect.kind === 'listMessages') {
      for (const box of effect.boxes) if (!support.boxes.includes(box)) missing.push(`${id}: message box ${box}`)
    }
  }
  return missing
}

/**
 * Everything the wallet checks before it shows or runs a chart: structure,
 * the hash it was shared under, the author's signature and what it needs.
 */
export function verifyChart(
  raw: unknown,
  support: ChartWalletSupport,
  options: { expectedHash?: string } = {},
): ChartVerification {
  const valid = validateChart(raw)
  if (!valid.ok) return { ok: false, reason: 'invalid', errors: valid.errors }
  const hash = chartHash(valid.chart)
  if (options.expectedHash && options.expectedHash.toLowerCase() !== hash) {
    return { ok: false, reason: 'hash', errors: ['The chart does not match the hash it was shared under'] }
  }
  if (!verifyChartSignature(valid.chart)) {
    return { ok: false, reason: 'signature', errors: ['The author signature does not match this chart'] }
  }
  const missing = unsupportedNeeds(valid.chart, support)
  if (missing.length) return { ok: false, reason: 'unsupported', errors: missing }
  return { ok: true, chart: valid.chart, hash }
}
