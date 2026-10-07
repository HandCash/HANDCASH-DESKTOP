import { beforeEach, describe, expect, it } from 'vitest'
import {
  allowOrigin,
  revokeAllOrigins,
  connectedAppChannel,
  listConnectedApps,
  setAcceptIncomingFunds,
} from './permissions'

describe('connected app channel', () => {
  beforeEach(() => revokeAllOrigins())

  it('binds a Connect made in an app tab to that channel', () => {
    allowOrigin('app.example.com', 'in-app')
    expect(connectedAppChannel('app.example.com')).toBe('in-app')
  })

  it('leaves a loopback Connect usable from either channel', () => {
    allowOrigin('app.example.com')
    expect(connectedAppChannel('app.example.com')).toBe('socket')
    expect(listConnectedApps()[0]).not.toHaveProperty('connectedVia')
  })

  it('never rebinds an existing grant, and keeps the binding through later edits', () => {
    allowOrigin('app.example.com', 'in-app')
    allowOrigin('app.example.com', 'socket')
    setAcceptIncomingFunds('app.example.com', false)
    expect(connectedAppChannel('app.example.com')).toBe('in-app')

    allowOrigin('other.example.com', 'socket')
    allowOrigin('other.example.com', 'in-app')
    expect(connectedAppChannel('other.example.com')).toBe('socket')
  })

  it('names no channel for an app that is not connected', () => {
    expect(connectedAppChannel('app.example.com')).toBeNull()
  })
})
