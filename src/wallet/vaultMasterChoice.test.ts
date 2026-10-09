import { describe, expect, it, vi } from 'vitest'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

import { chooseRestoredMaster, type MasterProbe } from './vaultMasterChoice'
import type { AccountUse } from './vaultAccountDiscovery'
import { brc157VaultMasterFromKey, brc42VaultMaster, vaultIdentityKey, type VaultMaster } from './vaultMaster'

type Reading = { master: VaultMaster; label: string }
const KEY = '1ad0895dd317163f0e83499c30bc593dbcc54cad96a5f57b065ce9f700513250'
const profiles: Reading = { master: brc157VaultMasterFromKey(KEY), label: 'brc-157' }
const root: Reading = { master: brc42VaultMaster(KEY), label: 'brc-42' }

function probeOf(uses: { profiles: AccountUse; root: AccountUse }): MasterProbe {
  return async (master) => (vaultIdentityKey(master) === vaultIdentityKey(profiles.master) ? uses.profiles : uses.root)
}

const choose = (uses: { profiles: AccountUse; root: AccountUse }, preferred = profiles) =>
  chooseRestoredMaster({ candidates: [profiles, root], preferred, probe: probeOf(uses) })

describe('chooseRestoredMaster', () => {
  it('opens the reading whose primary account left something to recover', async () => {
    expect(await choose({ profiles: 'unused', root: 'used' })).toBe(root)
    expect(await choose({ profiles: 'used', root: 'unused' }, root)).toBe(profiles)
    expect(await choose({ profiles: 'unknown', root: 'used' })).toBe(root)
  })

  it('takes the preferred reading when nothing anywhere was used', async () => {
    expect(await choose({ profiles: 'unused', root: 'unused' })).toBe(profiles)
    expect(await choose({ profiles: 'unused', root: 'unused' }, root)).toBe(root)
  })

  it('prefers the preferred reading when both were used', async () => {
    expect(await choose({ profiles: 'used', root: 'used' }, root)).toBe(root)
  })

  it('refuses to guess when a host cannot answer and nothing was found', async () => {
    await expect(choose({ profiles: 'unknown', root: 'unused' })).rejects.toThrow(/could not check/)
  })

  it('does not probe a single reading', async () => {
    const probe = vi.fn<MasterProbe>()
    expect(await chooseRestoredMaster({ candidates: [root, { ...root, label: 'dup' }], preferred: root, probe })).toBe(root)
    expect(probe).not.toHaveBeenCalled()
  })
})
