import { Prompt, StatusBanner } from '@aeon-ui/react'
import { useUpdate } from '../wallet/updateProvider'

function bannerCopy(phase: string, version: string | null, percent: number | null) {
  if (phase === 'ready') {
    return {
      title: 'Update ready',
      body: `HandCash Desktop ${version ?? ''} is ready to install.`,
      action: 'restart' as const,
    }
  }
  if (phase === 'downloading') {
    return {
      title: 'Downloading update…',
      body: `${version ?? ''} — ${percent ?? 0}%`,
      action: null,
    }
  }
  if (phase === 'available') {
    return {
      title: 'Update available',
      body: `HandCash Desktop ${version ?? ''} is available.`,
      action: 'download' as const,
    }
  }
  return null
}

/** Cursor-style update UX projected from appUpdate statechart. */
export function UpdatePrompt() {
  const update = useUpdate()
  const { context, promptOpen, download, install, dismissPrompt } = update
  const copy = bannerCopy(context.phase, context.availableVersion, context.percent)

  return (
    <div data-aeon-scope="app-update" data-aeon-state={update.stateAttr}>
      {copy ? (
        <StatusBanner.Root tone="info" status={context.phase}>
          <StatusBanner.Copy>
            <StatusBanner.Title>{copy.title}</StatusBanner.Title>
            <StatusBanner.Body>{copy.body}</StatusBanner.Body>
          </StatusBanner.Copy>
          <StatusBanner.Actions>
            {copy.action === 'download' ? (
              <StatusBanner.Action className="btn btn-primary" onClick={() => void download()}>
                Update
              </StatusBanner.Action>
            ) : null}
            {copy.action === 'restart' ? (
              <StatusBanner.Action className="btn btn-primary" onClick={() => void install()}>
                Restart to Update
              </StatusBanner.Action>
            ) : null}
          </StatusBanner.Actions>
        </StatusBanner.Root>
      ) : null}

      <Prompt.Root open={promptOpen} status={promptOpen ? 'pending' : 'dismissed'}>
        <Prompt.Portal>
          <Prompt.Backdrop />
          <Prompt.Positioner>
            <Prompt.Content className="modal update-prompt-modal">
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
