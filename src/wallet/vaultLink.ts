/**
 * The device link between installs of one vault (draft BRC-249 over draft
 * BRC-246 v2).
 *
 * Every install keeps a WebRTC data channel to every other install it knows
 * of (the device ids its holder records name), on the vault identity
 * (account 0). Account moves ride it: a release request goes straight to the
 * holding device, and its accept comes straight back. Each message is still
 * signed by the account root, so the link adds reach, not authority.
 *
 * Signals ride box `vault-link` on the vault identity, sealed to itself. It is
 * not `session-upgrade`, so the account's chat sessions never answer an
 * install's offer. The box stays the rendezvous; nothing custodial crosses it.
 */
import { createSessionTable, type RtcFactory, type SessionTable } from './directSession/session'
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
  seal: (rootKeyHex: string, plaintext: string) => Promise<string>
  open: (rootKeyHex: string, body: string) => Promise<string | null>
}

export type VaultLinkListener = (body: string, device: string) => void

type Link = {
  identityKey: string
  rootKeyHex: string
  deviceId: string
  table: SessionTable
  io: VaultLinkIo
  pingedAt: Map<string, number>
  reading: Promise<void> | null
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
    seal: async (root, plaintext) => (await t()).sealToSelf(root, plaintext),
    open: async (root, body) => (await t()).openFromSelf(root, body),
  }
}

/** Bind the link to this vault and install. Idempotent; another vault resets it. */
export function startVaultLink(args: {
  master: VaultMaster
  deviceId: string
  io?: VaultLinkIo
  rtc?: RtcFactory | null
}): void {
  const identityKey = vaultIdentityKey(args.master)
  if (link && link.identityKey === identityKey && link.deviceId === args.deviceId) return
  stopVaultLink()
  const rootKeyHex = rootKeyHexForAccount(args.master, 0)
  const io = args.io ?? lazyIo()
  const table = createSessionTable('vault-link')
  if (args.rtc !== undefined) table.installRtcFactory(args.rtc)
  table.setIdentity({ rootKeyHex, identityKey, device: args.deviceId })
  // Only installs of this vault: an offer from any other identity is refused.
  table.installOfferPolicy(() => false)
  table.installSignalSender(async (_to, body) => io.send(rootKeyHex, await io.seal(rootKeyHex, body)))
  table.setInboundHandler((_sender, body, device) => {
    if (body === PING) return
    for (const listener of listeners) listener(body, device)
  })
  link = { identityKey, rootKeyHex, deviceId: args.deviceId, table, io, pingedAt: new Map(), reading: null }
}

export function stopVaultLink(): void {
  link?.table.reset()
  link = null
}

async function readSignals(current: Link): Promise<void> {
  const messages = await current.io.list(current.rootKeyHex)
  if (!messages) return
  const ack: string[] = []
  for (const m of messages) {
    const plaintext = await current.io.open(current.rootKeyHex, m.body)
    const disposition = plaintext == null ? 'invalid' : await current.table.ingest(plaintext)
    if (disposition !== 'not-mine') ack.push(m.messageId)
  }
  if (ack.length) await current.io.acknowledge(current.rootKeyHex, ack)
}

/** One read of box `vault-link`; concurrent callers share it. */
function pollSignals(current: Link): Promise<void> {
  current.reading ??= readSignals(current)
    .catch((error: unknown) => {
      console.info('[vault-link] signal read failed', error instanceof Error ? error.message : String(error))
    })
    .finally(() => {
      current.reading = null
    })
  return current.reading
}

/**
 * One holding-service tick: answer waiting offers, offer a link to each
 * known install without one, and keep live links warm.
 */
export async function serveVaultLink(peers: Iterable<string>, now = Date.now()): Promise<void> {
  const current = link
  if (!current) return
  await pollSignals(current)
  for (const device of new Set(peers)) {
    if (!device || device === current.deviceId) continue
    if (!current.table.hasSession(current.identityKey, device)) {
      await current.table.request(current.identityKey, device, now)
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
  await current.table.request(current.identityKey, device)
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
    if (link !== current) return false
    await pollSignals(current)
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
