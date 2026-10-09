/**
 * Which vault master a restored phrase or key opens.
 *
 * The same words are a BRC-157 entropy phrase, a BRC-75 phrase or a pre-BRC-75
 * HD phrase, and a reconstructed key is a BRC-157 entropy key or a BRC-42
 * root; each reading opens different accounts. The reading whose primary
 * account left something to recover wins. When none did, the wallet that
 * made the backup decides (24 words are BRC-157). A host that cannot answer
 * stops the restore: picking the wrong reading would show an empty wallet
 * over the real one.
 */
import { PrivateKey } from '@bsv/sdk'
import { appendAppLog } from './appLog'
import { probeAccountUse, type AccountUse } from './vaultAccountDiscovery'
import { accountRootKeyHex, vaultIdentityKey, type VaultMaster } from './vaultMaster'

export type MasterProbe = (master: VaultMaster) => Promise<AccountUse>

function combine(uses: AccountUse[]): AccountUse {
  if (uses.includes('used')) return 'used'
  if (uses.includes('unknown')) return 'unknown'
  return 'unused'
}

async function addressUse(address: string, chain: 'main' | 'test'): Promise<AccountUse> {
  const { cloudAddressUnspent } = await import('./chainProbeClient')
  const cloud = await cloudAddressUnspent(address, chain).catch(() => null)
  if (cloud) return cloud.utxos.length > 0 ? 'used' : 'unused'
  try {
    const { scanAddressViaWhatsOnChain } = await import('./legacyScan')
    const scan = await scanAddressViaWhatsOnChain(address, chain)
    return scan.utxos.length > 0 ? 'used' : 'unused'
  } catch {
    return 'unknown'
  }
}

async function handleUse(identityKey: string): Promise<AccountUse> {
  try {
    const { resolveHandleByIdentityKey } = await import('./handleResolve')
    return (await resolveHandleByIdentityKey(identityKey)).length > 0 ? 'used' : 'unused'
  } catch {
    return 'unknown'
  }
}

/**
 * Account 0 of `master` is used when it has a history backup or mail, coins
 * at its own address (the address chain ingest scans, mainnet form on every
 * chain), or a `$handle`.
 */
export function probeVaultMasterUse(chain: 'main' | 'test'): MasterProbe {
  return async (master) => {
    const rootKeyHex = accountRootKeyHex(master, 0)
    const key = PrivateKey.fromHex(rootKeyHex)
    const identityKey = key.toPublicKey().toString()
    return combine(
      await Promise.all([
        probeAccountUse({ index: 0, identityKey, rootKeyHex }),
        addressUse(key.toAddress(), chain),
        handleUse(identityKey),
      ]),
    )
  }
}

export async function chooseRestoredMaster<T extends { master: VaultMaster; label: string }>(args: {
  candidates: T[]
  preferred: T
  probe: MasterProbe
}): Promise<T> {
  const seen = new Set<string>()
  const candidates = args.candidates.filter((c) => {
    const id = vaultIdentityKey(c.master)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  if (candidates.length <= 1) return candidates[0] ?? args.preferred

  const started = Date.now()
  const uses = await Promise.all(candidates.map((c) => args.probe(c.master)))
  const ms = Date.now() - started
  const used = candidates.filter((_, i) => uses[i] === 'used')
  const summary = candidates.map((c, i) => `${c.label}=${uses[i]}`).join(' ')
  if (used.length === 0 && uses.includes('unknown')) {
    appendAppLog('warn', `[vault] derivation choice unknown after ${ms}ms: ${summary}`)
    throw new Error(
      'HandCash could not check which wallet this backup opens. Check the connection and try again.',
    )
  }
  const chosen =
    used.length === 0 ? args.preferred : used.includes(args.preferred) ? args.preferred : used[0]!
  appendAppLog(
    used.length > 1 ? 'warn' : 'info',
    `[vault] derivation choice done ${ms}ms: ${chosen.label} (${summary})`,
  )
  return chosen
}
