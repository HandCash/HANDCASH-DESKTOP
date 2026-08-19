import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

describe('deviceWallets pair + linked identities', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('rejects unsupported pair payload versions', async () => {
    const { parsePairPayload } = await import('./deviceWallets')
    expect(() => parsePairPayload('{"v":9}')).toThrow(/version/i)
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
    ).toThrow(/outdated|fresh link/i)
  })

  it('parses and builds v3 pair payload without History URL', async () => {
    const { parsePairPayload, buildPairPayload, pairPayloadToQrText } = await import(
      './deviceWallets'
    )
    const ik =
      '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const payload = buildPairPayload({
      identityKey: ik,
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      platform: 'darwin',
      label: 'This Mac',
    })
    expect(payload.v).toBe(3)
    expect(payload.address).toBe('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')
    const roundTrip = parsePairPayload(pairPayloadToQrText(payload))
    expect(roundTrip.v).toBe(3)
    expect(roundTrip.identityKey).toBe(ik)
    if (roundTrip.v === 3) expect(roundTrip.address).toBe(payload.address)
  })

  it('still parses legacy v2 pair payload with backupBaseUrl', async () => {
    const { parsePairPayload } = await import('./deviceWallets')
    const ik =
      '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const roundTrip = parsePairPayload(
      JSON.stringify({
        v: 2,
        identityKey: ik,
        deviceId: 'peer',
        label: 'Phone',
        platform: 'android',
        backupBaseUrl: 'https://backup.example/',
      }),
    )
    expect(roundTrip.v).toBe(2)
    if (roundTrip.v === 2) {
      expect(roundTrip.backupBaseUrl).toBe('https://backup.example')
    }
  })

  it('tryParsePairPayload accepts v3 and rejects junk / sealed-backup blobs', async () => {
    const { tryParsePairPayload, buildPairPayload, pairPayloadToQrText } = await import(
      './deviceWallets'
    )
    const ik =
      '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const text = pairPayloadToQrText(
      buildPairPayload({
        identityKey: ik,
        address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        platform: 'android',
      }),
    )
    expect(tryParsePairPayload(text)?.deviceId).toBeTruthy()
    expect(tryParsePairPayload('02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull()
    expect(tryParsePairPayload('not json')).toBeNull()
    expect(
      tryParsePairPayload(
        JSON.stringify({
          v: 1,
          kind: 'handcash-device-key-backup',
          identityKey: ik,
        }),
      ),
    ).toBeNull()
  })

  it('rejects legacy v2 link when local backup URL differs', async () => {
    store.set(
      'handcash.brc100.historyBackup.v1',
      JSON.stringify({ baseUrl: 'https://a.example', lastUploadedAt: null, lastError: null }),
    )
    const { assertPairBackupUrlCompatible } = await import('./deviceWallets')
    expect(() => assertPairBackupUrlCompatible('https://b.example')).toThrow(/do not match/i)
  })

  it('enrolls local and links peers with different identity keys', async () => {
    const {
      enrollLocalDevice,
      upsertPeerDevice,
      selectDeviceWallet,
      getSelectedDeviceId,
      listDeviceWallets,
    } = await import('./deviceWallets')

    const localIk =
      '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const peerIk =
      '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const local = enrollLocalDevice({
      identityKey: localIk,
      address: '1LocalAddressxxxxxxxxxxxxxxxxx',
      platform: 'darwin',
    })
    expect(local.isLocal).toBe(true)
    expect(getSelectedDeviceId()).toBe(local.deviceId)

    upsertPeerDevice({
      deviceId: 'peer-1',
      label: 'Phone',
      platform: 'android',
      peerBaseUrl: null,
      identityKey: peerIk,
      address: '1PeerAddressxxxxxxxxxxxxxxxxxx',
      lastSeenAt: Date.now(),
      online: true,
    })

    const roster = listDeviceWallets()
    expect(roster).toHaveLength(2)
    expect(roster.find((w) => w.deviceId === 'peer-1')?.identityKey).toBe(peerIk)
    selectDeviceWallet('peer-1')
    expect(getSelectedDeviceId()).toBe('peer-1')
    selectDeviceWallet(local.deviceId)
    expect(getSelectedDeviceId()).toBe(local.deviceId)
  })
})

describe('verifyAndEnrichPair linked identities', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('accepts v3 pair for a different identity', async () => {
    const { verifyAndEnrichPair } = await import('./devicePeer')
    const local =
      '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    const other =
      '02eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const result = await verifyAndEnrichPair(
      JSON.stringify({
        v: 3,
        identityKey: other,
        address: '1OtherAddressxxxxxxxxxxxxxxxxx',
        deviceId: 'peer-x',
        label: 'Other',
        platform: 'darwin',
      }),
      local,
    )
    expect(result.v).toBe(3)
    expect(result.identityKey).toBe(other)
    expect(result.online).toBe(false)
  })

  it('rejects legacy v2 when identity differs', async () => {
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
    ).rejects.toThrow(/legacy same-key|different identity/i)
  })

  it('rejects legacy v2 backup URL mismatch', async () => {
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
})
