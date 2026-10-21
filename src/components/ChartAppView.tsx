import { Button, Field, ListRow } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { useEffect, useMemo, useState } from 'react'
import { machineFromChart, chartPosition, type ChartRunnerSnapshot } from '../apps/chartRunner'
import { interpolate, BOX_MESSAGE_KIND_LABELS, formatMessageTime } from '../apps/chartFormat'
import type {
  BoxMessage,
  ChartApp,
  ChartBlock,
  ChartEffectPorts,
  ChartNetwork,
  Recipient,
  SenderRef,
} from '../apps/chartTypes'
import { listFriends, subscribeFriends, type Friend } from '../wallet/friends'
import { collectableIsFungible, subscribeCollectables, type Collectable } from '../wallet/collectables'
import { playWalletSound } from '../wallet/soundService'
import { LoadingSpinner } from './LoadingSpinner'
import { SelectionCheckbox } from './SelectionCheckbox'

const ITEM_PICKER_MAX = 40

function recipientOf(friend: Friend): Recipient {
  return { id: friend.id, label: friend.handle || friend.label, identityKey: friend.identityKey }
}

function useFriends(): Friend[] {
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  useEffect(() => subscribeFriends(setFriends), [])
  return friends
}

function useItems(): Collectable[] {
  const [items, setItems] = useState<Collectable[]>([])
  useEffect(() => subscribeCollectables((all) => setItems(all.filter((c) => !collectableIsFungible(c)))), [])
  return items
}

type Send = (event: { type: string; [key: string]: unknown }) => void

type ViewGroup = { kind: 'block' | 'actions'; blocks: ChartBlock[] }

function viewGroups(view: ChartBlock[]): ViewGroup[] {
  const groups: ViewGroup[] = []
  for (const block of view) {
    const isButton = block.block === 'primaryButton' || block.block === 'secondaryButton'
    const last = groups[groups.length - 1]
    if (isButton && last?.kind === 'actions') last.blocks.push(block)
    else groups.push({ kind: isButton ? 'actions' : 'block', blocks: [block] })
  }
  return groups
}

function FriendPicker({ chart, block, snapshot, send }: {
  chart: ChartApp
  block: Extract<ChartBlock, { block: 'friendPicker' }>
  snapshot: ChartRunnerSnapshot
  send: Send
}) {
  const friends = useFriends()
  const multiple = chart.fields[block.field].type === 'friends'
  const value = snapshot.context.values[block.field]
  const chosen = new Set(
    (Array.isArray(value) ? (value as Recipient[]) : value ? [value as Recipient] : []).map((r) => r.id),
  )
  const pick = (friend: Friend) => {
    playWalletSound('soft')
    if (!multiple) {
      send({ type: 'SET', field: block.field, value: chosen.has(friend.id) ? undefined : recipientOf(friend) })
      return
    }
    const current = Array.isArray(value) ? (value as Recipient[]) : []
    const next = chosen.has(friend.id)
      ? current.filter((r) => r.id !== friend.id)
      : [...current, recipientOf(friend)]
    send({ type: 'SET', field: block.field, value: next.length ? next : undefined })
  }
  return (
    <div className="field" data-aeon-part="friend-picker">
      <span className="field-static-label">{block.label}</span>
      {friends.length === 0 ? (
        <p className="permission-note">Add a friend first. Friends live in the Friends tab.</p>
      ) : (
        <div className="permission-chips" role="group" aria-label={block.label}>
          {friends.map((friend) => (
            <button
              key={friend.id}
              type="button"
              className={`permission-chip ${chosen.has(friend.id) ? 'permission-chip-accent' : 'permission-chip-muted'}`}
              aria-pressed={chosen.has(friend.id)}
              data-aeon-state={chosen.has(friend.id) ? 'on' : 'off'}
              onClick={() => pick(friend)}
            >
              {friend.handle || friend.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ItemPicker({ block, snapshot, send }: {
  block: Extract<ChartBlock, { block: 'itemPicker' }>
  snapshot: ChartRunnerSnapshot
  send: Send
}) {
  const items = useItems()
  const value = snapshot.context.values[block.field] as { outpoint: string } | undefined
  return (
    <div className="field" data-aeon-part="item-picker">
      <span className="field-static-label">{block.label}</span>
      {items.length === 0 ? (
        <p className="permission-note">No items in this wallet yet.</p>
      ) : (
        <div className="permission-chips" role="group" aria-label={block.label}>
          {items.slice(0, ITEM_PICKER_MAX).map((item) => {
            const on = value?.outpoint === item.outpoint
            return (
              <button
                key={item.outpoint}
                type="button"
                className={`permission-chip ${on ? 'permission-chip-accent' : 'permission-chip-muted'}`}
                aria-pressed={on}
                data-aeon-state={on ? 'on' : 'off'}
                onClick={() => {
                  playWalletSound('soft')
                  send({
                    type: 'SET',
                    field: block.field,
                    value: on ? undefined : { outpoint: item.outpoint, name: item.name || 'Item' },
                  })
                }}
              >
                {item.name || 'Item'}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RowList({ chart, block, snapshot, send }: {
  chart: ChartApp
  block: Extract<ChartBlock, { block: 'list' }>
  snapshot: ChartRunnerSnapshot
  send: Send
}) {
  const rows = (snapshot.context.values[block.field] as Array<BoxMessage | SenderRef> | undefined) ?? []
  const selected = new Set(
    block.select && Array.isArray(snapshot.context.values[block.select])
      ? (snapshot.context.values[block.select] as unknown as string[])
      : [],
  )
  if (rows.length === 0) {
    return block.empty ? <p className="permission-note">{interpolate(chart, snapshot.context.values, block.empty)}</p> : null
  }
  return (
    <ul className="settings-list" data-aeon-part="rows" aria-label={block.label}>
      {rows.map((row) => {
        const id = 'id' in row ? row.id : row.identityKey
        const label = 'id' in row ? row.senderName : row.name
        const description =
          'id' in row
            ? `${BOX_MESSAGE_KIND_LABELS[row.kind]} · ${row.box} · ${formatMessageTime(row.at)}`
            : row.identityKey
        return (
          <li key={id}>
            <ListRow.Root as="div" data-aeon-state={selected.has(id) ? 'selected' : 'idle'}>
              {block.select ? (
                <ListRow.Leading>
                  <SelectionCheckbox
                    checked={selected.has(id)}
                    label={`Select ${label}`}
                    onChange={() => send({ type: 'TOGGLE', field: block.select!, id })}
                  />
                </ListRow.Leading>
              ) : null}
              <ListRow.Label>{label}</ListRow.Label>
              <ListRow.Description>{description}</ListRow.Description>
              {block.open ? (
                <ListRow.Trailing>
                  <Button.Root
                    variant="ghost"
                    className="btn btn-ghost btn-compact"
                    onClick={() => {
                      playWalletSound('soft')
                      send({ type: block.open!.event, row })
                    }}
                  >
                    <Button.Label>Open</Button.Label>
                  </Button.Root>
                </ListRow.Trailing>
              ) : null}
            </ListRow.Root>
          </li>
        )
      })}
    </ul>
  )
}

function ViewBlock({ chart, block, snapshot, send }: {
  chart: ChartApp
  block: ChartBlock
  snapshot: ChartRunnerSnapshot
  send: Send
}) {
  const values = snapshot.context.values
  switch (block.block) {
    case 'heading':
      return <h2 className="permission-request-title">{interpolate(chart, values, block.text)}</h2>
    case 'text':
      return <p className="confirm-password-lede">{interpolate(chart, values, block.text)}</p>
    case 'amountInput':
    case 'textInput': {
      const id = `chart-app-${chart.id}-${block.field}`
      const value = values[block.field]
      return (
        <Field.Root className="field">
          <Field.Label htmlFor={id}>{block.label}</Field.Label>
          <Field.Control
            id={id}
            value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
            inputMode={block.block === 'amountInput' ? 'numeric' : undefined}
            placeholder={block.block === 'textInput' ? block.placeholder : '0'}
            autoComplete="off"
            onChange={(e) => send({ type: 'SET', field: block.field, value: e.target.value })}
          />
        </Field.Root>
      )
    }
    case 'friendPicker':
      return <FriendPicker chart={chart} block={block} snapshot={snapshot} send={send} />
    case 'itemPicker':
      return <ItemPicker block={block} snapshot={snapshot} send={send} />
    case 'list':
      return <RowList chart={chart} block={block} snapshot={snapshot} send={send} />
    case 'primaryButton':
    case 'secondaryButton': {
      const primary = block.block === 'primaryButton'
      return (
        <Button.Root
          variant={primary ? 'solid' : 'ghost'}
          className={primary ? 'btn btn-primary' : 'btn btn-ghost'}
          data-aeon-part={primary ? 'primary' : 'secondary'}
          disabled={!snapshot.can({ type: block.event })}
          onClick={() => {
            playWalletSound('soft')
            send({ type: block.event })
          }}
        >
          <Button.Label>{block.label}</Button.Label>
        </Button.Root>
      )
    }
  }
}

function Approval({ snapshot, send }: { snapshot: ChartRunnerSnapshot; send: Send }) {
  const approval = snapshot.context.pending?.approval
  // Approval never takes focus: a key press meant for the form must not land on Approve.
  useEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  }, [])
  if (!approval) return null
  return (
    <div className="permission-details-hero" data-aeon-part="approval" role="group" aria-label={approval.title}>
      <p className="permission-eyebrow">{approval.eyebrow}</p>
      <h2 className="permission-request-title">{approval.title}</h2>
      {approval.amount ? (
        <div className="action-amount">
          <span>Amount</span>
          <strong>{approval.amount}</strong>
        </div>
      ) : null}
      <dl className="permission-meta">
        {approval.lines.map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {approval.note ? <p className="permission-note">{approval.note}</p> : null}
      <div className="actions">
        <Button.Root
          variant="ghost"
          className="btn btn-ghost"
          data-aeon-part="decline"
          onClick={() => {
            playWalletSound('soft')
            send({ type: 'DECLINE' })
          }}
        >
          <Button.Label>Decline</Button.Label>
        </Button.Root>
        <Button.Root
          variant="solid"
          className="btn btn-primary"
          data-aeon-part="approve"
          onClick={() => {
            playWalletSound('soft')
            send({ type: 'APPROVE' })
          }}
        >
          <Button.Label>{approval.confirm}</Button.Label>
        </Button.Root>
      </div>
    </div>
  )
}

/** Runs one verified chart: its view blocks, its approval steps and its effects. */
export function ChartAppView({ chart, ports, network, onClose }: {
  chart: ChartApp
  ports: ChartEffectPorts
  network: ChartNetwork
  onClose: () => void
}) {
  const machine = useMemo(() => machineFromChart(chart, { ports, network }), [chart, ports, network])
  const [snapshot, send] = useMachine(machine)
  const { state, step } = chartPosition(snapshot.value)
  const chartState = chart.states[state]
  const done = snapshot.status === 'done'
  const groups = viewGroups(chartState?.view ?? [])
  const errorAt = groups[groups.length - 1]?.kind === 'actions' ? groups.length - 1 : groups.length
  const renderGroup = (group: ViewGroup, g: number) =>
    group.kind === 'actions' ? (
      <div key={`${state}-${g}`} className="actions">
        {group.blocks.map((block, i) => (
          <ViewBlock key={i} chart={chart} block={block} snapshot={snapshot} send={send as Send} />
        ))}
      </div>
    ) : (
      <ViewBlock key={`${state}-${g}`} chart={chart} block={group.blocks[0]} snapshot={snapshot} send={send as Send} />
    )

  return (
    <div
      className="settings-form"
      data-aeon-scope="chart-app"
      data-aeon-state={stateToAttr(snapshot.value)}
      data-chart-app={chart.id}
    >
      {step === 'approving' ? (
        <Approval key={state} snapshot={snapshot} send={send as Send} />
      ) : step === 'running' ? (
        <p className="confirm-password-lede" data-aeon-part="running" aria-live="polite">
          <LoadingSpinner size="sm" /> Working…
        </p>
      ) : (
        <>
          {groups.slice(0, errorAt).map(renderGroup)}
          {snapshot.context.error ? (
            <p className="permission-note" role="alert" data-aeon-part="error">{snapshot.context.error}</p>
          ) : null}
          {groups.slice(errorAt).map((group, g) => renderGroup(group, errorAt + g))}
          {done ? (
            <div className="actions">
              <Button.Root variant="solid" className="btn btn-primary" data-aeon-part="close" onClick={onClose}>
                <Button.Label>Done</Button.Label>
              </Button.Root>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
