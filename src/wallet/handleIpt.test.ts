import { describe, expect, it } from 'vitest'
import { HANDLE_IPT_PROFILE, handleIptFromClaim } from './handleIpt'

describe('handleIptFromClaim', () => {
  it('projects empty when there is no claim', () => {
    const view = handleIptFromClaim(null, null)
    expect(view.state).toBe('empty')
    expect(view.profile).toBe(HANDLE_IPT_PROFILE)
    expect(view.label).toBe('')
  })

  it('projects a claimed handle as iptnft under the certificate state', () => {
    const view = handleIptFromClaim(
      {
        handle: 'alice',
        display: '$alice',
        identityKey: '02'.repeat(33),
        claimedAt: 1,
      },
      '$alice',
    )
    expect(view).toMatchObject({
      profile: 'iptnft',
      state: 'certificate',
      label: '$alice',
      handle: 'alice',
    })
  })
})
