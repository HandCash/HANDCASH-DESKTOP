import { act, render, screen } from '@testing-library/react'
import { createAeonStore, defineSlice, entityAttrs, queryAttrs } from '@aeon-ui/primitives'
import { describe, expect, it, vi } from 'vitest'
import { useAeonQuery, useAeonSelector } from './use-aeon-store.js'

interface Wallet {
  id: string
  label: string
  balance: number
}

function makeStore(load = async (): Promise<Wallet[]> => []) {
  return createAeonStore({
    id: 'app',
    slices: { wallets: defineSlice<Wallet>({ idOf: (w) => w.id, load }) },
  })
}

type Store = ReturnType<typeof makeStore>

function WalletRow({ store, id, onRender }: { store: Store; id: string; onRender: () => void }) {
  onRender()
  const wallet = useAeonSelector(store, (state) => state.slices.wallets.byId[id])
  const slice = useAeonSelector(store, (state) => state.slices.wallets)
  if (!wallet) return null
  return (
    <li {...entityAttrs(slice, 'wallets', id)} data-testid={id}>
      {wallet.label}: {wallet.balance}
    </li>
  )
}

function BalanceRow({ store, id, onRender }: { store: Store; id: string; onRender: () => void }) {
  onRender()
  const balance = useAeonSelector(store, (state) => state.slices.wallets.byId[id]?.balance)
  return <span data-testid={`balance-${id}`}>{balance}</span>
}

function WalletList({ store }: { store: Store }) {
  const result = useAeonQuery(store, 'wallets', 'all')
  return (
    <ul data-testid="list" {...queryAttrs(result)}>
      {result.entities.map((w) => (
        <li key={w.id}>{w.label}</li>
      ))}
    </ul>
  )
}

describe('useAeonSelector', () => {
  it('re-renders a component only when the entity it selects changes', () => {
    const store = makeStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [{ id: 'w1', label: 'Main', balance: 10 }, { id: 'w2', label: 'Savings', balance: 50 }] })
    const renders = vi.fn()
    render(<BalanceRow store={store} id="w1" onRender={renders} />)
    expect(renders).toHaveBeenCalledTimes(1)

    act(() => store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w2', patch: { balance: 51 } }))
    act(() => store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { label: 'Daily' } }))
    expect(renders).toHaveBeenCalledTimes(1)

    act(() => store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { balance: 11 } }))
    expect(renders).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('balance-w1')).toHaveTextContent('11')
  })

  it('projects a pending write onto data-aeon-state', () => {
    const store = makeStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [{ id: 'w1', label: 'Main', balance: 10 }] })
    render(<WalletRow store={store} id="w1" onRender={() => {}} />)
    expect(screen.getByTestId('w1')).toHaveAttribute('data-aeon-state', 'settled')

    act(() => store.send({ type: 'WRITE.BEGIN', slice: 'wallets', write: 'rename', upsert: [{ id: 'w1', label: 'Daily', balance: 10 }] }))
    expect(screen.getByTestId('w1')).toHaveAttribute('data-aeon-state', 'pending')
    expect(screen.getByTestId('w1')).toHaveTextContent('Daily: 10')

    act(() => store.send({ type: 'WRITE.ROLLBACK', write: 'rename', error: 'offline' }))
    expect(screen.getByTestId('w1')).toHaveAttribute('data-aeon-state', 'failed')
    expect(screen.getByTestId('w1')).toHaveTextContent('Main: 10')
  })
})

describe('useAeonQuery', () => {
  it('fetches on mount and shows the load state through data-aeon-state', async () => {
    let resolve!: (wallets: Wallet[]) => void
    const store = makeStore(() => new Promise((r) => (resolve = r)))
    render(<WalletList store={store} />)
    expect(screen.getByTestId('list')).toHaveAttribute('data-aeon-state', 'loading')

    await act(async () => resolve([{ id: 'w1', label: 'Main', balance: 10 }]))
    expect(screen.getByTestId('list')).toHaveAttribute('data-aeon-state', 'ready')
    expect(screen.getByTestId('list')).toHaveAttribute('data-aeon-count', '1')
    expect(screen.getByText('Main')).toBeInTheDocument()
  })
})
