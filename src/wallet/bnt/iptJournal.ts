import { storageRegistry } from '../../storage/registry'
import { accountLocalKeyFor, type BoundAccountKeyScope } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'
import { createIptReservations, type IptReservationEvent, type IptReservationJournal } from './iptReservations'

const LIMIT = 4096
const PUBKEY = /^0[23][0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/

/** BRC-253 §6. One writer per account/issuer. Immutable event segments precede
 * the head write; a crash between them is recovered without freeing inputs.
 * This is not a cross-process compare-and-swap or a funding recovery service.
 */
export function createDurableIptJournal(owner: BoundAccountKeyScope, issuer: string): IptReservationJournal {
  if (!PUBKEY.test(issuer) || !PUBKEY.test(owner.identityKey) ||
      !Number.isSafeInteger(owner.accountIndex) || owner.accountIndex < 0 ||
      (owner.chain !== 'main' && owner.chain !== 'test')) throw new Error('Invalid IPT journal owner')
  const base = accountLocalKeyFor(`${storageRegistry.iptReservations.key}:${issuer}`, { ...owner })
  const segment = (index: number) => `${base}.s${index}`
  const events: IptReservationEvent[] = []
  const headRaw = durableGetItem(base)
  const head = headRaw === null ? 0 : Number(headRaw)
  if (!Number.isSafeInteger(head) || head < 0 || head > LIMIT || (headRaw !== null && String(head) !== headRaw)) {
    throw new Error('Corrupt IPT journal head')
  }
  // Probe one beyond the head: its immutable segment may have landed before a
  // failed head update. Never overwrite it or treat its inputs as available.
  for (let index = 0; index < head + 1; index++) {
    const raw = durableGetItem(segment(index))
    if (raw === null) {
      if (index < head) throw new Error('Missing IPT reservation segment')
      break
    }
    if (index >= LIMIT) throw new Error('IPT reservation journal full')
    if (raw.length > 5 * 1024 * 1024) throw new Error('Oversized IPT reservation segment')
    let event: IptReservationEvent
    try { event = JSON.parse(raw) } catch { throw new Error('Corrupt IPT reservation segment') }
    if (!event || !HASH.test(event.requestId) ||
        (event.t !== 'reserved' && event.t !== 'signed') ||
        (event.t === 'reserved' && (!/^[0-9a-f]{40}$/.test(event.assetId) ||
          !Array.isArray(event.inputs) || event.inputs.length > 100 ||
          event.inputs.some((input) => typeof input !== 'string' || !/^[0-9a-f]{64}\.\d+$/.test(input)))) ||
        (event.t === 'signed' && !Array.isArray(event.signedEf))) throw new Error('Corrupt IPT reservation segment')
    events.push(event)
  }
  // Validate the entire projection before exposing any stored result.
  createIptReservations({ read: () => events, append: () => { throw new Error('Read only') } })
  let poisoned = false
  return {
    read: () => structuredClone(events),
    append(event) {
      if (poisoned) throw new Error('Reopen IPT journal after failed write')
      if (events.length >= LIMIT) throw new Error('IPT reservation journal full')
      if (durableGetItem(segment(events.length)) !== null) throw new Error('IPT journal has another writer')
      const raw = JSON.stringify(event)
      // The caller's ledger validates transitions; validate persisted shape on
      // reopen as well. Do not mutate an already written segment.
      if (!durableSetItem(segment(events.length), raw)) {
        poisoned = true
        throw new Error('IPT reservation was not saved')
      }
      events.push(structuredClone(event))
      if (!durableSetItem(base, String(events.length))) {
        poisoned = true
        throw new Error('IPT reservation head was not saved; reopen to recover')
      }
    },
  }
}
