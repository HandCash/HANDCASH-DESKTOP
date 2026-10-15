/**
 * Local-only metadata carrying the Wallet Toolbox signer's exact wallet-funded
 * amount for a partial action. A symbol keeps this implementation detail out of
 * the BRC-100 JSON and binary wire protocols while allowing local wrappers such
 * as WalletPermissionsManager to include storage service charges in approval.
 */
export const exactActionSpendSymbol = Symbol.for('@bsv/wallet-toolbox/exact-action-spend')

export interface ExactActionSpendCarrier {
  [exactActionSpendSymbol]?: number
}
