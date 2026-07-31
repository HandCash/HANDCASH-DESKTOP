import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Prompt } from '@aeon-ui/react'
import { useUpdate } from '../wallet/updateProvider'
import { playWalletSound } from '../wallet/soundService'

type ToastAction = 'download' | 'restart' | null

type ToastCopy = {
  title: string
  body: string
  action: ToastAction
  dismissable: boolean
  sticky: boolean
}

function toastCopy(
  phase: string,
  version: string | null,
  percent: number | null,
  error: string | null,
  fromCheck: boolean,
  macManual: boolean,
): ToastCopy | null {
  if (phase === 'ready') {
    return {
      title: 'Update ready',
      body: `HandCash Desktop ${version ?? ''} is ready to install.`,
      action: 'restart',
      dismissable: true,
      sticky: true,
    }
  }
  if (phase === 'downloading') {
    return {
      title: macManual ? 'Opening installer…' : 'Downloading update…',
      body: macManual
        ? `HandCash Desktop ${version ?? ''} — your browser will download the DMG.`
        : `${version ?? 'Update'} — ${percent ?? 0}%`,
      action: null,
      dismissable: false,
      sticky: true,
    }
  }
  if (phase === 'available') {
    if (macManual) {
      return {
        title: 'Update available',
        body:
          error ??
          `HandCash Desktop ${version ?? ''} is ready. Get the installer — drag HandCash into Applications.`,
        action: 'download',
        dismissable: true,
        sticky: true,
      }
    }
    return {
      title: 'Update available',
      body: `HandCash Desktop ${version ?? ''} is available.`,
      action: 'download',
      dismissable: true,
      sticky: true,
    }
  }
  if (phase === 'checking') {
    return {
      title: 'Checking for updates…',
      body: 'Looking for a newer HandCash Desktop build.',
      action: null,
      dismissable: false,
      sticky: true,
    }
  }
  if (phase === 'error') {
    return {
      title: 'Update check failed',
      body: error ?? 'Something went wrong while checking for updates.',
      action: null,
      dismissable: true,
      sticky: false,
    }
  }
  if (phase === 'not-available' && fromCheck) {
    return {
      title: 'Up to date',
      body: error ?? "You're on the latest HandCash Desktop.",
      action: null,
      dismissable: true,
      sticky: false,
    }
  }
  return null
}

/** Cursor-style update UX — bottom-right toast projected from appUpdate. */
export function UpdatePrompt() {
  const update = useUpdate()
  const { context, promptOpen, download, install, dismissPrompt } = update
  const [mounted, setMounted] = useState(false)
  const [userDismissed, setUserDismissed] = useState(false)
  const prevPhase = useRef(context.phase)
  const [fromCheck, setFromCheck] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const prev = prevPhase.current
    prevPhase.current = context.phase
    if (prev !== context.phase) setUserDismissed(false)

    if (context.phase === 'checking') {
      setFromCheck(true)
      return
    }
    if (
      context.phase === 'available' ||
      context.phase === 'downloading' ||
      context.phase === 'ready'
    ) {
      if (prev !== context.phase) {
        if (context.phase === 'ready' || context.phase === 'available') {
          playWalletSound('soft')
        }
      }
      setFromCheck(false)
      return
    }
    if (context.phase === 'error' && prev !== 'error') {
      playWalletSound('error')
    }
    if (context.phase === 'idle') {
      setFromCheck(false)
    }
  }, [context.phase])

  const macManual = window.handcash?.platform === 'darwin'
  const copy = toastCopy(
    context.phase,
    context.availableVersion,
    context.percent,
    context.error,
    fromCheck,
    macManual,
  )
  const visible = Boolean(copy && !userDismissed)

  useEffect(() => {
    if (!copy || copy.sticky || userDismissed) return
    const timer = window.setTimeout(() => {
      setUserDismissed(true)
      setFromCheck(false)
    }, 6000)
    return () => window.clearTimeout(timer)
  }, [copy, context.phase, userDismissed])

  const dismissToast = () => {
    if (context.phase === 'ready') dismissPrompt()
    setUserDismissed(true)
    if (!copy?.sticky) setFromCheck(false)
  }

  return (
    <div data-aeon-scope="app-update" data-aeon-state={update.stateAttr}>
      {mounted && visible && copy
        ? createPortal(
            <div
              className="aeonToast__viewport update-toast-viewport"
              data-aeon-scope="toast"
              data-aeon-part="viewport"
              data-aeon-state="active"
              data-placement="bottom-end"
            >
              <div
                className="aeonToast__root update-toast"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                data-aeon-scope="toast"
                data-aeon-part="root"
                data-aeon-state={context.phase}
              >
                <p className="aeonToast__title" data-aeon-scope="toast" data-aeon-part="title">
                  {copy.title}
                </p>
                <p
                  className="aeonToast__description"
                  data-aeon-scope="toast"
                  data-aeon-part="description"
                >
                  {copy.body}
                </p>
                {copy.action ? (
                  <div className="update-toast-actions">
                    {copy.action === 'download' ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void download()}
                      >
                        {macManual ? 'Get update' : 'Update'}
                      </button>
                    ) : null}
                    {copy.action === 'restart' ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void install()}
                      >
                        Restart to Update
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {copy.dismissable ? (
                  <button
                    type="button"
                    className="aeonToast__closeTrigger"
                    data-aeon-scope="toast"
                    data-aeon-part="closeTrigger"
                    aria-label="Dismiss"
                    onClick={dismissToast}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}

      <Prompt.Root open={promptOpen} status={promptOpen ? 'pending' : 'dismissed'}>
        <Prompt.Portal>
          <Prompt.Backdrop />
          <Prompt.Positioner>
            <Prompt.Content className="panel modal update-prompt-modal">
              <Prompt.Eyebrow>Security</Prompt.Eyebrow>
              <Prompt.Title>Restart to Update</Prompt.Title>
              <Prompt.Description>
                HandCash Desktop <strong>{context.availableVersion}</strong> has been downloaded and
                is ready to install.
              </Prompt.Description>
              <Prompt.Actions>
                <Prompt.Secondary className="btn btn-ghost" onClick={dismissPrompt}>
                  Later
                </Prompt.Secondary>
                <Prompt.Primary className="btn btn-primary" onClick={() => void install()}>
                  Restart to Update
                </Prompt.Primary>
              </Prompt.Actions>
            </Prompt.Content>
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>
    </div>
  )
}
