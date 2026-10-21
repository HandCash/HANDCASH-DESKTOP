/**
 * Chart apps (draft BRC, `docs/bsva/brcs/apps/0260.md`): an app is a small
 * signed JSON state chart. The wallet validates it, verifies its hash and
 * signature, then renders it from a fixed set of blocks. Declared effects are
 * the only way a chart reaches money, identity, the network or message boxes.
 */

export const CHART_APP_FORMAT = 'chart-app/1'

/** Coin ids a chart may name. Display names live in {@link COIN_NAMES}. */
export type ChartCoinId = 'BSV' | 'BTC'
export type ChartNetwork = 'mainnet' | 'testnet'

export const COIN_NAMES: Record<ChartCoinId, string> = {
  BSV: 'Bitcoin SV',
  BTC: 'Bitcoin',
}

export type ChartFieldType =
  | 'amount'
  | 'text'
  | 'friend'
  | 'friends'
  | 'item'
  | 'messages'
  | 'senders'
  | 'selection'
  | 'message'
  | 'sender'
  | 'signature'
  | 'fetched'

export type ChartField = {
  type: ChartFieldType
  /** Text fields only. */
  maxLength?: number
  /** Amount fields only: the coin whose base unit the amount is in. */
  coin?: ChartCoinId
}

export type ChartBlock =
  | { block: 'heading'; text: string }
  | { block: 'text'; text: string }
  | { block: 'amountInput'; field: string; label: string }
  | { block: 'textInput'; field: string; label: string; placeholder?: string }
  | { block: 'friendPicker'; field: string; label: string }
  | { block: 'itemPicker'; field: string; label: string }
  | {
      block: 'list'
      field: string
      label?: string
      /** A `selection` field the list's checkboxes fill. */
      select?: string
      /** Opening a row stores it in `field` and sends `event`. */
      open?: { event: string; field: string }
      empty?: string
    }
  | { block: 'primaryButton'; label: string; event: string }
  | { block: 'secondaryButton'; label: string; event: string }

export type ChartBlockKind = ChartBlock['block']

export type ChartTransition =
  | string
  | {
      target: string
      /** Fields that must hold a value before the transition is taken. */
      requires?: string[]
      /** Literal values written to fields as the transition is taken. */
      assign?: Record<string, number | string>
    }

export type ChartState = {
  view?: ChartBlock[]
  on?: Record<string, ChartTransition>
  /** Id of a declared effect; the state runs it, then goes to `onDone` or `onError`. */
  effect?: string
  onDone?: string
  onError?: string
  /** Where a declined approval returns. Required for effects that need approval. */
  onDecline?: string
  final?: boolean
}

export type FieldRef = { field: string }

export type AmountRef = FieldRef & {
  /** Split the amount evenly: divide by the number of entries in `countOf`, plus `plus`. */
  divideBy?: { countOf: string; plus?: number }
}

export type ChartEffect =
  | {
      kind: 'requestPayment'
      coin: ChartCoinId
      networks: ChartNetwork[]
      from: FieldRef
      amount: AmountRef
      memo?: FieldRef
    }
  | {
      kind: 'sendPayment'
      coin: ChartCoinId
      networks: ChartNetwork[]
      to: FieldRef
      amount: AmountRef
      memo?: FieldRef
    }
  | {
      kind: 'sendItem'
      coin: ChartCoinId
      networks: ChartNetwork[]
      to: FieldRef
      item: FieldRef
    }
  | { kind: 'signMessage'; message: FieldRef; result: string }
  | { kind: 'fetch'; url: string; result: string }
  | { kind: 'listMessages'; boxes: string[]; result: string; blocked?: string }
  | { kind: 'acknowledgeMessages'; messages: FieldRef }
  | { kind: 'deleteMessages'; messages: FieldRef }
  | { kind: 'blockSender'; sender: FieldRef }
  | { kind: 'unblockSender'; sender: FieldRef }

export type ChartEffectKind = ChartEffect['kind']

export type ChartAuthor = {
  /** Compressed secp256k1 public key, hex. */
  identityKey: string
  name: string
}

export type ChartApp = {
  format: typeof CHART_APP_FORMAT
  id: string
  name: string
  summary: string
  version: string
  author: ChartAuthor
  initial: string
  fields: Record<string, ChartField>
  effects: Record<string, ChartEffect>
  states: Record<string, ChartState>
  /** DER ECDSA signature, hex, by `author.identityKey` over the chart's signing preimage. */
  signature: string
}

/** A chart without its signature: what the hash and signature cover. */
export type UnsignedChartApp = Omit<ChartApp, 'signature'>

/** What the running wallet offers charts. */
export type ChartWalletSupport = {
  coins: ReadonlyArray<{ coin: ChartCoinId; network: ChartNetwork }>
  /** Message boxes charts may list and clear. */
  boxes: readonly string[]
}

// Values the runner holds per field.

export type Recipient = { id: string; label: string; identityKey: string }
export type ItemRef = { outpoint: string; name: string }
export type BoxMessageKind =
  | 'message'
  | 'payment-request'
  | 'payment-notice'
  | 'tip'
  | 'file'
  | 'identity-card'
  | 'market'
  | 'unreadable'
export type BoxMessage = {
  id: string
  box: string
  sender: string
  senderName: string
  at: number
  kind: BoxMessageKind
  text: string
}
export type SenderRef = { identityKey: string; name: string }
export type SignatureResult = { identityKey: string; signature: string; message: string }
export type FetchedResult = { url: string; status: number; text: string }

export type ChartFieldValue =
  | number
  | string
  /** A selection: ids of listed messages. */
  | string[]
  | Recipient
  | Recipient[]
  | ItemRef
  | BoxMessage
  | BoxMessage[]
  | SenderRef
  | SenderRef[]
  | SignatureResult
  | FetchedResult

export type ChartValues = Record<string, ChartFieldValue | undefined>

/** An effect with every reference resolved: exactly what is approved and run. */
export type ResolvedEffect =
  | { kind: 'requestPayment'; coin: ChartCoinId; network: ChartNetwork; from: Recipient[]; amountEach: number; memo: string }
  | { kind: 'sendPayment'; coin: ChartCoinId; network: ChartNetwork; to: Recipient; amount: number; memo: string }
  | { kind: 'sendItem'; coin: ChartCoinId; network: ChartNetwork; to: Recipient; item: ItemRef }
  | { kind: 'signMessage'; appId: string; message: string }
  | { kind: 'fetch'; url: string }
  | { kind: 'listMessages'; boxes: string[] }
  | { kind: 'acknowledgeMessages'; messages: BoxMessage[] }
  | { kind: 'deleteMessages'; messages: BoxMessage[] }
  | { kind: 'blockSender'; sender: SenderRef }
  | { kind: 'unblockSender'; sender: SenderRef }

export type EffectResult =
  | { kind: 'none' }
  | { kind: 'messages'; messages: BoxMessage[]; blocked: SenderRef[] }
  | { kind: 'signature'; value: SignatureResult }
  | { kind: 'fetched'; value: FetchedResult }

/** The wallet side of every effect. Desktop's lives in `desktopEffectPorts.ts`. */
export type ChartEffectPorts = {
  run(effect: ResolvedEffect, app: { id: string; name: string }): Promise<EffectResult>
}
