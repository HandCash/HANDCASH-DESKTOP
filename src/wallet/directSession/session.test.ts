import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { signSessionOffer, signSessionWelcome, signSessionHello } from './protocol'
import {
  installDirectSessionPort,
  rememberSessionOffer,
  resetDirectSessions,
  setDirectSessionIdentity,
  tryDirectDeliver,
  type DirectSessionPort,
} from './session'

const HOST = '2001:db8:2::8'

function keys() {
  const a = PrivateKey.fromRandom()
  const b = PrivateKey.fromRandom()
  const aKey = a.toPublicKey().toString().toLowerCase()
  const bKey = b.toPublicKey().toString().toLowerCase()
  const dialer = aKey < bKey ? a : b
  const acceptor = aKey < bKey ? b : a
  return {
    dialer,
    acceptor,
    dialerKey: dialer.toPublicKey().toString().toLowerCase(),
    acceptorKey: acceptor.toPublicKey().toString().toLowerCase(),
  }
}

describe('session race', () => {
  it('falls through immediately on connection refused and does not wait the budget', async () => {
    const { dialer, acceptor, dialerKey, acceptorKey } = keys()
    setDirectSessionIdentity({ rootKeyHex: dialer.toHex(), identityKey: dialerKey })
    const offer = signSessionOffer({
      rootKeyHex: acceptor.toHex(),
      counterparty: dialerKey,
      host: HOST,
      port: 9,
    })
    rememberSessionOffer(offer)
    let waited = false
    const port: DirectSessionPort = {
      listen: async () => null,
      connect: async () => {
        await new Promise((r) => setTimeout(r, 20))
        waited = true
        return { ok: false, immediate: true }
      },
      send: async () => false,
      close: async () => undefined,
      accept: async () => undefined,
      reject: async () => undefined,
    }
    installDirectSessionPort(port)
    const started = Date.now()
    const result = await tryDirectDeliver({
      recipientIdentityKey: acceptorKey,
      body: 'hello',
    })
    expect(result).toBe('box')
    expect(waited).toBe(true)
    expect(Date.now() - started).toBeLessThan(250)
    resetDirectSessions()
    installDirectSessionPort(null)
  })

  it('sends on the socket when the handshake finishes inside the budget', async () => {
    const { dialer, acceptor, dialerKey, acceptorKey } = keys()
    setDirectSessionIdentity({ rootKeyHex: dialer.toHex(), identityKey: dialerKey })
    const offer = signSessionOffer({
      rootKeyHex: acceptor.toHex(),
      counterparty: dialerKey,
      host: HOST,
      port: 9,
    })
    rememberSessionOffer(offer)
    const sent: string[] = []
    const port: DirectSessionPort = {
      listen: async () => null,
      connect: async (args) => {
        const parsed = JSON.parse(args.hello) as ReturnType<typeof signSessionHello>
        const welcome = signSessionWelcome({
          rootKeyHex: acceptor.toHex(),
          hello: parsed,
        })
        return { ok: true, remoteHello: JSON.stringify(welcome), socketId: 'sock' }
      },
      send: async (_id, body) => {
        sent.push(body)
        return true
      },
      close: async () => undefined,
      accept: async () => undefined,
      reject: async () => undefined,
    }
    installDirectSessionPort(port)
    const result = await tryDirectDeliver({
      recipientIdentityKey: acceptorKey,
      body: 'payload',
    })
    expect(result).toBe('direct')
    expect(sent).toEqual(['payload'])
    resetDirectSessions()
    installDirectSessionPort(null)
  })
})
