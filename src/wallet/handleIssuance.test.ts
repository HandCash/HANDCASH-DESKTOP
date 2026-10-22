import { beforeEach, describe, expect, it } from 'vitest'
import { HOME_HANDLE_DOMAIN } from './handleDomain'
import { HandleClaimError } from './handleResolve'
import {
  HANDLE_ISSUE_GRANT_TTL_MS,
  HandleIssueError,
  grantHandleIssue,
  issueHandleCertificate,
  listHandleIssueGrants,
  revokeHandleIssueGrant,
  revokeHandleIssueGrants,
  takeHandleIssueGrant,
  type HandleIssueDeps,
  type HandleIssueRequest,
  type HandleIssueScope,
} from './handleIssuance'
import { summarizeAction } from './permissions'

const APP = 'apps.alignity.test'
const KEY = `02${'a'.repeat(64)}`
const OTHER_KEY = `03${'b'.repeat(64)}`
const TICKET = 'eyJ2IjoxLCJoYW5kbGUiOiJhbGlnbml0eSJ9.c2lnbmF0dXJl'
const REQUEST = { handle: 'alignity', identityKey: KEY, claimTicket: TICKET }

function harness(overrides: Partial<HandleIssueDeps> = {}) {
  const state = {
    clock: 1_000_000,
    signingKey: KEY as string | null,
    approvals: [] as Array<[string, HandleIssueScope]>,
    sent: [] as HandleIssueRequest[],
  }
  const deps: HandleIssueDeps = {
    now: () => state.clock,
    activeIdentityKey: () => state.signingKey,
    approve: async (origin, scope) => {
      state.approvals.push([origin, scope])
      return 'allow'
    },
    prepare: async () => async (request) => {
      state.sent.push(request)
      return {
        handle: request.handle,
        domain: HOME_HANDLE_DOMAIN,
        display: `@${request.handle}@${HOME_HANDLE_DOMAIN}`,
        identityKey: request.identityKey,
        certificate: { type: 'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=', subject: request.identityKey, signature: '3044' },
      }
    },
    ...overrides,
  }
  return { state, deps }
}

async function failure(promise: Promise<unknown>): Promise<HandleIssueError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(HandleIssueError)
  return err as HandleIssueError
}

beforeEach(() => {
  revokeHandleIssueGrants()
})

describe('issueHandleCertificate', () => {
  it('granted: asks once for that app, handle and key, then returns the signed certificate', async () => {
    const { state, deps } = harness()
    const issued = await issueHandleCertificate(APP, REQUEST, deps)

    expect(issued).toMatchObject({ handle: 'alignity', identityKey: KEY, domain: HOME_HANDLE_DOMAIN })
    expect(issued.certificate.signature).toBe('3044')
    expect(state.approvals).toEqual([[APP, { handle: 'alignity', identityKey: KEY }]])
    expect(state.sent).toEqual([REQUEST])
    expect(listHandleIssueGrants(state.clock)).toEqual([])
  })

  it('the owner is a parameter: the same app may issue for whichever key the wallet signs with', async () => {
    const { state, deps } = harness()
    state.signingKey = OTHER_KEY
    const issued = await issueHandleCertificate(APP, { ...REQUEST, identityKey: OTHER_KEY.toUpperCase() }, deps)
    expect(issued.identityKey).toBe(OTHER_KEY)
  })

  it('never shows or grants on the ticket: the prompt gets the scope alone', async () => {
    const { state, deps } = harness()
    await issueHandleCertificate(APP, REQUEST, deps)
    expect(JSON.stringify(state.approvals)).not.toContain(TICKET)
    expect(JSON.stringify(summarizeAction('issueHandle', REQUEST))).not.toContain(TICKET)
    expect(summarizeAction('issueHandle', REQUEST).summary).toBe(`Bind @alignity@${HOME_HANDLE_DOMAIN} to your identity key`)
  })

  it('refused: nothing is claimed and no grant is left', async () => {
    const { state, deps } = harness({ approve: async () => 'deny' })
    const err = await failure(issueHandleCertificate(APP, REQUEST, deps))
    expect([err.code, err.status]).toEqual(['HANDLE_ISSUE_REFUSED', 403])
    expect(state.sent).toEqual([])
    expect(listHandleIssueGrants(state.clock)).toEqual([])
  })

  it('expired: an approval older than its lifetime does not spend the ticket', async () => {
    const { state, deps } = harness()
    deps.prepare = async () => {
      state.clock += HANDLE_ISSUE_GRANT_TTL_MS
      return async () => {
        throw new Error('must not be called')
      }
    }
    const err = await failure(issueHandleCertificate(APP, REQUEST, deps))
    expect(err.code).toBe('HANDLE_ISSUE_GRANT_EXPIRED')
    expect(state.sent).toEqual([])
  })

  it('revoked: the user can withdraw an approval before it is used', async () => {
    const { state, deps } = harness()
    const prepare = deps.prepare
    deps.prepare = async () => {
      revokeHandleIssueGrants(APP)
      return prepare()
    }
    const err = await failure(issueHandleCertificate(APP, REQUEST, deps))
    expect(err.code).toBe('HANDLE_ISSUE_GRANT_REVOKED')
    expect(state.sent).toEqual([])
  })

  it('wrong key: a key the wallet is not signing with is refused before any prompt', async () => {
    const { state, deps } = harness()
    const err = await failure(issueHandleCertificate(APP, { ...REQUEST, identityKey: OTHER_KEY }, deps))
    expect(err.code).toBe('HANDLE_ISSUE_WRONG_KEY')
    expect(state.approvals).toEqual([])
    expect(state.sent).toEqual([])
  })

  it('wrong key: switching accounts while the prompt is open stops the claim', async () => {
    const { state, deps } = harness()
    deps.approve = async () => {
      state.signingKey = OTHER_KEY
      return 'allow'
    }
    const err = await failure(issueHandleCertificate(APP, REQUEST, deps))
    expect(err.code).toBe('HANDLE_ISSUE_WRONG_KEY')
    expect(state.sent).toEqual([])
  })

  it('a locked wallet signs with no key, so it is the wrong key', async () => {
    const { state, deps } = harness()
    state.signingKey = null
    expect((await failure(issueHandleCertificate(APP, REQUEST, deps))).code).toBe('HANDLE_ISSUE_WRONG_KEY')
  })

  it.each([
    ['no ticket', { handle: 'alignity', identityKey: KEY }],
    ['a ticket that is not body.signature', { ...REQUEST, claimTicket: 'not a ticket' }],
    ['a bad handle', { ...REQUEST, handle: '-bad-' }],
    ['a key that is not a compressed public key', { ...REQUEST, identityKey: 'abc' }],
  ])('invalid: %s is refused before any prompt', async (_label, body) => {
    const { state, deps } = harness()
    expect((await failure(issueHandleCertificate(APP, body, deps))).code).toBe('HANDLE_ISSUE_INVALID')
    expect(state.approvals).toEqual([])
  })

  it.each([
    ['ticket-used', 409, 'HANDLE_ISSUE_TICKET_REJECTED'],
    ['ticket-expired', 401, 'HANDLE_ISSUE_TICKET_REJECTED'],
    ['ticket-identity-mismatch', 401, 'HANDLE_ISSUE_TICKET_REJECTED'],
    ['handle-taken', 409, 'HANDLE_ISSUE_TAKEN'],
    ['wrong-identity', 403, 'HANDLE_ISSUE_WRONG_KEY'],
    ['certifier-unavailable', 503, 'HANDLE_ISSUE_FAILED'],
  ] as const)('BRC-CLOUD answering %s maps to %s', async (reason, status, code) => {
    const { deps } = harness({
      prepare: async () => async () => {
        throw new HandleClaimError(`Handle claim failed (${status}): ${reason}`, status, reason)
      },
    })
    const err = await failure(issueHandleCertificate(APP, REQUEST, deps))
    expect([err.code, err.reason]).toEqual([code, reason])
  })

  it('a lost reply may have bound the handle, so it says check first', async () => {
    const { deps } = harness({
      prepare: async () => async () => {
        throw new TypeError('fetch failed')
      },
    })
    const err = await failure(issueHandleCertificate(APP, REQUEST, deps))
    expect(err.code).toBe('HANDLE_ISSUE_FAILED')
    expect(err.message).toMatch(/Resolve the handle/)
  })

  it('refuses an answer for another handle or key', async () => {
    const { deps } = harness()
    const send = await deps.prepare()
    deps.prepare = async () => async (request) => ({ ...(await send(request)), handle: 'someone-else' })
    expect((await failure(issueHandleCertificate(APP, REQUEST, deps))).code).toBe('HANDLE_ISSUE_FAILED')
  })
})

describe('handle issue grants', () => {
  const scope = { handle: 'alignity', identityKey: KEY }

  it('reused: a grant authorizes exactly one claim', () => {
    const grant = grantHandleIssue(APP, scope, 0)
    takeHandleIssueGrant(grant.id, APP, scope, 1)
    expect(() => takeHandleIssueGrant(grant.id, APP, scope, 2)).toThrow(
      expect.objectContaining({ code: 'HANDLE_ISSUE_GRANT_USED' }),
    )
  })

  it('is scoped to one app, one handle and one key', () => {
    for (const [origin, other] of [
      ['other.app.test', scope],
      [APP, { ...scope, handle: 'alignity2' }],
      [APP, { ...scope, identityKey: OTHER_KEY }],
    ] as const) {
      const grant = grantHandleIssue(APP, scope, 0)
      expect(() => takeHandleIssueGrant(grant.id, origin, other, 1)).toThrow(
        expect.objectContaining({ code: 'HANDLE_ISSUE_REFUSED' }),
      )
    }
  })

  it('expires after its lifetime and is listed only while live', () => {
    const grant = grantHandleIssue(APP, scope, 0)
    expect(listHandleIssueGrants(HANDLE_ISSUE_GRANT_TTL_MS - 1).map((g) => g.id)).toEqual([grant.id])
    expect(listHandleIssueGrants(HANDLE_ISSUE_GRANT_TTL_MS)).toEqual([])
    expect(() => takeHandleIssueGrant(grant.id, APP, scope, HANDLE_ISSUE_GRANT_TTL_MS)).toThrow(
      expect.objectContaining({ code: 'HANDLE_ISSUE_GRANT_EXPIRED' }),
    )
  })

  it('revokes one grant, or every grant of an app when it is disconnected', () => {
    const one = grantHandleIssue(APP, scope, 0)
    const two = grantHandleIssue(APP, { ...scope, handle: 'alignity2' }, 0)
    const other = grantHandleIssue('other.app.test', scope, 0)
    expect(revokeHandleIssueGrant(one.id)).toBe(true)
    expect(revokeHandleIssueGrant(one.id)).toBe(false)
    revokeHandleIssueGrants(APP)
    expect(listHandleIssueGrants(1).map((g) => g.id)).toEqual([other.id])
    expect(() => takeHandleIssueGrant(two.id, APP, { ...scope, handle: 'alignity2' }, 1)).toThrow(
      expect.objectContaining({ code: 'HANDLE_ISSUE_GRANT_REVOKED' }),
    )
  })
})
