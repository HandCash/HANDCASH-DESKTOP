import type {
  ComputeInput,
  ComputeOp,
  ComputeOutput,
  ComputeReply,
  ComputeRequest,
} from '../../ports/computePort'
import { decodeItemArtFromProvenance } from '../itemArtDecode'

const ops: { [K in ComputeOp]: (input: ComputeInput<K>) => ComputeOutput<K> } = {
  itemArtFromProvenance: decodeItemArtFromProvenance,
}

export function runComputeOp<K extends ComputeOp>(op: K, input: ComputeInput<K>): ComputeOutput<K> {
  const fn = ops[op] as ((input: ComputeInput<K>) => ComputeOutput<K>) | undefined
  if (!fn) throw new Error(`Unknown compute op: ${String(op)}`)
  return fn(input)
}

/** Buffers a reply can hand over instead of copying. */
function transferablesOf(output: unknown): Transferable[] {
  if (output && typeof output === 'object' && 'body' in output && output.body instanceof Uint8Array) {
    return [output.body.buffer as ArrayBuffer]
  }
  return []
}

/**
 * One request in, one reply out. A body that views a larger buffer is copied
 * first, so the transfer hands over only its own bytes.
 */
export function handleComputeRequest(request: ComputeRequest): {
  reply: ComputeReply
  transfer: Transferable[]
} {
  try {
    let output = runComputeOp(request.op, request.input) as ComputeOutput<ComputeOp>
    if (output && output.body.byteLength !== output.body.buffer.byteLength) {
      output = { ...output, body: output.body.slice() }
    }
    return { reply: { id: request.id, ok: true, output }, transfer: transferablesOf(output) }
  } catch (err) {
    return {
      reply: { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) },
      transfer: [],
    }
  }
}
