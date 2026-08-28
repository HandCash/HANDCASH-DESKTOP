/**
 * Compact QR frame codec for payloads too dense for a single code.
 *
 * Wire format: HCF1|<index>|<count>|<id>|<chunk>
 * Chunks are ~100 characters so each frame stays scannable at phone distance.
 */
export const QR_FRAME_PREFIX = 'HCF1'
export const QR_FRAME_CHUNK_SIZE = 100

export type QrFrame = {
  index: number
  count: number
  id: string
  payload: string
}

export type QrFrameProgress = {
  complete: false
  got: number
  count: number
  id: string | null
}

export type QrFrameComplete = {
  complete: true
  payload: string
  got: number
  count: number
  id: string
}

function fnv1a36(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export function encodeQrFrame(frame: QrFrame): string {
  return `${QR_FRAME_PREFIX}|${frame.index}|${frame.count}|${frame.id}|${frame.payload}`
}

export function parseQrFrame(raw: string): QrFrame | null {
  const text = raw.trim()
  const prefix = `${QR_FRAME_PREFIX}|`
  if (!text.startsWith(prefix)) return null
  const rest = text.slice(prefix.length)
  const i = rest.indexOf('|')
  if (i < 0) return null
  const j = rest.indexOf('|', i + 1)
  if (j < 0) return null
  const k = rest.indexOf('|', j + 1)
  if (k < 0) return null
  const index = Number(rest.slice(0, i))
  const count = Number(rest.slice(i + 1, j))
  const id = rest.slice(j + 1, k)
  const payload = rest.slice(k + 1)
  if (!Number.isInteger(index) || !Number.isInteger(count)) return null
  if (count < 1 || index < 0 || index >= count) return null
  if (!id) return null
  return { index, count, id, payload }
}

export function isQrFrame(raw: string): boolean {
  return parseQrFrame(raw) !== null
}

export function splitQrFrames(
  payload: string,
  chunkSize = QR_FRAME_CHUNK_SIZE,
): string[] {
  const text = payload
  const size = Math.max(1, chunkSize)
  if (!text) {
    return [encodeQrFrame({ index: 0, count: 1, id: fnv1a36(''), payload: '' })]
  }
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  const id = fnv1a36(text)
  const count = chunks.length
  return chunks.map((chunk, index) => encodeQrFrame({ index, count, id, payload: chunk }))
}

export function createQrFrameAssembler(): {
  add: (raw: string) => QrFrameProgress | QrFrameComplete | null
  reset: () => void
  snapshot: () => { id: string | null; got: number; count: number }
} {
  let id: string | null = null
  let count = 0
  const parts = new Map<number, string>()

  const snapshot = () => ({ id, got: parts.size, count })

  return {
    add(raw: string) {
      const frame = parseQrFrame(raw)
      if (!frame) return null
      if (id !== null && frame.id !== id) {
        parts.clear()
      }
      id = frame.id
      count = frame.count
      parts.set(frame.index, frame.payload)
      if (parts.size === count) {
        const missing = Array.from({ length: count }, (_, i) => i).some((i) => !parts.has(i))
        if (!missing) {
          const payload = Array.from({ length: count }, (_, i) => parts.get(i) ?? '').join('')
          return { complete: true as const, payload, got: count, count, id }
        }
      }
      return { complete: false as const, got: parts.size, count, id }
    },
    reset() {
      id = null
      count = 0
      parts.clear()
    },
    snapshot,
  }
}

/** Reassemble a bag of frame strings. Missing or mixed sequences return null. */
export function reassembleQrFrames(frames: Iterable<string>): string | null {
  const assembler = createQrFrameAssembler()
  let payload: string | null = null
  for (const raw of frames) {
    const result = assembler.add(raw)
    if (result?.complete) payload = result.payload
  }
  return payload
}
