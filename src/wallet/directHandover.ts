/**
 * Draft BRC-249 handover over the authenticated BRC-246 vault link.
 * A transport ACK is not custody acceptance: only a successful holder merge
 * produces the application receipt. Failed sends retain the existing box retry.
 */
import { HANDOVER_MAX_PARTS, HANDOVER_PART_CHARS, parseHandoverPart } from './accountHandover'

const RECEIPT_MS = 15_000
const MAX_GROUPS = 4
const MAX_AGE_MS = 60_000

type Frame = { type: 'direct-handover'; identityKey: string; sealed: string }
type Receipt = { type: 'direct-handover-merged'; identityKey: string; handoverId: string }

export function createDirectHandover(io: {
  send: (device: string, body: string) => Promise<'direct' | 'box'>
  /** Null unless this install currently holds and has opened the named account. */
  inbox: (identityKey: string) => {
    open: (sealed: string) => string | null
    merge: (json: string, kind?: 'custody') => Promise<void>
  } | null | Promise<{
    open: (sealed: string) => string | null
    merge: (json: string, kind?: 'custody') => Promise<void>
  } | null>
}) {
  const waiting = new Map<string, { device: string; resolve: (merged: boolean) => void }>()
  const groups = new Map<string, {
    at: number; total: number; parts: Map<number, string>; merging: boolean; kind?: 'custody'
  }>()
  const keyOf = (identity: string, id: string) => JSON.stringify([identity, id])
  return {
    async send(device: string, identityKey: string, handoverId: string, sealed: string[]): Promise<boolean> {
      const key = keyOf(identityKey, handoverId)
      if (!sealed.length || sealed.length > HANDOVER_MAX_PARTS || waiting.has(key)) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const receipt = new Promise<boolean>(resolve => {
        waiting.set(key, { device, resolve })
        timer = setTimeout(() => resolve(false), RECEIPT_MS)
      })
      try {
        for (const part of sealed) {
          const frame: Frame = { type: 'direct-handover', identityKey, sealed: part }
          if (await io.send(device, JSON.stringify(frame)) !== 'direct') return false
        }
        return await receipt
      } finally {
        clearTimeout(timer)
        waiting.delete(key)
      }
    },
    async receive(body: string, device: string): Promise<void> {
      let frame: { type?: string; identityKey?: string; sealed?: string; handoverId?: string }
      try { frame = JSON.parse(body) } catch { return }
      if (!frame || typeof frame.identityKey !== 'string') return
      if (frame.type === 'direct-handover-merged' && typeof frame.handoverId === 'string') {
        const pending = waiting.get(keyOf(frame.identityKey, frame.handoverId))
        if (pending?.device === device) pending.resolve(true)
        return
      }
      if (frame.type !== 'direct-handover' || typeof frame.sealed !== 'string'
        || frame.sealed.length > HANDOVER_PART_CHARS * 4) return
      const inbox = await io.inbox(frame.identityKey)
      if (!inbox) return
      const plain = inbox.open(frame.sealed)
      const part = plain == null ? null : parseHandoverPart(plain, frame.identityKey)
      if (!part || part.deviceId !== device || part.data.length > HANDOVER_PART_CHARS) return
      const now = Date.now()
      for (const [key, group] of groups) if (now - group.at > MAX_AGE_MS && !group.merging) groups.delete(key)
      const key = JSON.stringify([device, part.identityKey, part.handoverId])
      let group = groups.get(key)
      if (!group) {
        if (groups.size >= MAX_GROUPS) return
        group = { at: now, total: part.parts, parts: new Map(), merging: false, ...(part.kind ? { kind: part.kind } : {}) }
        groups.set(key, group)
      }
      if (group.total !== part.parts || group.kind !== part.kind || group.merging) return
      const prior = group.parts.get(part.part)
      if (prior !== undefined && prior !== part.data) { groups.delete(key); return }
      group.parts.set(part.part, part.data)
      if (group.parts.size !== group.total) return
      group.merging = true
      try {
        await inbox.merge(Array.from({ length: group.total }, (_, i) => group.parts.get(i)!).join(''), group.kind)
        const receipt: Receipt = { type: 'direct-handover-merged', identityKey: part.identityKey, handoverId: part.handoverId }
        await io.send(device, JSON.stringify(receipt))
      } finally {
        groups.delete(key)
      }
    },
    stop(): void {
      for (const pending of waiting.values()) pending.resolve(false)
      waiting.clear()
      groups.clear()
    },
  }
}
