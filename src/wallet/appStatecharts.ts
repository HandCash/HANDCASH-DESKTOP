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
  appSession --> chainIngestChart : Refresh
  appSession --> messageboxChart : chat relay

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
  connectedApps : Connected apps
  connectPermission : Connect prompt
  actionPermission : Action prompt
  activityFeed : Activity
  identityPanel : Identity
  settingsFlow : Settings
  changePassword : Change password
  backupKeys : Keys backup
  historyBackup : History backup
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
`

const APP_SESSION = `stateDiagram-v2
  direction TB
  [*] --> boot

  boot --> locked : BOOTSTRAPPED\\nhas vault
  boot --> onboarding : BOOTSTRAPPED\\nnew / restore-only
  boot --> failure : FAIL

  onboarding --> ready : CREATED
  locked --> ready : UNLOCKED / CREATED
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
  confirming --> broadcasting : CONFIRM
  broadcasting --> success : SUCCESS
  broadcasting --> failure : FAIL
  success --> editing : RESET
  failure --> editing : BACK / RESET
  editing : Edit
  confirming : Confirm
  broadcasting : Broadcast
  success : Success
  failure : Failure
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
  sendCollectable --> details : back / done
  grid : Grid
  details : Details
  sendCollectable : Send item
`

const SEND_COLLECTABLE = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> classifying : START with SendPath
  classifying --> softLatch : softLatch
  classifying --> refusing : refuse
  refusing --> failed
  softLatch --> done : SUCCESS
  softLatch --> failed : FAIL
  done --> idle : RESET
  failed --> idle : RESET
`

const COLLECTABLE_SEND_PATH = `stateDiagram-v2
  direction TB
  [*] --> tipKind
  tipKind --> covenantLocked : long non-P2PKH
  tipKind --> softP2pkh : P2PKH
  tipKind --> unknown : empty / other
  covenantLocked --> refuse : abandon only
  softP2pkh --> softLatch
  unknown --> softLatch : BRC-150 proven
  unknown --> refuse : unproven
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
    Legacy brc156 paints as BRC-150
  end note
`

const SOFT_LATCH_SEND = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> building : START with ItemSettlePath
  building --> createAction : BUILT
  createAction --> chooseSettle : CREATED with txid\\nnoSend
  createAction --> signing : CREATED needs sign
  signing --> chooseSettle : SIGNED noSend
  chooseSettle --> peerDeliver : peerDeliver
  chooseSettle --> selfReceive : selfReceive
  chooseSettle --> externalBroadcast : externalBroadcast
  peerDeliver --> confirmBroadcast : DELIVERED
  peerDeliver --> senderFallback : DELIVER_FAILED
  confirmBroadcast --> done : BROADCASTED / SKIPPED
  senderFallback --> done : BROADCASTED
  selfReceive --> done : BROADCASTED
  externalBroadcast --> done : BROADCASTED
  note right of peerDeliver
    No BROADCASTED edge.
    Silent sender postBeef after inbox.
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
  peerNotify --> done : BEEF_IN_BOX / REMIT_IN_BOX / BOX_UNREACHABLE
  selfReceive --> done : SETTLED
  note right of broadcasting
    Toolbox createAction broadcasts now.
    Inbox is notify + outbox retry.
    No noSend / no second tx.
  end note
  preparing --> failed : FAIL
  broadcasting --> failed : FAIL
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
  pending --> idle : ALLOW
  pending --> idle : DENY
  idle : Idle
  loading : Loading
  pending : Pending
`

const ACTION_PERMISSION = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> loading : request
  loading --> pending : icon ready
  pending --> idle : ALLOW
  pending --> idle : DENY / ALLOW+auto
  idle : Idle
  loading : Loading
  pending : Pending
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
  settingsHome --> trustholderBackup : open
  settingsHome --> deviceHandoff : open
  settingsHome --> historyBackup : open
  settingsHome --> wipeWallet : open
  settingsHome --> aboutHandCash : open
  changePassword --> settingsHome : back
  backupKeys --> settingsHome : back
  backupKeys --> trustholderBackup : add trustholder
  trustholderBackup --> backupKeys : back
  trustholderBackup --> historyBackup : continue after offline slice
  trustholderBackup --> settingsHome : back
  deviceHandoff --> backupKeys : open keys
  deviceHandoff --> historyBackup : open history
  deviceHandoff --> trustholderBackup : open cloud keys
  deviceHandoff --> settingsHome : back
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
  trustholderBackup : Cloud key backup
  deviceHandoff : Use on another device
  historyBackup : History
  wipeWallet : Wipe
  aboutHandCash : About HandCash
  statecharts : Statecharts
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
    SPEND["Spend machines\\nBSV / soft-latch / BRC-100"]
    INGEST["chainIngest\\nscan → classify → import"]
    HIST["historyReplica\\nBRC-39"]
    HANDLER["brc100Handler\\ndevicePeerHandler"]
  end

  subgraph Chain["Chain / SPV peers"]
    BITAILS["Bitails\\nrawtx · UTXO · postBeef"]
    WOC["WhatsOnChain\\nfallback"]
    JB["JungleBus"]
    GP["GorillaPool ordinals"]
    CT["Chaintracks\\nheaders"]
    ARC["ARC stack\\nBitails · Arcade · GP · TAAL · WoC"]
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
  INGEST --> BITAILS
  INGEST --> WOC
  INGEST --> GP
  INGEST --> JB
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

/** Signing + settle — noSend create/sign; ItemSettlePath owns who broadcasts. */
const SPEND_SIGN = `stateDiagram-v2
  direction LR
  [*] --> prepare

  prepare --> createAction : local balance / lease ok
  prepare --> refuse : TipKind refuse / thin funds

  createAction --> signedNoSend : noSend + signAndProcess
  signedNoSend --> peerDeliver : ItemSettlePath peerDeliver
  signedNoSend --> selfReceive : selfReceive
  signedNoSend --> externalBroadcast : pasted address
  peerDeliver --> confirmBroadcast : messagebox accepted
  confirmBroadcast --> postBeef : silent sender postBeef
  peerDeliver --> senderFallback : DELIVER_FAILED
  senderFallback --> postBeef : sender fallback
  selfReceive --> postBeef
  externalBroadcast --> postBeef
  postBeef --> done : accepted
  signedNoSend --> sendWithOk : BSV BRC-29 same pattern
  sendWithOk --> done : no failure
  postBeef --> failed : missing-inputs / reject
  sendWithOk --> failed : sendWith failure
  createAction --> review : WERR_REVIEW_ACTIONS / reserved batch
  review --> recover : abort batches · no unfail
  recover --> createAction : retry
  refuse --> failed
  failed --> [*]
  done --> [*] : activity + history push
`

/** Receive / Refresh pipeline. */
const CHAIN_INGEST_CHART = `flowchart TB
  START([refreshFromChain]) --> RECON[reconcile pending sends\\nheal ghost · abort batches]
  RECON --> SCAN[legacy address UTXO scan\\nBitails → WoC]
  SCAN --> CLASS[classifyLegacyUtxos]
  CLASS --> FUND[funding → importLegacyUtxos]
  CLASS --> BUNDLE[soft-latch tip+latch\\none BEEF · concurrency 3]
  CLASS --> TIPS[solo 1sat tips]
  CLASS --> FT[bsv21 tokens]
  CLASS --> HOLD[held unrecognized 1-sat\\nnever sweep]
  BUNDLE --> PAINT[listCollectables paint]
  TIPS --> PAINT
  PAINT --> AUTH[authenticity / genesis\\nbudgeted background]
  FUND --> AUDIT[spendable audit report-only]
  BUNDLE --> AUDIT
  TIPS --> AUDIT
  FT --> AUDIT
  AUDIT --> BAL[balance refresh + toast]
  BAL --> END([ok])
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
    HARD["hardcoded BRC-CLOUD\\n/v1/messagebox"] --> SEND2["sendMessage\\nplaintext / handcash-message cards"]
    SEND2 --> FILES["optional POST /files → R2"]
    HARD --> POLL["listMessages by recipient key\\nno BRC-31 auth yet"]
    POLL --> LOCAL2["messageStore"]
  end

  subgraph NotBox["Not messagebox"]
    CHAIN["BSV + soft-latch settle\\nlatch state OP_RETURN"]
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
    caption: 'noSend sign → ItemSettlePath (peer first) → optional sender postBeef',
    source: SPEND_SIGN,
  },
  {
    id: 'chainIngestChart',
    label: 'Chain ingest',
    caption: 'Refresh pipeline — scan → classify → import → paint',
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
    caption: 'sendPayment — edit → confirm → broadcast',
    source: SEND,
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
    caption: 'collectables — inventory, details, send',
    source: COLLECTABLES,
  },
  {
    id: 'sendCollectable',
    label: 'Send item',
    caption: 'collectableSendMachine — classify → softLatch | refuse',
    source: SEND_COLLECTABLE,
  },
  {
    id: 'sendPath',
    label: 'Send path',
    caption: 'chooseSendPath — TipKind → softLatch | refuse (150-proven unknown ok)',
    source: COLLECTABLE_SEND_PATH,
  },
  {
    id: 'authenticity',
    label: 'Authenticity',
    caption: 'authenticityMachine — BRC-150 ladder (legacy brc156 → 150)',
    source: AUTHENTICITY,
  },
  {
    id: 'softLatchSend',
    label: 'Soft-latch send',
    caption: 'softLatchSendMachine — noSend sign → peerDeliver | self | external',
    source: SOFT_LATCH_SEND,
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
    caption: 'activity — feed, filters, payment details',
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
  APP_STATECHART_PAGES.map((p) => p.id).filter((id) => id !== 'master'),
)
