import type { WalletInterface } from '@bsv/sdk'
import { signIptProposal, validateIptAcceptance, validateIptProposal } from './iptProposal'
import { verifyIptRecipients, type IptRecipient } from './iptRecipients'
import { createIptReservations, type IptReservationJournal } from './iptReservations'

type Signing = Parameters<typeof signIptProposal>[0]
type Request = {
  sender: string
  ef: number[]
  recipients: IptRecipient[]
}

/** BRC-253 §§5–6. One pinned account/issuer writer, never an ambient active
 * wallet. Hosts must supply trusted accepted facts, authenticated sender,
 * policy and durable funding recovery. No signature escapes before journaling.
 * A pending request is NOT signed again: its funding action needs recovery.
 */
export function createIptAcceptor(host: {
  journal: IptReservationJournal
  wallet: Pick<WalletInterface, 'decrypt'>
  deploy: Signing['deploy']
  accepted: Signing['accepted']
  authorize(sender: string, identities: readonly string[]): Promise<void>
  fund(requestId: string): Promise<Pick<Signing, 'fee' | 'minimumFee' | 'signIssuer' | 'signFee'>>
}) {
  const reservations = createIptReservations(host.journal)
  let tail: Promise<unknown> = Promise.resolve()
  return {
    accept(request: Request) {
      // Snapshot untrusted request before waiting behind another request.
      const snapshot = structuredClone(request)
      const run = async () => {
        if (host.deploy.rules.mode !== 'countersign' ||
            host.deploy.rules.issuer.m !== 1 || host.deploy.rules.issuer.keys.length !== 1) {
          throw new Error('IPT acceptor supports singleton issuers only')
        }
        const proposal = validateIptProposal(snapshot.ef, host.deploy, host.accepted)
        const identities = await verifyIptRecipients(host.wallet, snapshot.sender, proposal, snapshot.recipients)
        await host.authorize(snapshot.sender, identities)
        const reservation = reservations.reserve(proposal)
        if (reservation.state === 'pending') return reservation
        if (reservation.state === 'signed') {
          validateIptAcceptance(snapshot.ef, reservation.signedEf, host.deploy, host.accepted)
          return reservation
        }
        // Reservation precedes funding. Any failure leaves it pending, including
        // a failed durable signed write; retry must recover, never create anew.
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
