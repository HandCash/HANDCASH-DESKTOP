import { Button } from '@aeon-ui/react'
import {
  updateView,
  type UpdateEscape,
  type UpdateView,
  type UpdateViewAction,
} from '../machines/updateMachine'
import { useUpdate } from '../wallet/updateProvider'

/**
 * Title bar update control: one solid pill in every state (Alignity mechanism).
 * Feeds HandCash's own release channel via window.handcash — never Alignity's.
 */
export function UpdatePill({
  view,
  onAction,
}: {
  view: UpdateView
  onAction: (action: UpdateViewAction) => void
}) {
  const { action } = view
  const percent = view.progress === null ? null : Math.round(view.progress * 100)
  return (
    <>
      <Button.Root
        variant="solid"
        size="sm"
        title={view.title}
        disabled={action === null}
        onClick={() => {
          if (action) onAction(action)
        }}
        data-aeon-scope="handcash-update"
        data-aeon-part="root"
        data-aeon-state={view.state}
        className="handcash-update-pill"
      >
        {percent !== null && (
          <span
            data-aeon-part="fill"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            style={{ width: `${percent}%` }}
          />
        )}
        <span data-aeon-part="label">{view.label}</span>
      </Button.Root>
      {view.escapes?.map((escape: UpdateEscape) => (
        <Button.Root
          key={escape.event}
          variant="ghost"
          size="sm"
          title={escape.title}
          onClick={() => onAction(escape.event)}
          data-aeon-scope="handcash-update"
          data-aeon-part="escape"
          data-aeon-state="dismiss"
          className="handcash-update-escape"
        >
          {escape.label}
        </Button.Root>
      ))}
    </>
  )
}

export function UpdateControl() {
  const update = useUpdate()
  const { context, check, download, install, dismissPrompt } = update
  const platform = window.handcash?.platform
  const sideloadManual =
    platform === 'darwin' || platform === 'android' || platform === 'ios'
  const view = updateView(context.phase, context, { sideloadManual })

  if (!view) return null

  const onAction = (action: UpdateViewAction) => {
    switch (action) {
      case 'DOWNLOAD':
        void download()
        return
      case 'INSTALL':
        void install()
        return
      case 'CHECK':
        void check()
        return
      case 'DISMISS':
        dismissPrompt()
        return
    }
  }

  return (
    <div
      className="handcash-update-cluster"
      data-aeon-scope="handcash-update"
      data-aeon-part="cluster"
      data-aeon-state={update.stateAttr}
    >
      <UpdatePill view={view} onAction={onAction} />
    </div>
  )
}
