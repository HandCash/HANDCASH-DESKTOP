/**
 * Circle Arc network constants for Arc-native USDC.
 *
 * USDC on Arc is the native gas + ERC-20 view of one pool
 * (`0x3600…0000`, 6 decimals). Other chains' USDC (Ethereum, Solana, …) is
 * refused — fractionalization is Arc-only.
 *
 * Refs: https://docs.arc.io · chain id 5042 mainnet / 5042002 testnet.
 */

export const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000' as const
/** Display / transfer decimals (ERC-20 view). Native gas view is 18 — never mix. */
export const ARC_USDC_DECIMALS = 6

export type ArcNetwork = 'arc-mainnet' | 'arc-testnet'

export const ARC_NETWORKS: Readonly<
  Record<
    ArcNetwork,
    {
      chainId: number
      label: string
      rpc: string
      explorer: string
    }
  >
> = Object.freeze({
  'arc-mainnet': {
    chainId: 5042,
    label: 'Arc',
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
  },
  'arc-testnet': {
    chainId: 5042002,
    label: 'Arc testnet',
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
  },
})

const BY_CHAIN_ID = new Map(
  (Object.entries(ARC_NETWORKS) as [ArcNetwork, (typeof ARC_NETWORKS)[ArcNetwork]][]).map(
    ([id, net]) => [net.chainId, id],
  ),
)

export function isArcChainId(chainId: unknown): boolean {
  return typeof chainId === 'number' && Number.isInteger(chainId) && BY_CHAIN_ID.has(chainId)
}

export function arcNetworkOf(chainId: number): ArcNetwork | null {
  return BY_CHAIN_ID.get(chainId) ?? null
}

/** True only for the Arc USDC ERC-20 predeploy (case-insensitive). */
export function isArcUsdcToken(address: unknown): boolean {
  return (
    typeof address === 'string' &&
    address.trim().toLowerCase() === ARC_USDC_ERC20.toLowerCase()
  )
}

/**
 * Refuse any non-Arc network or non-Arc-USDC token. Used at every
 * fractionalize / redeem entry so Ethereum USDC (and others) never enter.
 */
export function assertArcUsdcOnly(args: {
  chainId: number
  tokenAddress?: string | null
}): ArcNetwork {
  const network = arcNetworkOf(args.chainId)
  if (!network) {
    throw new Error(
      `ARC_USDC_CHAIN: USDC fractionalization is Arc-only (got chainId ${args.chainId})`,
    )
  }
  if (args.tokenAddress != null && args.tokenAddress !== '' && !isArcUsdcToken(args.tokenAddress)) {
    throw new Error(
      `ARC_USDC_TOKEN: only Arc USDC at ${ARC_USDC_ERC20} is accepted (got ${args.tokenAddress})`,
    )
  }
  return network
}
