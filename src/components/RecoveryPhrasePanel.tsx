import { useMemo, useState } from 'react'

type Props = {
  mnemonic: string
  onConfirmed: () => void
}

/** Gate: user must confirm they saved the BIP39 phrase before entering the wallet. */
export function RecoveryPhrasePanel({ mnemonic, onConfirmed }: Props) {
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic])
  const [ack, setAck] = useState(false)
  const [challengeIndex] = useState(() => Math.floor(Math.random() * words.length))
  const [challengeAnswer, setChallengeAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const expected = words[challengeIndex] ?? ''

  const confirm = () => {
    setError(null)
    if (!ack) {
      setError('Confirm that you wrote down your recovery phrase.')
      return
    }
    if (challengeAnswer.trim().toLowerCase() !== expected.toLowerCase()) {
      setError(`Word #${challengeIndex + 1} does not match.`)
      return
    }
    onConfirmed()
  }

  const copy = async () => {
    try {
      if (window.handcash?.clipboardWrite) await window.handcash.clipboardWrite(mnemonic)
      else await navigator.clipboard.writeText(mnemonic)
      setCopied(true)
    } catch {
      setError('Could not copy to clipboard.')
    }
  }

  return (
    <section className="hero-panel" data-aeon-scope="recovery-phrase" data-aeon-state="pending">
      <div>
        <p className="brand-sub" style={{ marginBottom: 10 }}>
          Backup required
        </p>
        <h1 className="display">Save your recovery phrase.</h1>
        <p className="lede" style={{ marginTop: 14 }}>
          This is the only way to restore your wallet if this device is lost or the app is reset.
          HandCash cannot recover it for you.
        </p>
      </div>

      <div className="panel" data-aeon-part="phrase">
        <ol className="recovery-phrase-grid">
          {words.map((word, i) => (
            <li key={`${i}-${word}`}>
              <span className="recovery-phrase-index">{i + 1}.</span> {word}
            </li>
          ))}
        </ol>

        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-ghost" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy phrase'}
          </button>
        </div>

        <label className="field" style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            style={{ marginTop: 4 }}
          />
          <span>I wrote down these {words.length} words and stored them offline.</span>
        </label>

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="phrase-challenge">
            Enter word #{challengeIndex + 1} to confirm
          </label>
          <input
            id="phrase-challenge"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={challengeAnswer}
            onChange={(e) => setChallengeAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
            }}
          />
        </div>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={confirm}>
            I saved it — continue
          </button>
        </div>
      </div>
    </section>
  )
}
