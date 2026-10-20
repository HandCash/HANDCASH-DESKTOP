/**
 * The device link between installs of one vault (draft BRC-249 over draft
 * BRC-246, `webrtpay/1`).
 *
 * Every install keeps a session to every other install it knows of (the
 * device ids its holder records name), on the vault identity (account 0).
 * Account moves ride it: a release request goes straight to the holding
 * device, and its accept comes straight back. Each message is still signed by
 * the account root, so the link adds reach, not authority.
 *
 * Signals ride box `vault-link` on the vault identity, encrypted to itself.
 * It is not `webrtpay_messages`, so the account's chat sessions never answer
 * an install's dial. The box stays the rendezvous; nothing custodial crosses it.
 */
import { createBoxPoller, type BoxPoller } from './directSession/boxPoller'
import { createSessionTable, type RtcConstructor, type SessionTable } from './directSession/session'
import type { ListedMessage } from './messageTransport'
import { rootKeyHexForAccount } from './vaultAccounts'
import { vaultIdentityKey, type VaultMaster } from './vaultMaster'

export const VAULT_LINK_BOX = 'vault-link'
/** How long a move waits for a link to the holding device before it asks through the box. */
export const LINK_DIAL_MS = 8_000
/** Cadence of signal reads while a dial waits for its answer. */
const DIAL_POLL_MS = 1_000
/** Keeps an idle link inside the session idle timeout. */
const LINK_PING_MS = 4 * 60_000
const PING = '{"type":"vault-link-ping"}'

/** The own-box operations a link needs; `messageTransport.ts` in the app. */
export type VaultLinkIo = {
  list: (rootKeyHex: string) => Promise<ListedMessage[] | null>
  send: (rootKeyHex: string, body: string) => Promise<void>
  acknowledge: (rootKeyHex: string, messageIds: string[]) => Promise<void>
}

export type VaultLinkListener = (body: string, device: string) => void

type Link = {
  identityKey: string
  rootKeyHex: string
  deviceId: string
  table: SessionTable
  poller: BoxPoller
  pingedAt: Map<string, number>
}

let link: Link | null = null
/** Outlive a link restart: the holding service subscribes once per unlock. */
const listeners = new Set<VaultLinkListener>()

function lazyIo(): VaultLinkIo {
  const t = () => import('./messageTransport')
  return {
    list: async (root) => (await t()).listOwnBox(root, VAULT_LINK_BOX),
    send: async (root, body) => (await t()).sendToOwnBox(root, VAULT_LINK_BOX, body),
    acknowledge: async (root, ids) => (await t()).acknowledgeOwnBox(root, VAULT_LINK_BOX, ids),
  }
}

/**
 * Bind the link to this vault and install. Idempotent; another vault resets
 * it. `poll: false` leaves box reads to the holding-service ticks (tests).
 */
export function startVaultLink(args: {
  master: VaultMaster
  deviceId: string
  io?: VaultLinkIo
  rtc?: RtcConstructor | null
  poll?: boolean
}): void {
  const identityKey = vaultIdentityKey(args.master)
  if (link && link.identityKey === identityKey && link.deviceId === args.deviceId) return
  stopVaultLink()
  const rootKeyHex = rootKeyHexForAccount(args.master, 0)
  const io = args.io ?? lazyIo()
  const table = createSessionTable('vault-link')
  if (args.rtc !== undefined) table.installRtc(args.rtc)
  table.setIdentity({ rootKeyHex, identityKey, device: args.deviceId })
  // Only installs of this vault: a dial from any other identity is refused.
  table.installOfferPolicy(() => false)
  table.installSignalSender((_to, body) => io.send(rootKeyHex, body))
  table.setInboundHandler((_sender, body, device) => {
    if (body === PING) return
    for (const listener of listeners) listener(body, device)
  })
  const poller = createBoxPoller({
    tag: 'vault-link',
    io: {
      list: async () =>
        (await io.list(rootKeyHex))?.map((m) => ({ messageId: m.messageId, body: m.body, sender: m.sender ?? m.senderIdentityKey ?? identityKey })) ?? null,
      acknowledge: (ids) => io.acknowledge(rootKeyHex, ids),
    },
    handle: async (m) => ((await table.ingest(m.sender, m.body)) === 'not-mine' ? 'leave' : 'ack'),
    dialing: table.hasActiveDials,
  })
  link = { identityKey, rootKeyHex, deviceId: args.deviceId, table, poller, pingedAt: new Map() }
  if (args.poll !== false) poller.start()
}

export function stopVaultLink(): void {
  link?.poller.stop()
  link?.table.reset()
  link = null
}

/**
 * One holding-service tick: answer waiting offers, offer a link to each
 * known install without one, and keep live links warm.
 */
export async function serveVaultLink(peers: Iterable<string>, now = Date.now()): Promise<void> {
  const current = link
  if (!current) return
  if (!current.poller.running) await current.poller.poll()
  for (const device of new Set(peers)) {
    if (!device || device === current.deviceId) continue
    if (!current.table.hasSession(current.identityKey, device)) {
      if (await current.table.request(current.identityKey, device, now)) current.poller.nudge()
      continue
    }
    if (now - (current.pingedAt.get(device) ?? 0) < LINK_PING_MS) continue
    current.pingedAt.set(device, now)
    await current.table.deliver({ recipientIdentityKey: current.identityKey, recipientDevice: device, body: PING })
  }
}

export function vaultLinkOpen(device: string): boolean {
  return !!link && link.table.hasSession(link.identityKey, device)
}

/** Open a link to `device`, waiting up to `waitMs` for its answer. */
export async function dialVaultLink(device: string, waitMs = LINK_DIAL_MS, pollMs = DIAL_POLL_MS): Promise<boolean> {
  const current = link
  if (!current || !device || device === current.deviceId) return false
  if (current.table.hasSession(current.identityKey, device)) return true
  if (await current.table.request(current.identityKey, device)) current.poller.nudge()
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
    if (link !== current) return false
    await current.poller.poll()
    if (current.table.hasSession(current.identityKey, device)) return true
  }
  return false
}

/** Send to one install over its link; `box` when no link acked the frame. */
export async function sendOverVaultLink(device: string, body: string): Promise<'direct' | 'box'> {
  const current = link
  if (!current) return 'box'
  return current.table.deliver({ recipientIdentityKey: current.identityKey, recipientDevice: device, body })
}

/** Every body arriving on any link of this vault, with the install that sent it. */
export function onVaultLinkMessage(listener: VaultLinkListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
