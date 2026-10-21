/**
 * Opens Google sign-in and mail drafts in the user's own browser and mail app,
 * where they are already signed in. Never an embedded window: that would hide
 * their existing Google session and ask them to type credentials into HandCash.
 */
export async function openInSystemBrowser(url: string): Promise<void> {
  if (window.handcash?.openExternal) return window.handcash.openExternal(url)
  window.open(url, '_blank', 'noopener,noreferrer')
}
