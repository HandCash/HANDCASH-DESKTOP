import { machineStateManifest } from '../machines/machineManifest'

/** Executable machine inventory shown beside the hand-authored explanatory charts. */
export const executableWalletStatecharts = machineStateManifest()

/**
 * HandCash Desktop — master + per-scope Mermaid statecharts.
 * Readable charts for Settings → About HandCash → Statecharts.
 * Covers XState machines and major UI scopes (Aeon data-aeon-state).
 */

export type AppStatechartPage = {
  id: string
  label: string
  caption: string
  source: string
}

/** Software map — how the session hosts the other charts. */
const MASTER = `stateDiagram-v2
  direction TB
  [*] --> appSession

  appSession --> unlockForm : lock / onboarding
  appSession --> walletNav : ready
  appSession --> sendPayment : Send panel / SENT balance
  appSession --> receiveFlow : OPEN_RECEIVE
  appSession --> wipeWallet : Settings wipe
  appSession --> qrReveal : show QR
  appSession --> appUpdate : always (background)
  appSession --> connectPermission : BRC-100 connect
  appSession --> actionPermission : BRC-100 pay / sign
  appSession --> walletIo : always (I/O map)
  appSession --> coordinator : always (UTXO mutex)
  appSession --> spendSign : spend paths
  appSession --> marketPurchase : market buy
  appSession --> marketSellerSettlement : market sell
  appSession --> chainIngestChart : Refresh
  appSession --> messageboxChart : chat relay
  appSession --> accountHolding : unlock / switch / gap / holding channel
  accountHolding --> accountMove : open an account held elsewhere

  walletNav --> friendsFlow : Friends
  walletNav --> collectablesFlow : Collectables
  walletNav --> connectedApps : Connect
  walletNav --> activityFeed : Activity
  walletNav --> identityPanel : Identity
  walletNav --> settingsFlow : Settings

  collectablesFlow --> sendCollectable : send item
  settingsFlow --> changePassword : change pw
  settingsFlow --> backupKeys : keys
  settingsFlow --> historyBackup : history
  settingsFlow --> deviceBackup : device backup
  settingsFlow --> legacyImport : import
  settingsFlow --> aboutHandCash : about
  settingsFlow --> wipeWallet : wipe
  aboutHandCash --> statecharts : view charts

  appSession : Session host
  unlockForm : Unlock form
  accountHolding : Account holding · one install per account
  accountMove : Account move · automatic
  walletNav : Nav sections
  sendPayment : Send payment
  receiveFlow : Receive
  friendsFlow : Friends
  collectablesFlow : Collectables
  sendCollectable : Send item
  connectedApps : Connected apps
  connectPermission : Connect prompt
  actionPermission : Action prompt
  activityFeed : Activity
  identityPanel : Identity
  settingsFlow : Settings
  changePassword : Change password
  backupKeys : Keys backup
  historyBackup : History backup
  deviceBackup : Device backup · one-way copy
  legacyImport : Import · legacy wallets
  aboutHandCash : About HandCash
  statecharts : Statecharts
  wipeWallet : Wipe wallet
  qrReveal : QR dialog
  appUpdate : App update
  walletIo : Wallet I/O
  coordinator : Coordinator
  spendSign : Sign / broadcast
  chainIngestChart : Chain ingest
  messageboxChart : Messagebox
  marketPurchase : Market purchase
  marketSellerSettlement : Market seller settlement
`

const APP_SESSION = `stateDiagram-v2
  direction TB
  [*] --> boot

  boot --> locked : BOOTSTRAPPED\\nhas vault
  boot --> onboarding : BOOTSTRAPPED\\nnew / restore-only
  boot --> failure : FAIL

  onboarding --> ready : CREATED
  locked --> ready : UNLOCKED / CREATED
  ready --> ready : ACCOUNT_SWITCH_STARTED / balance pending
  ready --> ready : ACCOUNT_SWITCHED / exact balance
  ready --> ready : SENT / REFRESHED exact balance
  ready --> locked : LOCK
  failure --> locked : BOOTSTRAPPED\\nhas vault
  failure --> onboarding : BOOTSTRAPPED\\nnew / restore-only
  failure --> boot : CLEAR_ERROR

  boot : Boot
  onboarding : Onboarding
  locked : Locked
  ready : Ready
  failure : Failure

  note right of ready
    UNLOCKED/CREATED publishes one WalletRuntime.
    Account switch and LOCK abort/dispose that runtime first;
    stale feature completions are fenced by runtime generation.
    A switch selects the account's warm unit (Toolbox + monitor);
    the outgoing unit keeps proving its transactions. LOCK clears all.
    A switched identity paints before balance; balance remains
    explicitly pending until that runtime's Toolbox answers.
  end note
`

const UNLOCK = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> submitting : SUBMIT\\n(password ≥ 8)
  submitting --> success : SUCCESS
  submitting --> failure : FAIL
  failure --> idle : RETRY / CHANGE
  success --> [*]

  note right of idle
    Modes: unlock | create | restore(phrase|shares|key)
    (AuthScreen formMode)
    Restore role: replace (claim every account)
    | keep both (discover, then reserve a new account)
  end note

  idle : Idle
  submitting : Submitting
  success : Success
  failure : Failure
`

const ACCOUNT_HOLDING = `stateDiagram-v2
  direction LR
  [*] --> here : created here\ncreate-only holder record
  [*] --> elsewhere : discovered\n(not taking over)
  [*] --> here : discovered while taking over\n(restore: replace)

  here --> here : check — record names this install\nor absent → publish
  here --> handingOver : check — newer record\nnames another install
  handingOver --> elsewhere : monitor stopped · notices of unsent tx tombstoned ·\nunsent tx voided · delta since last upload sealed to box
  here --> releasing : release-request over the vault link\nor box account-holding (seq = local, < 10 min)\n→ accept the same way back, no prompt
  releasing --> elsewhere : open: history flushed, record released (seq+1)\nnot open: record released, then handover
  releasing --> here : flush or announce failed\n(mover forces after 2 min)
  elsewhere --> moving : open it (wallet menu)
  moving --> here : accountMoveMachine taken\n(released, or forced after 10 s silence)
  moving --> elsewhere : failed (named reason)

  here : Held here · opens + spends
  elsewhere : Held elsewhere · listed, never opened or warmed
  releasing : Releasing · spends refused
  handingOver : Handing over · never uploads or broadcasts
  moving : Moving here · see accountMove

  note right of here
    Spend guard reads local holding while fresh. Fresh = checked, then the
    holding channel served every 5 s with no break over 15 s. After a gap
    (start, suspend, throttled timer, reconnect, switch) the first spend
    reads holder.json once; host unreachable keeps local holding.
    holder.json beside wallet.brc39, signed by the account root; seq only grows.
    New accounts reserve their index create-only, so two devices never share a key.
  end note
`

const ACCOUNT_MOVE = `stateDiagram-v2
  direction LR
  [*] --> reading
  reading --> taking : released / ours
  reading --> dialing : held by another install
  reading --> requestingBox : unannounced in use\n(no device to dial)
  reading --> failed : host unreachable / unsupported
  dialing --> requestingDirect : vault link to the holding device open
  dialing --> requestingBox : no link within 8 s
  requestingDirect --> awaitingAccept : release-request acked\ndevice to device
  requestingDirect --> requestingBox : frame not acked
  requestingBox --> awaitingAccept : release-request posted to box
  requestingBox --> failed : box unreachable\n(never force unasked)
  awaitingAccept --> awaitingRelease : release-accept (our nonce)\nover the link or the box
  awaitingAccept --> taking : record released
  awaitingAccept --> forcing : 10 s answer window
  awaitingAccept --> reading : record overtaken (≤ 2 restarts)
  awaitingRelease --> taking : record released
  awaitingRelease --> forcing : 2 min release window
  awaitingRelease --> reading : record overtaken (≤ 2 restarts)
  forcing --> taken : held seq+1 over the ETag
  taking --> taken : held seq+1 over the ETag
  taking --> reading : another install won (≤ 2 restarts)
  forcing --> failed : take unavailable
  taking --> failed : take unavailable / kept changing
  taken --> [*]
  failed --> [*]

  note right of taken
    Caller opens the account with arrived: the history backup
    merges before anything spends. Own requests are acknowledged.
  end note
`

const WALLET_NAV = `stateDiagram-v2
  direction TB
  [*] --> section

  section --> child : open child
  child --> section : back / clear

  state section {
    [*] --> activity
    activity --> apps : tab
    apps --> collectables : tab
    collectables --> friends : tab
    friends --> identity : tab
    identity --> settings : tab
    settings --> activity : tab
  }

  state child {
    [*] --> none
    none --> send
    none --> receive
    none --> paymentDetails
    none --> friendDetails
    none --> addFriend
    none --> collectableDetails
    none --> sendCollectable
    none --> appDetails
    none --> permissionDetails
    none --> settingDetail
    send --> none : close
    receive --> none : close
  }

  section : Section
  child : Child
`

const SEND = `stateDiagram-v2
  direction LR
  [*] --> editing
  editing --> confirming : REVIEW
  confirming --> editing : BACK
  confirming --> handoff : CONFIRM
  confirming --> failure : FAIL (pre-flight)
  handoff --> [*] : panel closes
  failure --> editing : BACK / RESET
  editing : Edit
  confirming : Confirm
  handoff : Handed to wallet
  failure : Refused before send
`

const ASSET_SEND = `stateDiagram-v2
  direction LR
  [*] --> editing
  editing --> confirming : REVIEW
  editing --> editing : CLASSIFY refuse
  confirming --> editing : BACK
  confirming --> handoff : CONFIRM
  confirming --> failure : CLASSIFY refuse / FAIL
  handoff --> [*] : panel closes
  failure --> editing : BACK / RESET
  editing : Recipient and optional quantity
  confirming : Confirm
  handoff : Handed to wallet
  failure : Domain send path refused
`

const RECEIVE = `stateDiagram-v2
  direction LR
  [*] --> ready
  ready --> copied : COPY
  copied --> ready : idle
  ready --> qrOpen : SHOW_QR
  qrOpen --> ready : HIDE_QR
  ready : Ready
  copied : Copied
  qrOpen : QR open
`

const FRIENDS = `stateDiagram-v2
  direction TB
  [*] --> list
  list --> details : open friend
  list --> add : add friend
  details --> list : back
  add --> list : saved / back
  list : List
  details : Details
  add : Add friend
`

const COLLECTABLES = `stateDiagram-v2
  direction TB
  [*] --> grid
  grid --> details : open item
  details --> grid : back
  details --> sendCollectable : Send
  details --> modelLoading : GLB / GLTF body
  modelLoading --> modelReady : READY
  modelLoading --> modelFailed : FAIL
  modelFailed --> modelLoading : RETRY
  details --> burnEditing : Burn item (side panel)
  sendCollectable --> details : back / done
  burnEditing --> burnConfirm : REVIEW
  burnConfirm --> burnEditing : BACK
  burnConfirm --> grid : FORGET / local relinquish + Activity
  burnEditing --> details : CANCEL item burn
  burnConfirm --> burning : CONFIRM / Activity pending before queue
  burning --> burnDone : SUCCESS
  burning --> burnFailed : FAIL
  burnFailed --> burnEditing : BACK
  burnDone --> grid : item inventory refresh
  grid : Grid
  details : Details
  modelLoading : 3D skeleton
  modelReady : Orbit / zoom / auto-rotate
  modelFailed : Named render failure
  sendCollectable : Send item
  burnEditing : Burn panel — economics
  burnConfirm : Confirm fixed amount
  burning : Burn on chain
  burnFailed : Failure and named reason
  burnDone : Burn activity recorded
`

const MODEL_VIEWER = `stateDiagram-v2
  direction LR
  [*] --> loading
  loading --> ready : READY after first frame
  loading --> failed : FAIL / timeout
  failed --> loading : RETRY / remount
  loading : Skeleton; model mounted underneath
  ready : Orbit · zoom · auto-rotate
  failed : Error + Try again
`

const SEND_COLLECTABLE = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> classifying : START with SendPath
  classifying --> p2pkhSend : p2pkhSend
  classifying --> refusing : refuse
  refusing --> failed
  p2pkhSend --> done : SUCCESS
  p2pkhSend --> failed : FAIL
  done --> idle : RESET
  failed --> idle : RESET
`

const SEND_COLLECTABLE_RUN = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> sending : START with planned legs
  sending --> checking : LEG_SENT
  sending --> splitting : LEG_REJECTED (leg > 1 tip)
  sending --> checking : LEG_REJECTED (single tip failed)
  sending --> halted : RUN_FAULT
  splitting --> sending : halves queued
  checking --> sending : legs queued
  checking --> done : queue empty
  done --> idle : RESET
  halted --> idle : RESET
`

const ASSET_BURN_UI = `stateDiagram-v2
  direction LR
  [*] --> closed
  closed --> editing : OPEN
  editing --> confirming : REVIEW
  editing --> failure : FAIL (pre-flight)
  confirming --> editing : BACK
  confirming --> closed : FORGET item locally
  confirming --> burning : CONFIRM
  burning --> done : SUCCESS
  burning --> failure : FAIL
  failure --> editing : BACK
  failure --> closed : CANCEL / RESET
  done --> closed : RESET
  editing : Review what is destroyed
  confirming : Confirm fixed amount
  burning : Handed to wallet
  failure : Nothing destroyed
`

const ASSET_BURN = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> planning : START with BurnPlan
  planning --> building : burnOneSat
  planning --> failed : named refuse
  building --> signing : BUILT
  signing --> broadcasting : SIGNED
  broadcasting --> internalizing : BROADCASTED
  internalizing --> refreshing : INTERNALIZED
  refreshing --> done : REFRESHED
  building --> failed : FAIL / abort unsigned action
  signing --> failed : FAIL / abort unsigned action
  broadcasting --> failed : FAIL
  internalizing --> failed : FAIL
  refreshing --> failed : FAIL
  done --> idle : RESET
  failed --> idle : RESET
  note right of internalizing
    Burn is irreversible.
    BRC-150 never crosses an item burn.
    Physical sats enter Pay only through
    self BRC-29 wallet-payment internalize.
  end note
`

const SERVER_WALLET_RECOVER = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> planning : START with DevWalletRecoverPlan
  planning --> spending : recover
  planning --> internalizing : finish (broadcast, not internalized)
  planning --> failed : nothing-to-recover | uneconomical
  spending --> internalizing : SPENT / pendingRecover saved
  internalizing --> done : INTERNALIZED
  spending --> failed : FAIL
  internalizing --> failed : FAIL / pendingRecover kept
  done --> idle : RESET
  failed --> idle : RESET
  note right of spending
    A dev key's wallet (same key + storage
    as the server) pays this wallet by
    BRC-29. Money only; items and
    tokens stay with the server.
  end note
`

const COLLECTABLE_SEND_PATH = `stateDiagram-v2
  direction TB
  [*] --> tipKind
  tipKind --> covenantLocked : long non-P2PKH
  tipKind --> p2pkh : P2PKH
  tipKind --> unknown : empty / other
  covenantLocked --> refuse : abandon only
  p2pkh --> p2pkhSend : BRC-150 verified, not known-unconfirmed
  p2pkh --> refuse : verifying / unproven / unconfirmed
  unknown --> p2pkhSend : BRC-150 verified, not known-unconfirmed
  unknown --> refuse : else
`

const AUTHENTICITY = `stateDiagram-v2
  direction TB
  [*] --> unknown
  unknown --> proven : HYDRATE proven / PROVEN
  unknown --> unproven : HYDRATE unproven / UNPROVEN
  unknown --> verifying : START_VERIFY
  verifying --> proven : PROVEN
  verifying --> unproven : UNPROVEN
  verifying --> budgetExhausted : BUDGET_EXHAUSTED
  verifying --> unknown : ABORT
  unproven --> verifying : RETRY / START_VERIFY
  unproven --> proven : PROVEN
  budgetExhausted --> verifying : RETRY
  proven --> proven : PROVEN (monotonic)
  note right of proven
    Never downgrade to unproven.
    Durable projection: provenCache.v2
  end note
`

const ITEM_SEND = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> building : START with ItemSettlePath
  idle --> confirmBroadcast : RETRY_BROADCAST\\nexisting signed BEEF
  building --> createAction : BUILT
  createAction --> chooseSettle : CREATED with txid\\nnoSend
  createAction --> signing : CREATED needs sign
  signing --> chooseSettle : SIGNED noSend
  chooseSettle --> peerDeliver : peerDeliver
  chooseSettle --> selfReceive : selfReceive
  chooseSettle --> externalBroadcast : externalBroadcast
  peerDeliver --> done : BROADCASTED\\npeer notify is metadata
  confirmBroadcast --> done : BROADCASTED / SKIPPED
  selfReceive --> done : BROADCASTED
  externalBroadcast --> done : BROADCASTED
  note right of confirmBroadcast
    Retry: same signed BEEF, never a competing spend.
  end note
  note right of peerDeliver
    Same signed-send miner + BUMP lifecycle as BSV.
    Messagebox notification never controls propagation.
  end note
  createAction --> failed : FAIL
  signing --> failed : FAIL
  building --> failed : FAIL
`

const BSV_SEND = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> preparing : START
  preparing --> broadcasting : READY
  broadcasting --> done : BROADCASTED
  preparing --> failed : FAIL
  broadcasting --> failed : FAIL
  note right of broadcasting
    External / pasted P2PKH only.
    HandCash peers use brc29Send.
  end note
`

const BRC29_SEND = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> preparing : START with Brc29SettlePath
  preparing --> signing : READY
  signing --> chooseSettle : SIGNED + SPV registered
  chooseSettle --> peerNotify : peerDeliver
  chooseSettle --> selfReceive : selfReceive
  peerNotify --> done : BEEF_IN_BOX / REMIT_IN_BOX / DIRECT / BOX_UNREACHABLE
  selfReceive --> done : SETTLED
  note right of signing
    Toolbox createAction signs noSend locally.
    Payment output records notice pending; delivery marks it.
    Sealed: notice journaled before propagation, replicated in seconds.
    Miner submit starts in the background; a later hard reject marks failed.
    Inbox is notify + outbox retry; recovery re-queues pending.
    Retry backs off to hourly, never gives up; stalled shows in details.
    No abort / no second tx.
  end note
  note right of chooseSettle
    Spend region ends at SIGNED (sealed + propagating).
    Settle runs outside it; the send resolves without it.
  end note
  preparing --> failed : FAIL
  signing --> failed : FAIL
`

const BNT = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> building : ISSUE (issuer coin P2PK, ALL|FORKID)
  idle --> building : MINT (authority row; fixed supply refused, cap never passed)
  idle --> building : TRANSFER (bntft / bntnft rows, wallet-only)
  idle --> building : BURN (wallet-internal: units to an unspendable holder + OP_RETURN memo)
  building --> signing : BUILT
  building --> failed : FAIL (abortAction, outputs stay put)
  signing --> signed : SIGNED txid
  signing --> failed : FAIL (abortAction)
  signed --> delivering : BROADCASTED (signed-send lifecycle)
  delivering --> committed : DELIVERED box bnt
  delivering --> committed : QUEUED outbox (retried each serve)
  note right of signing
    Open mode: holder signs ALL|ANYONECANPAY
    with a fresh bnt holder child per output.
    The wallet re-checks conservation (§4)
    on the signed transaction before it is
    registered; a mismatch aborts.
  end note
  note right of delivering
    Box bnt carries remittance + the §6 proof
    package (Extended Format, hops the peer
    has not been sent). Receive walks §7 to
    the deploy, checks every claimed source
    against its parent, files bntft / bntnft,
    and ACKs only once filed or invalid.
  end note
`

const COIN = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> reading : RECEIVE (output paying this wallet's key on the coin's chain, or named by a coin-payment notice, not yet recorded)
  reading --> received : SEEN (bytes hash to txid, output pays this wallet's script, or the key derived for the notice's sender and key id)
  reading --> refused : REFUSED tx-mismatch | malformed | coinbase | no-output | wrong-script
  idle --> proving : PROVE (received coin, not yet buried)
  proving --> proven : PROVEN (block D deep on this wallet's own header chain for the coin: LTC 6 · BCH 6 · BTC 3 · DOGE 20; spendable)
  proving --> pending : PENDING (unconfirmed, n of D counted on this chain, or the chain unreadable)
  proving --> voided : VOIDED (shown abandoned: unknown to the sources for 30 min; never spent)
  idle --> building : SEND (online; account held here, re-checked after a gap; spendable coins: buried received + change of own broadcast payments; to an identity only if its signed record names coin:<chain>, else unsupported-recipient | recipient-unchecked)
  building --> broadcasting : SIGNED (LTC, BTC: BIP143 P2WPKH · BCH: P2PKH, SIGHASH_ALL|FORKID · DOGE: P2PKH, legacy SIGHASH_ALL; recorded before broadcast)
  broadcasting --> sent : BROADCASTED (kept alive until it confirms; to an identity: sealed notice to box coin-payment, retried, never gating it)
  broadcasting --> queued : BROADCAST_QUEUED (retried every pass)
  idle --> broadcasting : RESUME_BROADCAST
  reading --> failed : FAIL
  proving --> failed : FAIL
  building --> failed : FAIL
`

const SWAP = `stateDiagram-v2
  direction LR
  [*] --> editing
  editing --> quoting : QUOTE (from ≠ to; 0 < amount ≤ held)
  quoting --> quoting : QUOTE (amount or coins changed)
  quoting --> quoted : routes ranked (direct offers paying ≥ Exolix, best then oldest · Exolix, custodial · worse direct); default = first
  quoting --> refused : bad-request | no-route (no verified offer covers it; Exolix below-min / above-max / unavailable) | failed
  quoted --> quoted : PICK (another ranked route)
  quoted --> reviewing : REVIEW (any ranked route; direct shows the 0.5% fee and lock times)
  reviewing --> quoted : BACK
  quoted --> stale : after 60 s
  reviewing --> stale : after 60 s
  reviewing --> swapping : CONFIRM (the only step that moves coins)
  swapping --> done : Exolix: can pay · exchange opened to this wallet's own payout + refund addresses · matches the confirmed quote · recorded · deposit paid from own balance
  swapping --> done : direct: can lock · take recorded and sent to the maker (swapSettleMachine locks at once; the maker need not be online)
  swapping --> failed : insufficient | unavailable | terms-changed | wrong-payout | bad-deposit | take refused | deposit failed
  quoted --> quoting : QUOTE
  stale --> quoting : QUOTE
  refused --> quoting : QUOTE
  refused --> offering : OFFER (no-route only; offer at the market rate, ≤ held)
  offering --> offering : PARTS (allow → smallest take = part floor; off → whole; only when splittable)
  offering --> refused : BACK
  offering --> quoting : QUOTE
  offering --> publishing : PUBLISH (signs with the swap order key; moves no coin)
  publishing --> published : offer book stored it
  publishing --> offering : refused | unreachable (named)
  published --> editing : RESET
  done --> editing : RESET
  failed --> editing : RESET
  note right of swapping
    Exolix holds the coins between the
    deposit and its payout. Direct offers
    (signed with the wallet-only swap order
    key) settle wallet to wallet, hash-locked
    on each chain, never through Exolix.
  end note
`

const SWAP_OFFERS = `stateDiagram-v2
  direction LR
  [*] --> loading
  loading --> ready : offers listed with signed fills · each verified here (shape, maker signature, not expired, room left) · served from the offer book cache when cached
  loading --> failed : offer book unavailable
  ready --> ready : REFRESH (cache revalidates; the last book stays shown)
  ready --> cancelling : CANCEL (own offer only; signs the withdrawal)
  cancelling --> ready : withdrawn (offer dropped; cache revalidates)
  cancelling --> ready : refused (named)
  ready --> reviewing : REVIEW (someone else's offer, still listed; amount = all that is left)
  reviewing --> reviewing : AMOUNT (offers filled in parts; minGet ≤ amount ≤ left)
  reviewing --> ready : BACK
  reviewing --> taking : CONFIRM (offer still listed · amount fits)
  reviewing --> reviewing : CONFIRM (amount out of range; stays)
  reviewing --> ready : CONFIRM after expiry (named)
  taking --> taken : take sent (balance checked first)
  taking --> reviewing : refused (named)
  taken --> ready : REFRESH (cache revalidates)
  failed --> loading : REFRESH
  note right of taking
    The take moves no coin itself. The
    wallet locks its side at once; the maker
    locks when next online, within 28 h
    (swapSettleMachine).
  end note
`

const SWAP_SETTLE = `stateDiagram-v2
  direction LR
  [*] --> negotiating
  negotiating --> presigning : PRESIGN (v1 BSV leg only: ask the peer to co-sign its refunds)
  presigning --> presigning : PRESIGN (ask again)
  negotiating --> locking : FUND
  presigning --> locking : FUND (refunds co-signed)
  negotiating --> ended : DONE declined | expired
  presigning --> ended : DONE declined | expired
  locking --> locking : FAIL · FUND (retry; never a second lock)
  locking --> locked : OK (funding recorded)
  locking --> ended : DONE declined | expired (nothing signed: short after one heal, or past the window)
  locked --> claiming : CLAIM (peer lock buried · secret known)
  locked --> refunding : REFUND | REFUND_FEE (past the lock time)
  claiming --> locked : OK | FAIL
  refunding --> locked : OK | FAIL
  locked --> settled : DONE swapped
  locked --> refunded : DONE refunded
  locked --> missed : DONE missed (taker refunded first)
  locked --> ended : DONE unsent (own lock proven never on chain)
  settled --> [*]
  refunded --> [*]
  ended --> [*]
  missed --> [*]
  note right of locked
    Hash-locked outputs on each chain:
    the taker's secret claims both, each
    payer refunds after its lock time
    (v2: maker 48 h, taker 72 h after the
    take). v2 BSV refunds prove their own
    nLockTime (push-tx), no co-signer and
    no accept wait; v1 swaps still presign.
    A take is judged by its signed time; a
    lock buried too late is refused. 0.5%
    fee output on the fee leg, same hash;
    paid only on success.
  end note
  note right of claiming
    Maker, waiting in locked for the secret:
    its claim is presigned (secret left out,
    template in the custody journal) and
    handed to claim watchtowers: its own
    box host, then BRC-CLOUD. A tower fills
    in the secret from the taker's claim and
    broadcasts; no key, pays only the maker.
    CLAIM commits that same transaction.
  end note
`

const COUNTERSIGN = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> issuing : ISSUE
  issuing --> broadcast : BROADCASTED deploy + beacon
  issuing --> failed : FAIL bad-asset-args | release-required | release-issuer-only | cosigners-invalid | cosigners-without-issuer | cosigners-split
  idle --> classifying : TRANSFER (CountersignTransferPath)
  note right of issuing
    ReleaseCustody: independent (keys the
    issuer does not hold meet k) or
    issuer-only (release: 'self', freezes
    for good if the issuer stops).
    CosignerQuorum: solo (this wallet) or
    shared m of n (this wallet among them,
    2m > n so two quorums always overlap).
    Other cosigners get a join invite and
    sign only after joinCountersignedAsset.
  end note
  classifying --> failed : refuse / named reason
  classifying --> holderSigning : local-acceptor | remote-acceptor | quorum | released
  holderSigning --> requesting : SIGNED request id
  holderSigning --> failed : FAIL
  requesting --> accepted : ACCEPTED countersigned EF
  requesting --> accepted : ACCEPTED released (holder countersigns with published keys)
  requesting --> refused : REFUSED signed reason
  requesting --> outstanding : SILENT
  requesting --> failed : FAIL
  accepted --> broadcast : BROADCASTED
  broadcast --> committed : COMMITTED
  note right of holderSigning
    Holder signs ALL|ANYONECANPAY; token
    inputs only, one satoshi per output.
    Each output is a fresh BRC-29 child
    (recipient's, or own for change); each
    request lists every output with a
    linkage sealed to the acceptor it goes to.
    local-acceptor: this wallet holds an
    issuer key and accepts in process.
    remote-acceptor: sealed request to the
    issuer's box countersign, no endpoint.
    released: the beacon chain shows the
    release keys published; no request.
    ended (retired | lapsed): refuse.
  end note
  note right of requesting
    Acceptor: opens each linkage (refuses
    recipient if one does not prove its
    holder), accept-once record, adds its
    fee input, countersigns ALL. Until it
    signs, no transaction exists.
    outstanding: inputs stay reserved;
    a repeat is the same request.
    Silent or not_acceptor issuer: read the
    beacon chain; released → holder
    countersigns and funds the fee.
    Released receipts credit once mined.
    quorum: the holder funds the fee, each
    cosigner proves the inputs, reserves
    them and returns its countersignatures;
    ACCEPTED at m, REFUSED once fewer than m
    can remain (signed refusals free the
    signers' reservations), SILENT keeps the
    answers on the open request.
  end note
`

const OFFER = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> classifying : LIST / CANCEL
  classifying --> failed : refuse / named reason
  classifying --> staging : list / cancel
  staging --> preSignAbortable : STAGED reference
  preSignAbortable --> signedUnknown : SIGNED_UNKNOWN
  preSignAbortable --> failed : ABORTED
  signedUnknown --> broadcast : BROADCASTED
  signedUnknown --> failed : ABORTED
  signedUnknown --> recovery : FAIL / RECOVER
  recovery --> broadcast : BROADCASTED
  recovery --> failed : ABORTED when Arcade never accepted
  broadcast --> committed : COMMITTED
  note right of staging
    One mechanism (offerSeal): hold the exact lot,
    sign it SINGLE|ANYONECANPAY over what the seller
    wants back: the item binds the seller payment,
    the advert deposit binds the fee (BRC-48 overlay).
  end note
  note right of signedUnknown
    noSend: abort + restore the lot until the cheque
    is registered. BROADCASTED = registered + sealed;
    miners run in the background. Never abort after
    BROADCASTED. A late reject retires a market
    listing auth (never-sent): no Cancel.
  end note
`

const MARKET_PURCHASE = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> classifying : START with MarketPurchasePath
  classifying --> failed : refuse / named reason
  classifying --> verifying : atomicPeerSettlement
  verifying --> reserving : VERIFIED
  reserving --> preSignAbortable : RESERVED / item0 + offer1
  preSignAbortable --> sellerSigned : seller signs both inputs
  sellerSigned --> signedUnknown : SIGNING / wallet processing begins
  signedUnknown --> broadcast : BROADCASTED cheque registered
  signedUnknown --> failed : ABORTED before registration
  signedUnknown --> recovery : unknown result
  broadcast --> committed : COMMITTED
  recovery --> broadcast : recovered txid
  recovery --> failed : ABORTED when never registered
  preSignAbortable --> aborting : TIMEOUT / DUPLICATE / COMPETING_BUYER / FAIL
  sellerSigned --> aborting : pre-sign FAIL
  aborting --> failed : ABORTED
  note right of signedUnknown
    Buyer-local reference never crosses wallets.
    Inputs: item0, offer1, then buyer funding.
    Abort after sign only while the cheque is unregistered.
    Miners run in the background; a late reject
    rewrites the row (reportLateMinerSubmitFailure).
  end note
  note right of broadcast
    MarketSoldAnnouncePath (catalog hygiene, never custody):
    overlaySubmit → BRC-22 settlement + buyerIdentityKey + payment address
    skip → no-host | no-settlement-beef | buyer-identity-unknown
    no miner ACK wait; pending outbox owns propagation
    buyer txid.0 extends the admitted BRC-150 proof and paints proven
    oversized seller receipt stays inline; seller fetches BEEF by txid
    local seller reconcile runs after the spend region + retries durably
  end note
`

const MARKET_SELLER_SETTLEMENT = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> classifying : START with MarketSellerSettlePath
  classifying --> refused : refuse / named reason
  classifying --> validating : peerDeliver
  validating --> signingSellerInputs : VALIDATED
  signingSellerInputs --> peerDeliver : both seller inputs signed
  peerDeliver --> awaitingBroadcast : DELIVERED
  awaitingBroadcast --> internalizingProceeds : receipt BEEF validated + broadcast
  internalizingProceeds --> retiringItem : PROCEEDS_INTERNALIZED
  retiringItem --> settled : ITEM_RETIRED / de-list backstop when buyer never announced
  internalizingProceeds --> recovery : ingest failed
  retiringItem --> recovery : retire failed
  validating --> refused : DUPLICATE / COMPETING_BUYER / TIMEOUT / FAIL
  signingSellerInputs --> refused : TIMEOUT / FAIL
  peerDeliver --> refused : TIMEOUT / FAIL
  note right of peerDeliver
    Receipt authority is explicit (marketReceiptAuthority):
    reservedBySignHop matches the reserved commitment + intent;
    listTimeUnlocks has no reservation, so the settlement tx must
    spend our item and offer and pay payTo + fee; else named refuse.
    Seller signs item and offer inputs only on the sign hop.
    Inbox polling starts before chain refresh on account activation.
    Compact receipt resolves settlement BEEF by txid, never /files.
    Slow miner ACK does not block proceeds ingest.
    ACK only after proceeds ingest and item retirement.
  end note
`

const CONNECTED_APPS = `stateDiagram-v2
  direction TB
  [*] --> list
  list --> appDetails : open app
  appDetails --> list : back
  appDetails --> permissionDetails : open scope
  permissionDetails --> appDetails : back
  list --> empty : no apps
  empty --> list : first connect
  list : List
  appDetails : App details
  permissionDetails : Permission
  empty : Empty
`

const CONNECT_PERMISSION = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> loading : request
  loading --> pending : icon ready
  pending --> committing : ALLOW
  pending --> committing : CANCEL
  committing --> idle : prompt resolved
  idle : Idle
  loading : Loading
  pending : Pending
  committing : Decision locked
  note right of idle
    Queue empty and the prompt raised the wallet
    over another app: releasePromptFocus hands it back
    (macOS app.hide, Android moveTaskToBack)
  end note
`

const ACTION_PERMISSION = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> loading : request
  loading --> pending : icon ready
  pending --> committing : ALLOW
  pending --> committing : CANCEL
  committing --> idle : prompt resolved
  idle : Idle
  loading : Loading
  pending : Pending
  committing : Decision locked
  note right of idle
    Queue empty and the prompt raised the wallet
    over another app: releasePromptFocus hands it back
    (macOS app.hide, Android moveTaskToBack)
  end note
`

const APP_BROWSER_PAGE = `stateDiagram-v2
  direction LR
  [*] --> loading
  loading --> ready : LOADED
  loading --> ready : STOP / stop
  loading --> failed : FAILED
  ready --> loading : RELOAD / reload
  ready --> loading : LOADING
  ready --> failed : FAILED
  failed --> loading : RETRY / reload
  failed --> loading : RELOAD / reload
  loading : Loading (progress bar)
  ready : Ready
  failed : Failed (Try again / Open in browser)
  note right of ready
    Location: app | insecure (http loopback)
    | elsewhere (left the app's host)
  end note
`

const ACTIVITY = `stateDiagram-v2
  direction TB
  [*] --> feed
  feed --> filtersOpen : toggle filters
  filtersOpen --> feed : toggle filters
  feed --> paymentDetails : open entry
  paymentDetails --> feed : back
  feed : Feed
  filtersOpen : Filters
  paymentDetails : Payment
  note right of paymentDetails
    Clear a signed send only
    when every input is spent
  end note
  note right of feed
    Owed BRC-29 notice: row reads
    Notifying recipient… | needs attention (stalled)
  end note
`

const IDENTITY = `stateDiagram-v2
  direction LR
  [*] --> ready
  ready --> copied : COPY_KEY / ADDRESS
  copied --> ready : idle
  ready --> qrOpen : SHOW_QR
  qrOpen --> ready : HIDE
  ready : Ready
  copied : Copied
  qrOpen : QR open
`

const PUBLIC_IDENTITIES = `stateDiagram-v2
  direction LR
  [*] --> browsing
  browsing --> composing : COMPOSE
  browsing --> importing : IMPORT_KEY
  composing --> composing : FIELD / IMAGE / CLEAR_IMAGE
  composing --> browsing : CLOSE
  importing --> browsing : CLOSE
  composing --> saving : SAVE [named]
  saving --> browsing : profile certificate signed
  saving --> composing : save refused
  browsing --> quoting : PUBLISH_BAP
  browsing --> quoting : ROTATE
  browsing --> quoting : LINK
  quoting --> reviewing : plan quoted
  quoting --> refused : quote refused / already-linked
  reviewing --> publishing : APPROVE
  publishing --> browsing : records and link signed
  publishing --> refused : plan-changed / fee-over-plan / staged-mismatch
  quoting --> browsing : CANCEL
  reviewing --> browsing : CANCEL
  refused --> browsing : DISMISS
  note right of saving
    The identity key's own profile (BRC-248 section 2):
    a self-signed BRC-52 certificate, name, bio and
    optional photo, newest issuedAt wins. Kept on this
    device and the encrypted backup; rides the identity
    card and item deliveries. No transaction, no fee.
  end note
  note right of reviewing
    Plan: every record tx, output bytes, fee estimate
    and ceiling, signing key, digest over the scripts.
    A profile not yet linked to the identity key adds
    the BRC-248 link tx (identity key + BAP key sign
    over a noSend anchor; both queued together).
    publishing rebuilds it under the spend lock, stages
    each tx unsigned, refuses a moved digest or a fee
    over its ceiling, then signs. Draft is frozen.
  end note
  note right of composing
    Draft holds the public image, name and bio only.
    Publish to BAP mirrors the saved profile as the
    optional BAP record; it is never the label source.
    asyncAction owns image encode, key import, removal.
  end note
`

const SETTINGS = `stateDiagram-v2
  direction TB
  [*] --> settingsHome
  settingsHome --> changePassword : open
  settingsHome --> backupKeys : open
  settingsHome --> deviceHandoff : open
  settingsHome --> historyBackup : open
  settingsHome --> wipeWallet : open
  settingsHome --> aboutHandCash : open
  settingsHome --> legacyImport : open
  legacyImport --> settingsHome : back
  changePassword --> settingsHome : back
  backupKeys --> settingsHome : back
  deviceHandoff --> backupKeys : open keys
  deviceHandoff --> historyBackup : open history
  deviceHandoff --> deviceBackupFlow : add / open device
  deviceHandoff --> settingsHome : back
  deviceBackupFlow --> deviceHandoff : done
  historyBackup --> settingsHome : back
  historyBackup --> deviceHandoff : back
  historyBackup --> backupKeys : back
  wipeWallet --> settingsHome : back / done
  aboutHandCash --> settingsHome : back
  aboutHandCash --> statecharts : view charts
  statecharts --> aboutHandCash : back

  settingsHome : Settings
  changePassword : Password
  backupKeys : Keys
  deviceHandoff : Device backup
  deviceBackupFlow : Devices · one-way copy
  historyBackup : History
  wipeWallet : Wipe
  aboutHandCash : About HandCash
  statecharts : Statecharts
  legacyImport : Import · legacy wallets
`

const LEGACY_IMPORT = `stateDiagram-v2
  direction TB
  [*] --> loading
  loading --> list : LOADED / FAIL
  list --> picking : ADD
  list --> source : OPEN
  list --> entering : PICK (openKeyRecovery from migrate page)
  picking --> entering : PICK (HandCash first)
  picking --> list : BACK
  entering --> saving : SUBMIT
  entering --> picking : BACK
  saving --> source : SAVED (enters scanning)
  saving --> entering : FAIL

  state source {
    [*] --> viewing
    viewing --> scanning : RESCAN
    viewing --> awaitingHints : ASK_HINTS (HandCash · opens /migrate)
    awaitingHints --> scanning : HINTS (openKeyRecovery with history)
    awaitingHints --> viewing : BACK / FAIL (other handle)
    scanning --> viewing : SCANNED / FAIL
    viewing --> browsing : BROWSE
    browsing --> viewing : BACK
    viewing --> reviewing : REVIEW
    reviewing --> sweeping : CONFIRM
    reviewing --> viewing : BACK
    sweeping --> viewing : SWEPT / FAIL
    viewing --> confirmingRemove : REMOVE
    confirmingRemove --> removing : CONFIRM
    confirmingRemove --> viewing : BACK
    removing --> viewing : FAIL

    viewing : Read-only · totals and held reasons
    awaitingHints : Sign in on /migrate · history, balance, items cross the bridge · moves nothing
    scanning : HandCash export → its UTXO set by key proof (sealed answer) · rows kept only if the keys derive them · cash and items checked by outpoint in bulk (an address is read in full only for an unplaced output) · else HandCash hints → items located by origin + newest history (500 → 2,500 → all) · reads only addresses with unspent outputs · kept once it covers HandCash balance + items · else gap walk · PAUSE
    browsing : importItemBrowser · chosen items queue to importQueue · share transactions
    reviewing : Preview · compatible only
    sweeping : Cash → items (BRC-150) · tokens stay at the source · PAUSE
  }

  source --> list : BACK (viewing) / REMOVED

  list : Saved legacy wallets · never BRC-100, never accounts
  entering : HandCash keys | phrase | Twetch | Yours file | WIF
  note right of reviewing
    No path reaches sweeping except CONFIRM here.
    Uncompressed keys, BSV-20 ticks, listings,
    other cosigned tokens, RUN jigs and covenants stay.
  end note
`

const IMPORT_ITEM_BROWSER = `stateDiagram-v2
  direction TB
  state sync {
    [*] --> checking
    checking --> checking : CHANGED (batch saved to disk)
    checking --> done : SYNCED
    checking --> failed : SYNC_FAILED
    failed --> checking : RETRY
    checking : prune what the source no longer names · ask the 1Sat index only about outputs never checked · leaving stops it, progress stays
  }
  --
  state shelves {
    [*] --> reading
    reading --> idle : read (issuer shelves from disk)
    reading --> failed : error
    idle --> settling : list changed
    settling --> reading : after 1.2s
    failed --> reading : RETRY
    reading : signer (index claim) → app → collection → no issuer
  }
  --
  state page {
    [*] --> closed
    closed --> routing : OPEN / FILTER
    routing --> reading : a shelf open or a search
    routing --> closed : neither
    reading --> ready : page of 60
    reading --> failed : error
    ready --> reading : MORE (near the end, more saved)
    failed --> reading : RETRY
  }
  --
  state gather {
    [*] --> idle
    idle --> reading : SELECT_SHELF (checked)
    reading --> idle : shelf outpoints from disk
  }
  --
  state move {
    [*] --> idle
    idle --> idle : IMPORT / IMPORT_SELECTED (one chosen) → enqueue
    idle --> confirming : IMPORT_SELECTED (several)
    confirming --> idle : CONFIRM → enqueue
    confirming --> idle : CANCEL
    idle : enqueue hands items to importQueue · rows already queued stay disabled · the rest stay usable
  }
  note right of move
    watchQueue (root invoke) mirrors importQueue for this source:
    run (moving · waiting · done) · report · paused.
    ANSWERED: moved and not-an-item rows leave the list and stay out; unfunded stay selected.
    STOP and DISMISS go to the queue. Leaving the page leaves the queue running.
    The list lives on this device until the item leaves the source.
  end note
`

const IMPORT_QUEUE = `stateDiagram-v2
  direction TB
  [*] --> idle
  idle --> deciding : ENQUEUE
  deciding --> moving : queue not empty
  deciding --> idle : queue empty
  moving --> moving : ENQUEUE (appended, deduped per source) / STOP (drops waiting) / LANDED (a tx of the chunk broadcast · bar counts its items)
  moving --> cooling : chunk answered · spent fee coin (pauses left)
  moving --> deciding : chunk answered / error
  cooling --> deciding : after 8s (untried items first)
  cooling --> deciding : STOP (paused source)

  moving : next 100 of one source + wallet → importItems · one migrate call across source keys · 25 tips per tx · same P2PKH item migrate (BRC-150 remittance) · prefetch next chunk's source txs
  cooling : the wallet retires the spent coin before the retry
  note right of moving
    Lives for the unlocked session, not the page.
    Missing funds drop the wallet's waiting items.
    A spent fee coin retries the same bundle once, then pauses (2 pauses max).
    A wallet change drops that wallet's items.
    Refused while a paused sweep reads the same address.
    One run (idle → idle) is one walletJob: one Activity row with a bar.
    Progress also mirrors walletProgress (item-import) → status pill.
  end note
`

const WALLET_JOB = `stateDiagram-v2
  direction TB
  [*] --> running
  running --> running : PROGRESS (current / total | unknown)
  running --> waiting : WAIT
  waiting --> running : RESUME / PROGRESS
  running --> done : FINISH
  running --> stopped : STOP
  running --> failed : FAIL
  waiting --> done : FINISH
  waiting --> stopped : STOP
  waiting --> failed : FAIL
  done --> [*]
  stopped --> [*]
  failed --> [*]

  running : one Activity row · determinate bar when total is known · indeterminate when not
  waiting : held outside the job · spent fee coin clearing · wallet sync lock
  note right of running
    Kinds: item-import (importQueue run) · wallet-sweep (Sweep everything)
      · balance-heal (manual heal pass).
    Item rows are written as each transaction broadcasts,
      before the ledger can show the migrate unannotated.
    The job id is the sendGroupId of every row it writes;
    those rows stay hidden while the job row shows,
    then fold into one record (fold kind job).
  end note
`

const DEVICE_BACKUP = `stateDiagram-v2
  direction TB
  [*] --> devices
  devices --> scanning : SCAN
  scanning --> devices : SCAN_CANCEL / SCANNED (same wallet)
  scanning --> device : SCANNED (peer)
  devices --> device : OPEN_DEVICE
  devices --> recovery : OPEN_RECOVERY
  device --> devices : BACK
  recovery --> devices : BACK

  state device {
    [*] --> choosing
    choosing --> sealPrompt : PROTECT_LOCAL
    choosing --> importPrompt : PROTECT_PEER
    sealPrompt --> sealing : SEAL
    sealing --> sealed : SEAL_OK
    sealing --> sealPrompt : FAIL
    sealPrompt --> choosing : BACK
    importPrompt --> importing : IMPORT
    importing --> choosing : IMPORT_OK
    importing --> importPrompt : FAIL
    importPrompt --> choosing : BACK

    choosing : One direction or none
    sealPrompt : Unlock password
    sealed : Sealed copy on screen
    importPrompt : Scan / paste their copy
  }

  state recovery {
    [*] --> locked
    locked --> unsealing : UNSEAL
    unsealing --> opened : UNSEAL_OK
    unsealing --> locked : FAIL

    opened : Phrase / emergency key
  }

  devices : Device list · this device’s code
  scanning : Camera
`

const QR_SCANNER = `stateDiagram-v2
  direction LR
  [*] --> loading
  loading --> ready : CAMERA_READY
  loading --> error : FAIL
  loading --> done : SCANNED
  ready --> error : FAIL
  ready --> done : SCANNED
  loading --> paused : PAUSE
  ready --> paused : PAUSE
  paused --> loading : RESUME / new session
  done --> [*]

  loading : Skeleton · acquire camera
  ready : Throttled QR decode
  error : Camera unavailable
  paused : Tracks stopped in background
  done : Tracks stopped
`

const CHANGE_PASSWORD = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> submitting : SUBMIT
  submitting --> success : SUCCESS
  submitting --> failure : FAIL
  failure --> idle : RETRY
  success --> [*]
  idle : Idle
  submitting : Submitting
  success : Success
  failure : Failure
`

const BACKUP_PHRASE = `stateDiagram-v2
  direction LR
  [*] --> locked
  locked --> revealing : unlock / confirm
  revealing --> revealed : SUCCESS
  revealing --> locked : FAIL / cancel
  revealed --> copied : COPY
  copied --> revealed : idle
  locked : Locked
  revealing : Revealing
  revealed : Revealed
  copied : Copied
`

const WIPE = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> syncing : SUBMIT\\n(DELETE + ack)
  syncing --> wiping : SYNCED\\n(history holds localState)
  syncing --> blocked : BLOCKED
  blocked --> syncing : RETRY
  blocked --> wiping : OVERRIDE\\n(loss named + confirmed)
  blocked --> idle : BACK
  wiping --> success : SUCCESS
  wiping --> failure : FAIL
  failure --> idle : RETRY
  success --> [*]
  idle : Idle
  syncing : Syncing history
  blocked : Blocked — not synced
  wiping : Wiping
  success : Success
  failure : Failure
`

const QR = `stateDiagram-v2
  direction LR
  [*] --> closed
  closed --> open : SHOW
  open --> closed : HIDE
  closed : Closed
  open : Open
`

const UPDATE = `stateDiagram-v2
  direction TB
  [*] --> idle
  idle --> checking : CHECK
  checking --> available : update found
  checking --> notAvailable : none
  checking --> error : fail
  available --> downloading : DOWNLOAD
  available --> checking : CHECK
  downloading --> ready : file ready
  downloading --> error : fail
  notAvailable --> checking : CHECK
  error --> checking : CHECK
  ready : Ready
  notAvailable : Up to date

  note right of idle
    Mode context:
    default | manual | none
  end note
`

const BRIDGE = `stateDiagram-v2
  direction LR
  [*] --> offline
  offline --> online : listen OK
  online --> offline : error / stop
  online --> handling : HTTP request
  handling --> online : respond
  handling --> prompt : needs permission
  prompt --> handling : allow / deny
  offline : Offline
  online : Online
  handling : Handling
  prompt : Prompt
`

/** Process + external world — where keys live vs who we call. */
const WALLET_IO = `flowchart TB
  subgraph Main["Electron main"]
    BRIDGE_N["BRC-100 :2121 / :3321"]
    DPEER["Device peer :3340"]
    VAULT["Durable vault / safeStorage"]
    UPDATER["Auto-updater"]
  end

  subgraph Renderer["Renderer — custody after unlock"]
    KEYS["vault master (BRC-157 / root)\\n→ account rootKeyHex + toolbox wallet"]
    COORD["walletCoordinator\\n4 exclusive regions"]
    SPEND["Spend machines\\nBSV / item / BRC-100"]
    INGEST["chainIngest\\nscan → import"]
    DIGEST["header digest\\nheaderProven vs unconfirmed"]
    HIST["historyReplica\\nBRC-39"]
    HANDLER["brc100Handler\\ndevicePeerHandler"]
  end

  subgraph Chain["Chain / SPV peers"]
    BITAILS["Bitails\\nrawtx · UTXO · postBeef"]
    WOC["WhatsOnChain\\nfallback"]
    JB["JungleBus"]
    GP["GorillaPool ordinals"]
    CT["Chaintracks\\nheaders"]
    ARC["Broadcast stack\\nARC · Bitails · WoC"]
  end

  subgraph Cloud["BRC-CLOUD"]
    H39["wallet.brc39 + friends"]
    HANDLES["$handle resolve / claim"]
    MSG["messagebox"]
    LOGS["support logs"]
  end

  subgraph Apps["Local apps / peers"]
    DAPP["Browser dapps"]
    PHONE["Paired phone / device"]
  end

  BRIDGE_N -->|IPC 120s| HANDLER
  DPEER -->|IPC 30s| HANDLER
  VAULT -->|unlock IPC| KEYS
  HANDLER --> SPEND
  COORD --> SPEND
  COORD --> INGEST
  COORD --> HIST
  SPEND -->|delayed + postBeef| ARC
  SPEND --> BITAILS
  SPEND --> DIGEST
  INGEST --> BITAILS
  INGEST --> WOC
  INGEST --> GP
  INGEST --> JB
  DIGEST --> CT
  KEYS --> CT
  HIST --> H39
  HANDLER --> HANDLES
  HANDLER --> MSG
  KEYS --> LOGS
  DAPP --> BRIDGE_N
  PHONE --> DPEER
  PHONE --> H39
`

/** Coordinator regions — legal overlaps (depth counters + per-region FIFO). */
const COORDINATOR = `stateDiagram-v2
  direction TB
  [*] --> idle

  state idle {
    [*] --> allQuiet
    allQuiet : all depths = 0
  }

  idle --> chainIngest : CHAIN_INGEST_BEGIN\\nno spend / history / recompose
  idle --> spend : SPEND_BEGIN\\nall quiet
  idle --> historyReplica : HISTORY_BEGIN\\nall quiet
  idle --> recompose : RECOMPOSE_BEGIN\\nall quiet

  chainIngest --> idle : CHAIN_INGEST_END
  spend --> idle : SPEND_END
  historyReplica --> idle : HISTORY_END
  recompose --> idle : RECOMPOSE_END

  spend --> nestedIngest : nested heal\\nCHAIN_INGEST_BEGIN nested
  nestedIngest --> spend : CHAIN_INGEST_END

  note right of recompose
    Replaced localState: payment reconcile
    starts here (notice journal, owed notices,
    Activity relist; a journaled payment the history
    lacks is resumed — inputs sealed, same txid).
    The next foreground spend waits for it, at most
    20 s; background never. Its notice waits for
    the miner verdict; a proven reject settles it.
  end note
`

/** Signing + settle — one Bitcoin lifecycle; asset paths only route metadata. */
const SPEND_SIGN = `stateDiagram-v2
  direction LR
  [*] --> prepare

  prepare --> createAction : local balance ok
  prepare --> refuse : TipKind refuse / thin funds

  createAction --> certify : every signed createAction\\n(toolbox instance gated at boot)
  createAction --> signable : signAndProcess false
  signable --> certify : signAction — judged before signing
  certify --> signedNoSend : noSend + signAndProcess
  signedNoSend --> peerDeliver : ItemSettlePath peerDeliver
  signedNoSend --> selfReceive : selfReceive
  signedNoSend --> externalBroadcast : pasted address
  prepare --> confirmBroadcast : retry unconfirmed signed BEEF\\nsource still unspent
  certify --> appReply : every coin cleared · or change of a\\ncertified / node-held parent
  certify --> createAction : coin spent (Teranode or explorer names it)\\n/ another install / parent rejected — retire, sign again (≤3)
  certify --> refuse : coin unanswered / parent not on a node\\n/ named or signable input dead — nothing sent
  appReply --> spv : txid to the app, then propagation
  peerDeliver --> spv : common signed-send propagation\\nnotify async
  confirmBroadcast --> spv : silent sender postBeef
  selfReceive --> spv
  externalBroadcast --> spv
  spv --> postBeef : package SPV-verified\\nscripts · amounts · proofs vs headers
  spv --> spv : incomplete — held in outbox, retried
  spv --> failed : invalid — never posted, inputs freed
  note right of certify
    inputCertainty + kernel/inputCertainty. SPV proves a parent exists;
    only a UTXO answer (Teranode /utxos with mempool spenders,
    WhatsOnChain for confirmed ones) or this wallet's own
    certified ledger proves unspent.
    peerDeviceSpends reads another install's BRC-39 upload (never imports):
    coins it spent are dead here before any explorer sees that tx.
  end note
  postBeef --> landing : Arcade 202 (queued, not landed)
  postBeef --> done : non-Arcade accept
  landing --> done : node holds it / on chain
  landing --> landing : Arcade queued / PENDING_RETRY / gave up (no verdict)\\nno input proven spent · re-post outside Arcade once
  landing --> failed : node rejected (466 names the spender)\\n/ input spent per Teranode or explorer\\n/ parent proven dead — fail closure, hide coins
  note right of signedNoSend
    registerSignedSend seals + queues before settle metadata.
    Asset data does not alter Bitcoin communication:
    same Arcade reject, retry, landing watch, and BUMP finality as BSV.
  end note
  note right of landing
    arcadeLanding + kernel/landingFate, never on the reply path.
    Unlock replays every pinned cheque that never landed.
  end note
  signedNoSend --> sendWithOk : BSV BRC-29 same pattern
  sendWithOk --> done : no failure
  postBeef --> failed : missing-inputs / reject
  sendWithOk --> failed : sendWith failure
  createAction --> review : WERR_REVIEW_ACTIONS / reserved batch
  review --> recover : abort batches · fail abandoned\\nreviewStatus · quarantine unscripted
  recover --> createAction : retry once
  refuse --> failed
  failed --> [*]
  done --> [*] : activity + history push
`

/**
 * Dual-layer confirmation — sits beside settle-path machines.
 * Optimistic soft-lock / ARC status vs SPV-verified MINED.
 */
const TX_UTXO_LIFECYCLE = `stateDiagram-v2
  direction LR
  [*] --> DRAFT
  DRAFT --> VALIDATING : protocolValidate
  VALIDATING --> BROADCASTING : offer cheque to miners
  VALIDATING --> SEEN_IN_MEMPOOL : signed Atomic BEEF\\n(local SPV cheque)
  VALIDATING --> FAILED_REJECTED : dust / funds / refuse
  BROADCASTING --> SEEN_IN_MEMPOOL : ARC rumour / still posting
  BROADCASTING --> FAILED_REJECTED : proven competing spend
  SEEN_IN_MEMPOOL --> MINED : BUMP verified vs headers
  SEEN_IN_MEMPOOL --> FAILED_REJECTED : eviction / reject
  MINED --> REORG_ORPHANED : reorg
  REORG_ORPHANED --> SEEN_IN_MEMPOOL : re-announced
  REORG_ORPHANED --> FAILED_REJECTED : gone
  FAILED_REJECTED --> [*] : spentBy set / spendable
  MINED --> [*] : spendable false + spentBy

  note right of DRAFT
    BRC-38 spendable true
    no mutation until VALIDATING ok
  end note
  note right of BROADCASTING
    miner cashing loop
    (secondary to SPV)
  end note
  note right of SEEN_IN_MEMPOOL
    owned cash = spendable
    + live unconfirmed change
    headers + unconfirmed bodies
  end note
  note right of MINED
    spendable false + spentBy
    (toolbox row kept)
    hard finality = BUMP + headers
  end note
`

/** Receive / Refresh pipeline. */
const CHAIN_INGEST_CHART = `flowchart TB
  START([refreshFromChain]) --> PRE[pending sends + abort reserved]
  PRE --> MAINT[parallel maintenance\\ndual-layer · ghost-heal\\nactivity prune · restore]
  MAINT --> SCAN[legacy address UTXO scan\\nfinder — not a cheque judge]
  MAINT -.-> REIMP["reimport from custody journal\\ninternalize the journaled spec\\nwhen chain says unspent + no row"]
  SCAN --> CLASS[classifyLegacyUtxos]
  CLASS --> FUND[funding → importLegacyUtxos]
  CLASS --> TIPS[1sat tips → importOneSatOrdinals]
  CLASS --> HOLD[held unrecognized 1-sat\\nnever sweep]
  CLASS --> DUST[heldUneconomical\\nbelow sweep floor\\nnever sweep]
  TIPS --> PAINT[listCollectables paint]
  PAINT --> AUTH[authenticity / genesis\\nbudgeted background]
  FUND --> AUDIT[spendable audit report-only\\nunconfirmed cheque ≠ spent]
  TIPS --> AUDIT
  AUDIT --> BAL[balance refresh + toast]
  BAL --> END([ok])
  END -.-> CONS["maybeConsolidateChange\\n(off ingest lock)"]
  CONS --> PLAN{planChangeConsolidation}
  PLAN -->|fragments < floor| CSKIP[skip — pool left as-is]
  PLAN -->|below fee floor| CSKIP
  PLAN -->|consolidate| CSELF["runExclusiveSpend\\nself-payment maxPossibleSatoshis\\n→ one managed-change UTXO"]
`

/**
 * Messagebox — BRC-33 store-and-forward vs HandCash convenience host.
 * Custody never depends on this chart.
 */
const MESSAGEBOX_CHART = `flowchart TB
  subgraph Ideal["BRC-169 / BRC-33 target"]
    RESOLVE["resolve handle"] --> BOXURL["messagebox URL"]
    BOXURL --> SEND["POST sendMessage"]
    SEND --> BOX["recipient PeerServ"]
    BOX --> LIST["POST listMessages"]
    LIST --> LOCAL["local messageStore"]
    LOCAL --> ACK["acknowledgeMessage"]
  end

  subgraph Today["HandCash today"]
    HARD["resolved messagebox URL\\nBRC-CLOUD fallback"] --> SEND2["sendMessage\\nBRC-169 envelope + BRC-78 content"]
    HARD --> SIGNAL["box webrtpay_messages\\nknock / ring / offer / answer"]
    SIGNAL --> RTC["webrtpay/1 data channel\\ndraft BRC-246"]
    RTC -->|ack within 1s| LOCAL2["messageStore friend thread"]
    RTC -.->|no ack| SEND2
    SEND2 --> FILES["optional chat attachments only\\nPOST /files → R2"]
    HARD --> POLL["listMessages by recipient key\\nBRC-104 session, else X-BRC33-*"]
    POLL --> LOCAL2
  end

  subgraph NotBox["Not messagebox"]
    CHAIN["BSV + item settle\\nP2PKH tip on chain"]
    REM["BRC-150 remittance\\nsender localState only"]
  end
`

export const APP_STATECHART_PAGES: AppStatechartPage[] = [
  {
    id: 'master',
    label: 'Master',
    caption: 'HandCash Desktop software map — session host and child charts',
    source: MASTER,
  },
  {
    id: 'walletIo',
    label: 'Wallet I/O',
    caption: 'Process topology + external peers (chain, cloud, bridge, device)',
    source: WALLET_IO,
  },
  {
    id: 'coordinator',
    label: 'Coordinator',
    caption: 'walletCoordinatorMachine — exclusive regions + nested heal',
    source: COORDINATOR,
  },
  {
    id: 'spendSign',
    label: 'Sign / broadcast',
    caption:
      'signedSendLifecycle — seal → durable miner queue → Arcade reject oracle → BUMP finality; metadata routes separately',
    source: SPEND_SIGN,
  },
  {
    id: 'txUtxoLifecycle',
    label: 'Tx / UTXO lifecycle',
    caption:
      'Dual-layer confirmation — ARC status + soft-locks; MINED only after SPV BUMP',
    source: TX_UTXO_LIFECYCLE,
  },
  {
    id: 'chainIngestChart',
    label: 'Chain ingest',
    caption: 'Refresh pipeline — find coins; do not judge unconfirmed cheques',
    source: CHAIN_INGEST_CHART,
  },
  {
    id: 'messageboxChart',
    label: 'Messagebox',
    caption: 'BRC-33 ideal vs BRC-CLOUD convenience — not custody',
    source: MESSAGEBOX_CHART,
  },
  {
    id: 'appSession',
    label: 'Session',
    caption: 'appSession — boot, lock, ready, failure',
    source: APP_SESSION,
  },
  {
    id: 'unlockForm',
    label: 'Unlock',
    caption: 'unlockForm — password create / unlock / restore',
    source: UNLOCK,
  },
  {
    id: 'accountHolding',
    label: 'Account holding',
    caption: 'One install per vault account — check, reserve, move between devices (accountHolding.ts)',
    source: ACCOUNT_HOLDING,
  },
  {
    id: 'accountMove',
    label: 'Account move',
    caption: 'accountMoveMachine — ask the holder, take on release, force after its silence (draft BRC-249)',
    source: ACCOUNT_MOVE,
  },
  {
    id: 'walletNav',
    label: 'Nav',
    caption: 'walletNav — sections and child panels',
    source: WALLET_NAV,
  },
  {
    id: 'sendPayment',
    label: 'Send',
    caption: 'sendPayment — edit → confirm → hand off to the wallet',
    source: SEND,
  },
  {
    id: 'assetSend',
    label: 'Send item / token',
    caption:
      'assetSendMachine — edit → confirm without a sat amount; collectableSendMachine owns refuse',
    source: ASSET_SEND,
  },
  {
    id: 'receiveFlow',
    label: 'Receive',
    caption: 'receiveFlow — address, copy, QR',
    source: RECEIVE,
  },
  {
    id: 'friendsFlow',
    label: 'Friends',
    caption: 'friends — list, add, details',
    source: FRIENDS,
  },
  {
    id: 'collectablesFlow',
    label: 'Items',
    caption: 'collectables — inventory, deferred media, send and burn',
    source: COLLECTABLES,
  },
  {
    id: 'modelViewer',
    label: '3D viewer',
    caption:
      'modelViewerMachine — skeleton → first frame | named failure and retry',
    source: MODEL_VIEWER,
  },
  {
    id: 'sendCollectable',
    label: 'Send item',
    caption: 'collectableSendMachine — classify → p2pkhSend | refuse',
    source: SEND_COLLECTABLE,
  },
  {
    id: 'sendCollectableRun',
    label: 'Bulk item send',
    caption:
      'collectableSendRunMachine — selection → one atomic tx; split only an item conflict, halt on every other fault',
    source: SEND_COLLECTABLE_RUN,
  },
  {
    id: 'assetBurnUi',
    label: 'Burn',
    caption:
      'assetBurn UI — side panel: edit → confirm → hand off to the wallet',
    source: ASSET_BURN_UI,
  },
  {
    id: 'assetBurn',
    label: 'Asset burn',
    caption:
      'burnMachine — 1Sat burn → managed Pay recovery | named refuse',
    source: ASSET_BURN,
  },
  {
    id: 'serverWalletRecover',
    label: 'Dev wallet recover',
    caption:
      'serverWalletRecoverMachine — dev key wallet money → BRC-29 to this wallet → internalize | named refuse',
    source: SERVER_WALLET_RECOVER,
  },
  {
    id: 'sendPath',
    label: 'Send path',
    caption:
      'chooseSendPath — stored BRC-150 + confirmed → p2pkhSend | refuse',
    source: COLLECTABLE_SEND_PATH,
  },
  {
    id: 'authenticity',
    label: 'Authenticity',
    caption: 'authenticityMachine — BRC-150 proof ladder',
    source: AUTHENTICITY,
  },
  {
    id: 'itemSend',
    label: 'Item send',
    caption: 'itemSendMachine — noSend sign/settle + safe signed-BEEF retry',
    source: ITEM_SEND,
  },
  {
    id: 'bsvSend',
    label: 'BSV send',
    caption: 'bsvSendMachine — pasted / external P2PKH',
    source: BSV_SEND,
  },
  {
    id: 'brc29Send',
    label: 'BRC-29 send',
    caption: 'brc29SendMachine — broadcast in the spend region → peerDeliver | selfReceive after it',
    source: BRC29_SEND,
  },
  {
    id: 'offer',
    label: 'Offer',
    caption:
      'offerMachine — market list / cancel; one SINGLE|ACP seller signature (offerSeal); abort+restore the lot until the cheque is registered',
    source: OFFER,
  },
  {
    id: 'countersign',
    label: 'Countersigned',
    caption:
      'countersignMachine — issuer-accepted tokens and items: holder signs, the issuer (or m of n cosigners) countersigns or refuses; nothing exists until accepted',
    source: COUNTERSIGN,
  },
  {
    id: 'bnt',
    label: 'BNT',
    caption:
      'bntMachine — open BRC-255 tokens and items: wallet builds and signs, the §6 package rides box bnt, receive walks to the deploy',
    source: BNT,
  },
  {
    id: 'coin',
    label: 'Coins (LTC, BCH, BTC, DOGE)',
    caption:
      'coinMachine — native Litecoin, Bitcoin Cash, Bitcoin and Dogecoin on the wallet\'s own key per chain (BRC-213): received coins spendable once buried on its own header chain (LTC 6: scrypt + 2016-block retarget; BCH 6: SHA-256d + ASERT; BTC 3: SHA-256d + 2016-block retarget; DOGE 20: AuxPoW + DigiShield); payments signed, recorded, broadcast and kept alive until confirmed. A payment to an identity (BRC-213 §7) is refused unless the recipient\'s signed record names the coin, is locked to a fresh BRC-42 child of the recipient, and owes it a sealed notice in box coin-payment, retried, never gating the payment; a notice is read through the same reading → received | refused path against the key derived for its sender. Nothing is wrapped.',
    source: COIN,
  },
  {
    id: 'swap',
    label: 'Swap',
    caption:
      'swapMachine — swap between coins this wallet holds, no addresses pasted: direct offers (maker-signed, verified here) ranked ahead of Exolix whenever they pay at least as much, priced halfway between the market rate and Exolix\'s; Exolix fills the rest, paying out to this wallet\'s own address and holding the coins while it swaps. Only CONFIRM moves coins. When no route takes the swap (under Exolix\'s minimum, say), OFFER reviews an offer at the market rate, PARTS lets takers fill part of it (down to a floor that keeps each claim worth its fee), and PUBLISH signs it to the market engine\'s offer book; publishing moves no coin.',
    source: SWAP,
  },
  {
    id: 'swapOffers',
    label: 'Swap offers',
    caption:
      'swapOffersMachine — browse the market engine\'s swap offer book (BRC-CLOUD hosts, never trusted: every offer is verified in the wallet). CANCEL withdraws this wallet\'s own offer with a signed withdrawal. REVIEW shows what taking someone else\'s offer locks, returns and costs, for all that is left of it (the maker\'s signed fills); AMOUNT takes a part of an offer that allows it. Only CONFIRM sends the take, after a balance check; the wallet then locks at once, and the maker need not be online.',
    source: SWAP_OFFERS,
  },
  {
    id: 'swapSettle',
    label: 'Swap settlement',
    caption:
      'swapSettleMachine — one wallet-to-wallet swap (settleRunner). Each pass reads box swap-settle and the chain, asks nextSettleStep, and runs the step only if this chart takes its event; the phase is kept on the swap record. FUND leaves negotiating for good, so a leg is locked at most once; CLAIM and REFUND only after this wallet locked. Both legs are hash-locked to the taker\'s secret: both complete or each payer refunds. No custodian; HandCash\'s 0.5% fee output shares the hash and returns to the payer if unclaimed.',
    source: SWAP_SETTLE,
  },
  {
    id: 'marketPurchase',
    label: 'Market buy',
    caption:
      'marketPurchaseMachine — list-time unlocks → broadcast → local self-reconcile | messagebox receipt',
    source: MARKET_PURCHASE,
  },
  {
    id: 'marketSellerSettlement',
    label: 'Market sell',
    caption:
      'marketSellerSettlementMachine — authorize terms → item-input signature → peer deliver',
    source: MARKET_SELLER_SETTLEMENT,
  },
  {
    id: 'connectedApps',
    label: 'Connect',
    caption: 'connectedApps — Connected apps list, details, scopes',
    source: CONNECTED_APPS,
  },
  {
    id: 'connectPermission',
    label: 'Connect',
    caption: 'connectPermission — BRC-100 app connect prompt',
    source: CONNECT_PERMISSION,
  },
  {
    id: 'appBrowserPage',
    label: 'App tab',
    caption: 'appBrowserPage — in-app browser tab page lifecycle',
    source: APP_BROWSER_PAGE,
  },
  {
    id: 'actionPermission',
    label: 'Action',
    caption: 'actionPermission — BRC-100 pay / sign prompt',
    source: ACTION_PERMISSION,
  },
  {
    id: 'activityFeed',
    label: 'Activity',
    caption:
      'activity — feed, filters; clear signed sends only if inputs spent',
    source: ACTIVITY,
  },
  {
    id: 'identityPanel',
    label: 'Identity',
    caption: 'identity — keys, copy, QR',
    source: IDENTITY,
  },
  {
    id: 'publicIdentities',
    label: 'Public identities',
    caption: 'Identity keys and their own signed profiles (name, photo; no fee); optional BAP mirror: quoted, approved publish, link and key rotation; signers and encrypted backup',
    source: PUBLIC_IDENTITIES,
  },
  {
    id: 'settingsFlow',
    label: 'Settings',
    caption: 'settings — keys, history, about, nested panels',
    source: SETTINGS,
  },
  {
    id: 'legacyImport',
    label: 'Import',
    caption: 'legacyImportMachine — saved legacy wallets · scan · explicit compatible-only sweep',
    source: LEGACY_IMPORT,
  },
  {
    id: 'importItemBrowser',
    label: 'Import items',
    caption: 'importItemBrowserMachine — saved items shelved by issuer · page · select · enqueue',
    source: IMPORT_ITEM_BROWSER,
  },
  {
    id: 'importQueue',
    label: 'Import queue',
    caption: 'importQueueMachine — background item import · 100 per call · 25 tips per tx · survives leaving the page',
    source: IMPORT_QUEUE,
  },
  {
    id: 'walletJob',
    label: 'Wallet job',
    caption: 'walletJobMachine — one long job (import run, sweep, balance heal) · one Activity row with a bar · rows fold under its id',
    source: WALLET_JOB,
  },
  {
    id: 'deviceBackup',
    label: 'Device backup',
    caption: 'deviceBackupMachine — devices · one direction · restore',
    source: DEVICE_BACKUP,
  },
  {
    id: 'changePassword',
    label: 'Password',
    caption: 'changePassword — re-encrypt vault',
    source: CHANGE_PASSWORD,
  },
  {
    id: 'backupPhrase',
    label: 'Keys',
    caption: 'backupKeys — BRC-140 / BRC-157 / BRC-75 reveal',
    source: BACKUP_PHRASE,
  },
  {
    id: 'wipeWallet',
    label: 'Wipe',
    caption: 'wipeWallet — factory reset on this device',
    source: WIPE,
  },
  {
    id: 'qrReveal',
    label: 'QR',
    caption: 'qrReveal — receive / identity QR dialog',
    source: QR,
  },
  {
    id: 'qrScanner',
    label: 'Scanner',
    caption: 'qrScanner — camera acquisition · throttled decode · cleanup',
    source: QR_SCANNER,
  },
  {
    id: 'appUpdate',
    label: 'Updates',
    caption: 'appUpdate — check, download, ready (Cursor-style modes)',
    source: UPDATE,
  },
  {
    id: 'brc100Bridge',
    label: 'Bridge',
    caption:
      'BRC-100 local bridge — online, handle, prompt; app createAction loading ends at preparing (Arcade/cheque background)',
    source: BRIDGE,
  },
]

/** Page ids that can be opened from a diagram node click (excludes master hub). */
export const STATECHART_NAVIGABLE_IDS: ReadonlySet<string> = new Set(
  APP_STATECHART_PAGES.map((p) => p.id).filter((id) => id !== 'master')
)
