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

vi.mock('./friends', () => ({ mergeFriends: vi.fn() }))
vi.mock('./deviceWallets', () => ({
  enrollLocalDevice: (args: unknown) => enrollLocalDevice(args),
  listDeviceWallets: () => [],
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
})
