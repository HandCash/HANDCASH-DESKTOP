/**
 * Prefer SPV-friendly providers ahead of WhatsOnChain in toolbox service lists.
 *
 * WhatsOnChain shares one rate budget across rawtx, UTXO, FX and merkle traffic.
 * A busy device hits CORS-less 429s that look like `Failed to fetch`, and every
 * BEEF build stalls. Bitails / JungleBus / Chaintracks keep an independent budget
 * so SPV (rawtx + merkle path + header) can finish without that host.
 */

type NamedService = { name: string }

type MutableCollection = {
  services?: NamedService[]
  reset?: () => void
}

/**
 * postBeef order: Arcade's first success completes the send. Keep Bitails /
 * WhatsOnChain / GorillaPool in the list so explorers can see the tx — item
 * peerDeliver often omits AtomicBEEF (box cap) and the payee SPV-fetches.
 */
export const POST_BEEF_PREFER = [
  'ArcadeBeef',
  'GorillaPoolArcBeef',
  'Bitails',
  'WhatsOnChain',
  'TaalArcBeef',
] as const

/**
 * Move `preferred` names to the front (in that order). Unknown names are ignored.
 * Remaining providers keep relative order after the preferred ones.
 */
export function preferServiceOrder(
  collection: MutableCollection | null | undefined,
  preferred: readonly string[],
): void {
  const services = collection?.services
  if (!Array.isArray(services) || services.length === 0 || preferred.length === 0) return

  const byName = new Map(services.map((s) => [s.name, s]))
  const front: NamedService[] = []
  const used = new Set<string>()
  for (const name of preferred) {
    const entry = byName.get(name)
    if (!entry || used.has(name)) continue
    front.push(entry)
    used.add(name)
  }
  if (front.length === 0) return

  const rest = services.filter((s) => !used.has(s.name))
  services.splice(0, services.length, ...front, ...rest)
  collection?.reset?.()
}

/**
 * Arcade first, public miners still in the list. Stripping Bitails/WoC made
 * Arcade-ACK'd item sends 404 on explorers (hc-ad7afb 627fb26bee9f).
 */
export function configurePostBeefServices(
  collection: MutableCollection | null | undefined,
): void {
  preferServiceOrder(collection, POST_BEEF_PREFER)
}
