/**
 * Which onboarding a new install walks through. The vault master is the one
 * key backup for every wallet on every device, so only a new vault asks for
 * it. A restore already used it; a device joined by approval was sent it.
 */
export type OnboardStep = 'keys-backup' | 'history' | 'accept' | 'email' | 'protect'

/** `joined`: a signed-in device approved this one and sent it the vault master. */
export type OnboardRoute = 'create' | 'restore' | 'joined'

/** The first step, or null to open the wallet at once. */
export function firstOnboardStep(route: OnboardRoute, hasMnemonic: boolean): OnboardStep | null {
  if (route === 'create') return hasMnemonic ? 'keys-backup' : 'accept'
  if (route === 'restore') return 'history'
  return null
}

/**
 * A new wallet asks for an optional sign-in email after what it accepts, so a
 * later device that can't reach this one on the local network can still sign
 * in. A wallet that already has one goes straight to protect.
 */
export function stepAfterAccept(hasSigninEmail: boolean): OnboardStep {
  return hasSigninEmail ? 'protect' : 'email'
}

/** Every route but a new vault proves the master key is already backed up. */
export function masterKeyAlreadyBackedUp(route: OnboardRoute): boolean {
  return route !== 'create'
}
