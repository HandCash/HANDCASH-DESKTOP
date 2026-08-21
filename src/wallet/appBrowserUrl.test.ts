import { describe, expect, it } from 'vitest'
import { decideAppBrowserTarget } from './appBrowserUrl'

describe('decideAppBrowserTarget', () => {
  it('assumes https for a bare host typed on a phone', () => {
    expect(decideAppBrowserTarget('lilpoker.com/poker')).toEqual({
      kind: 'open',
      url: 'https://lilpoker.com/poker',
      host: 'lilpoker.com',
    })
  })

  it('keeps an explicit https url, port and query included', () => {
    const target = decideAppBrowserTarget('https://lil.example:8443/table?seat=3')

    expect(target).toEqual({
      kind: 'open',
      url: 'https://lil.example:8443/table?seat=3',
      host: 'lil.example:8443',
    })
  })

  it('allows plaintext http only on loopback', () => {
    expect(decideAppBrowserTarget('http://127.0.0.1:3000').kind).toBe('open')
    expect(decideAppBrowserTarget('http://localhost:3000').kind).toBe('open')

    const remote = decideAppBrowserTarget('http://lilpoker.com')
    expect(remote.kind === 'refuse' && remote.reason).toBe('insecure-host')
  })

  it('refuses schemes that would run in the wallet or read the device', () => {
    for (const raw of [
      'javascript:alert(document.cookie)',
      'file:///data/data/io.handcash.mobile',
      'data:text/html,<script>1</script>',
      'content://media/external/images',
      'peerpay:02abc',
    ]) {
      const target = decideAppBrowserTarget(raw)
      expect(target.kind === 'refuse' && target.reason).toBe('scheme-not-allowed')
    }
  })

  it('refuses empty and unparsable input', () => {
    for (const raw of ['', '  ']) {
      const target = decideAppBrowserTarget(raw)
      expect(target.kind === 'refuse' && target.reason).toBe('empty')
    }
    const bare = decideAppBrowserTarget('https://')
    expect(bare.kind === 'refuse' && bare.reason).toBe('unparsable')
  })
})
