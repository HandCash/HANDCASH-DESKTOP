import { useMemo, useSyncExternalStore } from 'react'
import {
  issuerViewFor,
  type IssuerIdentityResolver,
  type IssuerView,
} from '../wallet/collectableGroups'
import {
  issuerIdentitiesGeneration,
  subscribeIssuerIdentities,
} from '../wallet/issuerIdentities'
import {
  issuerAttributionResolver,
  publicIdentitiesGeneration,
  subscribePublicIdentities,
} from '../wallet/publicIdentities'
import { getWalletRuntime } from '../wallet/walletRuntime'

export type IssuerAsset = {
  issuer?: string
  issuerAttested?: boolean
  bapId?: string
  /** Outpoint whose mined height judges the signer: item origin or token deploy. */
  origin?: string
}

/** Resolver bound to the current runtime, for one render pass. */
export function currentIssuerResolver(): IssuerIdentityResolver {
  return issuerAttributionResolver(getWalletRuntime())
}

/** Generation that changes whenever an identity or a stored package does. */
export function useIssuerIdentitiesGeneration(): string {
  const identities = useSyncExternalStore(subscribePublicIdentities, publicIdentitiesGeneration)
  const packages = useSyncExternalStore(subscribeIssuerIdentities, issuerIdentitiesGeneration)
  return `${identities}:${packages}`
}

/** One asset's issuer, re-read when identities or stored packages change. */
export function useIssuerView(asset: IssuerAsset | null): IssuerView | null {
  const generation = useIssuerIdentitiesGeneration()
  const issuer = asset?.issuer
  const issuerAttested = asset?.issuerAttested
  const bapId = asset?.bapId
  const origin = asset?.origin
  return useMemo(
    () =>
      issuer
        ? issuerViewFor({ issuer, issuerAttested, bapId, origin }, currentIssuerResolver())
        : null,
    [issuer, issuerAttested, bapId, origin, generation],
  )
}
