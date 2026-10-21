/** Which form the auth screen shows, and where an existing wallet starts. */

/** Custody restore paths the vault can bootstrap from. */
export type RestoreMethod = 'phrase' | 'shares' | 'key'
export type FormMode = 'create' | 'unlock' | 'signin' | 'google' | RestoreMethod

export const RESTORE_METHODS: { id: RestoreMethod; label: string }[] = [
  { id: 'phrase', label: 'Phrase' },
  { id: 'shares', label: 'Shares' },
  { id: 'key', label: 'Key' },
]

/**
 * An existing wallet on a new device signs in with its email code and approval
 * from a signed-in device. Google and recovery sit behind "Other ways to sign in".
 */
export const EXISTING_WALLET_MODE: FormMode = 'signin'

/**
 * Inside sign-in, scan-to-login over the local network comes first; the email
 * code with HandCash relaying the approval is the fallback, and the only way
 * when this device has no local network address for its peer server.
 */
export function firstSigninStep(lanUrls: readonly string[]): 'scan' | 'email' {
  return lanUrls.length > 0 ? 'scan' : 'email'
}

/** Where "Other ways to sign in" lands: the recovery methods, phrase first. */
export const OTHER_SIGNIN_MODE: FormMode = 'phrase'

export function isRestoreMethod(mode: FormMode): mode is RestoreMethod {
  return mode === 'phrase' || mode === 'shares' || mode === 'key'
}

export function initialFormMode(args: { mode: 'onboarding' | 'locked'; recoveryOnly: boolean }): FormMode {
  if (args.recoveryOnly) return 'phrase'
  return args.mode === 'locked' ? 'unlock' : 'create'
}

/** Leaving Google sign-in goes back to where the user came from. */
export function formModeAfterGoogle(args: { mode: 'onboarding' | 'locked'; recoveryOnly: boolean }): FormMode {
  return args.mode === 'locked' && !args.recoveryOnly ? 'unlock' : OTHER_SIGNIN_MODE
}
