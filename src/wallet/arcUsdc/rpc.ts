/**
 * Minimal Arc JSON-RPC. One POST per call; responses are validated enough to
 * refuse garbage before any signing or balance math.
 */
import { ARC_NETWORKS, type ArcNetwork } from './chain'

export type ArcRpc = {
  network: ArcNetwork
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>
}

export function createArcRpc(
  network: ArcNetwork = 'arc-mainnet',
  fetchImpl: typeof fetch = fetch,
): ArcRpc {
  const url = ARC_NETWORKS[network].rpc
  return {
    network,
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!res.ok) throw new Error(`ARC_USD_RPC: HTTP ${res.status} from ${url}`)
      const body = (await res.json()) as { result?: T; error?: { message?: string } }
      if (body.error) {
        throw new Error(`ARC_USD_RPC: ${body.error.message ?? JSON.stringify(body.error)}`)
      }
      return body.result as T
    },
  }
}

export async function ethChainId(rpc: ArcRpc): Promise<number> {
  const hex = await rpc.call<string>('eth_chainId')
  const id = Number.parseInt(hex, 16)
  if (!Number.isInteger(id) || id <= 0) throw new Error('ARC_USD_RPC: bad eth_chainId')
  return id
}

export async function ethGetTransactionCount(rpc: ArcRpc, address: string): Promise<number> {
  const hex = await rpc.call<string>('eth_getTransactionCount', [address, 'pending'])
  const n = Number.parseInt(hex, 16)
  if (!Number.isInteger(n) || n < 0) throw new Error('ARC_USD_RPC: bad nonce')
  return n
}

export async function ethGasPrice(rpc: ArcRpc): Promise<bigint> {
  const hex = await rpc.call<string>('eth_gasPrice')
  return readHexQuantity(hex, 'gasPrice')
}

export async function ethEstimateGas(
  rpc: ArcRpc,
  tx: { from: string; to: string; data?: string; value?: string },
): Promise<bigint> {
  const hex = await rpc.call<string>('eth_estimateGas', [tx])
  return readHexQuantity(hex, 'estimateGas')
}

export async function ethCall(rpc: ArcRpc, to: string, data: string, from?: string): Promise<string> {
  return rpc.call<string>('eth_call', [{ ...(from ? { from } : {}), to, data }, 'latest'])
}

export async function ethSendRawTransaction(rpc: ArcRpc, raw: string): Promise<string> {
  const hash = await rpc.call<string>('eth_sendRawTransaction', [raw])
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error('ARC_USD_RPC: bad tx hash from eth_sendRawTransaction')
  }
  return hash.toLowerCase()
}

function readHexQuantity(hex: unknown, label: string): bigint {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`ARC_USD_RPC: bad ${label}`)
  }
  return BigInt(hex)
}
