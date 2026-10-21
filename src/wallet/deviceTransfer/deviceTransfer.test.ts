import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  approvalComparisonCode,
  commitmentFor,
  comparisonCode,
  formatComparisonCode,
  localDeviceLabel,
  openVaultTransfer,
  sealVaultTransfer,
  type VaultTransfer,
} from '.'

const transfer: VaultTransfer = {
  v: 1,
  kind: 'handcash-brc250-vault',
  master: { derivation: 'brc-42', keyHex: PrivateKey.fromRandom().toHex() },
  enrollment: null,
  accounts: { version: 1 },
  sentAt: 1,
}

describe('device approval', () => {
  it('binds commitments and comparison codes to one login', () => {
    const key = PrivateKey.fromRandom().toPublicKey()
    expect(commitmentFor(key, 'aa'.repeat(32))).not.toBe(commitmentFor(key, 'bb'.repeat(32)))
    expect(comparisonCode('binding', 'aa'.repeat(32), 'bb'.repeat(32))).toMatch(/^\d{8}$/)
    expect(comparisonCode('binding', 'aa'.repeat(32), 'bb'.repeat(32))).not.toBe(
      comparisonCode('other', 'aa'.repeat(32), 'bb'.repeat(32)),
    )
  })

  it('both screens show the same code only for the committed key', () => {
    const login = PrivateKey.fromRandom().toPublicKey()
    const relay = PrivateKey.fromRandom().toPublicKey()
    const rA = 'aa'.repeat(32)
    const rB = 'cc'.repeat(32)
    const request = { binding: 'b', loginKey: login.toString(), commitment: commitmentFor(login, rA), rA }
    expect(approvalComparisonCode(request, rB)).toBe(comparisonCode('b', rA, rB))
    expect(() => approvalComparisonCode({ ...request, loginKey: relay.toString() }, rB)).toThrow(/does not match/)
    expect(() => approvalComparisonCode({ ...request, rA: null }, rB)).toThrow(/not revealed/)
  })

  it('shows the code in two groups of four', () => {
    expect(formatComparisonCode('12345678')).toBe('1234 5678')
  })

  it('names the device from its platform', () => {
    expect(localDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('Mac')
    expect(localDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows PC')
    expect(localDeviceLabel('')).toBe('HandCash device')
  })
})

describe('vault transfer', () => {
  it('opens only with the new device key', () => {
    const login = PrivateKey.fromRandom()
    const sealed = sealVaultTransfer(transfer, PrivateKey.fromRandom(), login.toPublicKey().toString())
    expect(sealed).not.toContain(transfer.master.keyHex)
    expect(openVaultTransfer(sealed, login).master.keyHex).toBe(transfer.master.keyHex)
    expect(() => openVaultTransfer(sealed, PrivateKey.fromRandom())).toThrow()
  })

  it('refuses a payload without a vault key', () => {
    const login = PrivateKey.fromRandom()
    const sealed = sealVaultTransfer(
      { ...transfer, master: { derivation: 'brc-42', keyHex: '' } },
      PrivateKey.fromRandom(),
      login.toPublicKey().toString(),
    )
    expect(() => openVaultTransfer(sealed, login)).toThrow(/invalid vault/)
  })
})
