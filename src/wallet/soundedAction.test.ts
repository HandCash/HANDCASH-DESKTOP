import { describe, expect, it, vi } from 'vitest'
import { playWalletSound } from './soundService'
import { withSoftSound } from './soundedAction'

vi.mock('./soundService', () => ({ playWalletSound: vi.fn() }))

describe('withSoftSound', () => {
  it('plays the soft sound before the action, on each click only', () => {
    const order: string[] = []
    vi.mocked(playWalletSound).mockImplementation((kind) => void order.push(`sound:${kind}`))
    const onClick = withSoftSound(() => order.push('action'))
    expect(order).toEqual([])
    onClick()
    onClick()
    expect(order).toEqual(['sound:soft', 'action', 'sound:soft', 'action'])
  })
})
