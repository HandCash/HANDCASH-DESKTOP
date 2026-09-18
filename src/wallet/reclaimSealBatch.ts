/**
 * Which sealed overlay rows a reclaim pass actually examines.
 *
 * A cap is required so a long-lived wallet cannot stall on hundreds of
 * explorer probes. Slicing the unsorted list forever hid anything past
 * position 200. Rank by value, always include remittance we can re-import,
 * and rotate the rest so every record is eventually seen.
 */
export type ReclaimSealPick = {
  outpoint: string
  satoshis: number
}

export function pickReclaimSeals(
  records: ReclaimSealPick[],
  opts: {
    max: number
    cursor: number
    priorityOutpoints?: ReadonlySet<string>
  },
): { picked: ReclaimSealPick[]; nextCursor: number } {
  const max = Math.max(0, Math.trunc(opts.max))
  if (max === 0 || records.length === 0) {
    return { picked: [], nextCursor: opts.cursor }
  }

  const priority = opts.priorityOutpoints ?? new Set<string>()
  const rank = (row: ReclaimSealPick) =>
    priority.has(row.outpoint) ? Number.MAX_SAFE_INTEGER : row.satoshis

  const sorted = [...records].sort((a, b) => {
    const d = rank(b) - rank(a)
    if (d !== 0) return d
    return a.outpoint.localeCompare(b.outpoint)
  })

  const hot = sorted.filter((row) => priority.has(row.outpoint))
  const rest = sorted.filter((row) => !priority.has(row.outpoint))
  if (rest.length === 0) {
    return { picked: hot.slice(0, max), nextCursor: 0 }
  }

  const cursor = ((opts.cursor % rest.length) + rest.length) % rest.length
  const rotated = rest.slice(cursor).concat(rest.slice(0, cursor))
  const room = Math.max(0, max - Math.min(hot.length, max))
  const fromRest = rotated.slice(0, room)
  const picked = [...hot.slice(0, max), ...fromRest]
  const nextCursor = (cursor + fromRest.length) % rest.length
  return { picked, nextCursor }
}
