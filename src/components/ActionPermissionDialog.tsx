import { useEffect, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import { Prompt } from '@aeon-ui/react'
import {
  acceptsIncomingFunds,
  setAcceptIncomingFunds,
  type PendingAction,
} from '../wallet/permissions'
import { appDisplayName, humanActionCopy } from '../wallet/appIdentity'
import { AppAvatar } from './AppAvatar'
import { PermissionItemPreview } from './PermissionItemPreview'
import {
  formatPrimaryFromSats,
  formatSecondaryFromSats,
  getCachedUsdPerBsv,
} from '../wallet/fx'
import { getDisplayCurrency } from '../wallet/displayCurrency'
import type { AutoPayChoice } from '../wallet/autoPay'
import {
  AutoPayControls,
  isBsvPaymentAction,
  useAutoPayForm,
  useLoadAutoPayOnOrigin,
} from './AutoPayControls'
import { permissionDecisionMachine } from '../machines/permissionDecisionMachine'
import { WalletActionBar } from './WalletActionBar'

export type { AutoPayChoice }

type Props = {
  pending: PendingAction | null
  onAllow: (autoPay?: AutoPayChoice) => boolean
  onDeny: () => boolean
}

/**
 * Chart projection: action permission prompt open ↔ pending request.
 * Uses Aeon Prompt Amount/Meta/Actions — same compound family as update restart.
 */
export function ActionPermissionDialog({ pending, onAllow, onDeny }: Props) {
  const [decision, sendDecision] = useMachine(permissionDecisionMachine)
  const decisionCommittedRef = useRef(false)
  const [iconReady, setIconReady] = useState(false)
  const [acceptIncoming, setAcceptIncoming] = useState(false)
  const autoPay = useAutoPayForm()
  const skipDenyRef = useRef(false)
  const open = Boolean(pending)

  useEffect(() => {
    decisionCommittedRef.current = false
    sendDecision({ type: 'RESET' })
    setIconReady(false)
  }, [pending?.id, pending?.origin, sendDecision])

  useLoadAutoPayOnOrigin(pending?.origin, pending?.id, autoPay.loadFromOrigin)

  useEffect(() => {
    if (!pending) return
    setAcceptIncoming(acceptsIncomingFunds(pending.origin))
  }, [pending])

  const name = pending ? appDisplayName(pending.origin) : ''
  const copy = pending
    ? humanActionCopy(pending.method, pending.title)
    : { eyebrow: '', verb: '' }
  const usdPerBsv = getCachedUsdPerBsv()
  const currency = getDisplayCurrency()
  const amountPrimary =
    pending?.amountSats != null && pending.amountSats > 0
      ? formatPrimaryFromSats(pending.amountSats, currency, usdPerBsv)
      : null
  const amountSecondary =
    pending?.amountSats != null && pending.amountSats > 0
      ? formatSecondaryFromSats(pending.amountSats, currency, usdPerBsv)
      : null
  const showAutoPay = pending ? isBsvPaymentAction(pending) : false
  const showAcceptIncoming = pending?.title === 'Accept incoming funds'
  const committing = decision.matches('committing')

  const allow = () => {
    if (decisionCommittedRef.current || !decision.matches('pending')) return
    decisionCommittedRef.current = true
    skipDenyRef.current = true
    if (!pending) {
      decisionCommittedRef.current = false
      skipDenyRef.current = false
      return
    }
    const accepted = !showAutoPay ? onAllow() : onAllow(autoPay.toChoice())
    if (accepted) {
      if (showAcceptIncoming) {
        setAcceptIncomingFunds(pending.origin, acceptIncoming)
      }
      sendDecision({ type: 'APPROVE' })
      return
    }
    decisionCommittedRef.current = false
    skipDenyRef.current = false
    sendDecision({ type: 'RESET' })
  }

  const deny = () => {
    if (decisionCommittedRef.current || !decision.matches('pending')) return
    decisionCommittedRef.current = true
    if (onDeny()) {
      sendDecision({ type: 'CANCEL' })
      return
    }
    decisionCommittedRef.current = false
    sendDecision({ type: 'RESET' })
  }

  return (
    <div
      data-aeon-scope="action-permission"
      data-aeon-state={open ? (iconReady ? 'pending' : 'loading') : 'idle'}
    >
      <Prompt.Root
        open={open}
        status={open ? 'pending' : 'dismissed'}
        onOpenChange={(next) => {
          if (next) return
          if (skipDenyRef.current) {
            skipDenyRef.current = false
            return
          }
          if (pending) deny()
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            {pending ? (
              <Prompt.Content
                className="panel modal permission-modal action-permission-modal"
                data-aeon-state={iconReady ? 'ready' : 'loading'}
              >
                <div className="connect-app-hero">
                  <AppAvatar
                    origin={pending.origin}
                    name={name}
                    size="md"
                    onReady={() => setIconReady(true)}
                  />
                  <div>
                    <Prompt.Eyebrow className="permission-eyebrow">{copy.eyebrow}</Prompt.Eyebrow>
                    <Prompt.Title>{pending.title}</Prompt.Title>
                    <Prompt.Description
                      className="lede permission-lede-compact"
                      style={{ marginBottom: 0 }}
                    >
                      <strong className="permission-origin">{name}</strong> {copy.verb}.
                    </Prompt.Description>
                  </div>
                </div>

                {(amountPrimary || pending.amountLabel) && (
                  <Prompt.Amount className="action-amount">
                    <span>Amount</span>
                    <strong>
                      {amountPrimary && amountPrimary !== '—'
                        ? amountPrimary
                        : pending.amountLabel}
                    </strong>
                    {amountSecondary && amountPrimary && amountPrimary !== '—' ? (
                      <em className="action-amount-bsv">{amountSecondary}</em>
                    ) : null}
                  </Prompt.Amount>
                )}

                {pending.itemOutpoint || pending.tokenId || pending.itemName ? (
                  <PermissionItemPreview
                    outpoint={pending.itemOutpoint}
                    tokenId={pending.tokenId}
                    itemName={pending.itemName}
                    itemImageUrl={pending.itemImageUrl}
                    previewKind={pending.previewKind}
                  />
                ) : null}

                <Prompt.Meta className="permission-meta">
                  <div>
                    <dt>What for</dt>
                    <dd>{pending.summary}</dd>
                  </div>
                  {pending.details.slice(0, pending.title === 'Mint token' ? 4 : 2).map((line) => (
                    <div key={line}>
                      <dt>Detail</dt>
                      <dd>{line}</dd>
                    </div>
                  ))}
                </Prompt.Meta>

                {showAutoPay ? (
                  <AutoPayControls
                    appName={name}
                    enabled={autoPay.enabled}
                    maxUsd={autoPay.maxUsd}
                    windowHours={autoPay.windowHours}
                    onEnabledChange={autoPay.setEnabled}
                    onMaxUsdChange={autoPay.setMaxUsd}
                    onWindowHoursChange={autoPay.setWindowHours}
                  />
                ) : null}

                {showAcceptIncoming ? (
                  <div className="auto-pay" data-aeon-part="accept-incoming">
                    <label className="auto-pay-toggle">
                      <input
                        type="checkbox"
                        checked={acceptIncoming}
                        onChange={(event) => setAcceptIncoming(event.target.checked)}
                      />
                      <span>
                        Accept funds automatically from <strong>{name}</strong>
                      </span>
                    </label>
                  </div>
                ) : null}

                <WalletActionBar
                  ariaLabel="Wallet action decision"
                  className="connect-actions"
                  secondary={{
                    label: 'Cancel',
                    onClick: deny,
                    disabled: committing,
                  }}
                  primary={{
                    label: committing ? 'Approving…' : 'Approve',
                    onClick: allow,
                    disabled: committing || (showAutoPay && autoPay.limitsInvalid),
                    autoFocus: true,
                    tone: 'primary',
                  }}
                />
              </Prompt.Content>
            ) : null}
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>
    </div>
  )
}
