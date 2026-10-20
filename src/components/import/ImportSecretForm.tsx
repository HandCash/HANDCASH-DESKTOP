import { Button, Field, FileUpload } from '@aeon-ui/react'
import { useState } from 'react'
import {
  IMPORT_SOURCE_HINTS,
  IMPORT_SOURCE_LABELS,
  type ImportSourceKind,
} from '../../wallet/import'
import { FileIcon } from '../icons'
import { ImportSourceIcon } from './importSourceIcons'

export type SecretFields = {
  primary: string
  secondary: string
  passphrase: string
  label: string
}

const EMPTY: SecretFields = { primary: '', secondary: '', passphrase: '', label: '' }

/**
 * Secret entry for one source kind. Holds field values only — the step it is
 * on and whether it is saving belong to `legacyImportMachine`.
 */
export function ImportSecretForm(props: {
  kind: ImportSourceKind
  saving: boolean
  error: string | null
  onSubmit: (fields: SecretFields) => void
  onBack: () => void
}) {
  const { kind, saving } = props
  const [fields, setFields] = useState<SecretFields>(EMPTY)
  const set = (patch: Partial<SecretFields>) => setFields((prev) => ({ ...prev, ...patch }))
  // A whole HandCash export pasted into the first field carries both keys.
  const bothKeysPresent =
    fields.secondary.trim().length > 0 || /xprv[\s\S]+xprv/.test(fields.primary)
  const ready = fields.primary.trim().length > 0 && (kind !== 'handcash' || bothKeysPresent)

  const readFile = async (file: File | undefined) => {
    if (!file) return
    set({ primary: await file.text() })
  }

  return (
    <form
      className="settings-form"
      data-aeon-part="secret-form"
      data-aeon-state={kind}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !saving) props.onSubmit(fields)
      }}
    >
      <header className="import-source-head" data-aeon-part="head">
        <ImportSourceIcon kind={kind} size="lg" />
        <div>
          <h3 className="confirm-password-title">{IMPORT_SOURCE_LABELS[kind]}</h3>
          <p className="confirm-password-lede">{IMPORT_SOURCE_HINTS[kind]}</p>
        </div>
      </header>

      {kind === 'handcash' ? (
        <>
          <Field.Root className="field">
            <Field.Label htmlFor="import-hc-first">First key</Field.Label>
            <Field.Textarea
              id="import-hc-first"
              rows={3}
              value={fields.primary}
              onChange={(e) => set({ primary: e.target.value })}
              placeholder="xprv… — or paste the whole export here"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </Field.Root>
          <Field.Root className="field">
            <Field.Label htmlFor="import-hc-second">Second key</Field.Label>
            <Field.Textarea
              id="import-hc-second"
              rows={3}
              value={fields.secondary}
              onChange={(e) => set({ secondary: e.target.value })}
              placeholder="xprv…"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </Field.Root>
        </>
      ) : null}

      {kind === 'phrase' || kind === 'twetch' ? (
        <>
          <Field.Root className="field">
            <Field.Label htmlFor="import-phrase-words">Recovery phrase</Field.Label>
            <Field.Textarea
              id="import-phrase-words"
              rows={3}
              value={fields.primary}
              onChange={(e) => set({ primary: e.target.value })}
              placeholder="twelve words separated by spaces"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </Field.Root>
          {kind === 'phrase' ? (
            <Field.Root className="field">
              <Field.Label htmlFor="import-phrase-passphrase">BIP39 passphrase (optional)</Field.Label>
              <Field.Control
                id="import-phrase-passphrase"
                type="password"
                value={fields.passphrase}
                onChange={(e) => set({ passphrase: e.target.value })}
                autoComplete="off"
                disabled={saving}
              />
            </Field.Root>
          ) : null}
        </>
      ) : null}

      {kind === 'yours' ? (
        <>
          <FileUpload.Root
            className="field import-file"
            accept="application/json,.json"
            disabled={saving}
            onFileSelect={(file) => void readFile(file ?? undefined)}
          >
            <FileUpload.Label>Key file</FileUpload.Label>
            <FileUpload.Dropzone className="import-file-drop">
              <FileIcon size={20} />
              <FileUpload.Preview className="import-file-name" />
              <span className="import-file-prompt">Drop the .json file here, or click to choose it</span>
            </FileUpload.Dropzone>
            <FileUpload.Input hidden />
          </FileUpload.Root>
          <Field.Root className="field">
            <Field.Label htmlFor="import-yours-json">Or paste what it holds</Field.Label>
            <Field.Textarea
              id="import-yours-json"
              rows={4}
              value={fields.primary}
              onChange={(e) => set({ primary: e.target.value })}
              placeholder='{"mnemonic": "…", "payPk": "…", "ordPk": "…"}'
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </Field.Root>
        </>
      ) : null}

      {kind === 'wif' ? (
        <Field.Root className="field">
          <Field.Label htmlFor="import-wif">Private keys</Field.Label>
          <Field.Textarea
            id="import-wif"
            rows={3}
            value={fields.primary}
            onChange={(e) => set({ primary: e.target.value })}
            placeholder="K… / L… / 5… — one per line"
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
          />
        </Field.Root>
      ) : null}

      <Field.Root className="field">
        <Field.Label htmlFor="import-label">Name (optional)</Field.Label>
        <Field.Control
          id="import-label"
          value={fields.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder={IMPORT_SOURCE_LABELS[kind]}
          autoComplete="off"
          disabled={saving}
        />
      </Field.Root>

      <p className="settings-row-desc">
        Saved encrypted on this device. It never becomes your HandCash identity or signs in to
        apps, and nothing moves until you choose Import.
      </p>

      {props.error ? (
        <p className="error" role="alert">
          {props.error}
        </p>
      ) : null}

      <div className="actions">
        <Button.Root variant="solid" type="submit" className="btn btn-primary" disabled={!ready || saving}>
          <Button.Label>{saving ? 'Saving…' : 'Save and scan'}</Button.Label>
        </Button.Root>
        <Button.Root variant="ghost" className="btn btn-ghost" disabled={saving} onClick={props.onBack}>
          <Button.Label>Back</Button.Label>
        </Button.Root>
      </div>
    </form>
  )
}
