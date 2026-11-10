import type { CallSnapshot } from '../../wallet/calls/callEngine'

/** Presentation only: callMachine remains the authority for every call step. */
export function callStatus(snapshot: CallSnapshot): string {
  const { context } = snapshot
  if (snapshot.matches('incoming')) return context.video ? 'Incoming video call · answer with voice' : 'Incoming voice call'
  if (snapshot.matches({ outgoing: 'reaching' })) return 'Reaching peer…'
  if (snapshot.matches({ outgoing: 'ringing' })) return 'Ringing…'
  if (snapshot.matches('connecting')) return 'Connecting audio…'
  if (snapshot.matches('active')) return context.remoteMuted ? 'Connected · peer muted' : 'Connected'
  if (snapshot.matches('ended')) {
    if (context.failure) return context.failure
    switch (context.outcome) {
      case 'unreachable': return 'Peer unreachable'
      case 'no-answer': return 'No answer'
      case 'missed': return 'Missed call'
      case 'declined': return 'Call declined'
      case 'busy': return 'Peer is on another call'
      case 'failed': return 'Call failed'
      case 'cancelled': return 'Call cancelled'
      default: return 'Call ended'
    }
  }
  return ''
}
