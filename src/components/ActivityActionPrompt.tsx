import { Prompt } from '@aeon-ui/react'
import type { ActivityActionHandle } from '../hooks/useActivityAction'

type Props = {
  action: ActivityActionHandle
}

/**
 * Confirm step for an Activity mutation, projected from `activityActionMachine`
 * (`confirming` → open). Replaces `window.confirm`: the copy lives in the chart
 * context and the decision is an event, so the buttons behind it stay disabled
 * for the same reason the Prompt is open.
 */
export function ActivityActionPrompt({ action }: Props) {
  const { confirm } = action
  const open = confirm !== null
  return (
    <Prompt.Root
      open={open}
      status="pending"
      onOpenChange={(next) => {
        if (!next) action.cancelPending()
      }}
    >
      <Prompt.Portal>
        <Prompt.Backdrop className="permission-backdrop" />
        <Prompt.Positioner className="permission-positioner">
          <Prompt.Content
            className="panel modal permission-modal"
            data-aeon-part="activity-action-confirm"
            data-aeon-state={action.stateAttr}
          >
            <Prompt.Title>{confirm?.title}</Prompt.Title>
            <Prompt.Effect>{confirm?.body}</Prompt.Effect>
            <Prompt.Actions className="actions">
              <Prompt.Secondary
                type="button"
                className="btn btn-ghost"
                onClick={action.cancelPending}
              >
                Cancel
              </Prompt.Secondary>
              <Prompt.Primary
                type="button"
                className={confirm?.danger ? 'btn btn-danger' : 'btn btn-primary'}
                onClick={action.confirmPending}
              >
                {confirm?.confirmLabel}
              </Prompt.Primary>
            </Prompt.Actions>
          </Prompt.Content>
        </Prompt.Positioner>
      </Prompt.Portal>
    </Prompt.Root>
  )
}
