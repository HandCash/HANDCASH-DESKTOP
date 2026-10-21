import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { listRecentActivity, subscribeAppActivity } from '../../wallet/appActivity'
import {
  COMMAND_PALETTE,
  helpText,
  matchingCommands,
  normalizeChatText,
  parseLocalCommand,
  type ParsedAmount,
} from '../../wallet/brc218'
import { getDisplayCurrency } from '../../wallet/displayCurrency'
import { copyText } from '../../wallet/clipboard'
import { getFriendById, listFriends, subscribeFriends, type Friend } from '../../wallet/friends'
import { getCachedUsdPerBsv } from '../../wallet/fx'
import { parseHandleInput, resolveHandle } from '../../wallet/handleResolve'
import { subscribeMessageFocus, takeMessageFocus } from '../../wallet/messageFocus'
import {
  appendMessage,
  listMessages,
  markThreadRead,
  messageBelongsInThreadSection,
  updateMessage,
  type ChatMessage,
  type ChatThreadSection,
} from '../../wallet/messageStore'
import {
  encodeMessageBody,
  MAX_CHAT_FILE_BYTES,
  pollInbound,
  preparePeerDirectPath,
} from '../../wallet/messageTransport'
import { openMessagesInbox, openMessagesWithFriend } from '../../wallet/navStore'
import { playWalletSound } from '../../wallet/soundService'
import {
  applyPaymentVerb,
  compactLines,
  composerStateFor,
  isCommandDraft,
  isUnwiredCommand,
  localNote,
  payConfirmRequest,
  paymentTimeline,
  peerActivityOutsideChat,
  resolveAmountSats,
  unwiredCommandNote,
  type ChatPeer,
  type PayConfirmRequest,
} from './chatFormat'
import {
  activeRootKeyHex,
  confirmChatPayment,
  deliverIfUnlocked,
  sendChatFile,
} from './chatOutbox'

/** Which peer's thread is open, kept in step with the route, message focus and the friends list. */
export function useChatPeerSelection(args: {
  peerId?: string
  navRouted: boolean
  threadOnly: boolean
}) {
  const { peerId, navRouted, threadOnly } = args
  const [, setFriendTick] = useState(0)
  const [activePeerId, setActivePeerId] = useState<string | null>(() => peerId ?? null)

  useEffect(() => {
    setActivePeerId(peerId ?? null)
  }, [peerId])

  useEffect(() => subscribeFriends(() => setFriendTick((tick) => tick + 1)), [])

  useEffect(() => {
    if (threadOnly) return
    return subscribeMessageFocus((focused) => {
      if (!focused) return
      setActivePeerId(focused)
      takeMessageFocus()
    })
  }, [threadOnly])

  useEffect(() => {
    if (!activePeerId) return
    markThreadRead(activePeerId)
  }, [activePeerId])

  const selectPeer = (id: string) => {
    playWalletSound('soft')
    if (navRouted) openMessagesWithFriend(id)
    else setActivePeerId(id)
  }

  const backToList = () => {
    playWalletSound('soft')
    if (navRouted) openMessagesInbox()
    else setActivePeerId(null)
  }

  const activeFriend = activePeerId ? getFriendById(activePeerId) : null
  return { activePeerId, activeFriend, selectPeer, backToList }
}

/** The open thread's messages for the selected section, plus wallet payments on the Payments tab. */
export function useThreadMessages(
  activePeerId: string | null,
  activeFriend: Friend | null,
  peers: readonly ChatPeer[],
) {
  const [threadSection, setThreadSection] = useState<ChatThreadSection>('messages')
  const [activityTick, setActivityTick] = useState(0)

  useEffect(() => {
    setThreadSection('messages')
  }, [activePeerId])

  useEffect(() => subscribeAppActivity(() => setActivityTick((n) => n + 1)), [])

  const messages = useMemo(
    () => (activePeerId ? listMessages(activePeerId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- peers tick refreshes store
    [activePeerId, peers],
  )
  const visibleMessages = useMemo(
    () => messages.filter((m) => messageBelongsInThreadSection(m, threadSection)),
    [messages, threadSection],
  )
  const timeline = useMemo(() => {
    if (threadSection !== 'payments') return null
    void activityTick
    const activity = activeFriend
      ? peerActivityOutsideChat(listRecentActivity(500), activeFriend, messages)
      : []
    return paymentTimeline(visibleMessages, activity)
  }, [activeFriend, threadSection, messages, visibleMessages, activityTick])

  return { threadSection, setThreadSection, messages, visibleMessages, timeline }
}

/** Polls the inbox every 20 s and keeps a direct path warm to the open peer. */
export function usePeerInboxPolling(identityKey: string | undefined, activePeerId: string | null): void {
  useEffect(() => {
    if (!identityKey) return
    const friends = listFriends()
    const map = new Map(friends.map((f) => [f.identityKey.toLowerCase(), f.id]))
    const tick = () => {
      const rootKeyHex = activeRootKeyHex()
      if (!rootKeyHex) return
      const friend = activePeerId ? getFriendById(activePeerId) : null
      if (friend) {
        void preparePeerDirectPath({
          rootKeyHex,
          senderIdentityKey: identityKey,
          recipientIdentityKey: friend.identityKey,
          messagebox: friend.messagebox,
        })
      }
      void pollInbound({
        identityKey,
        rootKeyHex,
        peerIdForSender: (ik) => map.get(ik.toLowerCase()) ?? null,
      })
    }
    tick()
    const id = window.setInterval(tick, 20_000)
    return () => window.clearInterval(id)
  }, [identityKey, activePeerId])
}

/** Keeps the thread pinned to the newest message unless the user has scrolled up. */
export function useThreadAutoScroll(
  activePeerId: string | null,
  visibleMessages: readonly ChatMessage[],
  peers: readonly ChatPeer[],
) {
  const threadEndRef = useRef<HTMLDivElement>(null)
  const threadListRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const lastVisibleId = visibleMessages[visibleMessages.length - 1]?.id
  const lastVisibleDirection = visibleMessages[visibleMessages.length - 1]?.direction

  useEffect(() => {
    stickToBottomRef.current = true
  }, [activePeerId])

  useEffect(() => {
    const list = threadListRef.current
    if (!list) return
    const onScroll = () => {
      const remaining = list.scrollHeight - list.scrollTop - list.clientHeight
      stickToBottomRef.current = remaining <= 48
    }
    onScroll()
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => list.removeEventListener('scroll', onScroll)
  }, [activePeerId])

  useEffect(() => {
    const list = threadListRef.current
    if (!list || !activePeerId) return
    const forceFollow = lastVisibleDirection === 'out' || lastVisibleDirection === 'system'
    if (!stickToBottomRef.current && !forceFollow) return

    const pin = () => {
      list.scrollTop = list.scrollHeight
      threadEndRef.current?.scrollIntoView({ block: 'end', inline: 'nearest' })
      stickToBottomRef.current = true
    }
    pin()
    // Layout after images / card mount can grow the list one frame later.
    const raf = window.requestAnimationFrame(pin)
    return () => window.cancelAnimationFrame(raf)
  }, [visibleMessages.length, lastVisibleId, lastVisibleDirection, activePeerId, peers])

  return { threadListRef, threadEndRef }
}

/** Draft, slash commands, pay cards, files and the pay confirm step for the open thread. */
export function useChatComposer(args: {
  identityKey?: string
  activePeerId: string | null
  activeFriend: Friend | null
  messages: readonly ChatMessage[]
  setThreadSection: (section: ChatThreadSection) => void
  onSent?: (balanceSats: number) => void
}) {
  const { identityKey, activePeerId, activeFriend, messages, setThreadSection, onSent } = args
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [showCommands, setShowCommands] = useState(false)
  const [boundMessageId, setBoundMessageId] = useState<string | null>(null)
  const [confirmCmd, setConfirmCmd] = useState<PayConfirmRequest | null>(null)
  /** One exclusive thread mutation: a file upload or a confirmed pay command. */
  const mutation = useAsyncAction<'file' | 'pay'>()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setBoundMessageId(null)
  }, [activePeerId])

  const commandHints = useMemo(() => matchingCommands(draft), [draft])
  const composerState = useMemo(() => composerStateFor(draft), [draft])
  const commandMenu = showCommands
    ? COMMAND_PALETTE
    : isCommandDraft(draft) && commandHints.length > 0
      ? commandHints
      : null

  const focusInput = () => requestAnimationFrame(() => inputRef.current?.focus())

  const findMessage = (id: string) => messages.find((m) => m.id === id)

  const queuePay = (
    friend: Friend,
    amount: ParsedAmount,
    memo?: string,
    kind: 'pay-sent' | 'tip' = 'pay-sent',
    bindId?: string | null,
  ) => {
    const resolved = resolveAmountSats(amount, getCachedUsdPerBsv())
    if (!resolved.sats || resolved.sats <= 0) {
      setHint(
        amount.kind === 'fiat' && getCachedUsdPerBsv() == null
          ? 'USD rate unavailable — try 1 sat or BSV'
          : 'Amount too small — try 1 sat or more',
      )
      playWalletSound('error')
      return
    }
    appendMessage(friend.id, {
      direction: 'out',
      kind,
      text: kind === 'tip' ? memo || 'Tip' : `Pay ${resolved.amountLabel ?? amount.label}`,
      meta: {
        amountLabel: resolved.amountLabel ?? amount.label,
        sats: resolved.sats,
        payeeIdentityKey: friend.identityKey,
        friendLabel: friend.label,
        memo,
        boundMessageId: kind === 'tip' ? bindId || undefined : undefined,
        payStatus: 'pending',
        status: 'Confirm to send',
        chatRef: true,
      },
    })
    if (kind === 'tip') setBoundMessageId(null)
    playWalletSound('soft')
  }

  const cancelPay = (messageId: string) => {
    const msg = findMessage(messageId)
    if (!msg || msg.meta?.payStatus !== 'pending') return
    updateMessage(messageId, { meta: { payStatus: 'cancelled', status: 'Cancelled' } })
    playWalletSound('soft')
  }

  const acceptEscrow = (messageId: string) => {
    updateMessage(messageId, {
      meta: {
        payStatus: 'accepted',
        status: 'Accepted — agent hold (local stub until BRC-218 §5.21 custody)',
      },
    })
    playWalletSound('soft')
  }

  const declineEscrow = (messageId: string) => {
    updateMessage(messageId, { meta: { payStatus: 'declined', status: 'Declined' } })
    playWalletSound('soft')
  }

  const requestPayConfirm = (messageId: string) => {
    const msg = findMessage(messageId)
    if (!msg) return
    setConfirmCmd(payConfirmRequest(msg))
  }

  const cancelPayConfirm = () => {
    if (mutation.running('pay')) return
    setConfirmCmd(null)
  }

  const confirmPayConfirm = () => {
    if (!confirmCmd) return
    void mutation
      .run('pay', async () => {
        const msg = findMessage(confirmCmd.id)
        if (!msg || msg.meta?.payStatus !== 'pending') return
        await confirmChatPayment(msg, { identityKey, onHint: setHint, onSent })
      })
      .then((outcome) => {
        if (!('refused' in outcome)) setConfirmCmd(null)
      })
  }

  const bindReply = (messageId: string) => {
    setBoundMessageId(messageId)
    setDraft('/tip ')
    setHint(`Bound tip to message ${messageId.slice(0, 8)}…`)
    playWalletSound('soft')
    focusInput()
  }

  const fillPaymentCommand = (verb: 'pay' | 'request') => {
    if (!activeFriend) return
    setHint(null)
    setShowCommands(false)
    let cursor = 0
    setDraft((prev) => {
      const next = applyPaymentVerb(prev, verb, getDisplayCurrency())
      cursor = next.cursor
      return next.draft
    })
    playWalletSound('soft')
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(cursor, cursor)
    })
  }

  const insertCommand = (verb: string) => {
    setShowCommands(false)
    setDraft(`/${verb} `)
    playWalletSound('soft')
    focusInput()
  }

  const toggleCommands = () => {
    setShowCommands((v) => !v)
    if (!draft.startsWith('/')) setDraft('/')
    playWalletSound('soft')
    focusInput()
  }

  const changeDraft = (value: string) => {
    setDraft(value)
    if (!value.startsWith('/')) setShowCommands(false)
  }

  const addSystemNote = (peerId: string, text: string, kind: 'system' | 'whois' = 'system', meta?: ChatMessage['meta']) =>
    appendMessage(peerId, { direction: 'system', kind, text, ...(meta ? { meta } : {}) })

  const whois = async (recipient?: string) => {
    if (!activeFriend && !recipient) return
    setHint(null)
    const target = recipient?.trim() || activeFriend?.label || ''
    if (parseHandleInput(target) || target.startsWith('$') || target.startsWith('@')) {
      const notePeerId = activePeerId || activeFriend!.id
      try {
        const resolved = await resolveHandle(/^(?:@\$|[$@])/.test(target) ? target : `$${target}`)
        addSystemNote(
          notePeerId,
          localNote(resolved.display, resolved.identityKey, `domain: ${resolved.domain}`),
          'whois',
          { handleDisplay: resolved.display, identityKey: resolved.identityKey },
        )
        playWalletSound('soft')
      } catch (err) {
        addSystemNote(notePeerId, localNote(err instanceof Error ? err.message : String(err)))
        playWalletSound('error')
      }
      return
    }

    if (!activeFriend) return
    const ok = await copyText(activeFriend.identityKey)
    addSystemNote(
      activeFriend.id,
      localNote(
        ...compactLines([
          activeFriend.label,
          activeFriend.identityKey,
          ok ? 'Copied wallet key' : null,
        ]),
      ),
      'whois',
      { identityKey: activeFriend.identityKey },
    )
    playWalletSound(ok ? 'copy' : 'soft')
  }

  const sendPlain = (peerId: string, friend: Friend, text: string) => {
    appendMessage(peerId, { direction: 'out', kind: 'text', text })
    deliverIfUnlocked(friend, identityKey, text, peerId)
    playWalletSound('soft')
  }

  const sendFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !activeFriend || !identityKey) return
    if (file.size > MAX_CHAT_FILE_BYTES) {
      setHint('Files are limited to 8 MB.')
      playWalletSound('error')
      return
    }

    setHint(`Uploading ${file.name}…`)
    const outcome = await mutation.run('file', async () => {
      await sendChatFile(file, activeFriend, identityKey)
      setHint(null)
      setThreadSection('messages')
      playWalletSound('soft')
    })
    if (!outcome.ok) {
      if (outcome.error !== null) {
        setHint(outcome.error)
        playWalletSound('error')
      } else {
        setHint(null)
      }
    }
  }

  /** Runs one line typed in the composer; returns false when the draft should stay for a fix. */
  const runLine = (line: string, peerId: string, friend: Friend): boolean => {
    if (line.startsWith('//')) {
      sendPlain(peerId, friend, normalizeChatText(line))
      return true
    }

    const cmd = parseLocalCommand(line)
    if (cmd?.verb === 'pay' || cmd?.verb === 'tip') {
      if (!cmd.amount) {
        setHint('Add an amount, e.g. /pay $0.01 or /pay 1 sat')
        playWalletSound('error')
        return false
      }
      queuePay(
        friend,
        cmd.amount,
        cmd.verb === 'pay' ? cmd.memo : undefined,
        cmd.verb === 'tip' ? 'tip' : 'pay-sent',
        cmd.verb === 'tip' ? boundMessageId : null,
      )
      return true
    }
    if (cmd?.verb === 'request') {
      if (!cmd.amount) {
        setHint('Add an amount, e.g. /request $0.01 or /request 1 sat')
        playWalletSound('error')
        return false
      }
      const resolved = resolveAmountSats(cmd.amount, getCachedUsdPerBsv())
      const request = appendMessage(friend.id, {
        direction: 'out',
        kind: 'pay-request',
        text: cmd.memo || cmd.amount.label,
        meta: {
          amountLabel: resolved.amountLabel ?? cmd.amount.label,
          sats: resolved.sats,
          status: 'Request',
        },
      })
      deliverIfUnlocked(friend, identityKey, encodeMessageBody(request))
      playWalletSound('soft')
      return true
    }
    if (cmd?.verb === 'escrow') {
      if (!cmd.amount) {
        setHint('Add an amount, e.g. /escrow 1000 sats')
        playWalletSound('error')
        return false
      }
      const resolved = resolveAmountSats(cmd.amount, getCachedUsdPerBsv())
      appendMessage(friend.id, {
        direction: 'out',
        kind: 'escrow',
        text: `Escrow ${resolved.amountLabel ?? cmd.amount.label}`,
        meta: {
          amountLabel: resolved.amountLabel ?? cmd.amount.label,
          sats: resolved.sats,
          memo: cmd.memo,
          escrowAsset: cmd.asset,
          payStatus: 'pending',
          status: 'Awaiting accept',
          commandRaw: line,
        },
      })
      playWalletSound('soft')
      return true
    }
    if (cmd?.verb === 'whois') {
      void whois(cmd.recipient)
      return true
    }
    if (cmd?.verb === 'help') {
      addSystemNote(peerId, helpText())
      playWalletSound('soft')
      return true
    }
    if (cmd?.verb === 'message' && cmd.text.trim()) {
      sendPlain(peerId, friend, cmd.text.trim())
      return true
    }
    if (isUnwiredCommand(cmd)) {
      addSystemNote(peerId, unwiredCommandNote(cmd), 'system', { commandRaw: line })
      playWalletSound('soft')
      return true
    }
    if (cmd?.verb === 'unsupported') {
      addSystemNote(peerId, localNote(`/${cmd.name} is not supported in this client.`))
      playWalletSound('soft')
      return true
    }

    sendPlain(peerId, friend, line)
    return true
  }

  const sendText = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line || !activePeerId || !activeFriend) return
    setHint(null)
    setShowCommands(false)
    if (runLine(line, activePeerId, activeFriend)) setDraft('')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    sendText(draft)
  }

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendText(draft)
    }
  }

  return {
    draft,
    hint,
    showCommands,
    commandMenu,
    composerState,
    confirmCmd,
    confirming: mutation.running('pay'),
    fileBusy: mutation.running('file'),
    inputRef,
    fileInputRef,
    cancelPay,
    acceptEscrow,
    declineEscrow,
    requestPayConfirm,
    cancelPayConfirm,
    confirmPayConfirm,
    bindReply,
    fillPaymentCommand,
    insertCommand,
    toggleCommands,
    changeDraft,
    sendFile,
    submit,
    keyDown,
  }
}

export type ChatComposerHandle = ReturnType<typeof useChatComposer>
