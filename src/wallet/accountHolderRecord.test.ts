import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('./identityRequestAuth', () => ({
  signedIdentityFetch: (...args: unknown[]) => fetchMock(...args),
}))
vi.mock('./historyBackupPrefs', () => ({
  resolveHistoryBackupBaseUrl: () => 'https://backup.example',
}))

import { writeHolderRecord } from './accountHolderRecord'

const ROOT = '1ad0895dd317163f0e83499c30bc593dbcc54cad96a5f57b065ce9f700513250'
const account = { rootKeyHex: ROOT, identityKey: PrivateKey.fromHex(ROOT).toPublicKey().toString() }
const fields = { deviceId: 'device-me', state: 'held' as const, seq: 3 }

describe('writeHolderRecord preconditions', () => {
  beforeEach(() => fetchMock.mockReset())

  it('never sends a replace without a version to match (no blind overwrite)', async () => {
    const out = await writeHolderRecord(account, fields, { create: false, etag: null })
    expect(out.kind).toBe('unreachable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends If-Match for a replace and If-None-Match for a create', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await writeHolderRecord(account, fields, { create: false, etag: '"e1"' })
    await writeHolderRecord(account, fields, { create: true })
    const [, , , replace] = fetchMock.mock.calls[0]
    const [, , , create] = fetchMock.mock.calls[1]
    expect(replace.headers['If-Match']).toBe('"e1"')
    expect(replace.headers['If-None-Match']).toBeUndefined()
    expect(create.headers['If-None-Match']).toBe('*')
    expect(create.headers['If-Match']).toBeUndefined()
  })

  it('reports a failed precondition as a conflict', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 412 }))
    expect((await writeHolderRecord(account, fields, { create: false, etag: '"e1"' })).kind).toBe('conflict')
  })
})
