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
  importIssuerPrivateKey,
  listPublicIdentities,
  MAX_IDENTITY_BACKUP_BYTES,
  presentedPublicIdentityKey,
  presentPublicIdentity,
  publicIdentitiesGeneration,
  removePublicIdentity,
  restorePublicIdentityBackup,
  saveIdentityProfile,
  saveIssuerIdentityBackup,
  selectedPublicIdentityKey,
  selectPublicIdentity,
  setSignsIssuance,
  signsIssuance,
  subscribePublicIdentities,
  type PublicIdentityRow,
} from '../wallet/publicIdentities'
import {
  IDENTITY_DESCRIPTION_MAX,
  IDENTITY_NAME_MAX,
  issuerIdentityImageDataUrl,
} from '../wallet/issuerIdentity'
import { identityProfilesGeneration, subscribeIdentityProfiles } from '../wallet/identityProfiles'
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
import { ProfileIdenticon } from './ProfileIdenticon'
import { IdentityPublishReview, type IdentityReviewStage } from './IdentityPublishReview'

const REVIEW_STAGES: readonly IdentityReviewStage[] = ['quoting', 'reviewing', 'publishing', 'refused']

const PUBLISHED_TOAST = {
  publish: 'Profile published to BAP',
  update: 'BAP profile updated',
  rotate: 'BAP signing key rotated',
  link: 'BAP profile linked to your identity key',
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
        save: async (identityKey, fields, image) => {
          await saveIdentityProfile(ownerRuntime(profile), identityKey, fields, image)
          toastSuccess('Profile saved')
        },
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
    | 'signing'
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
  const profiles = useSyncExternalStore(
    subscribeIdentityProfiles,
    identityProfilesGeneration,
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
        signs: signsIssuance(runtime),
        error: null,
      }
    } catch (error) {
      return {
        rows: [] as PublicIdentityRow[],
        selected: profile.identityKey,
        presented: null,
        signs: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [generation, profiles, packages, profile.identityKey, runtime])
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
      ...(row.profile
        ? {
            fields: { name: row.profile.name, description: row.profile.description },
            ...(row.profile.image ? { image: row.profile.image } : {}),
          }
        : {}),
    })
  const publishBap = (row: PublicIdentityRow) => {
    if (!row.profile?.image) return
    send({
      type: 'PUBLISH_BAP',
      identityKey: row.identityKey,
      fields: { name: row.profile.name, description: row.profile.description },
      image: row.profile.image,
    })
  }
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
  const present = (row: PublicIdentityRow) =>
    action.run('present', async () => {
      assertOwner()
      presentPublicIdentity(runtime!, row.identityKey)
      toastSuccess(`${row.profile?.name ?? 'Profile'} shared with contacts`)
    })
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
      await restorePublicIdentityBackup(runtime!, raw)
      toastSuccess('Identities restored')
    })
  const review = REVIEW_STAGES.find((stage) => snapshot.matches(stage)) ?? null
  const { request } = snapshot.context
  const saving = snapshot.matches('saving')
  const busy = action.busy || snapshot.hasTag('busy')
  const browsing = snapshot.matches('browsing') || !!review
  const importing = snapshot.matches('importing')
  const draft = snapshot.context
  const exportBackup = () =>
    action.run('export', async () => {
      assertOwner()
      const saved = await saveIssuerIdentityBackup(runtime!)
      if (saved.saved) toastSuccess('Issuer backup saved', saved.path)
    })
  const copyKey = (row: PublicIdentityRow) =>
    action.run('copy', async () => {
      assertOwner()
      await copyText(row.identityKey, { label: 'issuer wallet key' })
    })
  const toggleSigning = () =>
    action.run('signing', async () => {
      assertOwner()
      setSignsIssuance(runtime!, !view.signs)
      toastSuccess(view.signs ? 'New mints will be unsigned' : 'New mints are signed by your identity key')
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
                    <Menu.Separator />
                    <Menu.Item disabled={!!view.error} onClick={() => void toggleSigning()}>
                      {view.signs ? 'Issue new mints unsigned' : 'Sign new mints'}
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
                const bap = row.identity && !row.identity.revoked ? row.identity : null
                const own = row.profile?.source === 'identity-key'
                const issuer = row.identityKey === view.selected
                const shown = row.identityKey === view.presented
                const confirming = !!bap && bap.keys.at(-1)!.minedHeight === undefined
                const unlinked = !!bap && !bap.links.some((link) => link.identityKey === row.identityKey)
                const profileId = row.profile?.id ?? row.identityKey
                return (
                  <li
                    key={row.identityKey}
                    data-aeon-part="record"
                    data-aeon-state={own ? 'profile' : row.profile ? 'bap' : row.identity?.revoked ? 'revoked' : 'draft'}
                  >
                    <span className="public-identity-avatar" aria-hidden>
                      {row.profile?.image ? (
                        <DeferredImage
                          src={issuerIdentityImageDataUrl(row.profile.image)}
                          alt=""
                          width={44}
                          height={44}
                          fallback={<ProfileIdenticon id={profileId} size={44} />}
                        />
                      ) : (
                        <ProfileIdenticon id={profileId} size={44} />
                      )}
                    </span>
                    <div className="public-identity-main">
                      <strong className="public-identity-name">
                        {row.profile?.name ?? 'No profile'}
                      </strong>
                      <span className="public-identity-bap mono" title={profileId}>
                        {shortKey(profileId)}
                      </span>
                      {row.profile?.description ? (
                        <p className="public-identity-bio">{row.profile.description}</p>
                      ) : null}
                      <span className="public-identity-chips" data-aeon-part="chips">
                        {issuer ? (
                          <span data-aeon-part="chip" data-aeon-state={view.signs ? 'issuer' : 'unsigned'}>
                            {view.signs ? 'Issuer' : 'Mints unsigned'}
                          </span>
                        ) : null}
                        {shown ? <span data-aeon-part="chip" data-aeon-state="shown">Shared with contacts</span> : null}
                        {bap && own ? <span data-aeon-part="chip" data-aeon-state="bap">On BAP</span> : null}
                        {row.identity?.revoked ? (
                          <span data-aeon-part="chip" data-aeon-state="revoked">BAP revoked</span>
                        ) : null}
                        {confirming ? (
                          <span data-aeon-part="chip" data-aeon-state="pending">BAP confirming</span>
                        ) : null}
                        {unlinked ? (
                          <span data-aeon-part="chip" data-aeon-state="unlinked">BAP not linked</span>
                        ) : null}
                        {row.signer === 'imported' ? (
                          <span data-aeon-part="chip" data-aeon-state="imported">Imported key</span>
                        ) : null}
                      </span>
                    </div>
                    <div className="public-identity-actions">
                      <Button.Root
                        className={own ? 'btn btn-ghost' : 'btn btn-primary'}
                        disabled={busy}
                        onClick={() => compose(row)}
                      >
                        {own ? 'Edit' : 'Add profile'}
                      </Button.Root>
                      <Menu.Root>
                        <Menu.Trigger
                          className="btn btn-ghost public-identity-more"
                          disabled={busy}
                          aria-label={`More for ${row.profile?.name ?? 'this identity'}`}
                        >
                          ⋯
                        </Menu.Trigger>
                        <Menu.Positioner placement="bottom-end">
                          <Menu.Content>
                            {!issuer ? (
                              <Menu.Item onClick={() => void useAsIssuer(row)}>Use as issuer</Menu.Item>
                            ) : null}
                            {row.profile && !shown ? (
                              <Menu.Item onClick={() => void present(row)}>Share this one instead</Menu.Item>
                            ) : null}
                            {row.profile && shown ? (
                              <Menu.Item onClick={() => void shareCard()}>Share identity card</Menu.Item>
                            ) : null}
                            {own && !row.identity?.revoked ? (
                              <>
                                <Menu.Separator />
                                <Menu.Item disabled={!row.profile!.image} onClick={() => publishBap(row)}>
                                  {bap ? 'Update BAP profile' : 'Publish to BAP'}
                                </Menu.Item>
                              </>
                            ) : null}
                            {unlinked ? (
                              <Menu.Item onClick={() => send({ type: 'LINK', identityKey: row.identityKey })}>
                                Link BAP profile to identity key
                              </Menu.Item>
                            ) : null}
                            {bap ? (
                              <Menu.Item
                                disabled={!bap.image}
                                onClick={() => send({ type: 'ROTATE', identityKey: row.identityKey })}
                              >
                                Rotate BAP signing key
                              </Menu.Item>
                            ) : null}
                            <Menu.Item onClick={() => void copyKey(row)}>Copy wallet key</Menu.Item>
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
              {view.rows.find((row) => row.identityKey === draft.identityKey)?.profile?.source === 'identity-key'
                ? 'Edit profile'
                : 'Add profile'}
            </h3>
            <p className="identity-note">
              Signed by this identity key and kept on this device; contacts get it with your identity card. No
              transaction, no fee.
            </p>
            <div className="public-identity-compose" data-aeon-part="compose">
              <div className="public-identity-image-col">
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
                {draft.image ? (
                  <Button.Root
                    variant="ghost"
                    className="btn btn-ghost public-identity-image-clear"
                    disabled={busy}
                    onClick={() => send({ type: 'CLEAR_IMAGE' })}
                  >
                    Remove
                  </Button.Root>
                ) : null}
              </div>
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
                disabled={busy || !draft.fields.name.trim()}
                onClick={() => send({ type: 'SAVE' })}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button.Root>
              <Button.Root variant="ghost" className="btn btn-ghost" disabled={busy} onClick={close}>
                Cancel
              </Button.Root>
            </div>
          </>
        )}
        {view.error || action.error || (!review && snapshot.context.error) ? (
          <p role="alert" className="identity-compose-status">
            {view.error ?? action.error ?? snapshot.context.error}
          </p>
        ) : null}
      </div>
      <AsyncActionPrompt action={action} />
      <IdentityPublishReview
        stage={review}
        pending={request ? (request.kind === 'profile' ? 'publish' : request.kind) : null}
        plan={snapshot.context.plan}
        error={snapshot.context.error}
        onApprove={() => send({ type: 'APPROVE' })}
        onCancel={() => send({ type: 'CANCEL' })}
        onDismiss={() => send({ type: 'DISMISS' })}
      />
    </section>
  )
}
