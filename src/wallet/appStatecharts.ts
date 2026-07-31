/**
 * HandCash Desktop — master + per-machine Mermaid statecharts.
 * Readable charts for Settings → About → View statecharts.
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
  appSession --> sendPayment : OPEN_SEND
  appSession --> wipeWallet : Settings wipe
  appSession --> qrReveal : show QR
  appSession --> appUpdate : always (background)

  appSession : Host · boot locked ready sending
  unlockForm : Password create unlock restore
  sendPayment : Edit confirm broadcast
  wipeWallet : Factory reset device
  qrReveal : Receive identity dialog
  appUpdate : Check download ready
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

  boot : Start · load vault
  onboarding : Create or restore
  locked : Password gate
  ready : Dashboard · nav
  sending : Payment flow open
  failure : Fatal boot error
`

const UNLOCK = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> submitting : SUBMIT\\n(password ≥ 8)
  submitting --> success : SUCCESS
  submitting --> failure : FAIL
  failure --> idle : RETRY / CHANGE
  success --> [*]
  idle : Edit password
  submitting : Unlocking vault
  success : Done
  failure : Show error
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
  editing : Amount · recipient
  confirming : Review send
  broadcasting : createAction
  success : Receipt
  failure : Error · retry
`

const WIPE = `stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> wiping : SUBMIT\\n(DELETE + ack)
  wiping --> success : SUCCESS
  wiping --> failure : FAIL
  failure --> idle : RETRY
  success --> [*]
  idle : Confirm wipe
  wiping : Clearing vault
  success : Restart required
  failure : Show error
`

const QR = `stateDiagram-v2
  direction LR
  [*] --> closed
  closed --> open : SHOW
  open --> closed : HIDE
  closed : Hidden
  open : QR dialog
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
  ready : Restart to install
  notAvailable : Up to date / soft miss
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
    id: 'sendPayment',
    label: 'Send',
    caption: 'sendPayment — edit → confirm → broadcast',
    source: SEND,
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
]
