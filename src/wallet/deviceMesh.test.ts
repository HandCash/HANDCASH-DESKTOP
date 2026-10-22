import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const enrollLocalDevice = vi.fn((args) => ({
  ...args,
  deviceId: 'local',
  label: 'This device',
  platform: 'darwin',
  peerBaseUrl: null,
  isLocal: true,
  lastSeenAt: Date.now(),
  online: true,
  linkedAt: null,
  linkMode: 'linked',
}))

const listDeviceWallets = vi.fn((): unknown[] => [])

vi.mock('./friends', () => ({ mergeFriends: vi.fn() }))
vi.mock('./deviceWallets', () => ({
  enrollLocalDevice: (args: unknown) => enrollLocalDevice(args),
  listDeviceWallets: () => listDeviceWallets(),
  patchDeviceWallet: vi.fn(),
}))
vi.mock('./devicePeer', () => ({
  fetchDevicePeerSnapshot: vi.fn(),
  probeDevicePeer: vi.fn(),
}))
vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: '02'.repeat(33),
    address: '1LocalAddress',
    rootKeyHex: 'ab'.repeat(32),
  }),
}))

describe('device mesh lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    enrollLocalDevice.mockClear()
    vi.stubGlobal('window', {
      handcash: {
        platform: 'darwin',
        getBridgeStatus: async () => ({ devicePeerLanUrls: [] }),
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stops polling when Dashboard returns the mesh cleanup on lock', async () => {
    const { startDeviceMesh } = await import('./deviceMesh')
    const stop = startDeviceMesh('02'.repeat(33))
    await vi.advanceTimersByTimeAsync(8_000)
    const beforeStop = enrollLocalDevice.mock.calls.length
    expect(beforeStop).toBeGreaterThan(0)

    stop()
    await vi.advanceTimersByTimeAsync(24_000)
    expect(enrollLocalDevice).toHaveBeenCalledTimes(beforeStop)
  })

  it('never shows one account\'s peer snapshots to the next account', async () => {
    const identityKey = '02'.repeat(33)
    const { fetchDevicePeerSnapshot, probeDevicePeer } = await import('./devicePeer')
    vi.mocked(probeDevicePeer).mockResolvedValue({ identityKey, label: 'Phone' } as never)
    vi.mocked(fetchDevicePeerSnapshot).mockResolvedValue({ friends: [] } as never)
    listDeviceWallets.mockReturnValue([
      { deviceId: 'phone', identityKey, isLocal: false, peerBaseUrl: 'http://10.0.0.2:3322' },
    ])
    const { getRemoteSnapshot, startDeviceMesh } = await import('./deviceMesh')

    const stopFirst = startDeviceMesh(identityKey)
    await vi.advanceTimersByTimeAsync(0)
    expect(getRemoteSnapshot('phone')).not.toBeNull()
    stopFirst()

    const stopNext = startDeviceMesh('03'.repeat(33))
    expect(getRemoteSnapshot('phone')).toBeNull()
    stopNext()
    listDeviceWallets.mockReturnValue([])
  })
})
