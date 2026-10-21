import type { ReactNode } from 'react'
import { Composer } from '@aeon-ui/react'
import type { ChatComposerHandle } from '../../features/messages'
import { AttachFileIcon, PayIcon, RequestMoneyIcon, SendIcon } from '../icons'

function ComposerAction({
  title,
  label,
  onClick,
  disabled,
  expanded,
  children,
}: {
  title: string
  label: string
  onClick: () => void
  disabled?: boolean
  expanded?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="chat-action-btn"
      title={title}
      aria-label={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function ChatComposer({
  composer,
  peerLabel,
  canAttach,
}: {
  composer: ChatComposerHandle
  peerLabel: string
  canAttach: boolean
}) {
  const { draft, commandMenu, fileInputRef, inputRef } = composer
  return (
    <Composer.Root
      className="chat-composer"
      state={composer.composerState}
      onSubmit={composer.submit}
      data-aeon-part="brc218-composer"
    >
      {commandMenu && (
        <Composer.Suggestions className="chat-command-menu" aria-label="Commands">
          {commandMenu.map((c) => (
            <li key={c.verb}>
              <Composer.Suggestion onClick={() => composer.insertCommand(c.verb)}>
                <code>/{c.verb}</code>
                <span>{c.hint}</span>
              </Composer.Suggestion>
            </li>
          ))}
        </Composer.Suggestions>
      )}

      <Composer.Toolbar className="chat-composer-toolbar">
        <input
          ref={fileInputRef}
          className="chat-file-input"
          type="file"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => void composer.sendFile(event)}
        />
        <ComposerAction
          title="Attach file (up to 8 MB)"
          label="Attach file"
          disabled={composer.fileBusy || !canAttach}
          onClick={() => fileInputRef.current?.click()}
        >
          <AttachFileIcon size={18} />
        </ComposerAction>
        <ComposerAction
          title="Commands"
          label="Commands"
          expanded={composer.showCommands}
          onClick={composer.toggleCommands}
        >
          /
        </ComposerAction>
        <ComposerAction title="Pay" label="Pay" onClick={() => composer.fillPaymentCommand('pay')}>
          <PayIcon size={18} />
        </ComposerAction>
        <ComposerAction title="Request" label="Request" onClick={() => composer.fillPaymentCommand('request')}>
          <RequestMoneyIcon size={18} />
        </ComposerAction>
      </Composer.Toolbar>

      <Composer.Input
        ref={inputRef}
        className="chat-input"
        placeholder={`Message ${peerLabel}`}
        value={draft}
        onChange={(e) => composer.changeDraft(e.target.value)}
        onKeyDown={composer.keyDown}
        autoComplete="off"
      />
      <Composer.Actions>
        <Composer.Send>
          <button type="submit" className="chat-send-btn" aria-label="Send" disabled={!draft.trim()}>
            <SendIcon size={18} />
          </button>
        </Composer.Send>
      </Composer.Actions>
    </Composer.Root>
  )
}
