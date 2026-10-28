/**
 * Onboarding first screen: Sign in + Create, or Migrate alone when cloud
 * prior session exists. Kept separate from authModes so Connect/Recover
 * work in another chat can land without fighting this file.
 */

export type OnboardEntryKind = 'unsigned' | 'signed-in'

export function onboardEntryKind(hasCloudPriorSession: boolean): OnboardEntryKind {
  return hasCloudPriorSession ? 'signed-in' : 'unsigned'
}

/** Whether onboarding should show the entry chooser before create / sign-in forms. */
export function showOnboardEntry(args: {
  mode: 'onboarding' | 'locked'
  recoveryOnly: boolean
}): boolean {
  return args.mode === 'onboarding' && !args.recoveryOnly
}
