import { normalizeAppHost } from './appIdentity'
const declarations = new Map<string, { expiresAt: number; protocols: Array<{ protocolID: unknown; counterparty?: unknown }> }>()
/** Metadata hint only: the permission manager revalidates the declaration and consent. */
export function rememberFeatureManifest(origin: string, manifest: unknown): void {
  if (!manifest || typeof manifest !== 'object') return
  const root = manifest as Record<string, any>, protocols = (root.metanet ?? root.babbage)?.groupPermissions?.protocolPermissions
  if (!Array.isArray(protocols) || protocols.length > 128) return
  if (declarations.size >= 256) declarations.delete(declarations.keys().next().value!)
  declarations.set(normalizeAppHost(origin), { expiresAt: Date.now() + 300_000, protocols: protocols.map(item => ({ protocolID: item?.protocolID, counterparty: item?.counterparty })) })
}
export function hasFeatureDeclarationHint(origin: string, protocolID: [number, string], counterparty: string): boolean {
  const declaration = declarations.get(normalizeAppHost(origin))
  if (!declaration || declaration.expiresAt <= Date.now()) return false
  return declaration.protocols.some(item => Array.isArray(item.protocolID) && item.protocolID[0] === protocolID[0] && item.protocolID[1] === protocolID[1] && (protocolID[0] === 1 || item.counterparty === counterparty))
}
