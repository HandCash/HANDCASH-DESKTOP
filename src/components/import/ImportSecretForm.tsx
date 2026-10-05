import { useState } from 'react'
import {
  IMPORT_SOURCE_HINTS,
  IMPORT_SOURCE_LABELS,
  type ImportSourceKind,
} from '../../wallet/import'

export type SecretFields = {
  primary: string
  secondary: string
  passphrase: string
  label: string
  handle: string
}

const EMPTY: SecretFields = { primary: '', secondary: '', passphrase: '', label: '', handle: '' }

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
      <div className="confirm-password-copy">
        <h3 className="confirm-password-title">{IMPORT_SOURCE_LABELS[kind]}</h3>
        <p className="confirm-password-lede">{IMPORT_SOURCE_HINTS[kind]}</p>
      </div>

      {kind === 'handcash' ? (
        <>
          <div className="field" data-aeon-part="field">
            <label htmlFor="import-hc-first">First key</label>
            <textarea
              id="import-hc-first"
              rows={3}
              value={fields.primary}
              onChange={(e) => set({ primary: e.target.value })}
              placeholder="xprv… — or paste the whole export here"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
          <div className="field" data-aeon-part="field">
            <label htmlFor="import-hc-second">Second key</label>
            <textarea
              id="import-hc-second"
              rows={3}
              value={fields.secondary}
              onChange={(e) => set({ secondary: e.target.value })}
              placeholder="xprv…"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
          <div className="field" data-aeon-part="field">
            <label htmlFor="import-hc-handle">Your HandCash handle (optional)</label>
            <input
              id="import-hc-handle"
              value={fields.handle}
              onChange={(e) => set({ handle: e.target.value })}
              placeholder="$handle"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
        </>
      ) : null}

      {kind === 'phrase' || kind === 'twetch' ? (
        <>
          <div className="field" data-aeon-part="field">
            <label htmlFor="import-phrase-words">Recovery phrase</label>
            <textarea
              id="import-phrase-words"
              rows={3}
              value={fields.primary}
              onChange={(e) => set({ primary: e.target.value })}
              placeholder="twelve words separated by spaces"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
          {kind === 'phrase' ? (
            <div className="field" data-aeon-part="field">
              <label htmlFor="import-phrase-passphrase">BIP39 passphrase (optional)</label>
              <input
                id="import-phrase-passphrase"
                type="password"
                value={fields.passphrase}
                onChange={(e) => set({ passphrase: e.target.value })}
                autoComplete="off"
                disabled={saving}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {kind === 'yours' ? (
        <>
          <div className="field" data-aeon-part="field">
            <label htmlFor="import-yours-file">Export file</label>
            <input
              id="import-yours-file"
              type="file"
              accept="application/json,.json"
              onChange={(e) => void readFile(e.target.files?.[0])}
              disabled={saving}
            />
          </div>
          <div className="field" data-aeon-part="field">
            <label htmlFor="import-yours-json">…or paste its contents</label>
            <textarea
              id="import-yours-json"
              rows={4}
              value={fields.primary}
              onChange={(e) => set({ primary: e.target.value })}
              placeholder='{"mnemonic": "…", "payPk": "…", "ordPk": "…"}'
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
        </>
      ) : null}

      {kind === 'wif' ? (
        <div className="field" data-aeon-part="field">
          <label htmlFor="import-wif">Private keys</label>
          <textarea
            id="import-wif"
            rows={3}
            value={fields.primary}
            onChange={(e) => set({ primary: e.target.value })}
            placeholder="K… / L… / 5… — one per line"
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
          />
        </div>
      ) : null}

      <div className="field" data-aeon-part="field">
        <label htmlFor="import-label">Name (optional)</label>
        <input
          id="import-label"
          value={fields.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder={IMPORT_SOURCE_LABELS[kind]}
          autoComplete="off"
          disabled={saving}
        />
      </div>

      <p className="settings-row-desc">
        Saved encrypted on this device under this wallet’s key. It is never your HandCash
        identity, never signs in to apps, and nothing moves until you choose Sweep.
      </p>

      {props.error ? (
        <p className="error" role="alert">
          {props.error}
        </p>
      ) : null}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || saving}>
          {saving ? 'Saving…' : 'Save and scan'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={props.onBack}>
          Back
        </button>
      </div>
    </form>
  )
}
