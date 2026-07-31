import { playWalletSound } from './soundService'

/** @deprecated Prefer playWalletSound('success') — kept for existing callers. */
export function playPaymentSuccessSound(): void {
  playWalletSound('success')
}
