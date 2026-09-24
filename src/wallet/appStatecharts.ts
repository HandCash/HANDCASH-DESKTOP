import { machineStateManifest } from '../machines/machineManifest'

/** Executable machine inventory shown beside the hand-authored explanatory charts. */
export const executableWalletStatecharts = machineStateManifest()

/**
 * HandCash Desktop — master + per-scope Mermaid statecharts.
 * Readable charts for Settings → About → HandCash → View statecharts.
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
  appSession --> sendPayment : OPEN_SEND
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

  walletNav --> friendsFlow : Friends
  walletNav --> collectablesFlow : Collectables
  walletNav --> connectedApps : Connect
  walletNav --> activityFeed : Activity
  walletNav --> identityPanel : Identity
  walletNav --> settingsFlow : Settings

  collectablesFlow --> sendCollectable : send item
  collectablesFlow --> sendFungible : send token
  settingsFlow --> changePassword : change pw
  settingsFlow --> backupKeys : keys
  settingsFlow --> historyBackup : history
  settingsFlow --> deviceBackup : device backup
  settingsFlow --> aboutHandCash : about
  settingsFlow --> wipeWallet : wipe
  aboutHandCash --> statecharts : view charts

  appSession : Session host
  unlockForm : Unlock form
  walletNav : Nav sections
  sendPayment : Send payment
  receiveFlow : Receive
  friendsFlow : Friends
  collectablesFlow : Collectables
  sendCollectable : Send item
  sendFungible : Send token
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
  ready --> locked : LOCK
  ready --> sending : OPEN_SEND
  sending --> ready : SENT
  sending --> ready : CLOSE_SEND
  failure --> boot : CLEAR_ERROR / BOOTSTRAPPED

  boot : Boot
  onboarding : Onboarding
  locked : Locked
  ready : Ready
  sending : Sending
  failure : Failure

  note right of ready
    UNLOCKED/CREATED publishes one WalletRuntime.
    Account switch and LOCK abort/dispose that runtime first;
    stale feature completions are fenced by runtime generation.
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
  end note

  idle : Idle
  submitting : Submitting
  success : Success
  failure : Failure
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
  grid --> fungibleDetails : open token
  details --> grid : back
  fungibleDetails --> grid : back
  details --> sendCollectable : Send
  fungibleDetails --> sendFungible : Send
  details --> modelLoading : GLB / GLTF body
  modelLoading --> modelReady : READY
  modelLoading --> modelFailed : FAIL
  modelFailed --> modelLoading : RETRY
  details --> burnEditing : Burn item (side panel)
  fungibleDetails --> burnEditing : Burn token (side panel)
  sendCollectable --> details : back / done
  sendFungible --> fungibleDetails : back / done
  burnEditing --> burnConfirm : REVIEW
  burnConfirm --> burnEditing : BACK
  burnConfirm --> grid : FORGET / local relinquish + Activity
  burnEditing --> details : CANCEL item burn
  burnEditing --> fungibleDetails : CANCEL token burn
  burnConfirm --> burning : CONFIRM / Activity pending before queue
  burning --> burnDone : SUCCESS
  burning --> burnFailed : FAIL
  burnFailed --> burnEditing : BACK
  burnDone --> grid : item inventory refresh
  burnDone --> fungibleDetails : token inventory refresh
  grid : Grid
  details : Details
  modelLoading : 3D skeleton
  modelReady : Orbit / zoom / auto-rotate
  modelFailed : Named render failure
  fungibleDetails : Token details
  sendCollectable : Send item
  sendFungible : Send token
  burnEditing : Burn panel — amount + economics
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

const SEND_FUNGIBLE = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> classifying : START with Bsv21SendPath
  classifying --> plainSend : plain
  classifying --> refusing : refuse / cosigned
  refusing --> failed
  plainSend --> proving : load complete BRC-176 ancestry
  proving --> refusing : invalid token proof
  proving --> ancestorCheck : token proof valid
  ancestorCheck --> refusing : Arcade ancestor rejected / pending
  ancestorCheck --> signing : no hard ancestor rejection
  signing --> done : SUCCESS
  signing --> failed : FAIL
  plainSend --> failed : FAIL
  done --> idle : RESET
  failed --> idle : RESET
`

const BSV21_SEND_PATH = `stateDiagram-v2
  direction TB
  [*] --> classifySelectedTips
  classifySelectedTips --> plain : every selected lock is device P2PKH
  classifySelectedTips --> mixed : plain + cosigned
  classifySelectedTips --> cosigned : every selected lock needs cosigner
  classifySelectedTips --> unknown : missing / unrecognized / not ours
  plain --> plainSend
  mixed --> refuse : mixed_tips
  cosigned --> refuse : cosigner_required
  unknown --> refuse : unknown_lock
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
  editing : Choose amount
  confirming : Confirm fixed amount
  burning : Handed to wallet
  failure : Nothing destroyed
`

const ASSET_BURN = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> planning : START with BurnPlan
  planning --> building : burnBsv21 / burnOneSat
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
  preparing --> broadcasting : READY
  broadcasting --> chooseSettle : BROADCASTED createAction
  chooseSettle --> peerNotify : peerDeliver
  chooseSettle --> selfReceive : selfReceive
  peerNotify --> done : BEEF_IN_BOX / REMIT_IN_BOX / DIRECT / BOX_UNREACHABLE
  selfReceive --> done : SETTLED
  note right of broadcasting
    Toolbox createAction broadcasts now.
    Inbox is notify + outbox retry.
    No noSend / no second tx.
  end note
  preparing --> failed : FAIL
  broadcasting --> failed : FAIL
`

const MARKET_LISTING = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> classifying : LIST / CANCEL
  classifying --> failed : refuse / named reason
  classifying --> staging : createOffer / cancelOffer
  staging --> preSignAbortable : STAGED reference
  preSignAbortable --> signedUnknown : SIGNED_UNKNOWN
  signedUnknown --> broadcast : BROADCASTED
  signedUnknown --> failed : ABORTED
  signedUnknown --> recovery : FAIL / RECOVER
  recovery --> failed : ABORTED when Arcade never accepted
  recovery --> broadcast : BROADCASTED
  broadcast --> committed : COMMITTED
  preSignAbortable --> failed : ABORTED
  note right of signedUnknown
    noSend listing/cancel.
    Abort + restore tip while Arcade has not accepted.
    Never abort after BROADCASTED.
  end note
  note right of committed
    MarketReceiptDeliveryPath:
    self → local seller reconcile
    counterparty → messagebox receipt
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
  signedUnknown --> broadcast : BROADCASTED
  signedUnknown --> failed : ABORTED on Arcade hard-reject
  signedUnknown --> recovery : unknown result
  broadcast --> committed : COMMITTED
  recovery --> broadcast : recovered txid
  recovery --> failed : ABORTED when Arcade ghosted the tx
  preSignAbortable --> aborting : TIMEOUT / DUPLICATE / COMPETING_BUYER / FAIL
  sellerSigned --> aborting : pre-sign FAIL
  aborting --> failed : ABORTED
  note right of signedUnknown
    Buyer-local reference never crosses wallets.
    Inputs: item0, offer1, then buyer funding.
    Abort after sign only when Arcade hard-rejects
    (ghost / ARCADE_HARD_REJECT) — frees funding.
  end note
  note right of broadcast
    MarketSoldAnnouncePath (catalog hygiene, never custody):
    overlaySubmit → BRC-22 settlement + buyerIdentityKey + payment address
    skip → no-host | no-settlement-beef | buyer-identity-unknown
    miner ACK wait is bounded; pending outbox owns slow propagation
    buyer txid.0 extends the admitted BRC-150 proof and paints proven
    oversized seller receipt stays inline; seller fetches BEEF by txid
    local seller reconcile runs after spend lease + retries durably
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

const SETTINGS = `stateDiagram-v2
  direction TB
  [*] --> settingsHome
  settingsHome --> changePassword : open
  settingsHome --> backupKeys : open
  settingsHome --> deviceHandoff : open
  settingsHome --> historyBackup : open
  settingsHome --> wipeWallet : open
  settingsHome --> aboutHandCash : open
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
  idle --> wiping : SUBMIT\\n(DELETE + ack)
  wiping --> success : SUCCESS
  wiping --> failure : FAIL
  failure --> idle : RETRY
  success --> [*]
  idle : Idle
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
    KEYS["rootKeyHex + toolbox wallet"]
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
    LEASE["spend-lease"]
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
  SPEND --> LEASE
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
`

/** Signing + settle — one Bitcoin lifecycle; asset paths only route metadata. */
const SPEND_SIGN = `stateDiagram-v2
  direction LR
  [*] --> prepare

  prepare --> createAction : local balance / lease ok
  prepare --> refuse : TipKind refuse / thin funds

  createAction --> signedNoSend : noSend + signAndProcess
  signedNoSend --> peerDeliver : ItemSettlePath peerDeliver
  signedNoSend --> selfReceive : selfReceive
  signedNoSend --> externalBroadcast : pasted address
  prepare --> confirmBroadcast : retry unconfirmed signed BEEF\\nsource still unspent
  peerDeliver --> postBeef : common signed-send propagation\\nnotify async
  confirmBroadcast --> postBeef : silent sender postBeef
  selfReceive --> postBeef
  externalBroadcast --> postBeef
  postBeef --> done : accepted
  note right of signedNoSend
    registerSignedSend seals + queues before settle metadata.
    Asset data does not alter Bitcoin communication:
    same Arcade reject, retry, and BUMP finality as BSV.
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
  MAINT -.-> REIMP["reimport derived change\\ninternalize wallet payment\\nwhen remittance echo exists"]
  SCAN --> CLASS[classifyLegacyUtxos]
  CLASS --> FUND[funding → importLegacyUtxos]
  CLASS --> TIPS[1sat tips → importOneSatOrdinals]
  CLASS --> FT[bsv21 tokens]
  CLASS --> HOLD[held unrecognized 1-sat\\nnever sweep]
  CLASS --> DUST[heldUneconomical\\nbelow sweep floor\\nnever sweep]
  TIPS --> PAINT[listCollectables paint]
  PAINT --> AUTH[authenticity / genesis\\nbudgeted background]
  FUND --> AUDIT[spendable audit report-only\\nunconfirmed cheque ≠ spent]
  TIPS --> AUDIT
  FT --> AUDIT
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
    SEND2 --> IPV6["live IPv6 session\\ndraft BRC-246 when both reachable"]
    IPV6 --> LOCAL2["messageStore friend thread"]
    SEND2 --> FILES["optional chat attachments only\\nPOST /files → R2"]
    HARD --> POLL["listMessages by recipient key\\nX-BRC33-* / X-BRC103-* on BRC-CLOUD"]
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
    caption: 'appSession — boot, lock, ready, send overlay',
    source: APP_SESSION,
  },
  {
    id: 'unlockForm',
    label: 'Unlock',
    caption: 'unlockForm — password create / unlock / restore',
    source: UNLOCK,
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
      'assetSendMachine — edit → confirm without a sat amount; collectableSendMachine / bsv21SendMachine own refuse',
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
      'collectableSendRunMachine — selection → atomic legs; split only an item conflict, halt on every other fault',
    source: SEND_COLLECTABLE_RUN,
  },
  {
    id: 'sendFungible',
    label: 'Send token',
    caption:
      'bsv21SendMachine builds asset outputs; signedSendLifecycle owns the same miner + BUMP path as BSV',
    source: SEND_FUNGIBLE,
  },
  {
    id: 'bsv21SendPath',
    label: 'Token send path',
    caption: 'chooseBsv21BatchSendPath — selected tips → plain | named refuse',
    source: BSV21_SEND_PATH,
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
      'burnMachine — explicit BSV-21 / 1Sat burn → managed Pay recovery | named refuse',
    source: ASSET_BURN,
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
    caption: 'brc29SendMachine — noSend → peerDeliver | selfReceive',
    source: BRC29_SEND,
  },
  {
    id: 'marketListing',
    label: 'Market list',
    caption:
      'marketListingMachine — noSend list/cancel; abort+restore tip until Arcade accepts',
    source: MARKET_LISTING,
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
    id: 'settingsFlow',
    label: 'Settings',
    caption: 'settings — keys, history, about, nested panels',
    source: SETTINGS,
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
    caption: 'backupKeys — BRC-140 / BRC-75 reveal',
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
    caption: 'BRC-100 local bridge — online, handle, prompt',
    source: BRIDGE,
  },
]

/** Page ids that can be opened from a diagram node click (excludes master hub). */
export const STATECHART_NAVIGABLE_IDS: ReadonlySet<string> = new Set(
  APP_STATECHART_PAGES.map((p) => p.id).filter((id) => id !== 'master')
)
