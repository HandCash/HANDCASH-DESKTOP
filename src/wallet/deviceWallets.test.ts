import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

describe('deviceWallets pair + backup URL', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('rejects pair payload without matching backup URL support', async () => {
    const { parsePairPayload } = await import('./deviceWallets')
    expect(() => parsePairPayload('{"v":3}')).toThrow(/version/i)
    expect(() =>
      parsePairPayload(
        JSON.stringify({
          v: 1,
          identityKey:
            '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          deviceId: 'a',
          peerBaseUrl: 'http://1.2.3.4:3340',
        }),
      ),
    ).toThrow(/outdated|backup/i)
  })

  it('parses v2 pair payload with backupBaseUrl', async () => {
    store.set(
      'handcash.brc100.historyBackup.v1',
      JSON.stringify({ baseUrl: 'https://backup.example', lastUploadedAt: null, lastError: null }),
    )
    const { parsePairPayload, buildPairPayload, pairPayloadToQrText } = await import(
      './deviceWallets'
    )
    const ik =
      '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const payload = buildPairPayload({
      identityKey: ik,
      backupBaseUrl: 'https://backup.example/',
      platform: 'darwin',
      label: 'This Mac',
    })
    expect(payload.v).toBe(2)
    expect(payload.backupBaseUrl).toBe('https://backup.example')
    const roundTrip = parsePairPayload(pairPayloadToQrText(payload))
    expect(roundTrip.identityKey).toBe(ik)
    expect(roundTrip.backupBaseUrl).toBe('https://backup.example')
  })

  it('tryParsePairPayload accepts v2 and rejects junk', async () => {
    const { tryParsePairPayload, buildPairPayload, pairPayloadToQrText } = await import(
      './deviceWallets'
    )
    const ik =
      '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const text = pairPayloadToQrText(
      buildPairPayload({
        identityKey: ik,
        backupBaseUrl: 'https://backup.example',
        platform: 'android',
      }),
    )
    expect(tryParsePairPayload(text)?.deviceId).toBeTruthy()
    expect(tryParsePairPayload('02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull()
    expect(tryParsePairPayload('not json')).toBeNull()
  })

  it('rejects link when local backup URL differs', async () => {
    store.set(
      'handcash.brc100.historyBackup.v1',
      JSON.stringify({ baseUrl: 'https://a.example', lastUploadedAt: null, lastError: null }),
    )
    const { assertPairBackupUrlCompatible } = await import('./deviceWallets')
    expect(() => assertPairBackupUrlCompatible('https://b.example')).toThrow(/do not match/i)
  })

  it('enrolls local and selects it; peers must match identity', async () => {
    const {
      enrollLocalDevice,
      upsertPeerDevice,
      selectDeviceWallet,
      getSelectedDeviceId,
      listDeviceWallets,
    } = await import('./deviceWallets')

    const ik =
      '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const local = enrollLocalDevice({ identityKey: ik, platform: 'darwin' })
    expect(local.isLocal).toBe(true)
    expect(getSelectedDeviceId()).toBe(local.deviceId)

    expect(() =>
      upsertPeerDevice({
        deviceId: 'peer-1',
        label: 'Phone',
        platform: 'android',
        peerBaseUrl: null,
        identityKey:
          '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        lastSeenAt: Date.now(),
      }),
    ).toThrow(/identity/i)

    upsertPeerDevice({
      deviceId: 'peer-1',
      label: 'Phone',
      platform: 'android',
      peerBaseUrl: null,
      identityKey: ik,
      lastSeenAt: Date.now(),
      online: true,
    })

    const roster = listDeviceWallets()
    expect(roster).toHaveLength(2)
    selectDeviceWallet('peer-1')
    expect(getSelectedDeviceId()).toBe('peer-1')
    selectDeviceWallet(local.deviceId)
    expect(getSelectedDeviceId()).toBe(local.deviceId)
  })
})

describe('verifyAndEnrichPair backup gate', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('rejects different identity before backup check', async () => {
    store.set(
      'handcash.brc100.historyBackup.v1',
      JSON.stringify({ baseUrl: 'https://backup.example', lastUploadedAt: null, lastError: null }),
    )
    const { verifyAndEnrichPair } = await import('./devicePeer')
    const local =
      '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    const other =
      '02eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    await expect(
      verifyAndEnrichPair(
        JSON.stringify({
          v: 2,
          identityKey: other,
          deviceId: 'x',
          label: 'Other',
          platform: 'darwin',
          backupBaseUrl: 'https://backup.example',
        }),
        local,
      ),
    ).rejects.toThrow(/different HandCash identity/i)
  })

  it('rejects backup URL mismatch', async () => {
    store.set(
      'handcash.brc100.historyBackup.v1',
      JSON.stringify({ baseUrl: 'https://mine.example', lastUploadedAt: null, lastError: null }),
    )
    const { verifyAndEnrichPair } = await import('./devicePeer')
    const ik =
      '02ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    await expect(
      verifyAndEnrichPair(
        JSON.stringify({
          v: 2,
          identityKey: ik,
          deviceId: 'peer-a',
          label: 'Laptop',
          platform: 'darwin',
          backupBaseUrl: 'https://theirs.example',
        }),
        ik,
      ),
    ).rejects.toThrow(/do not match/i)
  })

  it('accepts matching backup URL without LAN peer', async () => {
    store.set(
      'handcash.brc100.historyBackup.v1',
      JSON.stringify({ baseUrl: 'https://backup.example', lastUploadedAt: null, lastError: null }),
    )
    const { verifyAndEnrichPair } = await import('./devicePeer')
    const ik =
      '02ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    const result = await verifyAndEnrichPair(
      JSON.stringify({
        v: 2,
        identityKey: ik,
        deviceId: 'peer-a',
        label: 'Laptop',
        platform: 'darwin',
        backupBaseUrl: 'https://backup.example',
      }),
      ik,
    )
    expect(result.online).toBe(false)
    expect(result.backupBaseUrl).toBe('https://backup.example')
  })
})
