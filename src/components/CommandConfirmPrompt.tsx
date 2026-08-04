import { Prompt } from '@aeon-ui/react'

type Props = {
  open: boolean
  verb: string
  recipient: string
  amountLabel: string
  satsLabel?: string | null
  effect: string
  confirming?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * BRC-218 §4 structured confirmation — verb, fully-qualified recipient,
 * amount (fiat + sats), plain-language effect.
 */
export function CommandConfirmPrompt({
  open,
  verb,
  recipient,
  amountLabel,
  satsLabel,
  effect,
  confirming = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Prompt.Root
      open={open}
      status={confirming ? 'confirming' : 'pending'}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <Prompt.Portal>
        <Prompt.Backdrop className="permission-backdrop" />
        <Prompt.Positioner className="permission-positioner">
          <Prompt.Content className="panel modal permission-modal" data-aeon-part="command-confirm">
            <Prompt.Eyebrow>Confirm command</Prompt.Eyebrow>
            <Prompt.Title>Confirm /{verb}</Prompt.Title>
            <Prompt.Verb>/{verb}</Prompt.Verb>
            <Prompt.Recipient>{recipient}</Prompt.Recipient>
            <Prompt.Amount>
              <strong>{amountLabel}</strong>
              {satsLabel ? <span> · {satsLabel}</span> : null}
            </Prompt.Amount>
            <Prompt.Effect>{effect}</Prompt.Effect>
            <Prompt.Actions className="actions">
              <Prompt.Secondary type="button" className="btn btn-ghost" onClick={onCancel}>
                Cancel
              </Prompt.Secondary>
              <Prompt.Primary
                type="button"
                className="btn btn-primary"
                disabled={confirming}
                onClick={onConfirm}
              >
                {confirming ? 'Sending…' : 'Confirm'}
              </Prompt.Primary>
            </Prompt.Actions>
          </Prompt.Content>
        </Prompt.Positioner>
      </Prompt.Portal>
    </Prompt.Root>
  )
}
