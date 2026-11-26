import type { WalletInterface } from '@bsv/sdk'
import { errorText } from '../errorText'
import { signIptProposal, validateIptAcceptance, validateIptProposal } from './iptProposal'
import { verifyIptRecipients, type IptRecipient } from './iptRecipients'
import { createIptReservations, type IptReservationJournal } from './iptReservations'

type Signing = Parameters<typeof signIptProposal>[0]

/** Why an acceptance failed, and whether this request may now hold inputs.
 * `held` is false only when the failure came before this request reached any
 * reservation; otherwise it may own its inputs and only replaying the same
 * request can finish it (BRC-253 §6 accept-once; no paid recovery).
 */
export class IptAcceptError extends Error {
  readonly held: boolean
  constructor(cause: unknown, held: boolean) {
    super(errorText(cause), { cause })
    this.name = 'IptAcceptError'
    this.held = held
  }
}
type Request = {
  sender: string
  ef: number[]
  recipients: IptRecipient[]
}

/** BRC-253 §§5–6. One pinned account/issuer writer, never an ambient active
 * wallet. Hosts must supply trusted accepted facts, authenticated sender,
 * policy and funding. No signature escapes before journaling.
 * A pending request is NOT signed again: a replay returns it still pending.
 */
export function createIptAcceptor(host: {
  journal: IptReservationJournal
  wallet: Pick<WalletInterface, 'decrypt'>
  deploy: Signing['deploy']
  accepted: Signing['accepted']
  authorize(sender: string, identities: readonly string[]): Promise<void>
  fund(requestId: string): Promise<Pick<Signing, 'fee' | 'minimumFee' | 'signIssuer' | 'signFee'>>
}) {
  // Requests run one at a time, so one flag tracks the current request's writes.
  let wrote = false
  const reservations = createIptReservations({
    read: () => host.journal.read(),
    append: (event) => { wrote = true; host.journal.append(event) },
  })
  let tail: Promise<unknown> = Promise.resolve()
  return {
    accept(request: Request) {
      // Snapshot untrusted request before waiting behind another request.
      const snapshot = structuredClone(request)
      let holding = false
      const run = async () => {
        wrote = false
        try {
          return await steps()
        } catch (err) {
          // A conflict refused before any write holds nothing for this request.
          // A write attempt (even a failed one) or a found reservation may.
          throw new IptAcceptError(err, wrote || holding)
        }
      }
      const steps = async () => {
        if (host.deploy.rules.mode !== 'countersign' ||
            host.deploy.rules.issuer.m !== 1 || host.deploy.rules.issuer.keys.length !== 1) {
          throw new Error('IPT acceptor supports singleton issuers only')
        }
        const proposal = validateIptProposal(snapshot.ef, host.deploy, host.accepted)
        const identities = await verifyIptRecipients(host.wallet, snapshot.sender, proposal, snapshot.recipients)
        await host.authorize(snapshot.sender, identities)
        const reservation = reservations.reserve(proposal)
        holding = true
        if (reservation.state === 'pending') return reservation
        if (reservation.state === 'signed') {
          validateIptAcceptance(snapshot.ef, reservation.signedEf, host.deploy, host.accepted)
          return reservation
        }
        // Reservation precedes funding. Any failure leaves it pending, including
        // a failed durable signed write; a replay finds it pending, never creates anew.
        const funding = await host.fund(proposal.requestId)
        const signed = await signIptProposal({
          ...funding, ef: snapshot.ef, deploy: host.deploy, accepted: host.accepted,
        })
        return reservations.recordSigned(proposal.requestId, signed.signedEf)
      }
      const result = tail.then(run)
      tail = result.catch(() => {})
      return result
    },
  }
}
