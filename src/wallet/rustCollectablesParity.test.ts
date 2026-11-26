import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Collectable } from './collectables'
import { groupCollectables, groupQuantityLabel, issuerViewFor } from './collectableGroups'
import type { IssuerAttribution, IssuerProfile } from './issuerIdentity'
import type { IssuerTrust } from './issuerTrust'
import { searchCollectables, suggestCollectableTerms } from './collectableSearch'
import { reconcileCollectableSelection, selectableCollectables, selectionState, toggleCollectableSelection } from './collectableSelection'
import type { BntAssetSummary } from './bnt/wallet'

const key = '02' + '11'.repeat(32)
const other = '03' + '22'.repeat(32)
const item = (outpoint: string, overrides: Partial<Collectable> = {}): Collectable => ({
  outpoint, origin: outpoint.replace('.', '_'), name: 'Award #1', imageUrl: '', satoshis: 1,
  traits: [], extras: [], proven: false, authenticity: 'unproven', ...overrides,
})
const items = [
  item('a.0', { issuer: key, issuerAttested: true, collectionId: 'SERIES', name: 'Award #1', proven: true, imageUrl: 'https://test/a', traits: [{ name: 'Colour', value: 'Red' }] }),
  item('b.0', { issuer: key, issuerAttested: true, collectionId: 'series', name: 'award #2', imageUrl: 'https://test/a', extras: [{ name: 'Level', value: 'Gold' }] }),
  item('c.0', { issuer: key, issuerAttested: false, name: 'Claim #3' }),
  item('d.0', { issuer: 'invalid', signer: 'sigma', app: ' Studio ', collectionId: 'mixed', name: 'Different #4', content: 'hello', type: 'badge', subType: 'award', mimeType: 'image/png' }),
  item('e.0', { signer: 'sigma', name: 'Other #5', collectionId: 'mixed' }),
  item('f.0', { app: 'Zulu' }),
  item('g.0', { collectionId: 'lonely', name: 'X' }),
  item('h.0', { name: 'Loose 6', traits: [{ name: 'Colour', value: 'Blue' }] }),
  item('i.0', { issuer: '0x' + other.toUpperCase(), issuerAttested: true, name: 'Étoile #7' }),
  item('j.0', { issuer: other, issuerAttested: true, collectionId: 'varied', name: 'First #1' }),
  item('k.0', { issuer: other, issuerAttested: true, collectionId: 'VARIED', name: 'Second #2' }),
  ...['École', 'eagle', 'Álbum', 'Zoo', 'emoji 😀'].map((name, n) =>
    item(`sort${n}.0`, { app: name, name: `${name} #${n}`, imageUrl: `https://test/sort${n}` })),
  ...Array.from({ length: 6 }, (_, n) =>
    item(`face${n}.0`, { issuer: key, issuerAttested: true, collectionId: 'faces', name: `Face #${n}`, imageUrl: `https://test/face${n}` })),
]
const bnt: BntAssetSummary[] = [
  { assetId: 'token', deploy: 'token_0', kind: 'token', mode: 'open', sym: 'GOLD', issuers: [key], balance: '100', outputs: 1, authority: false, imageUrl: 'https://test/token' },
  { assetId: 'member', deploy: 'member_0', kind: 'item', mode: 'open', name: 'Member', issuers: [key], balance: '1', outputs: 1, authority: false },
  { assetId: 'unknown', deploy: 'unknown_0', kind: 'token', mode: 'open', sym: 'UNKNOWN', issuers: [], balance: '1', outputs: 1, authority: false },
]
function inputItem(i: Collectable) {
  return {
    ...i, issuer: i.issuer ?? '', bapId: i.bapId ?? '', signer: i.signer ?? '', app: i.app ?? '',
    collectionId: i.collectionId ?? '', imageUrl: i.imageUrl ?? '', content: i.content ?? '',
    itemType: i.type ?? '', subType: i.subType ?? '', mimeType: i.mimeType ?? '',
  }
}
function projection(list: Collectable[], assets: BntAssetSummary[]) {
  const g = groupCollectables(list, undefined, undefined, assets)
  return {
    issuers: g.issuers.map(s => ({
      issuer: {
        key: s.key, label: s.label, identityKey: s.identityKey ?? null,
        profileId: s.profile?.id ?? null, imageUrl: s.icon ?? null,
        rank: s.profile?.state === 'verified' ? (s.profile.listed ? 0 : 1)
          : !s.identityKey ? 2 : s.profile?.state === 'unconfirmed' ? 4 : s.issuerAttested ? 3 : 5,
      },
      items: s.items.map(i => i.outpoint), bnt: s.bnt.map(a => a.assetId),
      collections: s.collections.map(c => ({
        key: c.key, label: c.label, items: c.items.map(i => i.outpoint),
        faces: c.faces, overflow: c.overflow, quantity: c.quantity, provenCount: c.provenCount,
      })),
      loose: s.loose.map(i => i.outpoint), faces: s.faces, overflow: s.overflow,
      quantity: s.quantity, provenCount: s.provenCount, quantityLabel: groupQuantityLabel(s),
    })),
    ungrouped: g.ungrouped.map(i => i.outpoint), ungroupedBnt: g.ungroupedBnt.map(a => a.assetId),
  }
}

describe('Rust collectables reference recorder', () => {
  it('records real TS grouping, search, suggestions and selection outcomes', () => {
    const cases = [[], items, [...items].reverse()].map(list => ({
      items: list.map(inputItem),
      assets: bnt.map(a => ({ ...a, name: a.name ?? '', sym: a.sym ?? '', imageUrl: a.imageUrl ?? '' })),
      grouped: projection(list, bnt),
      searches: ['', ' , ', 'colour red,award', 'level gold', 'hello,badge,image/png', 'ÉTOILE', key, 'sigma'].map(query => ({
        query, outpoints: searchCollectables(query, list).map(i => i.outpoint),
      })),
      suggestions: [
        { draft: '', terms: [] }, { draft: 'aw', terms: [] },
        { draft: 'red', terms: ['award'] }, { draft: 'gold', terms: [] },
      ].map(s => ({ ...s, result: suggestCollectableTerms(s.draft, s.terms, list) })),
      selections: [[], ['a.0'], ['a.0', 'b.0', 'gone.0']].map(selected => {
        const set = new Set(selected)
        const available = selectableCollectables(list, new Set(['b.0']))
        return {
          selected, busy: ['b.0'], reconciled: [...reconcileCollectableSelection(set, list)].sort(),
          selectable: available.map(i => i.outpoint), state: selectionState(set, available),
          on: [...toggleCollectableSelection(set, available, true)].sort(),
          off: [...toggleCollectableSelection(set, available, false)].sort(),
        }
      }),
    }))
    expect(cases[1]!.grouped.issuers.some(s => s.issuer.key.startsWith('issuer:claim:'))).toBe(true)
    const dir = path.resolve('native-desktop/fixtures/collectables')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'read-model.json'), JSON.stringify(cases, null, 2) + '\n')

    const profile: IssuerProfile = {
      id: key, identityKey: key, source: 'identity-key', name: 'École', description: '',
    }
    const linked: IssuerProfile = {
      ...profile, id: 'bap-test',
      bap: { bapId: 'bap-test', name: 'École', description: '', rootAddress: '', keys: [],
        alias: { txid: 'alias', signer: '' }, links: [] },
    }
    const trust: IssuerTrust = {
      listed: id => id === 'bap-test' ? { bapId: id, name: 'École' } : null,
      caution: () => null,
    }
    const views: { attested: boolean; bapId?: string; attribution: IssuerAttribution | null }[] = [
      { attested: false, attribution: { kind: 'verified', identityKey: key, profile: linked } },
      { attested: true, attribution: { kind: 'verified', identityKey: key, profile } },
      { attested: true, bapId: 'bap-test', attribution: { kind: 'verified', identityKey: other, profile: linked } },
      { attested: true, bapId: 'copied', attribution: { kind: 'verified', identityKey: key, profile: linked } },
      { attested: true, bapId: 'bap-test', attribution: { kind: 'unconfirmed', bapId: 'bap-test', reason: 'not-linked' } },
      { attested: true, bapId: 'copied', attribution: { kind: 'unconfirmed', bapId: 'bap-test', reason: 'no-package' } },
      { attested: true, bapId: 'bap-test', attribution: { kind: 'refused', bapId: 'bap-test', reason: 'revoked' } },
      { attested: true, attribution: null },
    ]
    const recordedViews = views.map(v => {
      const a = v.attribution
      const result = issuerViewFor({ issuer: key, issuerAttested: v.attested, bapId: v.bapId }, () => a, trust)!
      return {
        item: { issuer: key, issuerAttested: v.attested, bapId: v.bapId ?? '',
          attribution: a?.kind === 'verified' ? {
            kind: 'verified', identity_key: a.identityKey, profile_id: a.profile.id,
            bap_id: a.profile.bap?.bapId ?? null, label: a.profile.name, image_url: null,
            listed: !!trust.listed(a.profile.id),
          } : a?.kind === 'unconfirmed' ? { kind: 'unconfirmed', bap_id: a.bapId } : null },
        expected: { key: result.key, label: result.label, identityKey: result.identityKey,
          profileId: result.profile?.id ?? null, imageUrl: null,
          rank: result.profile?.state === 'verified' ? (result.profile.listed ? 0 : 1)
            : result.profile?.state === 'unconfirmed' ? 4 : v.attested ? 3 : 5 },
      }
    })
    fs.writeFileSync(path.join(dir, 'issuer-views.json'), JSON.stringify(recordedViews, null, 2) + '\n')
  })
})
