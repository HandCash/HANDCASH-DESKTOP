import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEmailRecoveryEnrollment } from '../wallet/brc250/store'
import type { EmailRecoveryEnrollment } from '../wallet/brc250/types'
import { HandCashRecoveryPanel } from './HandCashRecoveryPanel'

vi.mock('../wallet/brc250/store', () => ({ getEmailRecoveryEnrollment: vi.fn(() => null) }))

const enrollment: EmailRecoveryEnrollment = {
  v: 1,
  host: 'https://recovery.example',
  email: 'ann@gmail.com',
  authorityKey: '02aa',
  attesterKey: '02bb',
  master: { derivation: 'brc-42' },
  mailboxConfirmed: true,
  enrolledAt: 1,
}

function method(html: string, name: 'google' | 'email'): string {
  const match = html.match(new RegExp(`<li[^>]*data-aeon-part="recovery-${name}"[\\s\\S]*?</li>`))
  expect(match, name).not.toBeNull()
  return match![0]
}

beforeEach(() => vi.mocked(getEmailRecoveryEnrollment).mockReturnValue(null))

describe('HandCashRecoveryPanel', () => {
  it('says HandCash provides the recovery, not Google or the email provider', () => {
    const html = renderToStaticMarkup(createElement(HandCashRecoveryPanel))
    expect(html).toContain('HandCash provides this recovery, not Google or your email provider.')
  })

  it('lists Google and email as separate methods, each with its own status and action', () => {
    const html = renderToStaticMarkup(createElement(HandCashRecoveryPanel))
    const google = method(html, 'google')
    const email = method(html, 'email')
    expect(google).toContain('data-aeon-state="warn"')
    expect(google).toContain('Not set up')
    expect(google).toContain('Continue with Google')
    expect(email).toContain('data-aeon-state="muted"')
    expect(email).toContain('Waits on Google sign-in')
    expect(email).not.toContain('<button')
  })

  it('shows both methods confirmed once recovery is saved, with nothing left to do', () => {
    vi.mocked(getEmailRecoveryEnrollment).mockReturnValue(enrollment)
    const html = renderToStaticMarkup(createElement(HandCashRecoveryPanel))
    expect(method(html, 'google')).toContain('Signed in as ann@gmail.com')
    expect(method(html, 'email')).toContain('Share confirmed in ann@gmail.com')
    expect(html).not.toContain('<button')
    expect(html).toContain('data-aeon-scope="handcash-recovery" data-aeon-state="ready"')
  })
})

describe('Google sign-in stays in the system browser', () => {
  const files = ['HandCashRecoveryPanel.tsx', 'GoogleLoginPanel.tsx'].map((name) =>
    fs.readFileSync(path.join(__dirname, name), 'utf8'),
  )

  it('opens Google through the shared system-browser opener', () => {
    for (const source of files) {
      expect(source).toContain("from '../wallet/brc250/systemBrowser'")
      expect(source).toMatch(/openInSystemBrowser\(next\.attempt\.openUrl\)/)
    }
  })

  it('never embeds the sign-in page', () => {
    for (const source of files) expect(source).not.toMatch(/<iframe|<webview|BrowserWindow|window\.open\(/)
  })
})
