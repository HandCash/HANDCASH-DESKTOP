/**
 * What a counterparty can already check (BRC-252 §2).
 *
 * Recorded when a package their box accepted carried the output. The next
 * package to them may stop at that output and name older transactions by
 * txid. It is not this wallet's own check, and a reinstall that lost the
 * check fetches the body. BRC-252 registers no compressed proof, so none is
 * stored or accepted here.
 */

import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = storageRegistry.proofFrontier.key
const MAX_ASSETS = 200
const MAX_OUTS = 32

type Row = { outs: string[]; at: number }

let rows: Map<string, Row> | null = null

function assetKey(peer: string, asset: string): string {
  return `${peer.trim().toLowerCase()}\n${asset.trim().toLowerCase()}`
}

function outpoint(value: string): string {
  return value.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

function load(): Map<string, Row> {
  if (rows) return rows
  rows = new Map()
  try {
    const raw = durableGetItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rows
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const row = value as { outs?: unknown; at?: unknown }
      if (!Array.isArray(row.outs) || typeof row.at !== 'number') continue
      const outs = row.outs.filter((item): item is string => typeof item === 'string').map(outpoint)
      if (outs.length === 0) continue
      rows.set(key, { outs, at: row.at })
    }
  } catch {
    rows.clear()
  }
  return rows
}

function save(): void {
  const map = load()
  durableSetItem(
    KEY,
    JSON.stringify(Object.fromEntries([...map].map(([key, row]) => [key, row]))),
  )
}

export function tokenFrontierAsset(tokenId: string): string {
  return `token:${tokenId.trim().toLowerCase()}`
}

export function itemFrontierAsset(origin: string): string {
  return `item:${outpoint(origin)}`
}

/** Outputs this peer was already given for this token or item origin. */
export function proofFrontier(peer: string, asset: string): Set<string> {
  const row = load().get(assetKey(peer, asset))
  return new Set(row?.outs ?? [])
}

/**
 * Remember value outputs a delivered package let this peer check.
 * Older outputs past the cap are dropped; the deploy is not inferred.
 */
export function rememberProofFrontier(
  peer: string,
  asset: string,
  outpoints: readonly string[],
): void {
  const outs = [...new Set(outpoints.map(outpoint).filter((op) => /^[0-9a-f]{64}_\d+$/.test(op)))]
  if (outs.length === 0 || !peer.trim() || !asset.trim()) return
  const map = load()
  const key = assetKey(peer, asset)
  const prev = map.get(key)?.outs ?? []
  const merged = [...new Set([...outs, ...prev])].slice(0, MAX_OUTS)
  map.delete(key)
  map.set(key, { outs: merged, at: Date.now() })
  while (map.size > MAX_ASSETS) map.delete(map.keys().next().value!)
  save()
}

export function resetProofFrontierForTests(): void {
  rows = null
  durableSetItem(KEY, '{}')
}
