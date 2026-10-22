import { Button, Field } from '@aeon-ui/react'
import { Switch } from '@aeon-ui/ui'
import { useState } from 'react'
import { parseRelayUrls, readCallSettings, writeCallSettings } from '../../wallet/calls/callSettings'
import { playWalletSound } from '../../wallet/soundService'
import { toastSuccess } from '../../wallet/toast'
import { CallIcon } from '../icons'
import { SettingsControlRow } from './SettingsControlRow'

/**
 * Optional TURN relay for calls. Calls go straight between the two wallets;
 * a relay only helps when both sit behind strict networks, and it carries
 * encrypted media it cannot read.
 */
export function CallRelayField() {
  const saved = readCallSettings().relay
  const [on, setOn] = useState(() => saved !== null)
  const [urls, setUrls] = useState(() => saved?.urls.join(' ') ?? '')
  const [username, setUsername] = useState(() => saved?.username ?? '')
  const [credential, setCredential] = useState(() => saved?.credential ?? '')
  const valid = parseRelayUrls(urls).length > 0

  const save = () => {
    writeCallSettings({ relay: { urls: parseRelayUrls(urls), username, credential } })
    playWalletSound('soft')
    toastSuccess('Call relay saved')
  }

  return (
    <div className="settings-form settings-form-compact" data-aeon-part="call-relay-field">
      <ul className="settings-list">
        <SettingsControlRow
          label="Call relay"
          icon={<CallIcon size={20} />}
          description={on ? 'Calls that can’t connect directly go through your TURN server' : 'Off · calls connect directly'}
        >
          <Switch.Root
            checked={on}
            aria-label="Call relay"
            onCheckedChange={(next) => {
              setOn(next)
              if (!next) writeCallSettings({ relay: null })
            }}
          />
        </SettingsControlRow>
      </ul>
      {on ? (
        <>
          <Field.Root className="field">
            <Field.Label htmlFor="call-relay-urls">TURN server</Field.Label>
            <Field.Control
              id="call-relay-urls"
              placeholder="turn:relay.example.com:3478"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field.Root>
          <Field.Root className="field">
            <Field.Label htmlFor="call-relay-user">Username</Field.Label>
            <Field.Control
              id="call-relay-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field.Root>
          <Field.Root className="field">
            <Field.Label htmlFor="call-relay-pass">Password</Field.Label>
            <Field.Control
              id="call-relay-pass"
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="off"
            />
          </Field.Root>
          <div className="actions">
            <Button.Root variant="solid" className="btn btn-primary" disabled={!valid} onClick={save}>
              <Button.Label>Save relay</Button.Label>
            </Button.Root>
          </div>
        </>
      ) : null}
    </div>
  )
}
