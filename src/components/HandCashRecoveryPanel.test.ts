import fs from 'node:fs'
import path from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listAddedDevices } from '../wallet/addedDevices'
import { savedBackupFormats } from '../wallet/backupFormats'
import { readVaultMeta } from '../wallet/vault'
import { HandCashRecoveryPanel } from './HandCashRecoveryPanel'

vi.mock('./settings', () => ({
  settingIconFor: () => ({ icon: null }),
  SettingsSection: ({ title, part, children }: { title: string; part: string; children: ReactNode }) =>
    createElement('section', { 'data-aeon-part': part }, createElement('h3', null, title), children),
  SettingsNavRow: ({ label, status, description }: { label: string; status?: string; description?: string }) =>
    createElement('li', null, createElement('button', null, label, ' ', status ?? description)),
}))
vi.mock('../wallet/deviceSignin', () => ({
  listSigninDevices: vi.fn(async () => ({ onlineMs: 600_000, devices: [] })),
  removeSigninDevice: vi.fn(async () => ({ ok: true })),
  signinErrorText: (error: unknown) => String(error),
  walletSigninKeyHex: vi.fn(() => '11'.repeat(32)),
}))
vi.mock('../wallet/vault', () => ({ readVaultMeta: vi.fn(() => ({ hasMnemonic: true })) }))
vi.mock('../wallet/deviceWallets', () => ({ getOrCreateDeviceId: () => 'device-this-1' }))
vi.mock('../wallet/deviceTransfer', () => ({ localDeviceLabel: () => 'Mac' }))
vi.mock('../wallet/addedDevices', () => ({
  listAddedDevices: vi.fn(() => []),
  noteDeviceRemoved: vi.fn(),
  subscribeAddedDevices: () => () => undefined,
}))
vi.mock('../wallet/backupFormats', () => ({
  openBackupFormat: vi.fn(),
  savedBackupFormats: vi.fn(() => new Set()),
  subscribeBackupFormats: () => () => undefined,
}))

const render = () => renderToStaticMarkup(createElement(HandCashRecoveryPanel))
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&rsquo;/g, '’').replace(/\s+/g, ' ')

beforeEach(() => {
  vi.mocked(listAddedDevices).mockReturnValue([])
  vi.mocked(savedBackupFormats).mockReturnValue(new Set())
  vi.mocked(readVaultMeta).mockReturnValue({ hasMnemonic: true } as ReturnType<typeof readVaultMeta>)
})

describe('HandCash Recovery section', () => {
  it('shows another device first, then a different wallet, then self-kept backups, then the enclave line', () => {
    const html = render()
    const order = ['recovery-devices', 'recovery-other-wallet', 'recovery-self', 'recovery-enclave'].map((part) =>
      html.indexOf(`data-aeon-part="${part}"`),
    )
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('leads with backing this wallet up on another device, in the agreed words', () => {
    const page = text(render())
    const button = page.indexOf('Back this up on another device')
    expect(button).toBeGreaterThanOrEqual(0)
    expect(page).toContain(
      'Use this wallet on your phone or another computer. Each device keeps a full copy, so losing one doesn’t lose your wallet.',
    )
    expect(button).toBeLessThan(page.indexOf('Back up a different wallet'))
  })

  it('lists this device and the devices it added, each added one removable', () => {
    vi.mocked(listAddedDevices).mockReturnValue([{ id: '02ab', label: 'iPhone', via: 'local', addedAt: new Date(2026, 9, 20, 12).getTime() }])
    const html = render()
    const rows = html.match(/<li[^>]*data-aeon-part="recovery-device"[\s\S]*?<\/li>/g) ?? []
    expect(rows).toHaveLength(2)
    expect(text(rows[0]!)).toContain('Mac This device')
    expect(rows[0]).not.toContain('Remove')
    expect(text(rows[1]!)).toMatch(/iPhone Added Oct 20/)
    expect(rows[1]).toContain('Remove')
  })

  it('offers the phrase, the key slices and the emergency key, each with its own saved status', () => {
    vi.mocked(savedBackupFormats).mockReturnValue(new Set(['split']))
    const self = text(render().split('data-aeon-part="recovery-self"')[1]!.split('data-aeon-part="recovery-enclave"')[0]!)
    expect(self).toContain('Save a backup yourself')
    expect(self).toContain('For when you can’t sign in on another device.')
    expect(self).toMatch(/24-word recovery phrase Not saved/)
    expect(self).toMatch(/3 key slices, any 2 restore it Saved/)
    expect(self).toMatch(/Emergency key Not saved/)
  })

  it('says when this wallet has no phrase instead of asking for one', () => {
    vi.mocked(readVaultMeta).mockReturnValue({ hasMnemonic: false } as ReturnType<typeof readVaultMeta>)
    expect(text(render())).toMatch(/24-word recovery phrase This wallet has no phrase/)
  })

  it('hides Google and email recovery behind one line, and keeps their code', () => {
    const html = render()
    expect(text(html)).toContain('Secure enclave recovery is coming.')
    expect(html).not.toMatch(/recovery-google|recovery-email|Continue with Google|Google/)
    const source = fs.readFileSync(path.join(__dirname, 'HandCashRecoveryPanel.tsx'), 'utf8')
    expect(source).not.toContain('GoogleEmailRecoveryMethods')
    expect(fs.existsSync(path.join(__dirname, 'GoogleEmailRecoveryMethods.tsx'))).toBe(true)
  })
})
