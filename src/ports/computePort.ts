/**
 * CPU work the UI thread hands off.
 *
 * Each op is a pure function of structured-cloneable input. Production runs
 * them in a Web Worker; tests and hosts without workers run the same functions
 * in process. An op belongs here only when its input is cheap to send and its
 * work is not: a history projection whose input clones as slowly as it
 * projects gains nothing off the main thread.
 */

export type ItemArtRequest = {
  /** Origin `txid_vout` whose output carries the ord envelope. */
  origin: string
  /** BRC-150 remittance BEEF, base64. */
  beefB64: string
}

export type ItemArt = {
  mime: string
  body: Uint8Array
}

export type ComputeOps = {
  itemArtFromProvenance: { input: ItemArtRequest; output: ItemArt | null }
}

export type ComputeOp = keyof ComputeOps
export type ComputeInput<K extends ComputeOp> = ComputeOps[K]['input']
export type ComputeOutput<K extends ComputeOp> = ComputeOps[K]['output']

export type ComputePort = {
  run<K extends ComputeOp>(op: K, input: ComputeInput<K>): Promise<ComputeOutput<K>>
}

export type ComputeRequest = {
  [K in ComputeOp]: { id: number; op: K; input: ComputeInput<K> }
}[ComputeOp]

export type ComputeReply =
  | { id: number; ok: true; output: ComputeOutput<ComputeOp> }
  | { id: number; ok: false; error: string }
