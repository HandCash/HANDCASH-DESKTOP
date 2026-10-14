import { Prompt } from '@aeon-ui/react'
import { useEffect, useState } from 'react'
import { useAsyncAction } from '../hooks/useAsyncAction'
import {
  refreshBrc250Approvals,
  subscribeBrc250Approval,
} from '../wallet/brc250/deviceService'
import {
  approvalComparisonCode,
  approveDeviceLogin,
  refuseDeviceLogin,
  type PendingDeviceApproval,
} from '../wallet/brc250/login'
import { WalletActionBar } from './WalletActionBar'

export function GoogleDeviceApprovalPrompt() {
  const [request, setRequest] = useState<PendingDeviceApproval | null>(null)
  const action = useAsyncAction<'approve' | 'refuse'>()

  useEffect(() => subscribeBrc250Approval(setRequest), [])

  const code =
    request?.rA && request.rB
      ? approvalComparisonCode(request, request.rB)
      : null

  const decide = async (kind: 'approve' | 'refuse') => {
    if (!request) return
    await action.run(kind, async () => {
      if (kind === 'approve') await approveDeviceLogin(request)
      else await refuseDeviceLogin(request)
      setRequest(null)
      refreshBrc250Approvals()
    })
  }

  return (
    <div
      data-aeon-scope="google-device-approval"
      data-aeon-state={
        !request ? 'idle' : code ? (action.busy ? 'deciding' : 'comparing') : 'waiting'
      }
    >
      <Prompt.Root
        open={Boolean(request)}
        status={request ? 'pending' : 'dismissed'}
        onOpenChange={(open) => {
          if (!open && request) void decide('refuse')
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            {request ? (
              <Prompt.Content className="panel modal permission-modal">
                <Prompt.Eyebrow>Device login</Prompt.Eyebrow>
                <Prompt.Title>Approve a new HandCash device?</Prompt.Title>
                <Prompt.Description>
                  {request.context || 'A device signed into your Google recovery account.'}
                </Prompt.Description>
                {code ? (
                  <>
                    <p data-aeon-part="comparison-code">{code}</p>
                    <p className="permission-note">
                      Approve only if the new device shows the same eight digits.
                    </p>
                  </>
                ) : (
                  <p className="permission-note">Waiting for the new device to show its code…</p>
                )}
                {action.error ? <p className="error">{action.error}</p> : null}
                <WalletActionBar
                  ariaLabel="Device login decision"
                  secondary={{
                    label: action.running('refuse') ? 'Refusing…' : 'Refuse',
                    onClick: () => void decide('refuse'),
                    disabled: action.busy,
                  }}
                  primary={{
                    label: action.running('approve') ? 'Approving…' : 'Approve device',
                    onClick: () => void decide('approve'),
                    disabled: action.busy || !code,
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
