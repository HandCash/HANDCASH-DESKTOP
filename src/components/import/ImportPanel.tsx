import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { ListRow, StatusBanner } from '@aeon-ui/react'
import { legacyImportMachine } from '../../machines/legacyImportMachine'
import { formatBsv } from '../../wallet/session'
import {
  clearPhraseItemMigrateCursor,
  peekPhraseItemMigrateCursor,
  subscribePhraseItemMigrateCursor,
  type PhraseItemMigrateCursor,
} from '../../wallet/phraseSweep'
import {
  IMPORT_SOURCE_HINTS,
  IMPORT_SOURCE_KINDS,
  IMPORT_SOURCE_LABELS,
  addImportedSource,
  loadImportedSources,
  parseImportSecret,
  planSweep,
  recoveryHintsGeneration,
  recoveryHintsOffer,
  removeImportedSource,
  scanImportedSource,
  subscribeImportIntent,
  subscribeImportedSources,
  subscribeRecoveryHints,
  sweepImportedSource,
  takeImportIntent,
  type ImportedSource,
  type ScanProgress,
  type SweepProgress,
} from '../../wallet/import'
import { playWalletSound } from '../../wallet/soundService'
import { toastError, toastSuccess } from '../../wallet/toast'
import { MIGRATE_HINTS_URL } from '../../wallet/walletConfig'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { AsyncActionPrompt } from '../AsyncActionPrompt'
import { ImportSecretForm, type SecretFields } from './ImportSecretForm'
import { ImportSourceView, type SourceFace } from './ImportSourceView'
import { ImportSourceIcon } from './importSourceIcons'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What a key-recovery request from the migrate page does in each state:
 * `route` opens a new HandCash entry, `absorb` keeps the screen (the open
 * HandCash entry or source will use any history that came with it), `hints`
 * feeds a source waiting for it, and `null` waits until no scan, sweep or
 * half-typed secret would be interrupted.
 */
type IntentRoute = 'route' | 'absorb' | 'hints' | null

/**
 * Settings → Import. Legacy wallets are stored and viewed here, apart from
 * the BRC-100 identity and the account switcher; value moves only on an
 * explicit, compatible-only sweep. Every face is `legacyImportMachine`.
 */

function of(done: number, total: number): number | null {
  return total > 0 ? Math.round((done / total) * 100) : null
}

/** The batch in flight fills the bar on a long sweep; null runs it indeterminate. */
function sweepPercent(p: SweepProgress): number | null {
  if (p.batch) return of(p.batch.done, p.batch.total)
  return p.total != null ? of(p.done, p.total) : null
}

function scanProgressMessage(p: ScanProgress): { message: string; percent: number | null } {
  switch (p.phase) {
    case 'utxoSet':
      return { message: `Fetching your coins from HandCash · ${p.fetched.toLocaleString()}`, percent: null }
    case 'discover':
      return { message: `Checking ${p.walk} · ${p.checked.toLocaleString()} addresses · ${p.found} used`, percent: null }
    case 'cash':
      return { message: `Checking your coins on chain · ${p.done.toLocaleString()}/${p.total.toLocaleString()}`, percent: of(p.done, p.total) }
    case 'items':
      return { message: `Checking your items on chain · ${p.done.toLocaleString()}/${p.total.toLocaleString()}`, percent: of(p.done, p.total) }
    case 'history':
      return { message: `Finding your coins in recent history · ${p.done.toLocaleString()} transactions read`, percent: of(p.done, p.total) }
    case 'holdings':
      return { message: `Reading holdings · ${p.done}/${p.total}`, percent: of(p.done, p.total) }
  }
}

export function ImportPanel() {
  const [snapshot, send, actor] = useMachine(legacyImportMachine)
  const [sources, setSources] = useState<ImportedSource[]>([])
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources
  const [pending, setPending] = useState<PhraseItemMigrateCursor | null>(() =>
    peekPhraseItemMigrateCursor(),
  )
  const forget = useAsyncAction<'forget'>()
  const { context } = snapshot
  const source = sources.find((s) => s.id === context.sourceId) ?? null
  const stopRequested = () => actor.getSnapshot().context.stopRequested

  useEffect(() => {
    let live = true
    loadImportedSources()
      .then((list) => {
        if (!live) return
        setSources(list)
        send({ type: 'LOADED' })
      })
      .catch((err) => live && send({ type: 'FAIL', error: errorText(err) }))
    const offSources = subscribeImportedSources(setSources)
    const offCursor = subscribePhraseItemMigrateCursor(setPending)
    return () => {
      live = false
      offSources()
      offCursor()
    }
  }, [send])

  const hintsGeneration = useSyncExternalStore(subscribeRecoveryHints, recoveryHintsGeneration)
  const hintsOffer = useMemo(
    () => (source ? recoveryHintsOffer(source) : null),
    [source, hintsGeneration],
  )
  const platform = window.handcash?.platform
  // The migrate page reaches Desktop's bridge and the Android app's :3321 bridge.
  const canAskHints = platform != null && platform !== 'web' && platform !== 'ios'

  const handcashOpen = source?.kind === 'handcash' || context.kind === 'handcash'
  const intentRoute: IntentRoute = snapshot.matches({ source: 'awaitingHints' })
    ? 'hints'
    : (snapshot.matches('entering') || snapshot.matches('saving') || snapshot.matches({ source: 'viewing' })) &&
        handcashOpen
      ? 'absorb'
      : snapshot.matches('list') || snapshot.matches('picking') || snapshot.matches({ source: 'viewing' })
        ? 'route'
        : null
  useEffect(() => {
    if (!intentRoute) return
    return subscribeImportIntent((requested) => {
      if (!requested) return
      const kind = takeImportIntent()
      if (!kind) return
      if (intentRoute === 'absorb') return
      if (intentRoute === 'hints') {
        const waiting = sourcesRef.current.find((s) => s.id === actor.getSnapshot().context.sourceId)
        const offer = waiting ? recoveryHintsOffer(waiting) : null
        if (offer?.kind === 'ready' && waiting) {
          console.info(`[import] HandCash history arrived txids=${offer.txids} — scanning`)
          send({ type: 'HINTS' })
          void runScan(waiting.id)
        } else if (offer?.kind === 'mismatch') {
          console.info(`[import] HandCash history is for $${offer.hinted}, these keys prove $${offer.saved}`)
          send({
            type: 'FAIL',
            error: `You signed in to HandCash as $${offer.hinted}, but these keys prove $${offer.saved}. Sign in as $${offer.saved} and try again.`,
          })
        } else {
          console.info('[import] key recovery opened without HandCash history — still waiting for sign-in')
        }
        return
      }
      if (actor.getSnapshot().matches({ source: 'viewing' })) send({ type: 'BACK' })
      send({ type: 'PICK', kind })
    })
  }, [intentRoute, actor, send])

  const askHints = () => {
    send({ type: 'ASK_HINTS' })
    console.info('[import] opened /migrate for HandCash history')
    void window.handcash?.openExternal?.(MIGRATE_HINTS_URL)
  }

  const runScan = async (sourceId: string) => {
    try {
      await scanImportedSource({
        sourceId,
        shouldStop: stopRequested,
        onProgress: (p) => send({ type: 'PROGRESS', ...scanProgressMessage(p) }),
      })
      send({ type: 'SCANNED' })
    } catch (err) {
      send({ type: 'FAIL', error: errorText(err) })
      playWalletSound('error')
    }
  }

  const submit = async (fields: SecretFields) => {
    const kind = context.kind
    if (!kind) return
    const parsed = parseImportSecret(kind, fields)
    if (!parsed.ok) {
      send({ type: 'FAIL', error: parsed.error })
      return
    }
    send({ type: 'SUBMIT' })
    try {
      const { source: saved, existing } = await addImportedSource(parsed.secret, fields.label)
      if (existing) toastSuccess('Already saved', `${saved.label} holds these keys.`)
      send({ type: 'SAVED', sourceId: saved.id })
      playWalletSound('soft')
      await runScan(saved.id)
    } catch (err) {
      send({ type: 'FAIL', error: errorText(err) })
      playWalletSound('error')
    }
  }

  const sweep = async () => {
    if (!source) return
    send({ type: 'CONFIRM' })
    playWalletSound('soft')
    try {
      const summary = await sweepImportedSource({
        sourceId: source.id,
        shouldStop: stopRequested,
        onProgress: (p) => send({ type: 'PROGRESS', message: p.message, percent: sweepPercent(p) }),
      })
      send({ type: 'SWEPT' })
      playWalletSound('success')
      const parts = [
        summary.cashSats > 0 ? `${formatBsv(summary.cashSats)} BSV` : null,
        summary.items > 0 ? `${summary.items.toLocaleString()} items` : null,
        summary.tokens.length > 0 ? summary.tokens.map((t) => t.sym).join(', ') : null,
      ].filter(Boolean)
      toastSuccess('Sweep finished', parts.length > 0 ? `Moved ${parts.join(' · ')}` : 'Nothing compatible moved.')
    } catch (err) {
      send({ type: 'FAIL', error: errorText(err) })
      playWalletSound('error')
      toastError('Sweep stopped', errorText(err))
    }
  }

  const remove = async () => {
    if (!source) return
    send({ type: 'CONFIRM' })
    try {
      await removeImportedSource(source.id)
      send({ type: 'REMOVED' })
    } catch (err) {
      send({ type: 'FAIL', error: errorText(err) })
    }
  }

  const forgetPending = async () => {
    const outcome = await forget.run('forget', async () => clearPhraseItemMigrateCursor(), {
      confirm: {
        title: 'Forget this paused import?',
        body: 'Collectables already moved stay in this wallet. Only the saved resume position is removed.',
        confirmLabel: 'Forget',
        danger: true,
      },
    })
    if (outcome.ok) toastSuccess('Paused import forgotten', 'Moved collectables were not changed.')
  }

  const face = (['viewing', 'awaitingHints', 'scanning', 'browsing', 'reviewing', 'sweeping', 'confirmingRemove', 'removing'] as const).find(
    (state) => snapshot.matches({ source: state }),
  ) as SourceFace | undefined

  return (
    <div
      className="nav-section-body settings-detail settings-scroll"
      data-aeon-scope="legacy-import"
      data-aeon-state={stateToAttr(snapshot.value)}
    >
      {snapshot.matches('loading') ? <p className="settings-hint">Opening saved wallets…</p> : null}

      {snapshot.matches('list') ? (
        <>
          <p className="settings-hint">
            Keep older wallets here — HandCash, Twetch, Yours, any phrase or key. They stay separate
            from this wallet’s identity; sweep compatible assets in when you choose.
          </p>
          {pending ? (
            <StatusBanner.Root tone="warning" status="paused-items">
              <StatusBanner.Copy>
                <StatusBanner.Title>Paused collectable import</StatusBanner.Title>
                <StatusBanner.Body>
                  {Math.max(0, pending.moved).toLocaleString()} moved,{' '}
                  {Math.max(0, pending.offset).toLocaleString()} checked from{' '}
                  <span className="mono">{pending.sourceAddress}</span>. Open the wallet it came
                  from and sweep again to resume.
                </StatusBanner.Body>
              </StatusBanner.Copy>
              <div className="actions" data-aeon-state={forget.stateAttr}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={forget.busy}
                  onClick={() => void forgetPending()}
                >
                  Forget paused import
                </button>
              </div>
            </StatusBanner.Root>
          ) : null}
          {sources.length > 0 ? (
            <ul data-aeon-part="sources">
              {sources.map((s) => {
                const totals = planSweep(s).totals
                return (
                  <li key={s.id}>
                    <ListRow.Root
                      as="button"
                      type="button"
                      className="settings-row"
                      data-aeon-state={s.kind}
                      onClick={() => send({ type: 'OPEN', sourceId: s.id })}
                    >
                      <ListRow.Leading aria-hidden>
                        <ImportSourceIcon kind={s.kind} />
                      </ListRow.Leading>
                      <ListRow.Label>{s.label}</ListRow.Label>
                      <ListRow.Description>
                        {IMPORT_SOURCE_LABELS[s.kind]}
                        {s.scan
                          ? ` · ${formatBsv(totals.cashSats)} BSV · ${totals.itemCount}${totals.itemCountCapped ? '+' : ''} items · ${totals.tokens.length} tokens`
                          : ' · not scanned'}
                      </ListRow.Description>
                    </ListRow.Root>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="settings-row-desc">No saved wallets yet.</p>
          )}
          {context.error ? (
            <p className="error" role="alert">
              {context.error}
            </p>
          ) : null}
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => send({ type: 'ADD' })}>
              Add a wallet
            </button>
          </div>
        </>
      ) : null}

      {snapshot.matches('picking') ? (
        <>
          <ul data-aeon-part="kinds">
            {IMPORT_SOURCE_KINDS.map((kind) => (
              <li key={kind}>
                <ListRow.Root
                  as="button"
                  type="button"
                  className="settings-row"
                  data-aeon-state={kind}
                  onClick={() => send({ type: 'PICK', kind })}
                >
                  <ListRow.Leading aria-hidden>
                    <ImportSourceIcon kind={kind} />
                  </ListRow.Leading>
                  <ListRow.Label>{IMPORT_SOURCE_LABELS[kind]}</ListRow.Label>
                  <ListRow.Description>{IMPORT_SOURCE_HINTS[kind]}</ListRow.Description>
                </ListRow.Root>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
              Back
            </button>
          </div>
        </>
      ) : null}

      {(snapshot.matches('entering') || snapshot.matches('saving')) && context.kind ? (
        <ImportSecretForm
          kind={context.kind}
          saving={snapshot.matches('saving')}
          error={context.error}
          onSubmit={(fields) => void submit(fields)}
          onBack={() => send({ type: 'BACK' })}
        />
      ) : null}

      {face && source ? (
        <ImportSourceView
          source={source}
          face={face}
          progress={context.progress}
          percent={context.percent}
          error={context.error}
          hintsOffer={canAskHints ? hintsOffer : null}
          onAskHints={askHints}
          onBack={() => send({ type: 'BACK' })}
          onRescan={() => {
            send({ type: 'RESCAN' })
            void runScan(source.id)
          }}
          onBrowse={() => send({ type: 'BROWSE' })}
          onReview={() => send({ type: 'REVIEW' })}
          onConfirm={() => void (face === 'reviewing' ? sweep() : remove())}
          onCancel={() => send({ type: 'BACK' })}
          onRemove={() => send({ type: 'REMOVE' })}
          onPause={() => send({ type: 'PAUSE' })}
        />
      ) : null}

      <AsyncActionPrompt action={forget} />
    </div>
  )
}
