import { useEffect, useState } from 'react'
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
  keyDeriverFor,
  loadImportedSources,
  parseImportSecret,
  planSweep,
  probeHandCashHandle,
  removeImportedSource,
  scanImportedSource,
  subscribeImportIntent,
  subscribeImportedSources,
  sweepImportedSource,
  takeImportIntent,
  updateImportedSource,
  type ImportedSource,
} from '../../wallet/import'
import { playWalletSound } from '../../wallet/soundService'
import { toastError, toastSuccess } from '../../wallet/toast'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { AsyncActionPrompt } from '../AsyncActionPrompt'
import { ImportSecretForm, type SecretFields } from './ImportSecretForm'
import { ImportSourceView, type SourceFace } from './ImportSourceView'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Settings → Import. Legacy wallets are stored and viewed here, apart from
 * the BRC-100 identity and the account switcher; value moves only on an
 * explicit, compatible-only sweep. Every face is `legacyImportMachine`.
 */
export function ImportPanel() {
  const [snapshot, send, actor] = useMachine(legacyImportMachine)
  const [sources, setSources] = useState<ImportedSource[]>([])
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

  // Key recovery opened from the migrate page waits until no scan, sweep or
  // half-typed secret would be interrupted.
  const takesIntent =
    snapshot.matches('list') || snapshot.matches('picking') || snapshot.matches({ source: 'viewing' })
  useEffect(() => {
    if (!takesIntent) return
    return subscribeImportIntent((requested) => {
      if (!requested) return
      const kind = takeImportIntent()
      if (!kind) return
      if (actor.getSnapshot().matches({ source: 'viewing' })) send({ type: 'BACK' })
      send({ type: 'PICK', kind })
    })
  }, [takesIntent, actor, send])

  const runScan = async (sourceId: string) => {
    try {
      await scanImportedSource({
        sourceId,
        shouldStop: stopRequested,
        onProgress: (p) =>
          send(
            p.phase === 'discover'
              ? {
                  type: 'PROGRESS',
                  message: `Checking ${p.walk} · ${p.checked.toLocaleString()} addresses · ${p.found} used`,
                  percent: null,
                }
              : {
                  type: 'PROGRESS',
                  message:
                    p.phase === 'history'
                      ? `Reading your HandCash history · ${p.done.toLocaleString()}/${p.total.toLocaleString()} transactions`
                      : `Reading holdings · ${p.done}/${p.total}`,
                  percent: p.total > 0 ? Math.round((p.done / p.total) * 100) : null,
                },
          ),
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
      if (kind === 'handcash' && fields.handle.trim()) {
        const handle = await probeHandCashHandle(fields.handle, keyDeriverFor(parsed.secret))
        await updateImportedSource(saved.id, { handle })
      }
      send({ type: 'SAVED', sourceId: saved.id })
      playWalletSound('soft')
      await runScan(saved.id)
    } catch (err) {
      send({ type: 'FAIL', error: errorText(err) })
      playWalletSound('error')
    }
  }

  const probe = async (handle: string) => {
    if (!source) return
    send({ type: 'PROBE_HANDLE' })
    try {
      const result = await probeHandCashHandle(handle, keyDeriverFor(source.secret))
      await updateImportedSource(source.id, { handle: result })
      send({ type: 'PROBED' })
    } catch (err) {
      send({ type: 'FAIL', error: errorText(err) })
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
        onProgress: (p) => send({ type: 'PROGRESS', message: p.message, percent: null }),
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

  const face = (['viewing', 'scanning', 'probing', 'reviewing', 'sweeping', 'confirmingRemove', 'removing'] as const).find(
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
                      onClick={() => send({ type: 'OPEN', sourceId: s.id })}
                    >
                      <span>
                        <ListRow.Label>{s.label}</ListRow.Label>
                        <ListRow.Description>
                          {IMPORT_SOURCE_LABELS[s.kind]}
                          {s.scan
                            ? ` · ${formatBsv(totals.cashSats)} BSV · ${totals.itemCount}${totals.itemCountCapped ? '+' : ''} items · ${totals.tokens.length} tokens`
                            : ' · not scanned'}
                        </ListRow.Description>
                      </span>
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
                  <span>
                    <ListRow.Label>{IMPORT_SOURCE_LABELS[kind]}</ListRow.Label>
                    <ListRow.Description>{IMPORT_SOURCE_HINTS[kind]}</ListRow.Description>
                  </span>
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
          onBack={() => send({ type: 'BACK' })}
          onRescan={() => {
            send({ type: 'RESCAN' })
            void runScan(source.id)
          }}
          onProbeHandle={(handle) => void probe(handle)}
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
