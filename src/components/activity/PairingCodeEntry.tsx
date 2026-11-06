/**
 * Type the numbers a new device shows, to let it sign in (BRC-249).
 * The chart owns the digits; this only projects them. The field starts empty,
 * refuses autofill and paste, never takes focus on its own, and the chart
 * ignores any change that is not one typed digit.
 */
import { useMachine } from '@xstate/react'
import { pairingCodeMachine, type PairingOutcome } from '../../machines/pairingCodeMachine'

export type PairingCodeEntryProps = {
  label: string
  length: number
  attemptsLeft: number
  confirm: (digits: string) => Promise<PairingOutcome>
  approve: () => Promise<void>
}

export function PairingCodeEntry({ label, length, attemptsLeft, confirm, approve }: PairingCodeEntryProps) {
  const [snapshot, send] = useMachine(pairingCodeMachine, { input: { length, attemptsLeft, confirm, approve } })
  const { digits, error, attemptsLeft: left } = snapshot.context
  const state = String(snapshot.value)
  const busy = state === 'verifying' || state === 'sending'
  return (
    <div data-aeon-scope="pairing-code" data-aeon-state={state}>
      {state === 'approved' ? (
        <p className="signin-note" role="status">
          {label} is signed in.
        </p>
      ) : state === 'ended' ? (
        <p className="signin-error" role="alert">
          {error ?? `${label} was not signed in.`}
        </p>
      ) : (
        <>
          <p className="signin-note">
            {state === 'sending' ? `Code accepted. Sending your wallet to ${label}…` : `Type the numbers shown on ${label} to sign it in.`}
          </p>
          <input
            className="signin-code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={length}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="pairing-code-not-stored"
            aria-label={`Code shown on ${label}`}
            placeholder={'•'.repeat(length)}
            value={digits}
            disabled={busy}
            data-aeon-part="digits"
            onChange={(event) => send({ type: 'TYPE', value: event.target.value })}
            onPaste={(event) => event.preventDefault()}
            onDrop={(event) => event.preventDefault()}
          />
          {error ? (
            <p className="signin-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="signin-note" data-aeon-part="attempts">
            {left === 1 ? '1 try left' : `${left} tries left`}
          </p>
        </>
      )}
    </div>
  )
}
