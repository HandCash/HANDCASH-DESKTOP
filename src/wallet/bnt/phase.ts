/** BRC-253 §9: phase projection from an already verified, ordered beacon chain.
 * Callers must verify scripts, spend branches and block proofs before supplying observations.
 * Missing proof is unknown, never permission to release or countersign.
 */
export type IptBeaconObservation = {
  /** Verified block time; null means this beacon has not been proven mined. */
  minedAt: number | null
  retired?: boolean
  /** A verified release-branch spend, mined, with no next beacon. */
  released?: boolean
}
export type IptPhase = 'unknown' | 'live' | 'ended' | 'released'

export function iptPhaseOf(beacons: readonly IptBeaconObservation[], silence: number, tipTime: number): IptPhase {
  if (!Number.isSafeInteger(silence) || silence < 604_800 || !Number.isSafeInteger(tipTime) || tipTime < 0 || !beacons.length) return 'unknown'
  let previous: number | undefined
  let ended = false
  for (let index = 0; index < beacons.length; index++) {
    const beacon = beacons[index]!
    const time = beacon.minedAt
    if (time === null) {
      // An unmined refresh cannot reset the last mined beacon's silence clock.
      if (index !== beacons.length - 1 || beacon.retired || beacon.released || previous === undefined) return 'unknown'
      return ended || tipTime - previous > silence ? 'ended' : 'live'
    }
    if (!Number.isSafeInteger(time) || time < 0 || time > tipTime) return 'unknown'
    if (previous !== undefined && time - previous > silence) ended = true
    if (beacon.retired) ended = true
    if (beacon.released) {
      // The supplied chain must end at the release, not continue past it.
      return index === beacons.length - 1 ? 'released' : 'unknown'
    }
    previous = time
  }
  return ended || tipTime - previous! > silence ? 'ended' : 'live'
}
