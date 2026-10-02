import { Prompt } from '@aeon-ui/react'
import type { IdentityPlanKey, IdentityPublishPlan } from '../wallet/identityPublish'
import { formatPrimaryFromSats, getCachedUsdPerBsv } from '../wallet/fx'
import { getDisplayCurrency } from '../wallet/displayCurrency'

export type IdentityReviewStage = 'quoting' | 'reviewing' | 'publishing' | 'refused'

type Props = {
  stage: IdentityReviewStage | null
  /** What is under review, before the quote names the kind. */
  rotation: boolean
  plan: IdentityPublishPlan | null
  error: string | null
  onApprove: () => void
  onCancel: () => void
  onDismiss: () => void
}

const COPY = {
  publish: {
    title: 'Publish identity',
    effect:
      'Public and permanent on-chain.',
    approve: 'Sign and publish',
  },
  update: {
    title: 'Update identity',
    effect:
      'Replaces your profile. The earlier one stays on-chain.',
    approve: 'Sign and update',
  },
  rotate: {
    title: 'Rotate signing key',
    effect:
      'Same BAP ID and profile. A new key signs from now on.',
    approve: 'Sign rotation',
  },
} as const

const sats = (n: number) => `${n.toLocaleString()} sat${n === 1 ? '' : 's'}`
const keyLabel = (key: IdentityPlanKey) =>
  `identity-${key.seq} · ${key.publicKey.slice(0, 10)}…${key.publicKey.slice(-6)}`
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

/**
 * Approval for wallet-originated identity records, projected from the
 * publicIdentities chart. Approve exists only in `reviewing`, on a quoted
 * plan; the wallet signs nothing else and holds each fee to its ceiling.
 */
export function IdentityPublishReview({
  stage,
  rotation,
  plan,
  error,
  onApprove,
  onCancel,
  onDismiss,
}: Props) {
  const open = stage !== null
  const copy = COPY[plan?.kind ?? (rotation ? 'rotate' : 'publish')]
  const fiat = plan
    ? formatPrimaryFromSats(plan.feeSats, getDisplayCurrency(), getCachedUsdPerBsv())
    : null
  const leave = stage === 'refused' ? onDismiss : onCancel
  return (
    <Prompt.Root
      open={open}
      status={stage === 'publishing' ? 'confirming' : 'pending'}
      onOpenChange={(next) => {
        if (!next && stage !== 'publishing') leave()
      }}
    >
      <Prompt.Portal>
        <Prompt.Backdrop className="permission-backdrop" />
        <Prompt.Positioner className="permission-positioner">
          <Prompt.Content
            className="panel modal permission-modal action-permission-modal"
            data-aeon-part="identity-publish-review"
            data-aeon-state={stage ?? 'closed'}
          >
            <Prompt.Title>{copy.title}</Prompt.Title>
            {stage === 'refused' ? (
              <Prompt.Effect role="alert">{error}</Prompt.Effect>
            ) : (
              <Prompt.Effect>{copy.effect}</Prompt.Effect>
            )}
            {plan && stage !== 'refused' ? (
              <>
                <Prompt.Amount className="action-amount">
                  <span>Network fee</span>
                  <strong>about {sats(plan.feeSats)}</strong>
                  <em className="action-amount-bsv">
                    at most {sats(plan.maxFeeSats)}
                    {fiat && fiat !== '—' ? ` · ${fiat}` : ''}
                  </em>
                </Prompt.Amount>
                <Prompt.Meta className="permission-meta">
                  <div>
                    <dt>Name</dt>
                    <dd>{plan.name}</dd>
                  </div>
                  <div>
                    <dt>Image</dt>
                    <dd>
                      {plan.image.status === 'new'
                        ? `New · ${kb(plan.image.bytes)} ${plan.image.contentType}, its own transaction`
                        : `Already on-chain · b://${plan.image.txid.slice(0, 12)}…`}
                    </dd>
                  </div>
                  <div>
                    <dt>{plan.retiredKey ? 'New signing key' : 'Signing key'}</dt>
                    <dd className="mono">{keyLabel(plan.signingKey)}</dd>
                  </div>
                  {plan.retiredKey ? (
                    <div>
                      <dt>Retires</dt>
                      <dd className="mono">{keyLabel(plan.retiredKey)}</dd>
                    </div>
                  ) : null}
                  {plan.transactions.map((tx) => (
                    <div key={tx.purpose} data-aeon-part="identity-record-tx">
                      <dt>{tx.description}</dt>
                      <dd>
                        {tx.outputs.map((o) => `${o.description} (${o.bytes.toLocaleString()} B)`).join(' + ')}
                        {' · '}0-sat data · fee about {sats(tx.feeSats)}, at most {sats(tx.maxFeeSats)}
                      </dd>
                    </div>
                  ))}
                </Prompt.Meta>
              </>
            ) : stage === 'quoting' ? (
              <Prompt.Description className="lede">Preparing…</Prompt.Description>
            ) : null}
            <Prompt.Actions className="actions">
              {stage === 'refused' ? (
                <Prompt.Primary type="button" className="btn btn-primary" onClick={onDismiss}>
                  Back
                </Prompt.Primary>
              ) : (
                <>
                  <Prompt.Secondary
                    type="button"
                    className="btn btn-ghost"
                    disabled={stage === 'publishing'}
                    onClick={onCancel}
                  >
                    Cancel
                  </Prompt.Secondary>
                  <Prompt.Primary
                    type="button"
                    className="btn btn-primary"
                    disabled={stage !== 'reviewing'}
                    onClick={onApprove}
                  >
                    {stage === 'publishing' ? 'Signing…' : copy.approve}
                  </Prompt.Primary>
                </>
              )}
            </Prompt.Actions>
          </Prompt.Content>
        </Prompt.Positioner>
      </Prompt.Portal>
    </Prompt.Root>
  )
}
