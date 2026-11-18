import { accountLocalKeyFor, type BoundAccountKeyScope } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'
import { storageRegistry } from '../../storage/registry'

export type ImportSelection = { outpoint: string; name: string | null }
type Entry = { sourceId: string; items: ImportSelection[] }
type Event = { kind: 'enqueue' | 'settled' | 'stop'; sourceId: string; items: ImportSelection[] }
const BASE = storageRegistry.importCheckpoint.key
export const CHECKPOINT_SLICE = 100

/**
 * The chosen work, not keys or signed transactions. Signed spends remain owned
 * by the wallet's outbox/sealed-tip recovery. Each event is bounded; commit its
 * index only after the segment lands, before a caller may begin signing.
 */
export class ImportCheckpoint {
  private readonly key: string
  private next = 0
  private pending = new Map<string, Map<string, ImportSelection>>()

  constructor(readonly owner: BoundAccountKeyScope) {
    this.key = accountLocalKeyFor(BASE, owner)
    this.refresh()
  }

  private refresh(): void {
    const head = durableGetItem(this.key)
    if (head === null || head === '') return
    const next: unknown = JSON.parse(head)
    if (!Number.isSafeInteger(next) || (next as number) < this.next) throw new Error('The import checkpoint is unreadable')
    for (let i = this.next; i < (next as number); i++) {
      const raw = durableGetItem(`${this.key}:${i}`)
      if (!raw) throw new Error('An import checkpoint segment is missing')
      const event = JSON.parse(raw) as Event
      if (!['enqueue', 'settled', 'stop'].includes(event.kind) || typeof event.sourceId !== 'string' ||
          !Array.isArray(event.items) || event.items.length > CHECKPOINT_SLICE ||
          event.items.some((item) => typeof item.outpoint !== 'string' || !(item.name === null || typeof item.name === 'string'))) {
        throw new Error('The import checkpoint is unreadable')
      }
      this.apply(event)
      this.next = i + 1
    }
  }

  entries(): Entry[] {
    this.refresh()
    return [...this.pending].map(([sourceId, items]) => ({ sourceId, items: [...items.values()] }))
  }

  enqueue(sourceId: string, items: readonly ImportSelection[]): void {
    this.refresh()
    const seen = new Set(this.pending.get(sourceId)?.keys())
    const fresh = items.filter((item) => {
      if (seen.has(item.outpoint)) return false
      seen.add(item.outpoint)
      return true
    })
    this.append('enqueue', sourceId, fresh)
  }

  settled(sourceId: string, outpoints: readonly string[]): void {
    this.refresh()
    const pending = this.pending.get(sourceId)
    this.append('settled', sourceId, outpoints.filter((outpoint) => pending?.has(outpoint)).map((outpoint) => ({ outpoint, name: null })))
  }

  stop(sourceId: string): void {
    this.refresh()
    if (this.pending.has(sourceId)) this.commit({ kind: 'stop', sourceId, items: [] })
  }

  private append(kind: Event['kind'], sourceId: string, items: readonly ImportSelection[]): void {
    for (let i = 0; i < items.length; i += CHECKPOINT_SLICE) {
      this.commit({ kind, sourceId, items: items.slice(i, i + CHECKPOINT_SLICE) })
    }
  }

  private commit(event: Event): void {
    if (!durableSetItem(`${this.key}:${this.next}`, JSON.stringify(event)) ||
        !durableSetItem(this.key, JSON.stringify(this.next + 1))) {
      throw new Error('The import checkpoint could not be saved. Free storage, then retry.')
    }
    this.next += 1
    this.apply(event)
  }

  private apply(event: Event): void {
    if (event.kind === 'stop') {
      this.pending.delete(event.sourceId)
      return
    }
    const items = this.pending.get(event.sourceId) ?? new Map<string, ImportSelection>()
    for (const item of event.items) {
      if (event.kind === 'enqueue') items.set(item.outpoint, item)
      else items.delete(item.outpoint)
    }
    if (items.size) this.pending.set(event.sourceId, items)
    else this.pending.delete(event.sourceId)
  }
}
