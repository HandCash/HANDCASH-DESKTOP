/**
 * Render fixtures: one component in one statechart state with mock data.
 * The states are data in tests/render/states/*.json (read by the browser and by
 * scripts/render-states.mjs); this file only supplies the rows they name and
 * the component each tab renders. Then `npm run ui:render -- --fixture <name>`.
 */
import type { ReactNode } from 'react'
import identityStates from './states/identity.json'
import { IdentityPanel } from '../../src/components/IdentityPanel'
import type { IssuerIdentity, IssuerProfile } from '../../src/wallet/issuerIdentity'
import type { PublicIdentityRow } from '../../src/wallet/publicIdentities'
import type { MachineState, MockState } from './mockState'

export type RenderFixture = {
  /** Mock data and machine snapshots the harness installs before rendering. */
  state: MockState
  /** Selectors that must all exist before the screenshot (async work landed). */
  waitFor: string[]
  /** The component under test; the harness wraps it in the WalletNav slot. */
  render: () => ReactNode
}

// Synthetic keys: shaped like compressed secp256k1 keys, owned by nobody.
const WALLET_KEY = identityStates.keys.wallet
const IMPORTED_KEY = identityStates.keys.imported
const BAP_ID = 'K9qdpCzuq4FN6gNXx3kQTgH1jRn8ZkTgaj'
const TXID = 'f3c1d9a07e5b2c4d8e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5'

const profile: MockState['profile'] = {
  handle: '',
  identityKey: WALLET_KEY,
  address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
  chain: 'main',
}

const bapIdentity: IssuerIdentity = {
  bapId: BAP_ID,
  rootAddress: '1HcRootAddressFixture000000000000',
  keys: [{ seq: 0, address: '1HcSigningKeyFixture0000000000000', txid: TXID, minedHeight: 912_345 }],
  alias: { txid: TXID, signer: '1HcSigningKeyFixture0000000000000', minedHeight: 912_345 },
  links: [{ identityKey: WALLET_KEY, txid: TXID, minedHeight: 912_346 }],
  name: 'Satoshi Workshop',
  description: 'Hand-made goods, minted and signed on BSV.',
}

const bapProfile: IssuerProfile = {
  id: BAP_ID,
  identityKey: WALLET_KEY,
  source: 'bap',
  name: bapIdentity.name,
  description: bapIdentity.description,
  bap: bapIdentity,
}

const walletRowBare: PublicIdentityRow = {
  identityKey: WALLET_KEY,
  signer: 'wallet',
  bapId: BAP_ID,
  profile: null,
  identity: null,
}

const walletRowBap: PublicIdentityRow = {
  identityKey: WALLET_KEY,
  signer: 'wallet',
  published: BAP_ID,
  bapId: BAP_ID,
  profile: bapProfile,
  identity: bapIdentity,
}

const importedRow: PublicIdentityRow = {
  identityKey: IMPORTED_KEY,
  signer: 'imported',
  bapId: 'Q7mXk2hV9sTzR4bLwN8pCfE3uYdA6gJ1oP',
  profile: {
    id: IMPORTED_KEY,
    identityKey: IMPORTED_KEY,
    source: 'identity-key',
    name: 'Studio issuer with a deliberately long display name for wrapping',
    description:
      'Imported signing key for the studio collection. Long bio text so the card shows how it wraps at phone widths.',
  },
  identity: null,
}

/** Rows a state file names in `data.identities`. */
const ROWS: Record<string, PublicIdentityRow> = { walletRowBare, walletRowBap, importedRow }

type StateEntry = {
  data: {
    claimed: MockState['claimed']
    identities: string[]
    presentedIdentityKey: string | null
  }
  machines: Record<string, MachineState>
  waitFor: string[]
}

function fromData(entry: StateEntry): MockState {
  return {
    profile,
    claimed: entry.data.claimed,
    identities: entry.data.identities.map((name) => {
      const row = ROWS[name]
      if (!row) throw new Error(`render state names unknown row "${name}"`)
      return row
    }),
    selectedIdentityKey: WALLET_KEY,
    presentedIdentityKey: entry.data.presentedIdentityKey,
    signsIssuance: true,
    machines: entry.machines,
  }
}

const identity = () => <IdentityPanel profile={profile} />

export const FIXTURES: Record<string, RenderFixture> = Object.fromEntries(
  Object.entries(identityStates.fixtures as Record<string, StateEntry>).map(([name, entry]) => [
    name,
    { state: fromData(entry), waitFor: entry.waitFor, render: identity },
  ]),
)
