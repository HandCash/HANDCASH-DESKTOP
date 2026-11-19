import { iptRequestId, type IptProposal } from './iptProposal'

/** BRC-253 §6. A single acceptor writer owns this journal. append must be
 * atomic and durable before returning; throwing means no signature may escape.
 * The host must bind the journal to account + issuer + network, not active UI.
 */
export type IptReservationEvent =
  | { t: 'reserved'; requestId: string; assetId: string; inputs: string[] }
  | { t: 'signed'; requestId: string; signedEf: number[] }

export type IptReservationJournal = {
  read(): readonly IptReservationEvent[]
  append(event: IptReservationEvent): void
}
export type IptReservationResult =
  | { state: 'reserved'; requestId: string }
  | { state: 'pending'; requestId: string }
  | { state: 'signed'; requestId: string; signedEf: number[] }

/** Reservations have no timeout/cancel shortcut. A missing reply or process
 * crash never authorizes a conflicting signature. A restarted pending request
 * needs explicit recovery of the staged funding action before it can finish.
 * This ledger alone does not authorize signing or validate a final transaction.
 */
export function createIptReservations(journal: IptReservationJournal) {
  const requests = new Map<string, { assetId: string; inputs: string[]; signedEf?: number[] }>()
  const owners = new Map<string, string>()
  for (const event of journal.read()) {
    if (event.t === 'reserved') {
      if (requests.has(event.requestId) || event.inputs.length === 0 || new Set(event.inputs).size !== event.inputs.length ||
          event.inputs.some((input) => owners.has(input))) throw new Error('Conflicting IPT reservation journal')
      requests.set(event.requestId, { assetId: event.assetId, inputs: [...event.inputs] })
      for (const input of event.inputs) owners.set(input, event.requestId)
    } else {
      const request = requests.get(event.requestId)
      if (!request || request.signedEf) throw new Error('Unbound IPT signed journal entry')
      iptRequestId(event.signedEf)
      request.signedEf = [...event.signedEf]
    }
  }
  return {
    reserve(proposal: IptProposal): IptReservationResult {
      if (iptRequestId(proposal.ef) !== proposal.requestId) throw new Error('IPT proposal commitment changed')
      const existing = requests.get(proposal.requestId)
      if (existing) {
        if (existing.assetId !== proposal.assetId || existing.inputs.join(',') !== proposal.inputs.join(',')) {
          throw new Error('IPT reservation binding changed')
        }
        return existing.signedEf
          ? { state: 'signed', requestId: proposal.requestId, signedEf: [...existing.signedEf] }
          : { state: 'pending', requestId: proposal.requestId }
      }
      if (proposal.inputs.length === 0 || new Set(proposal.inputs).size !== proposal.inputs.length ||
          proposal.inputs.some((input) => owners.has(input))) throw new Error('IPT input already reserved')
      const event: IptReservationEvent = {
        t: 'reserved', requestId: proposal.requestId, assetId: proposal.assetId, inputs: [...proposal.inputs],
      }
      journal.append(event)
      requests.set(proposal.requestId, { assetId: proposal.assetId, inputs: [...proposal.inputs] })
      for (const input of proposal.inputs) owners.set(input, proposal.requestId)
      return { state: 'reserved', requestId: proposal.requestId }
    },
    /** Caller supplies a fully validated transaction, already signed but never
     * delivered/broadcast until this durable write succeeds. */
    recordSigned(requestId: string, signedEf: number[]): IptReservationResult {
      const request = requests.get(requestId)
      if (!request) throw new Error('IPT request is not reserved')
      iptRequestId(signedEf)
      if (request.signedEf) {
        if (iptRequestId(request.signedEf) !== iptRequestId(signedEf)) throw new Error('IPT request already signed')
        return { state: 'signed', requestId, signedEf: [...request.signedEf] }
      }
      journal.append({ t: 'signed', requestId, signedEf: [...signedEf] })
      request.signedEf = [...signedEf]
      return { state: 'signed', requestId, signedEf: [...signedEf] }
    },
  }
}
