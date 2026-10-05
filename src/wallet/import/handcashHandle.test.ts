import { describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))

import { normalizeHandCashHandle, probeHandCashHandle } from './handcashHandle'
import { keyDeriverFor } from './importSource'

const SHARE_ONE =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'
const SHARE_TWO =
  'xprv9s21ZrQH143K31xYSDQpPDxsXRTUcvj2iNHm5NUtrGiGG5e2DtALGdso3pGz6ssrdK4PFmM8NSpSBHNqPqm55Qn3LqFtT2emdEXVYsCzC2U'
const deriver = keyDeriverFor({ kind: 'handcash', first: SHARE_ONE, second: SHARE_TWO })

const pki = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('HandCash handle proof', () => {
  it('normalises the forms people paste', () => {
    expect(normalizeHandCashHandle('$Alice')).toBe('alice')
    expect(normalizeHandCashHandle('bob@handcash.io')).toBe('bob')
    expect(normalizeHandCashHandle('has space')).toBeNull()
  })

  it('proves a handle when a composed key equals its PKI key', async () => {
    const pubkey = deriver.privateKeyAt('m/2/0').toPublicKey().toString()
    const fetchImpl = pki({ pubkey })
    const probe = await probeHandCashHandle('$alice', deriver, fetchImpl)
    expect(probe).toMatchObject({ handle: 'alice', pubkey, match: 'm/2/0', error: null })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cloud.handcash.io/api/bsvalias/id/alice@handcash.io',
      expect.anything(),
    )
  })

  it('reports unproven without refusing when no key matches', async () => {
    const probe = await probeHandCashHandle('alice', deriver, pki({ pubkey: `02${'11'.repeat(32)}` }))
    expect(probe.match).toBeNull()
    expect(probe.error).toBeNull()
  })

  it('carries the PKI failure as the reason', async () => {
    expect((await probeHandCashHandle('ghost', deriver, pki({}, 404))).error).toContain('does not know')
    await expect(probeHandCashHandle('', deriver, pki({}))).rejects.toThrow('Enter a HandCash handle')
  })
})
