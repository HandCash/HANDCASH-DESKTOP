import { describe, expect, it, vi } from 'vitest'

import {
  isNullMemberRejection,
  repairProvenTxReqHistoryNulls,
  type ProvenTxReqHistoryStore,
} from './brc38HistoryRepair'

vi.mock('./appLog', () => ({ appendAppLog: () => {} }))

function storeWith(
  rows: Array<{ provenTxReqId: number; history?: unknown }>,
): ProvenTxReqHistoryStore & { writes: Array<[number, { history: string }]> } {
  const writes: Array<[number, { history: string }]> = []
  return {
    writes,
    findUserByIdentityKey: async () => ({ userId: 1 }),
    getProvenTxReqsForUser: async () => rows,
    updateProvenTxReq: async (id, update) => {
      writes.push([id, update])
      return 1
    },
  }
}

describe('isNullMemberRejection', () => {
  it('recognizes the BRC-38 refusal the monitor keeps triggering', () => {
    expect(
      isNullMemberRejection(
        new Error('BRC-38 document.tables.provenTxReqs[4].history.notes[2].txid must omit null values'),
      ),
    ).toBe(true)
  })

  it('does not claim unrelated export failures', () => {
    expect(isNullMemberRejection(new Error('BRC-38 exportedAt must be a UTC ISO timestamp'))).toBe(false)
    expect(isNullMemberRejection('BRC-38 document must omit null values')).toBe(false)
  })
})

describe('repairProvenTxReqHistoryNulls', () => {
  it('drops null fields from a note and leaves the rest intact', async () => {
    const store = storeWith([
      {
        provenTxReqId: 7,
        history: JSON.stringify({
          notes: [{ what: 'getMerklePathBadStatus', name: 'BitailsProofTsc', txid: null }],
        }),
      },
    ])

    expect(await repairProvenTxReqHistoryNulls(store, 'pub')).toBe(1)
    expect(store.writes).toEqual([
      [
        7,
        {
          history: JSON.stringify({
            notes: [{ what: 'getMerklePathBadStatus', name: 'BitailsProofTsc' }],
          }),
        },
      ],
    ])
  })

  it('drops null array members rather than leaving holes', async () => {
    const store = storeWith([
      { provenTxReqId: 2, history: JSON.stringify({ notes: [null, { what: 'sent' }] }) },
    ])

    await repairProvenTxReqHistoryNulls(store, 'pub')
    expect(store.writes[0][1].history).toBe(JSON.stringify({ notes: [{ what: 'sent' }] }))
  })

  it('leaves clean rows untouched', async () => {
    const store = storeWith([
      { provenTxReqId: 1, history: JSON.stringify({ notes: [{ what: 'sent' }] }) },
      { provenTxReqId: 2 },
      { provenTxReqId: 3, history: '' },
    ])

    expect(await repairProvenTxReqHistoryNulls(store, 'pub')).toBe(0)
    expect(store.writes).toEqual([])
  })

  it('does not rewrite a row whose history only mentions null inside a string', async () => {
    const store = storeWith([
      { provenTxReqId: 4, history: JSON.stringify({ notes: [{ what: 'status:null' }] }) },
    ])

    expect(await repairProvenTxReqHistoryNulls(store, 'pub')).toBe(0)
  })

  it('skips unparseable history instead of destroying it', async () => {
    const store = storeWith([{ provenTxReqId: 5, history: '{notes: null' }])

    expect(await repairProvenTxReqHistoryNulls(store, 'pub')).toBe(0)
    expect(store.writes).toEqual([])
  })

  it('does nothing when the identity has no user row', async () => {
    const store = storeWith([{ provenTxReqId: 6, history: '{"notes":[null]}' }])
    store.findUserByIdentityKey = async () => undefined

    expect(await repairProvenTxReqHistoryNulls(store, 'pub')).toBe(0)
  })
})
