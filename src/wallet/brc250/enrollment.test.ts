import { PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  googleEmail: 'me@gmail.com',
  signedBrc250Fetch: vi.fn(),
}))

vi.mock('./api', () => ({
  createGoogleAttempt: vi.fn(),
  fetchBrc250Manifest: vi.fn(async () => ({ attesterKey: '02' + 'ab'.repeat(32) })),
  googleEmailOf: () => api.googleEmail,
  signedBrc250Fetch: api.signedBrc250Fetch,
  verifiedGoogleProof: vi.fn(async () => ({ idToken: 'header.payload.signature' })),
}))

import {
  completeGoogleEnrollment,
  googleEnrollmentEmail,
  type GoogleEnrollmentSession,
} from './enrollment'

function mxAnswers(table: Record<string, string[]>) {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input))
    const name = url.searchParams.get('name') ?? ''
    const hosts = table[name] ?? []
    return new Response(
      JSON.stringify({
        Status: 0,
        Answer: hosts.map((host, i) => ({ name, type: 15, data: `${(i + 1) * 10} ${host}` })),
      }),
    )
  })
}

const session = {
  host: 'https://recovery.handcash.io',
  attempt: { binding: 'binding', openUrl: 'https://recovery.handcash.io/?binding=binding', expiresAt: 0 },
  authorityKey: PrivateKey.fromRandom(),
  hostShare: 'host-share',
  mailboxShare: 'mailbox-share',
  vaultMasterHex: 'ab'.repeat(32),
  master: { derivation: 'brc-42' },
  loginKey: '02' + 'cd'.repeat(32),
  commitment: 'ef'.repeat(32),
} as unknown as GoogleEnrollmentSession

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    mxAnswers({
      'acme.example': ['aspmx.l.google.com.', 'alt1.aspmx.l.google.com.'],
      'proton.example': ['mail.protonmail.ch.'],
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  api.signedBrc250Fetch.mockReset()
})

describe('Google recovery enrollment refuses a recovery email Google handles', () => {
  it.each(['me@gmail.com', 'me@googlemail.com', 'me@acme.example'])(
    'never hands out %s as the address for the mailbox share',
    async (address) => {
      api.googleEmail = address
      await expect(googleEnrollmentEmail(session)).rejects.toThrow(/Google handles mail/)
    },
  )

  it('refuses a Google Workspace domain before asking the host to enroll', async () => {
    api.googleEmail = 'me@acme.example'
    await expect(completeGoogleEnrollment(session, 'mailbox-share')).rejects.toThrow(
      /Google handles mail for acme\.example/,
    )
    expect(api.signedBrc250Fetch).not.toHaveBeenCalled()
  })

  it('refuses an address whose mail provider it cannot confirm', async () => {
    api.googleEmail = 'me@nomx.example'
    await expect(completeGoogleEnrollment(session, 'mailbox-share')).rejects.toThrow(
      /Couldn't confirm who handles mail for nomx\.example/,
    )
    expect(api.signedBrc250Fetch).not.toHaveBeenCalled()
  })

  it('lets an address with another mail provider through', async () => {
    api.googleEmail = 'me@proton.example'
    await expect(googleEnrollmentEmail(session)).resolves.toBe('me@proton.example')
  })
})
