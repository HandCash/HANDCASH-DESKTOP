import { useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { grantExpiryMachine } from '../machines/grantExpiryMachine'
import { retireLapsedGrants } from '../wallet/permissions'

const TICK_MS = 60_000

function lapseText(expiresAt: number, now: number): string {
  const hours = Math.max(1, Math.ceil((expiresAt - now) / 3_600_000))
  return hours < 24 ? `Lapses in ${hours} h` : `Connected until ${new Date(expiresAt).toLocaleDateString()}`
}

/** One connected app's grant over time (BRC-73): the grantExpiry chart decides; this projects it. */
export function GrantExpiryLine({ expiresAt }: { expiresAt: number | undefined }) {
  const [snapshot, send] = useMachine(grantExpiryMachine, {
    input: { expiresAt: expiresAt ?? null, now: Date.now() },
  })

  useEffect(() => {
    send({ type: 'SET_EXPIRY', expiresAt: expiresAt ?? null, now: Date.now() })
  }, [expiresAt, send])

  useEffect(() => {
    if (expiresAt == null) return
    const id = window.setInterval(() => send({ type: 'TICK', now: Date.now() }), TICK_MS)
    return () => window.clearInterval(id)
  }, [expiresAt, send])

  const lapsed = snapshot.matches('expired')
  useEffect(() => {
    if (lapsed) retireLapsedGrants()
  }, [lapsed])

  const { context } = snapshot
  return (
    <p className="grant-expiry" data-aeon-scope="grant-expiry" data-aeon-state={stateToAttr(snapshot.value)}>
      {context.expiresAt == null
        ? 'Connected until you disconnect'
        : lapsed
          ? 'Connection lapsed'
          : lapseText(context.expiresAt, context.now)}
    </p>
  )
}
