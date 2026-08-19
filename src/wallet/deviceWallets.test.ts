import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

describe('deviceWallets backup links', () => {
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

  it('routes a cross-identity legacy QR to backup-only', async () => {
    const { choosePairAcceptancePath } = await import('./deviceWallets')
    const localIk =
      '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const peerIk =
      '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    expect(
      choosePairAcceptancePath(
        {
          v: 2,
          identityKey: peerIk,
          deviceId: 'peer',
          label: 'Phone',
          platform: 'android',
          backupBaseUrl: 'https://backup.example',
        },
        localIk,
        'local',
      ),
    ).toEqual({ path: 'backup-only', reason: 'cross-identity' })
  })

  it('routes a cross-identity v3 QR to backup-only', async () => {
    const { choosePairAcceptancePath } = await import('./deviceWallets')
    const localIk =
      '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const peerIk =
      '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    expect(
      choosePairAcceptancePath(
        {
          v: 3,
          identityKey: peerIk,
          address: '1PeerAddressxxxxxxxxxxxxxxxxxx',
          deviceId: 'peer',
          label: 'Phone',
          platform: 'android',
        },
        localIk,
        'local',
      ),
    ).toEqual({ path: 'backup-only', reason: 'cross-identity' })
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

  it('enrolls local and keeps different-identity peers backup-only', async () => {
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
    expect(roster.find((w) => w.deviceId === 'peer-1')?.linkMode).toBe('backup-only')
    selectDeviceWallet('peer-1')
    expect(getSelectedDeviceId()).toBe(local.deviceId)
    selectDeviceWallet(local.deviceId)
    expect(getSelectedDeviceId()).toBe(local.deviceId)
  })

  it('upserts an imported spare as one idempotent backup-only peer', async () => {
    const { upsertPeerFromSealedBackup, listDeviceWallets } = await import(
      './deviceWallets'
    )
    const pkg = {
      fromDeviceId: 'backup-peer',
      fromIdentityKey:
        '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      fromAddress: '1PeerAddressxxxxxxxxxxxxxxxxxx',
      fromLabel: 'Old phone',
    }
    upsertPeerFromSealedBackup(pkg)
    upsertPeerFromSealedBackup({ ...pkg, fromLabel: 'Phone backup' })

    const peers = listDeviceWallets().filter((w) => !w.isLocal)
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({
      deviceId: 'backup-peer',
      label: 'Phone backup',
      linkMode: 'backup-only',
    })
  })
})

describe('verifyAndEnrichPair payload verification', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('refuses v3 same-wallet verification for a different identity', async () => {
    const { verifyAndEnrichPair } = await import('./devicePeer')
    const local =
      '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    const other =
      '02eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    await expect(
      verifyAndEnrichPair(
        JSON.stringify({
          v: 3,
          identityKey: other,
          address: '1OtherAddressxxxxxxxxxxxxxxxxx',
          deviceId: 'peer-x',
          label: 'Other',
          platform: 'darwin',
        }),
        local,
      ),
    ).rejects.toThrow(/cannot be linked|backup flow/i)
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
    ).rejects.toThrow(/different wallet identities|backup flow/i)
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
