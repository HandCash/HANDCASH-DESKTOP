import { afterEach, describe, expect, it, vi } from 'vitest'
import { Utils } from '@bsv/sdk'

import { installRawTxFallback } from './rawTxFallback'

vi.mock('./appLog', () => ({ appendAppLog: () => {} }))

type Entry = { name: string; service: (txid: string) => Promise<unknown> }

function fakeServices(existing: string[] = ['WhatsOnChain']) {
  const services: Entry[] = existing.map((name) => ({
    name,
    service: async () => ({ name, txid: '' }),
  }))
  return {
    getRawTxServices: {
      services,
      add(entry: Entry) {
        services.push(entry)
        return this
      },
    },
  }
}

const TXID = 'a'.repeat(64)
const RAW_HEX = '0100000001'

function textResponse(body: string, ok = true): Response {
  return { ok, text: async () => body, json: async () => ({}) } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installRawTxFallback', () => {
  it('prefers Bitails and JungleBus ahead of WhatsOnChain', () => {
    const services = fakeServices()
    installRawTxFallback(services as never, 'main')

    expect(services.getRawTxServices.services.map((s) => s.name)).toEqual([
      'BitailsRawTx',
      'JungleBusRawTx',
      'WhatsOnChain',
    ])
  })

  it('returns the transaction bytes a hex provider serves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse(RAW_HEX)))
    const services = fakeServices()
    installRawTxFallback(services as never, 'main')

    const bitails = services.getRawTxServices.services[0]
    expect(await bitails.service(TXID)).toEqual({
      name: 'BitailsRawTx',
      txid: TXID,
      rawTx: Utils.toArray(RAW_HEX, 'hex'),
    })
  })

  it('reports no bytes — not an error — when a provider is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const services = fakeServices()
    installRawTxFallback(services as never, 'main')

    // A throw here would abort the rotation before the next provider is tried.
    expect(await services.getRawTxServices.services[0].service(TXID)).toEqual({
      name: 'BitailsRawTx',
      txid: TXID,
    })
  })

  it('refuses a body that is not hex', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('<html>rate limited</html>')))
    const services = fakeServices()
    installRawTxFallback(services as never, 'main')

    expect(await services.getRawTxServices.services[0].service(TXID)).toEqual({
      name: 'BitailsRawTx',
      txid: TXID,
    })
  })

  it('decodes the base64 body JungleBus returns', async () => {
    const raw = Utils.toArray(RAW_HEX, 'hex')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ transaction: Utils.toBase64(raw) }),
        text: async () => '',
      })) as never,
    )
    const services = fakeServices()
    installRawTxFallback(services as never, 'main')

    expect(await services.getRawTxServices.services[1].service(TXID)).toEqual({
      name: 'JungleBusRawTx',
      txid: TXID,
      rawTx: raw,
    })
  })

  it('registers only Bitails on testnet and nothing on other chains', () => {
    const test = fakeServices()
    installRawTxFallback(test as never, 'test')
    expect(test.getRawTxServices.services.map((s) => s.name)).toEqual([
      'BitailsRawTx',
      'WhatsOnChain',
    ])

    const local = fakeServices()
    installRawTxFallback(local as never, 'local' as never)
    expect(local.getRawTxServices.services).toHaveLength(1)
  })

  it('does not register the same provider twice across boots', () => {
    const services = fakeServices()
    installRawTxFallback(services as never, 'main')
    installRawTxFallback(services as never, 'main')

    expect(services.getRawTxServices.services).toHaveLength(3)
  })
})
