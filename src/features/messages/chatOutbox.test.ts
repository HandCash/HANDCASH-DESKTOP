import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rootKeyHex: 'root' as string | undefined,
  deliverOutbound: vi.fn(),
  uploadChatFile: vi.fn(),
  sendBrc29ToIdentityKey: vi.fn(),
  sendSatsToAddress: vi.fn(),
  updateMessage: vi.fn(),
  appendMessage: vi.fn(),
  getFriendById: vi.fn(),
}))

vi.mock('../../wallet/session', () => ({
  getActiveWallet: () => (mocks.rootKeyHex ? { rootKeyHex: mocks.rootKeyHex } : null),
}))
vi.mock('../../wallet/messageTransport', () => ({
  deliverOutbound: mocks.deliverOutbound,
  uploadChatFile: mocks.uploadChatFile,
  encodeMessageBody: (m: { kind: string; text: string }) => `wire:${m.kind}:${m.text}`,
}))
vi.mock('../../wallet/messageStore', () => ({
  updateMessage: mocks.updateMessage,
  appendMessage: mocks.appendMessage,
}))
vi.mock('../../wallet/friends', () => ({ getFriendById: mocks.getFriendById }))
vi.mock('../../wallet/sendBrc29Payment', () => ({ sendBrc29ToIdentityKey: mocks.sendBrc29ToIdentityKey }))
vi.mock('../../wallet/sendPayment', () => ({ sendSatsToAddress: mocks.sendSatsToAddress }))
vi.mock('../../wallet/soundService', () => ({ playWalletSound: vi.fn() }))
vi.mock('../../wallet/paymentSuccessSound', () => ({ playPaymentSuccessSound: vi.fn() }))

import type { ChatMessage } from '../../wallet/messageStore'
import { confirmChatPayment, deliverIfUnlocked, sendChatFile, sendChatPayment } from './chatOutbox'

const FRIEND = { id: 'f1', label: 'Alice', identityKey: 'PEER', createdAt: 0, messagebox: 'https://box' }

function card(meta: ChatMessage['meta']): ChatMessage {
  return { id: 'm1', peerId: 'f1', direction: 'out', kind: 'pay-sent', text: 'Pay', createdAt: 1, meta }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rootKeyHex = 'root'
  mocks.deliverOutbound.mockResolvedValue({ delivered: 'cloud', messagebox: 'https://box' })
  mocks.updateMessage.mockImplementation((id: string, patch: Partial<ChatMessage>) => ({ ...card({}), id, ...patch }))
  mocks.getFriendById.mockReturnValue(FRIEND)
})

describe('deliverIfUnlocked', () => {
  it('delivers to the friend with their messagebox', () => {
    deliverIfUnlocked(FRIEND, 'ME', 'hello')
    expect(mocks.deliverOutbound).toHaveBeenCalledWith({
      recipientIdentityKey: 'PEER',
      senderIdentityKey: 'ME',
      rootKeyHex: 'root',
      body: 'hello',
      peerId: 'f1',
      messagebox: 'https://box',
    })
  })

  it('stays local without an identity or with the wallet locked', () => {
    deliverIfUnlocked(FRIEND, undefined, 'hello')
    mocks.rootKeyHex = undefined
    deliverIfUnlocked(FRIEND, 'ME', 'hello')
    expect(mocks.deliverOutbound).not.toHaveBeenCalled()
  })
})

describe('sendChatPayment', () => {
  it('pays an identity key over BRC-29 and returns its remittance', async () => {
    mocks.sendBrc29ToIdentityKey.mockResolvedValue({
      txid: 't1',
      balanceSats: 9,
      remittance: { derivationPrefix: 'p', derivationSuffix: 's' },
    })
    await expect(sendChatPayment({ payeeKey: 'PEER', sats: 5, memo: 'lunch' })).resolves.toEqual({
      txid: 't1',
      balanceSats: 9,
      brc29: { derivationPrefix: 'p', derivationSuffix: 's', outputIndex: 0 },
    })
    expect(mocks.sendBrc29ToIdentityKey).toHaveBeenCalledWith(
      expect.objectContaining({ payeeIdentityKey: 'PEER', satoshis: 5, description: 'HandCash messages: lunch', chatRef: true }),
    )
  })

  it('pays an address when there is no payee key', async () => {
    mocks.sendSatsToAddress.mockResolvedValue({ txid: 't2', balanceSats: 3 })
    await expect(sendChatPayment({ payeeKey: null, to: 'addr', sats: 5 })).resolves.toEqual({
      txid: 't2',
      balanceSats: 3,
    })
    expect(mocks.sendSatsToAddress).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'addr', description: 'HandCash messages pay to addr' }),
    )
  })
})

describe('confirmChatPayment', () => {
  it('fails the card when payment details are missing', async () => {
    await confirmChatPayment(card({ sats: 5 }), { onHint: vi.fn() })
    expect(mocks.updateMessage).toHaveBeenCalledWith('m1', {
      meta: { payStatus: 'failed', status: 'Failed', error: 'Missing payment details' },
    })
  })

  it('marks a BRC-29 payment sent without a second chat delivery', async () => {
    mocks.sendBrc29ToIdentityKey.mockResolvedValue({
      txid: 't1',
      balanceSats: 9,
      remittance: { derivationPrefix: 'p', derivationSuffix: 's', outputIndex: 1 },
    })
    const onSent = vi.fn()
    await confirmChatPayment(card({ sats: 5, payeeIdentityKey: 'PEER' }), { identityKey: 'ME', onHint: vi.fn(), onSent })
    expect(mocks.updateMessage).toHaveBeenLastCalledWith('m1', {
      meta: {
        payStatus: 'sent',
        status: 'Sent',
        txid: 't1',
        brc29: { derivationPrefix: 'p', derivationSuffix: 's', outputIndex: 1 },
        error: undefined,
      },
    })
    expect(mocks.deliverOutbound).not.toHaveBeenCalled()
    expect(onSent).toHaveBeenCalledWith(9)
  })

  it('delivers the card after an address payment and hints when it stays local', async () => {
    mocks.sendSatsToAddress.mockResolvedValue({ txid: 't2', balanceSats: 3 })
    mocks.deliverOutbound.mockResolvedValue({ delivered: 'local', messagebox: 'https://box' })
    const onHint = vi.fn()
    await confirmChatPayment(card({ sats: 5, to: 'addr' }), { identityKey: 'ME', onHint })
    expect(mocks.deliverOutbound).toHaveBeenCalledWith(expect.objectContaining({ peerId: 'f1', body: 'wire:pay-sent:Pay' }))
    expect(onHint).toHaveBeenCalledWith('Payment sent on-chain, but the chat card could not be delivered yet.')
  })

  it('does not deliver a payment to yourself', async () => {
    mocks.sendSatsToAddress.mockResolvedValue({ txid: 't2', balanceSats: 3 })
    await confirmChatPayment(card({ sats: 5, to: 'addr' }), { identityKey: 'peer', onHint: vi.fn() })
    expect(mocks.deliverOutbound).not.toHaveBeenCalled()
  })

  it('records a send failure on the card', async () => {
    mocks.sendSatsToAddress.mockRejectedValue(new Error('no funds'))
    await confirmChatPayment(card({ sats: 5, to: 'addr' }), { identityKey: 'ME', onHint: vi.fn() })
    expect(mocks.updateMessage).toHaveBeenLastCalledWith('m1', {
      meta: { payStatus: 'failed', status: 'Failed', error: 'no funds' },
    })
  })
})

describe('sendChatFile', () => {
  const file = { name: 'a.txt', size: 3 } as File

  it('uploads, delivers, then appends the file card', async () => {
    const attachment = { name: 'a.txt', contentType: 'text/plain', size: 3, url: 'https://f' }
    mocks.uploadChatFile.mockResolvedValue(attachment)
    await sendChatFile(file, FRIEND, 'ME')
    expect(mocks.deliverOutbound).toHaveBeenCalledWith(expect.objectContaining({ body: 'wire:file:a.txt' }))
    expect(mocks.appendMessage).toHaveBeenCalledWith('f1', {
      direction: 'out',
      kind: 'file',
      text: 'a.txt',
      meta: { attachment, status: 'Sent file' },
    })
  })

  it('throws without appending when delivery stays local or the wallet is locked', async () => {
    mocks.uploadChatFile.mockResolvedValue({ name: 'a.txt', contentType: 'text/plain', size: 3, url: 'u' })
    mocks.deliverOutbound.mockResolvedValue({ delivered: 'local', messagebox: 'https://box' })
    await expect(sendChatFile(file, FRIEND, 'ME')).rejects.toThrow('could not be delivered')
    mocks.rootKeyHex = undefined
    await expect(sendChatFile(file, FRIEND, 'ME')).rejects.toThrow('Wallet locked')
    expect(mocks.appendMessage).not.toHaveBeenCalled()
  })
})
