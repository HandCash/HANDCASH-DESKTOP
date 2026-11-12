/**
 * Onboarding first screen gate. Kept separate from authModes so Connect/Recover
 * work can land without fighting this file.
 */

/** Whether onboarding should show the entry chooser before create / sign-in forms. */
export function showOnboardEntry(args: {
  mode: 'onboarding' | 'locked'
  recoveryOnly: boolean
}): boolean {
  return args.mode === 'onboarding' && !args.recoveryOnly
}
