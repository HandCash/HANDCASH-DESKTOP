import { copyText } from '../wallet/clipboard'
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { Button, Field } from '@aeon-ui/react'
import { publicIdentitiesMachine } from '../machines/publicIdentitiesMachine'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { getWalletRuntime, runtimeIsCurrent } from '../wallet/walletRuntime'
import {
  exportPublicIdentityBackup,
  importIssuerPrivateKey,
  listPublicIdentities,
  MAX_IDENTITY_BACKUP_BYTES,
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
  publishIssuerIdentity,
  rotateIssuerSigningKey,
  syncHeldIssuerIdentities,
  upgradeIssuerIdentityProofs,
} from '../wallet/identityPublish'
import { toastSuccess } from '../wallet/toast'
import type { WalletProfile } from '../machines/appMachine'
import { AsyncActionPrompt } from './AsyncActionPrompt'
import { DeferredImage } from './DeferredImage'

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

/** Account-keyed by the parent: switching wallets discards drafts and secret input. */
export function PublicIdentitiesPanel({ profile }: { profile: WalletProfile }) {
  const [snapshot, send] = useMachine(publicIdentitiesMachine)
  const action = useAsyncAction<
    'publish' | 'rotate' | 'image' | 'select' | 'remove' | 'import' | 'restore' | 'export' | 'copy'
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
        error: null,
      }
    } catch (error) {
      return {
        rows: [] as PublicIdentityRow[],
        selected: profile.identityKey,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [generation, packages, profile.identityKey, runtime])
  const assertOwner = () => {
    if (
      !runtime ||
      !runtimeIsCurrent(runtime) ||
      runtime.instance.identityKey !== profile.identityKey ||
      runtime.instance.chain !== profile.chain
    )
      throw new Error('Wallet changed; reopen Identity and retry.')
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
  const publish = () => {
    const { identityKey, fields, image } = snapshot.context
    return action.run(
      'publish',
      async () => {
        assertOwner()
        if (!identityKey || !image) throw new Error('Choose an image first.')
        await publishIssuerIdentity(runtime!, identityKey, fields, image)
        close()
        toastSuccess('Issuer identity published')
      },
      {
        confirm: {
          title: 'Publish issuer identity?',
          body: 'This image, name and bio are published on-chain as a BAP profile signed by your identity key. They are public and permanent; a later update adds a new profile but never erases this one. Publishing costs a small network fee.',
          confirmLabel: 'Publish',
        },
      },
    )
  }
  const rotate = (row: PublicIdentityRow) =>
    action.run(
      'rotate',
      async () => {
        assertOwner()
        await rotateIssuerSigningKey(runtime!, row.identityKey)
        toastSuccess('Signing key rotated')
      },
      {
        confirm: {
          title: 'Rotate signing key?',
          body: 'Your BAP ID, name and image stay the same; a new key signs everything you issue from now on. Assets the old key signed stay attributed to you when they were mined before this rotation. Rotate if you suspect the current key leaked. Costs a small network fee.',
          confirmLabel: 'Rotate key',
        },
      },
    )
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
  const browsing = snapshot.matches('browsing')
  const importing = snapshot.matches('importing')
  const selectedRow = view.rows.find((row) => row.identityKey === view.selected)
  const draft = snapshot.context
  return (
    <section
      className="identity-card identity-compose"
      data-aeon-scope="public-identities"
      data-aeon-state={stateToAttr(snapshot.value)}
      aria-label="Public identities"
    >
      <h3 className="identity-compose-title">Public identities</h3>
      <p className="identity-compose-lede">
        Your issuer identity is a BAP identity: a stable BAP ID with an image, a
        name and a bio, signed by a key you can rotate. Every asset you issue
        names the BAP ID and is signed by its current key, and the identity
        proof travels with it, so holders can show who made it without trusting
        a server. Publish one before issuing.
      </p>
      <div data-aeon-part="actions" data-aeon-state={action.stateAttr}>
        {browsing ? (
          <>
            <p>
              Issuer:{' '}
              <strong>{selectedRow?.identity?.name ?? 'Not published'}</strong>{' '}
              <span className="mono" title={view.selected}>
                {shortKey(view.selected)}
              </span>
            </p>
            <div className="actions">
              <Button.Root
                variant="ghost"
                className="btn btn-ghost"
                disabled={action.busy || !!view.error}
                onClick={() => send({ type: 'IMPORT_KEY' })}
              >
                Import signing key
              </Button.Root>
              <Button.Root
                variant="ghost"
                className="btn btn-ghost"
                disabled={action.busy}
                onClick={() => backupFile.current?.click()}
              >
                Restore backup
              </Button.Root>
              <Button.Root
                variant="ghost"
                className="btn btn-ghost"
                disabled={action.busy || !!view.error}
                onClick={() =>
                  void action.run('export', async () => {
                    assertOwner()
                    downloadJson(
                      exportPublicIdentityBackup(runtime!),
                      'handcash-issuer-backup.json',
                    )
                  })
                }
              >
                Back up identities
              </Button.Root>
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
              {view.rows.map((row) => (
                <li key={row.identityKey} data-aeon-part="record">
                  {row.identity?.image ? (
                    <DeferredImage
                      src={issuerIdentityImageDataUrl(row.identity.image)}
                      alt=""
                      width={40}
                      height={40}
                      fallback={<span aria-hidden>◈</span>}
                    />
                  ) : (
                    <span aria-hidden>◈</span>
                  )}
                  <strong>{row.identity?.name ?? 'Not published'}</strong>
                  <p className="mono" title={row.identityKey}>
                    {shortKey(row.identityKey)}
                  </p>
                  <p>
                    {row.signer === 'imported' ? 'Imported signer' : 'Wallet signer'}
                    {row.identityKey === view.selected ? ' · selected issuer' : ''}
                  </p>
                  {row.identity?.description ? <p>{row.identity.description}</p> : null}
                  <p className="mono" title={row.bapId}>
                    BAP ID {row.bapId}
                  </p>
                  {row.identity ? (
                    <p>
                      {row.identity.revoked
                        ? 'Revoked'
                        : `Signing key ${row.identity.keys.length}${
                            row.identity.keys.at(-1)!.minedHeight === undefined ? ' · confirming' : ''
                          }`}
                      {row.identity.image ? '' : ' · no image yet'}
                    </p>
                  ) : null}
                  <div className="actions">
                    <Button.Root
                      className="btn btn-primary"
                      disabled={action.busy || !!row.identity?.revoked}
                      onClick={() => compose(row)}
                    >
                      {row.identity ? 'Publish update' : 'Publish identity'}
                    </Button.Root>
                    {row.identity && !row.identity.revoked ? (
                      <Button.Root
                        variant="ghost"
                        className="btn btn-ghost"
                        disabled={action.busy || !row.identity.image}
                        onClick={() => void rotate(row)}
                      >
                        {action.running('rotate') ? 'Rotating…' : 'Rotate signing key'}
                      </Button.Root>
                    ) : null}
                    <Button.Root
                      variant="ghost"
                      className="btn btn-ghost"
                      disabled={action.busy || row.identityKey === view.selected}
                      onClick={() =>
                        void action.run('select', async () => {
                          assertOwner()
                          selectPublicIdentity(runtime!, row.identityKey)
                        })
                      }
                    >
                      Use as issuer
                    </Button.Root>
                    <Button.Root
                      variant="ghost"
                      className="btn btn-ghost"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run('copy', async () => {
                          assertOwner()
                          await copyText(row.identityKey, {
                            label: 'issuer identity key',
                          })
                        })
                      }
                    >
                      Copy identity key
                    </Button.Root>
                    {row.signer === 'imported' ? (
                      <Button.Root
                        variant="ghost"
                        className="btn btn-ghost"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(
                            'remove',
                            async () => {
                              assertOwner()
                              removePublicIdentity(runtime!, row.identityKey)
                            },
                            {
                              confirm: {
                                title: 'Remove imported signer?',
                                body: 'This removes its private signing key from this wallet. Keep an identity backup and your wallet recovery phrase, or the original key, before removing it. Published identities and existing assets are unaffected.',
                                confirmLabel: 'Remove signer',
                                danger: true,
                              },
                            },
                          )
                        }
                      >
                        Remove
                      </Button.Root>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="identity-compose-lede">
              Imported keys are encrypted to this wallet. Your recovery phrase
              alone cannot recover them: keep an identity backup too.
            </p>
          </>
        ) : importing ? (
          <>
            <h4>Import existing issuer key</h4>
            <Field.Root className="identity-compose-field">
              <Field.Label htmlFor={`${prefix}-key`}>
                Private signing key (hex or WIF)
              </Field.Label>
              <Field.Control
                id={`${prefix}-key`}
                ref={privateKey}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={action.busy}
              />
              <p>
                Use the identity's master key, the one 1Sat or Yours derived
                its BAP ID from, not an API credential. Importing does not move
                funds.
              </p>
            </Field.Root>
            <div className="actions">
              <Button.Root
                className="btn btn-primary"
                disabled={action.busy}
                onClick={() => void importKey()}
              >
                {action.running('import') ? 'Importing…' : 'Import key'}
              </Button.Root>
              <Button.Root
                variant="ghost"
                className="btn btn-ghost"
                disabled={action.busy}
                onClick={close}
              >
                Cancel
              </Button.Root>
            </div>
          </>
        ) : (
          <>
            <h4>Publish issuer identity</h4>
            <p className="mono" title={draft.identityKey ?? ''}>
              {draft.identityKey ? shortKey(draft.identityKey) : null}
            </p>
            <div className="identity-compose-field" data-aeon-part="image">
              {draft.image ? (
                <DeferredImage
                  src={issuerIdentityImageDataUrl(draft.image)}
                  alt="Identity image"
                  width={96}
                  height={96}
                  fallback={<span aria-hidden>◈</span>}
                />
              ) : null}
              <Button.Root
                variant="ghost"
                className="btn btn-ghost"
                disabled={action.busy}
                onClick={() => imageFile.current?.click()}
              >
                {action.running('image')
                  ? 'Preparing image…'
                  : draft.image
                    ? 'Change image'
                    : 'Choose image'}
              </Button.Root>
              <p>
                Cropped square and compressed to 64 KB. Photo metadata such as
                location is removed before anything is published.
              </p>
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
            </div>
            <Field.Root className="identity-compose-field">
              <Field.Label htmlFor={`${prefix}-name`}>Name</Field.Label>
              <Field.Control
                id={`${prefix}-name`}
                value={draft.fields.name}
                maxLength={IDENTITY_NAME_MAX}
                disabled={action.busy}
                onChange={(event) =>
                  send({ type: 'FIELD', field: 'name', value: event.target.value })
                }
              />
            </Field.Root>
            <Field.Root className="identity-compose-field">
              <Field.Label htmlFor={`${prefix}-bio`}>Bio (optional)</Field.Label>
              <Field.Control
                id={`${prefix}-bio`}
                value={draft.fields.description}
                maxLength={IDENTITY_DESCRIPTION_MAX}
                disabled={action.busy}
                onChange={(event) =>
                  send({ type: 'FIELD', field: 'description', value: event.target.value })
                }
              />
            </Field.Root>
            <p className="identity-compose-lede">
              The signature proves control of the BAP identity; it does not
              verify a real-world name or handle.
            </p>
            <div className="actions">
              <Button.Root
                className="btn btn-primary"
                disabled={action.busy || !draft.image || !draft.fields.name.trim()}
                onClick={() => void publish()}
              >
                {action.running('publish') ? 'Publishing…' : 'Publish'}
              </Button.Root>
              <Button.Root
                variant="ghost"
                className="btn btn-ghost"
                disabled={action.busy}
                onClick={close}
              >
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
    </section>
  )
}
