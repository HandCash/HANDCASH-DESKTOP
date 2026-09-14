import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  decodeSessionOffer,
  encodeSessionOffer,
  isGlobalUnicastIpv6,
  isImmediateConnectFailure,
  sessionConnector,
  signSessionHello,
  signSessionOffer,
  signSessionWelcome,
  verifySessionHello,
  verifySessionOffer,
  verifySessionWelcome,
  weDial,
} from './protocol'

const HOST = '2001:db8:1::10'

function pair() {
  const dialer = PrivateKey.fromRandom()
  const listener = PrivateKey.fromRandom()
  const dialerKey = dialer.toPublicKey().toString().toLowerCase()
  const listenerKey = listener.toPublicKey().toString().toLowerCase()
  const lower = sessionConnector(dialerKey, listenerKey)
  const dialerIsLower = lower === dialerKey
  return {
    dialer,
    listener,
    dialerKey,
    listenerKey,
    connector: dialerIsLower ? dialer : listener,
    acceptor: dialerIsLower ? listener : dialer,
    connectorKey: dialerIsLower ? dialerKey : listenerKey,
    acceptorKey: dialerIsLower ? listenerKey : dialerKey,
  }
}

describe('session upgrade protocol', () => {
  it('accepts global unicast and rejects link-local, ULA, and loopback', () => {
    expect(isGlobalUnicastIpv6('2001:db8::1')).toBe(true)
    expect(isGlobalUnicastIpv6('fe80::1')).toBe(false)
    expect(isGlobalUnicastIpv6('fd00::1')).toBe(false)
    expect(isGlobalUnicastIpv6('::1')).toBe(false)
  })

  it('the lower identity key is the only dialer', () => {
    const { connectorKey, acceptorKey } = pair()
    expect(weDial(connectorKey, acceptorKey)).toBe(true)
    expect(weDial(acceptorKey, connectorKey)).toBe(false)
  })

  it('binds an offer to one counterparty and rejects a replay to someone else', () => {
    const { connector, acceptorKey, connectorKey } = pair()
    const offer = signSessionOffer({
      rootKeyHex: connector.toHex(),
      counterparty: acceptorKey,
      host: HOST,
      port: 3342,
    })
    expect(verifySessionOffer(offer, { localIdentity: acceptorKey })).toBe(true)
    expect(verifySessionOffer(offer, { localIdentity: connectorKey })).toBe(false)
    expect(decodeSessionOffer(encodeSessionOffer(offer))?.host).toBe(HOST)
  })

  it('completes a mutual handshake and rejects a welcome for a different hello', () => {
    const { connector, acceptor, connectorKey, acceptorKey } = pair()
    const offer = signSessionOffer({
      rootKeyHex: acceptor.toHex(),
      counterparty: connectorKey,
      host: HOST,
      port: 9,
    })
    const hello = signSessionHello({ rootKeyHex: connector.toHex(), offer })
    expect(verifySessionHello(hello, { localIdentity: acceptorKey })).toBe(true)
    const welcome = signSessionWelcome({ rootKeyHex: acceptor.toHex(), hello })
    expect(verifySessionWelcome(welcome, { hello })).toBe(true)
    const other = signSessionHello({ rootKeyHex: connector.toHex(), offer })
    expect(verifySessionWelcome(welcome, { hello: other })).toBe(false)
  })

  it('treats refusal and unreachable as immediate, not a timeout', () => {
    expect(isImmediateConnectFailure('ECONNREFUSED')).toBe(true)
    expect(isImmediateConnectFailure('ENETUNREACH')).toBe(true)
    expect(isImmediateConnectFailure('ETIMEDOUT')).toBe(false)
  })
})
