import { describe, expect, it } from 'vitest'
import {
  gateOriginAccess,
  listConnectedApps,
  resolvePermission,
  retireLapsedGrants,
  setPendingGrantDuration,
  subscribePermissionRequests,
  type GrantDuration,
} from './permissions'

const DAY = 24 * 60 * 60 * 1000

async function connect(origin: string, duration: GrantDuration | null): Promise<void> {
  let pendingId: number | null = null
  const stop = subscribePermissionRequests((p) => {
    if (p?.kind === 'connect' && p.origin === origin) pendingId = p.id
  })
  const gate = gateOriginAccess(`https://${origin}`, 'createAction')
  await Promise.resolve()
  stop()
  expect(pendingId).not.toBeNull()
  if (duration) setPendingGrantDuration(pendingId!, duration)
  expect(resolvePermission(pendingId!, 'allow')).toBe(true)
  expect(await gate).toBe('allow')
}

const grantOf = (origin: string) => listConnectedApps().find((a) => a.origin === origin)

describe('Connect grant length (BRC-73 grant lapse)', () => {
  it('lasts 30 days unless the prompt picks another length', async () => {
    const before = Date.now()
    await connect('thirty.example', null)
    const at = grantOf('thirty.example')?.expiresAt ?? 0
    expect(at).toBeGreaterThanOrEqual(before + 30 * DAY)
    expect(at).toBeLessThanOrEqual(Date.now() + 30 * DAY)
  })

  it('writes the length chosen on the prompt, and none for until-disconnect', async () => {
    await connect('day.example', '1d')
    expect(grantOf('day.example')?.expiresAt).toBeLessThanOrEqual(Date.now() + DAY)
    await connect('open.example', 'open')
    expect(grantOf('open.example')).toBeDefined()
    expect(grantOf('open.example')?.expiresAt).toBeUndefined()
  })

  it('retires a lapsed grant, leaving open ones', async () => {
    await connect('lapse.example', '1d')
    await connect('keep.example', 'open')
    retireLapsedGrants(Date.now() + 2 * DAY)
    expect(grantOf('lapse.example')).toBeUndefined()
    expect(grantOf('keep.example')).toBeDefined()
  })
})
