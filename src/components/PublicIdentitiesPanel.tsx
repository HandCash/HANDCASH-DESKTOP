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
  importPublicIdentityProfile,
  listPublicIdentities,
  MAX_IDENTITY_FILE_BYTES,
  publicIdentitiesGeneration,
  removePublicIdentity,
  restorePublicIdentityBackup,
  saveWalletPublicIdentity,
  selectedPublicIdentityKey,
  selectPublicIdentity,
  subscribePublicIdentities,
  updatePublicIdentity,
} from '../wallet/publicIdentities'
import { toastSuccess } from '../wallet/toast'
import type { WalletProfile } from '../machines/appMachine'
import { contentUrlForOrigin } from '../wallet/oneSatImport'
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

/** Account-keyed by the parent: switching wallets discards drafts and secret input. */
export function PublicIdentitiesPanel({ profile }: { profile: WalletProfile }) {
  const [snapshot, send] = useMachine(publicIdentitiesMachine)
  const action = useAsyncAction<
    'save' | 'select' | 'remove' | 'import' | 'export' | 'copy'
  >()
  const privateKey = useRef<HTMLInputElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const prefix = useId()
  const runtime = getWalletRuntime()
  const generation = useSyncExternalStore(
    subscribePublicIdentities,
    publicIdentitiesGeneration,
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
        rows: [],
        selected: profile.identityKey,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [generation, profile.identityKey, runtime])
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
  const close = () => {
    if (privateKey.current) privateKey.current.value = ''
    send({ type: 'CLOSE' })
  }
  const save = async () => {
    const result = await action.run('save', async () => {
      assertOwner()
      try {
        if (snapshot.matches('importing'))
          importIssuerPrivateKey(
            runtime!,
            privateKey.current?.value ?? '',
            snapshot.context.fields,
          )
        else if (snapshot.context.identityKey)
          updatePublicIdentity(
            runtime!,
            snapshot.context.identityKey,
            snapshot.context.fields,
          )
        else saveWalletPublicIdentity(runtime!, snapshot.context.fields)
        close()
        toastSuccess('Public identity saved')
      } finally {
        if (privateKey.current) privateKey.current.value = ''
      }
    })
    return result
  }
  const loadFile = async (picked: File) => {
    await action.run('import', async () => {
      assertOwner()
      if (picked.size > MAX_IDENTITY_FILE_BYTES)
        throw new Error('Identity file is too large (128 KB maximum).')
      const raw: unknown = JSON.parse(await picked.text())
      assertOwner()
      if (
        (raw as { kind?: string })?.kind === 'handcash-public-identities-backup'
      )
        restorePublicIdentityBackup(runtime!, raw)
      else importPublicIdentityProfile(runtime!, raw)
      toastSuccess('Identity imported')
    })
  }
  const browsing = snapshot.matches('browsing')
  const importing = snapshot.matches('importing')
  return (
    <section
      className="identity-card identity-compose"
      data-aeon-scope="public-identities"
      data-aeon-state={stateToAttr(snapshot.value)}
      aria-label="Public identities"
    >
      <h3 className="identity-compose-title">Public identities</h3>
      <p className="identity-compose-lede">
        Put a name and icon behind the key you use to issue items and tokens. A
        name and icon are required before issuing. Selecting an issuer changes
        asset signing; payments still use your wallet account.
      </p>
      <div data-aeon-part="actions" data-aeon-state={action.stateAttr}>
        {browsing ? (
          <>
            <p>
              Issuer:{' '}
              <strong>
                {view.rows.find(
                  (row) => row.profile.identityKey === view.selected,
                )?.profile.displayName ?? 'Wallet identity'}
              </strong>{' '}
              <span className="mono" title={view.selected}>
                {view.selected.slice(0, 10)}…{view.selected.slice(-8)}
              </span>
            </p>
            <div className="actions">
              <Button.Root
                className="btn btn-primary"
                disabled={action.busy || !!view.error}
                onClick={() => {
                  const own = view.rows.find(
                    (row) => row.profile.identityKey === profile.identityKey,
                  )
                  send(
                    own
                      ? {
                          type: 'EDIT',
                          identityKey: profile.identityKey,
                          fields: own.profile,
                        }
                      : { type: 'CREATE' },
                  )
                }}
              >
                Define wallet identity
              </Button.Root>
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
                onClick={() => file.current?.click()}
              >
                Import profile / backup
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
              ref={file}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const picked = event.target.files?.[0]
                event.target.value = ''
                if (picked) void loadFile(picked)
              }}
            />
            {view.selected !== profile.identityKey ? (
              <Button.Root
                variant="ghost"
                className="btn btn-ghost"
                disabled={action.busy}
                onClick={() =>
                  void action.run('select', async () => {
                    assertOwner()
                    selectPublicIdentity(runtime!, profile.identityKey)
                  })
                }
              >
                Use wallet identity as issuer
              </Button.Root>
            ) : null}
            <ul className="identity-list" data-aeon-part="records">
              {view.rows.map((row) => (
                <li key={row.profile.identityKey} data-aeon-part="record">
                  <DeferredImage
                    src={
                      row.profile.icon.startsWith('ord://')
                        ? contentUrlForOrigin(
                            row.profile.icon.slice(6),
                            profile.chain,
                          )
                        : row.profile.icon
                    }
                    alt=""
                    width={40}
                    height={40}
                    fallback={<span aria-hidden>◈</span>}
                  />
                  <strong>{row.profile.displayName}</strong>
                  <p className="mono" title={row.profile.identityKey}>
                    {row.profile.identityKey.slice(0, 12)}…
                    {row.profile.identityKey.slice(-8)}
                  </p>
                  <p>
                    {row.signer === 'imported'
                      ? 'Imported signer'
                      : row.signer === 'wallet'
                        ? 'Wallet signer'
                        : 'Public profile · view only'}
                    {row.profile.identityKey === view.selected
                      ? ' · selected issuer'
                      : ''}
                  </p>
                  {row.profile.description ? (
                    <p>{row.profile.description}</p>
                  ) : null}
                  <div className="actions">
                    <Button.Root
                      variant="ghost"
                      className="btn btn-ghost"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run('copy', async () => {
                          assertOwner()
                          await copyText(row.profile.identityKey, {
                            label: 'issuer identity key',
                          })
                        })
                      }
                    >
                      Copy identity key
                    </Button.Root>
                    {row.signer !== 'public' ? (
                      <>
                        <Button.Root
                          variant="ghost"
                          className="btn btn-ghost"
                          disabled={
                            action.busy ||
                            row.profile.identityKey === view.selected
                          }
                          onClick={() =>
                            void action.run('select', async () => {
                              assertOwner()
                              selectPublicIdentity(
                                runtime!,
                                row.profile.identityKey,
                              )
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
                            send({
                              type: 'EDIT',
                              identityKey: row.profile.identityKey,
                              fields: row.profile,
                            })
                          }
                        >
                          Edit profile
                        </Button.Root>
                      </>
                    ) : null}
                    <Button.Root
                      variant="ghost"
                      className="btn btn-ghost"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run('export', async () => {
                          assertOwner()
                          downloadJson(
                            JSON.stringify(row.profile, null, 2),
                            `issuer-${row.profile.identityKey.slice(0, 12)}.json`,
                          )
                        })
                      }
                    >
                      Export public profile
                    </Button.Root>
                    <Button.Root
                      variant="ghost"
                      className="btn btn-ghost"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(
                          'remove',
                          async () => {
                            assertOwner()
                            removePublicIdentity(
                              runtime!,
                              row.profile.identityKey,
                            )
                          },
                          {
                            confirm: {
                              title: 'Remove public identity?',
                              body:
                                row.signer === 'imported'
                                  ? 'This removes its private signing key from this wallet. Keep an identity backup and your wallet recovery phrase, or the original key, before removing it. Existing assets are unaffected.'
                                  : 'This removes the saved profile. Existing assets are unaffected.',
                              confirmLabel: 'Remove identity',
                              danger: true,
                            },
                          },
                        )
                      }
                    >
                      Remove
                    </Button.Root>
                  </div>
                </li>
              ))}
            </ul>
            <p className="identity-compose-lede">
              Imported keys are encrypted to this wallet. Your recovery phrase
              alone cannot recover them: keep an identity backup too. Public
              profile exports contain no private keys.
            </p>
          </>
        ) : (
          <>
            <h4>
              {importing
                ? 'Import existing issuer key'
                : 'Define public identity'}
            </h4>
            {importing ? (
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
                  Use the actual Sigma signing key, not an API credential.
                  Importing does not move funds.
                </p>
              </Field.Root>
            ) : null}
            {(['displayName', 'icon', 'description'] as const).map((field) => (
              <Field.Root className="identity-compose-field" key={field}>
                <Field.Label htmlFor={`${prefix}-${field}`}>
                  {field === 'displayName'
                    ? 'Display name'
                    : field === 'icon'
                      ? 'Icon URL (HTTPS or ord://)'
                      : 'About (optional)'}
                </Field.Label>
                <Field.Control
                  id={`${prefix}-${field}`}
                  value={snapshot.context.fields[field]}
                  maxLength={
                    field === 'displayName' ? 80 : field === 'icon' ? 512 : 280
                  }
                  disabled={action.busy}
                  onChange={(event) =>
                    send({ type: 'FIELD', field, value: event.target.value })
                  }
                />
              </Field.Root>
            ))}
            <p className="identity-compose-lede">
              Saving signs this profile with the identity key. No publishing
              fee. The signature proves control of the key; it does not verify a
              real-world name or handle.
            </p>
            <div className="actions">
              <Button.Root
                className="btn btn-primary"
                disabled={action.busy}
                onClick={() => void save()}
              >
                {action.running('save') ? 'Saving…' : 'Save signed profile'}
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
