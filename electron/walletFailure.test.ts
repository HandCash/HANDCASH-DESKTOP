import { describe, expect, it } from 'vitest'
import { bridgeFailureDescription, walletFailureFor, withWalletFailure } from './walletFailure.js'

describe('walletFailureFor (BRC-326)', () => {
  it('never reports a spend that may have run as a clean failure', () => {
    for (const code of ['WALLET_BRIDGE_PENDING', 'ACTION_IN_PROGRESS', 'SPEND_REGION_ABANDONED', 'INSUFFICIENT_OR_STALE_FUNDS']) {
      expect(walletFailureFor(code, 503, '/createAction')).toEqual({
        class: 'uncertain-delivery',
        fault: 'none',
        retry: 'check-first',
      })
    }
  })

  it('treats an unknown failure on a money-moving method as uncertain, and on a read as retryable', () => {
    expect(walletFailureFor('WALLET_HANDLER_ERROR', 500, '/createAction').class).toBe('uncertain-delivery')
    expect(walletFailureFor(undefined, 409, '/sendCoins').class).toBe('uncertain-delivery')
    expect(walletFailureFor('WALLET_HANDLER_ERROR', 500, '/listOutputs')).toEqual({
      class: 'unavailable',
      fault: 'wallet',
      retry: 'safe',
    })
  })

  it('says check first only when a handle claim may have bound the handle', () => {
    expect(walletFailureFor('HANDLE_ISSUE_FAILED', 502, '/issueHandle').retry).toBe('check-first')
    expect(walletFailureFor('HANDLE_ISSUE_REFUSED', 403, '/issueHandle').class).toBe('permission-denied')
    expect(walletFailureFor('HANDLE_ISSUE_GRANT_EXPIRED', 403, '/issueHandle')).toEqual({
      class: 'permission-denied',
      fault: 'none',
      retry: 'safe',
    })
    expect(walletFailureFor('HANDLE_ISSUE_TICKET_REJECTED', 400, '/issueHandle').class).toBe('invalid-request')
  })

  it('keeps a refusal by the user apart from one by a standing rule', () => {
    expect(walletFailureFor('PERMISSION_DENIED', 403, '/createAction')).toEqual({
      class: 'permission-denied',
      fault: 'user',
      retry: 'unsafe',
    })
    expect(walletFailureFor('ORIGIN_REFUSED', 403, '/createAction')).toEqual({
      class: 'policy-blocked',
      fault: 'none',
      retry: 'unsafe',
    })
  })

  it('calls a locked or unstarted wallet locked or unreachable, never absent', () => {
    expect(walletFailureFor('WALLET_LOCKED', 401, '/getPublicKey').class).toBe('locked')
    expect(walletFailureFor('WALLET_BRIDGE_UNAVAILABLE', 503, '/createAction')).toEqual({
      class: 'unreachable',
      fault: 'none',
      retry: 'safe',
    })
  })

  it('blames the app for a request it got wrong', () => {
    expect(walletFailureFor('BAD_REQUEST', 400, '/createAction')).toEqual({
      class: 'invalid-request',
      fault: 'application',
      retry: 'unsafe',
    })
    expect(walletFailureFor(undefined, 404, '/nope').class).toBe('invalid-request')
  })

  it('says insufficient funds only for a known shortfall', () => {
    expect(walletFailureFor('INSUFFICIENT_FUNDS', 400, '/createAction').class).toBe('insufficient-funds')
    expect(walletFailureFor('UNIMPLEMENTED', 400, '/createAction')).toEqual({
      class: 'unavailable',
      fault: 'wallet',
      retry: 'unsafe',
    })
  })
})

describe('withWalletFailure', () => {
  it('adds the three fields to an error body and keeps what was there', () => {
    const body = JSON.stringify({ status: 'error', code: 'PERMISSION_DENIED', description: 'You denied this app access to HandCash.' })
    expect(JSON.parse(withWalletFailure(403, body, '/createAction'))).toEqual({
      status: 'error',
      code: 'PERMISSION_DENIED',
      description: 'You denied this app access to HandCash.',
      class: 'permission-denied',
      fault: 'user',
      retry: 'unsafe',
    })
  })

  it('marks an error body that has no status or code', () => {
    const out = JSON.parse(withWalletFailure(409, JSON.stringify({ error: 'Wallet account changed during request' }), '/createAction'))
    expect(out).toMatchObject({ status: 'error', class: 'uncertain-delivery', retry: 'check-first' })
  })

  it('leaves successes, non-JSON bodies and bodies that already carry a class alone', () => {
    const ok = JSON.stringify({ txid: 'ab' })
    expect(withWalletFailure(200, ok, '/createAction')).toBe(ok)
    expect(withWalletFailure(500, 'boom', '/createAction')).toBe('boom')
    const classed = JSON.stringify({ status: 'error', class: 'locked', fault: 'none', retry: 'safe' })
    expect(withWalletFailure(401, classed, '/createAction')).toBe(classed)
  })
})

describe('bridgeFailureDescription', () => {
  it('speaks plainly, with no codes, methods or timings', () => {
    const words = [
      bridgeFailureDescription('WALLET_BRIDGE_PENDING', 'WALLET_BRIDGE_PENDING: POST /createAction is still running after 300000ms', '/createAction'),
      bridgeFailureDescription('WALLET_BRIDGE_TIMEOUT', 'WALLET_BRIDGE_TIMEOUT: no renderer reply for GET /listOutputs within 120000ms', '/listOutputs'),
      bridgeFailureDescription('WALLET_BRIDGE_UNAVAILABLE', 'WALLET_BRIDGE_UNAVAILABLE: wallet window is still loading (renderer-not-ready)', '/getVersion'),
      bridgeFailureDescription('HTTP_BRIDGE_ERROR', 'boom', '/listOutputs'),
    ]
    for (const text of words) {
      expect(text).not.toMatch(/[A-Z]{3,}_|\/[a-z]|\d{3,}ms|renderer/)
      expect(text.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2)
    }
    expect(words[2]).toBe('HandCash is still starting. Try again in a moment.')
  })

  it('never tells a spend that failed inside the bridge it can simply retry', () => {
    expect(bridgeFailureDescription('HTTP_BRIDGE_ERROR', 'boom', '/createAction')).toMatch(/may still finish/)
  })
})
