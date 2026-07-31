/**
 * HandCash Desktop — master + per-scope Mermaid statecharts.
 * Readable charts for Settings → Lab → View statecharts.
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

  walletNav --> friendsFlow : Friends
  walletNav --> collectablesFlow : Collectables
  walletNav --> connectedApps : Apps
  walletNav --> activityFeed : Activity
  walletNav --> identityPanel : Identity
  walletNav --> settingsFlow : Settings

  collectablesFlow --> sendCollectable : send item
  settingsFlow --> changePassword : change pw
  settingsFlow --> backupPhrase : backup
  settingsFlow --> wipeWallet : wipe

  appSession : Session host
  unlockForm : Unlock form
  walletNav : Nav sections
  sendPayment : Send payment
  receiveFlow : Receive
  friendsFlow : Friends
  collectablesFlow : Collectables
  sendCollectable : Send item
  connectedApps : Apps
  connectPermission : Connect prompt
  actionPermission : Action prompt
  activityFeed : Activity
  identityPanel : Identity
  settingsFlow : Settings
  changePassword : Change password
  backupPhrase : Backup phrase
  wipeWallet : Wipe wallet
  qrReveal : QR dialog
  appUpdate : App update
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
    Modes: unlock | create | restore
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
  [*] --> edit
  edit --> confirm : REVIEW
  confirm --> edit : BACK
  confirm --> sending : CONFIRM
  sending --> success : SUCCESS
  sending --> failure : FAIL
  failure --> edit : RETRY
  success --> [*]
  edit : Edit
  confirm : Confirm
  sending : Sending
  success : Success
  failure : Failure
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
  settingsHome --> backupPhrase : open
  settingsHome --> wipeWallet : open
  settingsHome --> lab : open lab
  changePassword --> settingsHome : back
  backupPhrase --> settingsHome : back
  wipeWallet --> settingsHome : back / done
  lab --> settingsHome : back
  lab --> statecharts : view charts
  statecharts --> lab : back

  settingsHome : Settings
  changePassword : Password
  backupPhrase : Backup
  wipeWallet : Wipe
  lab : Lab
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

export const APP_STATECHART_PAGES: AppStatechartPage[] = [
  {
    id: 'master',
    label: 'Master',
    caption: 'HandCash Desktop software map — session host and child charts',
    source: MASTER,
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
    caption: 'sendCollectable — edit → confirm → transfer',
    source: SEND_COLLECTABLE,
  },
  {
    id: 'connectedApps',
    label: 'Apps',
    caption: 'connectedApps — list, details, scopes',
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
    caption: 'settings — home, lab, nested panels',
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
    label: 'Backup',
    caption: 'backupPhrase — reveal mnemonic',
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
