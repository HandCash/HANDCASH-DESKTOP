import { Transaction } from '@bsv/sdk'
import type { Chain } from '../vault'
import type { BeaconChainSource } from './beacon'

const TXID_RE = /^[0-9a-f]{64}$/

/** A beacon chain source over WhatsOnChain; every miss is "no answer". */
export function whatsOnChainBeaconSource(chain: Chain): BeaconChainSource {
  const get = async (path: string): Promise<Response | null> => {
    const { whatsOnChainGet } = await import('../legacyScan')
    return whatsOnChainGet(chain, path)
  }
  return {
    async spentBy(txid, vout) {
      const res = await get(`/tx/${txid}/${vout}/spent`)
      if (!res) return undefined
      if (res.status === 404) return null
      if (!res.ok) return undefined
      const body = (await res.json().catch(() => null)) as { txid?: unknown } | null
      const spender = String(body?.txid ?? '').toLowerCase()
      return TXID_RE.test(spender) ? spender : undefined
    },
    async tx(txid) {
      const res = await get(`/tx/${txid}/hex`)
      if (!res?.ok) return null
      try {
        const tx = Transaction.fromHex((await res.text()).trim())
        return String(tx.id('hex')) === txid ? tx : null
      } catch {
        return null
      }
    },
    async blockTime(txid) {
      const res = await get(`/tx/hash/${txid}`)
      if (!res?.ok) return undefined
      const body = (await res.json().catch(() => null)) as { blocktime?: unknown; confirmations?: unknown } | null
      if (!body) return undefined
      const time = Number(body.blocktime)
      return Number(body.confirmations) > 0 && Number.isFinite(time) && time > 0 ? time : null
    },
    async tipTime() {
      const res = await get('/chain/info')
      if (!res?.ok) return null
      const body = (await res.json().catch(() => null)) as { mediantime?: unknown } | null
      const time = Number(body?.mediantime)
      return Number.isFinite(time) && time > 0 ? time : null
    },
  }
}
