/**
 * Calls on Activity: the call under way, from dialling to its end, then each
 * missed or finished call of the last few days with a way to call back.
 */
import { useEffect, useMemo, useState } from 'react'
import { callPeerLabel, useCall, useCallElapsed } from '../../features/calls/useCall'
import { callDurationText, callOutcomeText, subscribeCallRecords, type CallRecord } from '../../wallet/calls/callHistory'
import { callEngine } from '../../wallet/calls/callService'
import { CallIcon, CallMissedIcon } from '../icons'

const RECENT_MS = 3 * 24 * 60 * 60 * 1000
const MAX_ROWS = 20

function timeOf(at: number): string {
  const d = new Date(at)
  const today = new Date()
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export function useRecentCalls(now = Date.now()): readonly CallRecord[] {
  const [records, setRecords] = useState<readonly CallRecord[]>([])
  useEffect(() => subscribeCallRecords(setRecords), [])
  return useMemo(() => records.filter((r) => now - r.startedAt < RECENT_MS).slice(0, MAX_ROWS), [records, now])
}

function missed(r: CallRecord): boolean {
  return r.direction === 'in' && (r.outcome === 'missed' || r.outcome === 'cancelled')
}

export function LiveCallRow() {
  const { snapshot, state, peerLabel } = useCall()
  const c = snapshot.context
  const elapsed = useCallElapsed(c.connectedAt, c.endedAt)
  if (snapshot.matches('idle') || snapshot.matches('ended')) return null
  const detail = snapshot.matches('incoming')
    ? 'Calling you'
    : snapshot.matches('outgoing')
      ? 'Calling…'
      : snapshot.matches('connecting')
        ? 'Connecting…'
        : `On a call · ${callDurationText(elapsed)}`
  return (
    <li data-aeon-scope="call-activity" data-aeon-state={state} data-activity-pending="">
      <div className="history-row">
        <div className="history-icon-wrap">
          <div className="history-icon">
            <span className="history-item-thumb-icon" aria-hidden>
              <CallIcon size={18} />
            </span>
          </div>
        </div>
        <div className="history-body">
          <strong className="history-title">{peerLabel}</strong>
          <span className="history-when">{detail}</span>
        </div>
      </div>
    </li>
  )
}

export function CallRecordRow({ record }: { record: CallRecord }) {
  const peer = record.peers[0] ?? null
  const label = record.peers.map((p) => callPeerLabel(p)).join(', ')
  const face = missed(record) ? 'missed' : record.outcome
  return (
    <li data-aeon-scope="call-activity" data-aeon-state={face} data-activity-key={`call:${record.id}`}>
      <div className="history-row">
        <div className="history-icon-wrap">
          <div className="history-icon">
            <span className="history-item-thumb-icon" data-aeon-part="mark" aria-hidden>
              {missed(record) ? <CallMissedIcon size={18} /> : <CallIcon size={18} />}
            </span>
          </div>
        </div>
        <div className="history-body">
          <strong className="history-title">{label}</strong>
          <span className="history-when" data-aeon-part="outcome">
            {missed(record) ? `Missed ${record.video ? 'video call' : 'call'}` : callOutcomeText(record)}
          </span>
        </div>
        <div className="history-amount-block call-activity-end">
          <span className="history-when">{timeOf(record.startedAt)}</span>
          {peer && record.peers.length === 1 ? (
            <button
              type="button"
              className="call-activity-back"
              data-aeon-part="call-back"
              aria-label={`Call ${label} back`}
              title="Call back"
              onClick={() => callEngine().call(peer)}
            >
              <CallIcon size={16} />
            </button>
          ) : null}
        </div>
      </div>
    </li>
  )
}
