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

/** Arcade V2 is the wallet's single canonical transaction submission path. */
export const POST_BEEF_PREFER = ['ArcadeBeef'] as const

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
 * Keep one transaction submission authority. Explorer and legacy ARC services
 * remain available elsewhere for read/proof reconciliation, never broadcast.
 */
export function configurePostBeefServices(
  collection: MutableCollection | null | undefined,
): void {
  const services = collection?.services
  if (!Array.isArray(services)) return
  const arcade = services.filter((service) => service.name === 'ArcadeBeef')
  services.splice(0, services.length, ...arcade)
  preferServiceOrder(collection, POST_BEEF_PREFER)
}
