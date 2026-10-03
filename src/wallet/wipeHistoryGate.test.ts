import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  backupOn: true,
  looksEmpty: false,
  credential: '' as string | null,
  upload: vi.fn(),
  meta: vi.fn(),
}))

vi.mock('./deviceSync', () => ({ hasDeviceLinkBackupUrl: () => h.backupOn }))
vi.mock('./layers', () => ({
  inspectLocalToolboxState: async () => ({ looksEmpty: h.looksEmpty }),
}))
vi.mock('./sessionBackupAuth', () => ({ sessionBackupCredential: () => h.credential }))
vi.mock('./appLog', () => ({ appendAppLog: () => undefined }))
vi.mock('./historyBackup', () => {
  class HistoryThinOverwriteError extends Error {}
  return {
    HistoryThinOverwriteError,
    uploadBrc39Backup: (...args: unknown[]) => h.upload(...args),
    fetchRemoteBrc39Meta: () => h.meta(),
  }
})

import { HistoryThinOverwriteError } from './historyBackup'
import {
  assertWipeGateFresh,
  overrideWipeGate,
  syncHistoryBeforeWipe,
  WIPE_GATE_TTL_MS,
  wipeLossWarning,
} from './wipeHistoryGate'

describe('syncHistoryBeforeWipe', () => {
  beforeEach(() => {
    h.backupOn = true
    h.looksEmpty = false
    h.credential = ''
    h.upload.mockReset().mockResolvedValue({ exportedAt: 1000 })
    h.meta.mockReset().mockResolvedValue({ exists: true, exportedAt: 1000 })
  })

  it('passes without a backup URL and never uploads', async () => {
    h.backupOn = false
    expect(await syncHistoryBeforeWipe()).toMatchObject({ ok: true, gate: { kind: 'backup-off' } })
    expect(h.upload).not.toHaveBeenCalled()
  })

  it('passes an empty device without uploading', async () => {
    h.looksEmpty = true
    expect(await syncHistoryBeforeWipe()).toMatchObject({ ok: true, gate: { kind: 'nothing-to-lose' } })
    expect(h.upload).not.toHaveBeenCalled()
  })

  it('uploads with the passwordless root-key credential, then confirms the remote', async () => {
    expect(await syncHistoryBeforeWipe()).toMatchObject({ ok: true, gate: { kind: 'synced' } })
    expect(h.upload).toHaveBeenCalledWith('', { passwordAlreadyVerified: true })
  })

  it('refuses when locked', async () => {
    h.credential = null
    expect(await syncHistoryBeforeWipe()).toEqual({ ok: false, refusal: { kind: 'locked' } })
  })

  it('refuses when the cloud copy is richer and never forces', async () => {
    h.upload.mockRejectedValue(new HistoryThinOverwriteError('thin'))
    expect(await syncHistoryBeforeWipe()).toMatchObject({ ok: false, refusal: { kind: 'cloud-richer' } })
    expect(h.upload).toHaveBeenCalledTimes(1)
    expect(h.upload.mock.calls[0][1]).not.toHaveProperty('force')
  })

  it('refuses when the upload fails', async () => {
    h.upload.mockRejectedValue(new Error('Upload failed (503)'))
    expect(await syncHistoryBeforeWipe()).toMatchObject({ ok: false, refusal: { kind: 'upload-failed' } })
  })

  it('refuses when the remote does not show the upload', async () => {
    h.meta.mockResolvedValue({ exists: true, exportedAt: 999 })
    expect(await syncHistoryBeforeWipe()).toEqual({ ok: false, refusal: { kind: 'unconfirmed' } })
    h.meta.mockResolvedValue(null)
    expect(await syncHistoryBeforeWipe()).toEqual({ ok: false, refusal: { kind: 'unconfirmed' } })
  })
})

describe('overrideWipeGate', () => {
  it('names an overridden gate the wipe accepts while fresh', () => {
    const gate = overrideWipeGate({ kind: 'upload-failed', detail: 'Failed to fetch' }, 1)
    expect(gate.kind).toBe('overridden')
    expect(() => assertWipeGateFresh(gate)).not.toThrow()
    expect(() => assertWipeGateFresh(gate, gate.checkedAt + WIPE_GATE_TTL_MS + 1)).toThrow(/sync/)
  })

  it('warns what the recovery phrase cannot bring back', () => {
    expect(wipeLossWarning(2)).toMatch(/^2 tokens and any payments received peer to peer/)
    expect(wipeLossWarning(1)).toMatch(/^1 token and/)
    expect(wipeLossWarning(0)).toMatch(/^Payments and tokens received peer to peer/)
  })
})

describe('assertWipeGateFresh', () => {
  it('refuses a missing or stale gate', () => {
    expect(() => assertWipeGateFresh(null)).toThrow(/sync/)
    const gate = { kind: 'synced' as const, checkedAt: 0 }
    expect(() => assertWipeGateFresh(gate, WIPE_GATE_TTL_MS + 1)).toThrow(/sync/)
    expect(() => assertWipeGateFresh(gate, WIPE_GATE_TTL_MS)).not.toThrow()
  })
})
