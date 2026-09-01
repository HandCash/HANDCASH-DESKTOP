import { useEffect, useState } from 'react'
import type { Chain } from '../wallet/vault'
import { readTrustedBalance } from '../wallet/balanceSnapshot'
import { DISPLAY_BALANCE_REFRESH_EVENT } from '../wallet/displayBalanceRefresh'

/** Live display balance for send panels — avoids re-rendering WalletNav on every sync tick. */
export function useDisplayBalanceSats(profile: {
  identityKey: string
  chain: Chain
}): number {
  const [sats, setSats] = useState(
    () => readTrustedBalance(profile.identityKey, profile.chain) ?? 0,
  )

  useEffect(() => {
    const trusted = readTrustedBalance(profile.identityKey, profile.chain)
    if (trusted != null) setSats(trusted)
  }, [profile.identityKey, profile.chain])

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceSats?: number }>).detail
      if (typeof detail?.balanceSats !== 'number') return
      setSats(detail.balanceSats)
    }
    document.addEventListener(DISPLAY_BALANCE_REFRESH_EVENT, onRefresh)
    return () => document.removeEventListener(DISPLAY_BALANCE_REFRESH_EVENT, onRefresh)
  }, [])

  return sats
}
