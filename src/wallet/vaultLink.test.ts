import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeRtc, type FakePeerConnection } from './directSession/fakeRtc.fixture'
import type { ListedMessage } from './messageTransport'
import { brc157VaultMaster } from './vaultMaster'

type LinkModule = typeof import('./vaultLink')

const MASTER = brc157VaultMaster(Array(32).fill(0x2a))

/** Box `vault-link` on the vault identity, shared by every install. */
function sharedBox() {
  const messages: ListedMessage[] = []
  let n = 0
  return {
    messages,
    io: {
      list: async () => messages.map((m) => ({ ...m })),
      send: async (_root: string, body: string) => void messages.push({ messageId: `s${++n}`, body, createdAt: Date.now() }),
      acknowledge: async (_root: string, ids: string[]) => {
        for (const id of ids) {
          const i = messages.findIndex((m) => m.messageId === id)
          if (i >= 0) messages.splice(i, 1)
        }
      },
    },
  }
}

type Install = { mod: LinkModule; device: string; inbound: Array<{ body: string; device: string }>; peers: FakePeerConnection[] }
const installs: Install[] = []

async function install(device: string, box: ReturnType<typeof sharedBox>): Promise<Install> {
  vi.resetModules()
  const mod = await import('./vaultLink')
  const inst: Install = { mod, device, inbound: [], peers: [] }
  mod.startVaultLink({ master: MASTER, deviceId: device, io: box.io, rtc: fakeRtc(inst.peers), poll: false })
  mod.onVaultLinkMessage((body, from) => inst.inbound.push({ body, device: from }))
  installs.push(inst)
  return inst
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** Holding-service ticks, in turn, until the box is quiet. */
async function serveAll(list: Array<[Install, string[]]>, box: ReturnType<typeof sharedBox>): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const [inst, peers] of list) await inst.mod.serveVaultLink(peers)
    for (let i = 0; i < 5; i += 1) await tick()
    if (box.messages.length === 0 && round > 0) break
  }
}

afterEach(() => {
  for (const inst of installs.splice(0)) inst.mod.stopVaultLink()
})

describe('the vault link (BRC-249 over BRC-246, webrtpay/1)', () => {
  it('connects two installs of one vault and carries frames device to device', async () => {
    const box = sharedBox()
    const mac = await install('mac', box)
    const phone = await install('phone', box)
    expect(await mac.mod.sendOverVaultLink('phone', 'early')).toBe('box')

    await mac.mod.serveVaultLink(['phone'])
    expect(box.messages).toHaveLength(1)
    expect(Object.keys(JSON.parse(box.messages[0]!.body)).sort()).toEqual(['ciphertext', 'sid', 'v'])
    await serveAll([[phone, []], [mac, []]], box)

    expect(mac.mod.vaultLinkOpen('phone')).toBe(true)
    expect(phone.mod.vaultLinkOpen('mac')).toBe(true)
    expect(box.messages).toHaveLength(0)
    expect(await mac.mod.sendOverVaultLink('phone', 'release-request')).toBe('direct')
    expect(phone.inbound).toEqual([{ body: 'release-request', device: 'mac' }])
    expect(await phone.mod.sendOverVaultLink('mac', 'release-accept')).toBe('direct')
    expect(mac.inbound).toEqual([{ body: 'release-accept', device: 'phone' }])
  })

  it('dials on demand while the other install serves its ticks', async () => {
    const box = sharedBox()
    const mac = await install('mac', box)
    const phone = await install('phone', box)
    const serving = setInterval(() => void phone.mod.serveVaultLink([]), 5)
    try {
      expect(await mac.mod.dialVaultLink('phone', 2_000, 5)).toBe(true)
    } finally {
      clearInterval(serving)
    }
    expect(await mac.mod.sendOverVaultLink('phone', 'hello')).toBe('direct')
  })

  it('gives up a dial when the other install never answers', async () => {
    const box = sharedBox()
    const mac = await install('mac', box)
    expect(await mac.mod.dialVaultLink('tablet', 30, 5)).toBe(false)
    expect(await mac.mod.sendOverVaultLink('tablet', 'x')).toBe('box')
  })

  it('leaves another install\u2019s signals in the box and survives a repeated read', async () => {
    const box = sharedBox()
    const mac = await install('mac', box)
    const phone = await install('phone', box)
    const tablet = await install('tablet', box)
    await mac.mod.serveVaultLink(['phone'])
    await tablet.mod.serveVaultLink([])
    expect(box.messages).toHaveLength(1)
    // Two reads of one signal must handle it once.
    await Promise.all([phone.mod.serveVaultLink([]), phone.mod.serveVaultLink([])])
    await serveAll([[mac, []], [tablet, []], [phone, []]], box)
    expect(phone.peers).toHaveLength(1)
    expect(tablet.peers).toHaveLength(0)
    expect(await phone.mod.sendOverVaultLink('mac', 'one')).toBe('direct')
    expect(tablet.mod.vaultLinkOpen('mac')).toBe(false)
  })

  it('drops pings instead of handing them on', async () => {
    const box = sharedBox()
    const mac = await install('mac', box)
    const phone = await install('phone', box)
    await mac.mod.serveVaultLink(['phone'])
    await serveAll([[phone, []], [mac, []]], box)
    await mac.mod.serveVaultLink(['phone'], Date.now() + 5 * 60_000)
    await tick()
    expect(phone.inbound).toEqual([])
    expect(phone.mod.vaultLinkOpen('mac')).toBe(true)
  })
})
