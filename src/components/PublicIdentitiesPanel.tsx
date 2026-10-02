import { copyText } from '../wallet/clipboard'
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { Button, Field } from '@aeon-ui/react'
import { Menu } from '@aeon-ui/ui'
import { publicIdentitiesMachine } from '../machines/publicIdentitiesMachine'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { getWalletRuntime, runtimeIsCurrent } from '../wallet/walletRuntime'
import {
  exportPublicIdentityBackup,
  importIssuerPrivateKey,
  listPublicIdentities,
  MAX_IDENTITY_BACKUP_BYTES,
  presentedPublicIdentityKey,
  presentPublicIdentity,
  publicIdentitiesGeneration,
  removePublicIdentity,
  restorePublicIdentityBackup,
  selectedPublicIdentityKey,
  selectPublicIdentity,
  subscribePublicIdentities,
  type PublicIdentityRow,
} from '../wallet/publicIdentities'
import {
  IDENTITY_DESCRIPTION_MAX,
  IDENTITY_NAME_MAX,
  issuerIdentityImageDataUrl,
} from '../wallet/issuerIdentity'
import { issuerIdentitiesGeneration, subscribeIssuerIdentities } from '../wallet/issuerIdentities'
import { encodeIdentityImage } from '../wallet/identityImage'
import {
  planIdentityPublish,
  publishIdentityPlan,
  syncHeldIssuerIdentities,
  upgradeIssuerIdentityProofs,
} from '../wallet/identityPublish'
import { exportIdentityCard } from '../wallet/identityCardShare'
import { toastSuccess } from '../wallet/toast'
import type { WalletProfile } from '../machines/appMachine'
import { AsyncActionPrompt } from './AsyncActionPrompt'
import { DeferredImage } from './DeferredImage'
import { BapIdenticon } from './BapIdenticon'
import { IdentityPublishReview, type IdentityReviewStage } from './IdentityPublishReview'

const REVIEW_STAGES: readonly IdentityReviewStage[] = ['quoting', 'reviewing', 'publishing', 'refused']

const PUBLISHED_TOAST = {
  publish: 'Identity published',
  update: 'Identity updated',
  rotate: 'Signing key rotated',
} as const

function downloadJson(value: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([value], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const shortKey = (key: string) => `${key.slice(0, 12)}…${key.slice(-8)}`

function ownerRuntime(profile: WalletProfile) {
  const runtime = getWalletRuntime()
  if (
    !runtime ||
    !runtimeIsCurrent(runtime) ||
    runtime.instance.identityKey !== profile.identityKey ||
    runtime.instance.chain !== profile.chain
  )
    throw new Error('Wallet changed; reopen Identity and retry.')
  return runtime
}

/** Account-keyed by the parent: switching wallets discards drafts and secret input. */
export function PublicIdentitiesPanel({ profile }: { profile: WalletProfile }) {
  const [snapshot, send] = useMachine(publicIdentitiesMachine, {
    input: {
      ports: {
        quote: async (request) => planIdentityPublish(ownerRuntime(profile), request),
        publish: async (request, plan) => {
          await publishIdentityPlan(ownerRuntime(profile), request, plan)
          toastSuccess(PUBLISHED_TOAST[plan.kind])
        },
      },
    },
  })
  const action = useAsyncAction<
    | 'image'
    | 'select'
    | 'remove'
    | 'import'
    | 'restore'
    | 'export'
    | 'copy'
    | 'present'
    | 'share'
  >()
  const privateKey = useRef<HTMLInputElement>(null)
  const backupFile = useRef<HTMLInputElement>(null)
  const imageFile = useRef<HTMLInputElement>(null)
  const prefix = useId()
  const runtime = getWalletRuntime()
  const generation = useSyncExternalStore(
    subscribePublicIdentities,
    publicIdentitiesGeneration,
  )
  const packages = useSyncExternalStore(
    subscribeIssuerIdentities,
    issuerIdentitiesGeneration,
  )
  const view = useMemo(() => {
    try {
      return {
        rows: listPublicIdentities(runtime),
        selected: selectedPublicIdentityKey(runtime),
        presented: presentedPublicIdentityKey(runtime),
        error: null,
      }
    } catch (error) {
      return {
        rows: [] as PublicIdentityRow[],
        selected: profile.identityKey,
        presented: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [generation, packages, profile.identityKey, runtime])
  const assertOwner = () => {
    if (ownerRuntime(profile) !== runtime) throw new Error('Wallet changed; reopen Identity and retry.')
  }
  useEffect(
    () => () => {
      action.reset()
    },
    [action.reset],
  )
  useEffect(() => {
    if (!runtime) return
    void syncHeldIssuerIdentities(runtime)
      .then(() => upgradeIssuerIdentityProofs(runtime))
      .catch((error) => console.warn('[identity-publish] maintenance skipped', error))
  }, [runtime])
  const close = () => {
    if (privateKey.current) privateKey.current.value = ''
    send({ type: 'CLOSE' })
  }
  const compose = (row: PublicIdentityRow) =>
    send({
      type: 'COMPOSE',
      identityKey: row.identityKey,
      ...(row.identity
        ? {
            fields: { name: row.identity.name, description: row.identity.description },
            ...(row.identity.image ? { image: row.identity.image } : {}),
          }
        : {}),
    })
  const importKey = () =>
    action.run('import', async () => {
      assertOwner()
      try {
        importIssuerPrivateKey(runtime!, privateKey.current?.value ?? '')
        close()
        toastSuccess('Signing key imported')
      } finally {
        if (privateKey.current) privateKey.current.value = ''
      }
    })
  const pickImage = (picked: File) =>
    action.run('image', async () => {
      send({ type: 'IMAGE', image: await encodeIdentityImage(picked) })
    })
  const present = (row: PublicIdentityRow | null) =>
    action.run(
      'present',
      async () => {
        assertOwner()
        presentPublicIdentity(runtime!, row?.identityKey ?? null)
        toastSuccess(row ? 'Identity shown to contacts' : 'Identity no longer shown')
      },
      row
        ? {
            confirm: {
              title: `Show ${row.identity?.name ?? 'this identity'} to contacts?`,
              body: 'Contacts you message or pay will see it linked to your handle. Copies they keep stay shared.',
              confirmLabel: 'Show to contacts',
            },
          }
        : undefined,
    )
  const shareCard = () =>
    action.run('share', async () => {
      assertOwner()
      downloadJson(await exportIdentityCard(runtime!), 'handcash-identity-card.json')
    })
  const restore = (picked: File) =>
    action.run('restore', async () => {
      assertOwner()
      if (picked.size > MAX_IDENTITY_BACKUP_BYTES)
        throw new Error('Backup file is too large (4 MB maximum).')
      const raw: unknown = JSON.parse(await picked.text())
      assertOwner()
      restorePublicIdentityBackup(runtime!, raw)
      toastSuccess('Identities restored')
    })
  const review = REVIEW_STAGES.find((stage) => snapshot.matches(stage)) ?? null
  const { request } = snapshot.context
  const rotating = !!review && request?.kind === 'rotate'
  const busy = action.busy || snapshot.hasTag('review')
  const browsing = snapshot.matches('browsing') || rotating
  const importing = snapshot.matches('importing')
  const draft = snapshot.context
  const exportBackup = () =>
    action.run('export', async () => {
      assertOwner()
      downloadJson(exportPublicIdentityBackup(runtime!), 'handcash-issuer-backup.json')
    })
  const copyKey = (row: PublicIdentityRow) =>
    action.run('copy', async () => {
      assertOwner()
      await copyText(row.identityKey, { label: 'issuer identity key' })
    })
  const useAsIssuer = (row: PublicIdentityRow) =>
    action.run('select', async () => {
      assertOwner()
      selectPublicIdentity(runtime!, row.identityKey)
    })
  const removeSigner = (row: PublicIdentityRow) =>
    action.run(
      'remove',
      async () => {
        assertOwner()
        removePublicIdentity(runtime!, row.identityKey)
      },
      {
        confirm: {
          title: 'Remove imported signer?',
          body: 'Its signing key leaves this wallet. Back up identities first.',
          confirmLabel: 'Remove signer',
          danger: true,
        },
      },
    )
  return (
    <section
      className="identity-card identity-compose"
      data-aeon-scope="public-identities"
      data-aeon-state={stateToAttr(snapshot.value)}
      aria-label="Public identities"
    >
      <div data-aeon-part="actions" data-aeon-state={action.stateAttr}>
        {browsing ? (
          <>
            <div className="public-identities-head" data-aeon-part="head">
              <h3 className="identity-compose-title">Public identities</h3>
              <Menu.Root>
                <Menu.Trigger
                  className="btn btn-ghost public-identity-more"
                  disabled={busy}
                  aria-label="Identity backup and import"
                >
                  More
                </Menu.Trigger>
                <Menu.Positioner placement="bottom-end">
                  <Menu.Content>
                    <Menu.Item disabled={!!view.error} onClick={() => void exportBackup()}>
                      Back up identities
                    </Menu.Item>
                    <Menu.Item onClick={() => backupFile.current?.click()}>
                      Restore backup
                    </Menu.Item>
                    <Menu.Separator />
                    <Menu.Item disabled={!!view.error} onClick={() => send({ type: 'IMPORT_KEY' })}>
                      Import signing key
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Menu.Root>
            </div>
            <input
              ref={backupFile}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const picked = event.target.files?.[0]
                event.target.value = ''
                if (picked) void restore(picked)
              }}
            />
            <ul className="identity-list" data-aeon-part="records">
              {view.rows.map((row) => {
                const live = !!row.identity && !row.identity.revoked
                const issuer = row.identityKey === view.selected
                const shown = row.identityKey === view.presented
                const confirming =
                  live && row.identity!.keys.at(-1)!.minedHeight === undefined
                return (
                  <li
                    key={row.identityKey}
                    data-aeon-part="record"
                    data-aeon-state={
                      row.identity?.revoked ? 'revoked' : row.identity ? 'published' : 'draft'
                    }
                  >
                    <span className="public-identity-avatar" aria-hidden>
                      {row.identity?.image ? (
                        <DeferredImage
                          src={issuerIdentityImageDataUrl(row.identity.image)}
                          alt=""
                          width={44}
                          height={44}
                          fallback={<BapIdenticon bapId={row.bapId} size={44} />}
                        />
                      ) : (
                        <BapIdenticon bapId={row.bapId} size={44} />
                      )}
                    </span>
                    <div className="public-identity-main">
                      <strong className="public-identity-name">
                        {row.identity?.name ?? 'Unpublished'}
                      </strong>
                      <span className="public-identity-bap mono" title={row.bapId}>
                        {shortKey(row.bapId)}
                      </span>
                      {row.identity?.description ? (
                        <p className="public-identity-bio">{row.identity.description}</p>
                      ) : null}
                      <span className="public-identity-chips" data-aeon-part="chips">
                        {issuer ? <span data-aeon-part="chip" data-aeon-state="issuer">Issuer</span> : null}
                        {shown ? <span data-aeon-part="chip" data-aeon-state="shown">Shown to contacts</span> : null}
                        {row.identity?.revoked ? (
                          <span data-aeon-part="chip" data-aeon-state="revoked">Revoked</span>
                        ) : null}
                        {confirming ? (
                          <span data-aeon-part="chip" data-aeon-state="pending">Confirming</span>
                        ) : null}
                        {row.signer === 'imported' ? (
                          <span data-aeon-part="chip" data-aeon-state="imported">Imported key</span>
                        ) : null}
                      </span>
                    </div>
                    <div className="public-identity-actions">
                      <Button.Root
                        className={row.identity ? 'btn btn-ghost' : 'btn btn-primary'}
                        disabled={busy || !!row.identity?.revoked}
                        onClick={() => compose(row)}
                      >
                        {row.identity ? 'Edit' : 'Publish'}
                      </Button.Root>
                      <Menu.Root>
                        <Menu.Trigger
                          className="btn btn-ghost public-identity-more"
                          disabled={busy}
                          aria-label={`More for ${row.identity?.name ?? 'this identity'}`}
                        >
                          ⋯
                        </Menu.Trigger>
                        <Menu.Positioner placement="bottom-end">
                          <Menu.Content>
                            {!issuer ? (
                              <Menu.Item onClick={() => void useAsIssuer(row)}>Use as issuer</Menu.Item>
                            ) : null}
                            {live && !shown ? (
                              <Menu.Item onClick={() => void present(row)}>Show to contacts</Menu.Item>
                            ) : null}
                            {live && shown ? (
                              <>
                                <Menu.Item onClick={() => void shareCard()}>Share identity card</Menu.Item>
                                <Menu.Item onClick={() => void present(null)}>Stop showing</Menu.Item>
                              </>
                            ) : null}
                            {live ? (
                              <Menu.Item
                                disabled={!row.identity!.image}
                                onClick={() => send({ type: 'ROTATE', identityKey: row.identityKey })}
                              >
                                Rotate signing key
                              </Menu.Item>
                            ) : null}
                            <Menu.Item onClick={() => void copyKey(row)}>Copy identity key</Menu.Item>
                            {row.signer === 'imported' ? (
                              <>
                                <Menu.Separator />
                                <Menu.Item onClick={() => void removeSigner(row)}>Remove signer</Menu.Item>
                              </>
                            ) : null}
                          </Menu.Content>
                        </Menu.Positioner>
                      </Menu.Root>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        ) : importing ? (
          <>
            <h3 className="identity-compose-title">Import signing key</h3>
            <Field.Root className="identity-compose-field">
              <Field.Label htmlFor={`${prefix}-key`}>Private key</Field.Label>
              <Field.Control
                id={`${prefix}-key`}
                ref={privateKey}
                type="password"
                placeholder="Hex or WIF"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </Field.Root>
            <div className="actions">
              <Button.Root
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void importKey()}
              >
                {action.running('import') ? 'Importing…' : 'Import'}
              </Button.Root>
              <Button.Root variant="ghost" className="btn btn-ghost" disabled={busy} onClick={close}>
                Cancel
              </Button.Root>
            </div>
          </>
        ) : (
          <>
            <h3 className="identity-compose-title">
              {view.rows.find((row) => row.identityKey === draft.identityKey)?.identity
                ? 'Edit identity'
                : 'Publish identity'}
            </h3>
            <div className="public-identity-compose" data-aeon-part="compose">
              <button
                type="button"
                className="public-identity-image-pick"
                data-aeon-part="image"
                data-aeon-state={
                  action.running('image') ? 'preparing' : draft.image ? 'set' : 'empty'
                }
                disabled={busy}
                aria-label={draft.image ? 'Change image' : 'Choose image'}
                onClick={() => imageFile.current?.click()}
              >
                {draft.image ? (
                  <DeferredImage
                    src={issuerIdentityImageDataUrl(draft.image)}
                    alt=""
                    width={88}
                    height={88}
                    fallback={<span aria-hidden>◈</span>}
                  />
                ) : (
                  <span aria-hidden>{action.running('image') ? '…' : '+'}</span>
                )}
                <span className="public-identity-image-label">
                  {action.running('image') ? 'Preparing…' : draft.image ? 'Change' : 'Image'}
                </span>
              </button>
              <input
                ref={imageFile}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const picked = event.target.files?.[0]
                  event.target.value = ''
                  if (picked) void pickImage(picked)
                }}
              />
              <div className="public-identity-compose-fields">
                <Field.Root className="identity-compose-field">
                  <Field.Label htmlFor={`${prefix}-name`}>Name</Field.Label>
                  <Field.Control
                    id={`${prefix}-name`}
                    value={draft.fields.name}
                    maxLength={IDENTITY_NAME_MAX}
                    disabled={busy}
                    onChange={(event) =>
                      send({ type: 'FIELD', field: 'name', value: event.target.value })
                    }
                  />
                </Field.Root>
                <Field.Root className="identity-compose-field">
                  <Field.Label htmlFor={`${prefix}-bio`}>Bio</Field.Label>
                  <Field.Control
                    id={`${prefix}-bio`}
                    value={draft.fields.description}
                    maxLength={IDENTITY_DESCRIPTION_MAX}
                    placeholder="Optional"
                    disabled={busy}
                    onChange={(event) =>
                      send({ type: 'FIELD', field: 'description', value: event.target.value })
                    }
                  />
                </Field.Root>
              </div>
            </div>
            <div className="actions">
              <Button.Root
                className="btn btn-primary"
                disabled={busy || !draft.image || !draft.fields.name.trim()}
                onClick={() => send({ type: 'REVIEW' })}
              >
                {review ? 'Publishing…' : 'Review'}
              </Button.Root>
              <Button.Root variant="ghost" className="btn btn-ghost" disabled={busy} onClick={close}>
                Cancel
              </Button.Root>
            </div>
          </>
        )}
        {view.error || action.error ? (
          <p role="alert" className="identity-compose-status">
            {view.error ?? action.error}
          </p>
        ) : null}
      </div>
      <AsyncActionPrompt action={action} />
      <IdentityPublishReview
        stage={review}
        rotation={request?.kind === 'rotate'}
        plan={snapshot.context.plan}
        error={snapshot.context.error}
        onApprove={() => send({ type: 'APPROVE' })}
        onCancel={() => send({ type: 'CANCEL' })}
        onDismiss={() => send({ type: 'DISMISS' })}
      />
    </section>
  )
}
