import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@aeon-ui/react'
import { describe, expect, it } from 'vitest'
import { handcashBrand } from '../assets/brand'
import { normalizeHtml } from '../test/domParityNormalizer'
import { convertTsxToRsx } from '../../scripts/tsx-to-rsx.mjs'
import { ACCEPTED_COINS_CHOICES, acceptedCoinsChoice } from '../wallet/acceptedCoins'
import { DEFAULT_PAYMENT_FILTERS } from '../wallet/paymentFilters'
import { WALLET_ACTIVITY_ORIGIN } from '../wallet/appActivity'
import { setDeviceLockMode } from '../wallet/deviceLockPrefs'
import { AddFriendPanel } from './AddFriendPanel'
import { AppDetailsPanel } from './AppDetailsPanel'
import { AppToastHost } from './AppToastHost'
import { AuthScreen } from './AuthScreen'
import { AuthShell } from './AuthShell'
import { BrandLogo } from './BrandLogo'
import { ConnectedAppsPanel } from './ConnectedAppsPanel'
import { CreateKeysBackupPanel } from './CreateKeysBackupPanel'
import { rememberDecodedUrl } from './DeferredImage'
import { EmptyState } from './EmptyState'
import { FiatCurrencyMenu } from './FiatCurrencyMenu'
import { FiatCurrencyPanel } from './FiatCurrencyPanel'
import { FriendDetailsPanel } from './FriendDetailsPanel'
import { FriendsPanel } from './FriendsPanel'
import {
  ActivityIcon,
  BackIcon,
  CheckIcon,
  CloseIcon,
  CoinGlyphIcon,
  DarkModeIcon,
  LightModeIcon,
  MonitorIcon,
  PersonAddIcon,
} from './icons'
import { OnboardAcceptPanel } from './OnboardAcceptPanel'
import { OnboardEntryPanel } from './OnboardEntryPanel'
import { OnboardFiatPanel } from './OnboardFiatPanel'
import { OnboardProtectPanel } from './OnboardProtectPanel'
import { PaymentDetailsPanel } from './PaymentDetailsPanel'
import { PaymentFiltersPanel } from './PaymentFiltersPanel'
import { RecentActivityPanel } from './RecentActivity'
import { SettingsControlRow } from './settings/SettingsControlRow'
import { SettingsFiatDropdown } from './settings/SettingsFiatDropdown'
import { SettingsIconToggle } from './settings/SettingsIconToggle'
import { SettingsNavRow } from './settings/SettingsNavRow'
import { SettingsSection } from './settings/SettingsSection'
import { SETTINGS_APPLICATION_ICONS, settingIconFor } from './settings/settingIcons'
import { WalletHealthAlertBadge } from './settings/WalletHealthAlertBadge'
import { WalletAccountMenu } from './WalletAccountMenu'
import { WalletActionBar } from './WalletActionBar'

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  ;(globalThis as { window?: unknown }).window = globalThis
}
if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
  ;(globalThis as { document?: unknown }).document = {
    documentElement: {
      getAttribute: () => 'dark',
      setAttribute: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixturesRoot = path.join(rootDir, 'native-desktop/fixtures/ui')
const noop = () => {}

const SAMPLE_MNEMONIC =
  'absurd avoid scissors anxiety gather lottery category door army half long cage bachelor another expect people blade school educate curtain scrub monitor lady beyond'
const SAMPLE_ROOT_KEY =
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'

function recordFixture(component: string, state: string, element: React.ReactElement): string {
  const raw = renderToStaticMarkup(element)
  const normalized = normalizeHtml(raw)
  const dir = path.join(fixturesRoot, component)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${state}.html`), `${normalized}
`, 'utf8')
  return normalized
}

describe('Rust UI DOM parity recorder & TSX-to-RSX converter', () => {
  it('converts TSX JSX snippets into Dioxus rsx! skeletons', () => {
    const sample = `<Button.Root variant="solid" className="btn btn-primary" data-aeon-part="submit"><Button.Label>Save</Button.Label></Button.Root>`
    const rsx = convertTsxToRsx(sample)
    expect(rsx).toContain('button::Root')
    expect(rsx).toContain('button::ButtonVariant::Solid')
    expect(rsx).toContain('class: "btn btn-primary"')
    expect(rsx).toContain('"data-aeon-part": "submit"')
    expect(rsx).toContain('button::Label')
  })

  it('records normalized DOM fixtures for all 18 match rows in docs/rust-ui-parity-matrix.md', () => {
    // Pre-mark brand mark as decoded so BrandLogo renders its ready <img> state deterministically
    rememberDecodedUrl(handcashBrand.markGreenPng)

    // Row 1: WalletActionBar, WalletActionDock
    const actionBarNav = recordFixture(
      'wallet-action-bar',
      'nav',
      React.createElement(WalletActionBar, {
        placement: 'nav',
        ariaLabel: 'Send actions',
        secondary: {
          label: 'Back',
          shortLabel: 'Back',
          tone: 'secondary',
          icon: React.createElement(BackIcon, { size: 18 }),
          onClick: noop,
        },
        primary: {
          label: 'Next',
          shortLabel: 'Next',
          tone: 'primary',
          icon: React.createElement(CheckIcon, { size: 18 }),
          onClick: noop,
        },
      }),
    )
    expect(actionBarNav).toContain('class="wallet-action-bar wallet-action-bar--nav"')

    const actionBarDanger = recordFixture(
      'wallet-action-bar',
      'nav-danger',
      React.createElement(WalletActionBar, {
        placement: 'nav',
        ariaLabel: 'Confirm disconnect app',
        secondary: {
          label: 'Cancel',
          shortLabel: 'Cancel',
          tone: 'secondary',
          icon: React.createElement(CloseIcon, { size: 18 }),
          onClick: noop,
        },
        primary: {
          label: 'Disconnect',
          shortLabel: 'Disconnect',
          tone: 'danger',
          icon: React.createElement(CloseIcon, { size: 18 }),
          onClick: noop,
        },
      }),
    )
    expect(actionBarDanger).toContain('data-cta="danger"')

    // Row 2: WalletAccountMenu, FiatCurrencyMenu, FiatCurrencyPanel
    const fiatMenu = recordFixture(
      'fiat-currency-menu',
      'closed',
      React.createElement(FiatCurrencyMenu, {
        amountLabel: '$0.00',
      }),
    )
    expect(fiatMenu).toContain('data-aeon-scope="fiat-currency"')

    const fiatPanel = recordFixture(
      'fiat-currency-panel',
      'usd',
      React.createElement(FiatCurrencyPanel),
    )
    expect(fiatPanel).toContain('class="panel fiat-currency-panel"')

    const accountMenu = recordFixture(
      'wallet-account-menu',
      'closed',
      React.createElement(WalletAccountMenu, {
        profile: {
          handle: 'alice',
          identityKey: '032a32ac11bbbd6b333b19cafc986e2508be3621246d75224e234a0d1a2f15eb75',
          address: '1Mmd5LJCnFKpkSYkZHdruZBs27koQoRpDj',
          chain: 'main',
        },
        identityLabel: '$alice',
        identityCopy: '$alice',
        onAccountSwitchStarted: noop,
        onAccountSwitched: noop,
      }),
    )
    expect(accountMenu).toContain('data-aeon-scope="wallet-account-menu"')

    // Row 3: AppToastHost
    const toastEmpty = recordFixture(
      'app-toast-host',
      'empty',
      React.createElement(AppToastHost),
    )
    expect(toastEmpty).toBe('')

    // Row 4: EmptyState, BrandLogo
    const emptyBasic = recordFixture(
      'empty-state',
      'basic',
      React.createElement(EmptyState, {
        icon: React.createElement(ActivityIcon, { size: 28 }),
        title: 'No activity yet',
        body: 'Sends, receives, connections, and other wallet actions show up here.',
      }),
    )
    expect(emptyBasic).toContain('data-aeon-scope="empty-state"')

    const emptyAction = recordFixture(
      'empty-state',
      'with-action',
      React.createElement(EmptyState, {
        icon: React.createElement(PersonAddIcon, { size: 28 }),
        title: 'No friends yet',
        body: 'Add someone by $handle or wallet key.',
        action: React.createElement(
          Button.Root,
          { variant: 'solid', className: 'btn btn-primary', onClick: noop },
          React.createElement(Button.Label, null, 'Add friend'),
        ),
      }),
    )
    expect(emptyAction).toContain('Add friend')

    const brandLogo = recordFixture(
      'brand-logo',
      'default',
      React.createElement(BrandLogo, { size: 28, showWordmark: true }),
    )
    expect(brandLogo).toContain('class="brand"')

    // Row 5: RecentActivity, PaymentFiltersPanel, PaymentDetailsPanel
    const paymentFilters = recordFixture(
      'payment-filters',
      'default',
      React.createElement(PaymentFiltersPanel, {
        value: DEFAULT_PAYMENT_FILTERS,
        origins: [
          { id: 'all', label: 'All' },
          { id: WALLET_ACTIVITY_ORIGIN, label: 'HandCash' },
        ],
        onChange: noop,
      }),
    )
    expect(paymentFilters).toContain('data-aeon-scope="payment-filters"')

    const recentActivity = recordFixture(
      'recent-activity',
      'empty',
      React.createElement(RecentActivityPanel, { chain: 'main' }),
    )
    expect(recentActivity).toContain('data-aeon-scope="recent-activity"')

    const paymentDetails = recordFixture(
      'payment-details',
      'not-found',
      React.createElement(PaymentDetailsPanel, {
        entryId: 'missing-entry',
        chain: 'main',
      }),
    )
    expect(paymentDetails).toContain('Transaction not found')

    // Row 6: FriendsPanel, AddFriendPanel, FriendDetailsPanel
    const friendsEmpty = recordFixture(
      'friends',
      'empty',
      React.createElement(FriendsPanel, { chain: 'main' }),
    )
    expect(friendsEmpty).toContain('data-aeon-scope="friends"')

    const addFriendIdle = recordFixture(
      'add-friend',
      'idle',
      React.createElement(AddFriendPanel, { chain: 'main' }),
    )
    expect(addFriendIdle).toContain('data-aeon-scope="add-friend"')

    const friendDetailsNotFound = recordFixture(
      'friend-details',
      'not-found',
      React.createElement(FriendDetailsPanel, {
        friendId: 'missing-friend',
        chain: 'main',
      }),
    )
    expect(friendDetailsNotFound).toContain('Friend not found')

    // Row 7: ConnectedAppsPanel, AppDetailsPanel
    const connectedAppsEmpty = recordFixture(
      'connected-apps',
      'empty',
      React.createElement(ConnectedAppsPanel, {
        apps: [],
        openTabCount: 0,
        onShowTabs: noop,
      }),
    )
    expect(connectedAppsEmpty).toContain('data-aeon-scope="connected-apps"')

    const appDetailsConnected = recordFixture(
      'app-details',
      'connected',
      React.createElement(AppDetailsPanel, {
        app: {
          origin: 'https://market.handcash.io',
          name: 'HandCash Market',
          connectedAt: 1700000000000,
        },
        onRevoke: noop,
        onDone: noop,
      }),
    )
    expect(appDetailsConnected).toContain('data-aeon-scope="app-details"')

    // Row 8: Preferences · Appearance, Accept
    const accepted = 'bitcoin' as const
    const acceptedChoice = acceptedCoinsChoice(accepted)
    const prefsAppearanceAccept = recordFixture(
      'settings-preferences',
      'appearance-accept',
      React.createElement(
        SettingsSection,
        { title: 'Preferences', part: 'preferences' },
        React.createElement(
          'ul',
          { className: 'settings-list' },
          React.createElement(
            SettingsControlRow,
            {
              icon: SETTINGS_APPLICATION_ICONS.appearance,
              label: 'Appearance',
              description: 'Follows Omarchy or your system theme.',
            },
            React.createElement(SettingsIconToggle, {
              ariaLabel: 'Appearance',
              value: 'system',
              onChange: noop,
              options: [
                { value: 'system', label: 'System', icon: React.createElement(MonitorIcon, { size: 16 }) },
                { value: 'dark', label: 'Dark', icon: React.createElement(DarkModeIcon, { size: 16 }) },
                { value: 'light', label: 'Light', icon: React.createElement(LightModeIcon, { size: 16 }) },
              ],
            }),
          ),
          React.createElement(
            SettingsControlRow,
            {
              icon: React.createElement(CoinGlyphIcon, { coin: 'bsv', size: 20 }),
              label: 'Accept',
              description: `${acceptedChoice.title}. ${acceptedChoice.description}`,
            },
            React.createElement(SettingsIconToggle, {
              ariaLabel: 'Accept',
              value: accepted,
              onChange: noop,
              options: ACCEPTED_COINS_CHOICES.map((choice) => ({
                value: choice.id,
                label: choice.title,
                icon:
                  choice.id === 'bitcoin'
                    ? React.createElement(CoinGlyphIcon, { coin: 'bsv', size: 16 })
                    : React.createElement(
                        'span',
                        { className: 'accepted-coins-glyphs' },
                        React.createElement(CoinGlyphIcon, { coin: 'bsv', size: 12 }),
                        React.createElement(CoinGlyphIcon, { coin: 'ltc', size: 12 }),
                      ),
              })),
            }),
          ),
        ),
      ),
    )
    expect(prefsAppearanceAccept).toContain('data-aeon-part="preferences"')

    // Row 9: Preferences · Currency (SettingsFiatDropdown)
    const settingsFiat = recordFixture(
      'settings-fiat-dropdown',
      'closed',
      React.createElement(SettingsFiatDropdown),
    )
    expect(settingsFiat).toContain('settings-fiat-menu')

    // Row 10: Support · Wallet health row + WalletHealthAlertBadge
    const healthRowOk = recordFixture(
      'settings-wallet-health-row',
      'ok',
      React.createElement(
        'ul',
        { className: 'settings-list' },
        React.createElement(SettingsNavRow, {
          label: 'Wallet health',
          description: 'All 5 checks OK',
          icon: settingIconFor('wallet-health').icon,
          onClick: noop,
        }),
      ),
    )
    expect(healthRowOk).toContain('All 5 checks OK')

    const healthRowWarn = recordFixture(
      'settings-wallet-health-row',
      'warn',
      React.createElement(
        'ul',
        { className: 'settings-list' },
        React.createElement(SettingsNavRow, {
          label: 'Wallet health',
          status: '1 of 5 checks degraded',
          statusTone: 'warn',
          icon: settingIconFor('wallet-health').icon,
          trailingEnd: React.createElement(WalletHealthAlertBadge, { tone: 'warn' }),
          onClick: noop,
        }),
      ),
    )
    expect(healthRowWarn).toContain('wallet-health-alert')

    // Row 11: AuthShell, AuthMeshBackground, OnboardEntryPanel, auth/AuthEntryTaglines
    const authShellEntry = recordFixture(
      'auth-shell',
      'onboard-entry',
      React.createElement(
        AuthShell,
        { state: 'onboarding' },
        React.createElement(OnboardEntryPanel, {
          onSignIn: noop,
          onCreate: noop,
          onMigrate: noop,
        }),
      ),
    )
    expect(authShellEntry).toContain('data-aeon-scope="auth-shell"')
    expect(authShellEntry).toContain('data-aeon-state="onboard-entry"')

    // Row 12: AuthScreen · Create form
    const authCreate = recordFixture(
      'auth-create',
      'idle',
      React.createElement(AuthScreen, {
        mode: 'onboarding',
        initialMode: 'create',
        error: null,
        onCreated: noop,
        onUnlocked: noop,
        onBalanceRefreshed: noop,
        onFail: noop,
      }),
    )
    expect(authCreate).toContain('Create wallet')

    // Row 13: AuthScreen · Restore (phrase) form
    const authRestorePhrase = recordFixture(
      'auth-restore-phrase',
      'idle',
      React.createElement(AuthScreen, {
        mode: 'onboarding',
        initialMode: 'phrase',
        error: null,
        onCreated: noop,
        onUnlocked: noop,
        onBalanceRefreshed: noop,
        onFail: noop,
      }),
    )
    expect(authRestorePhrase).toContain('Restore on this device')

    // Row 14: AuthScreen · Unlock lede
    setDeviceLockMode('none')
    const authUnlock = recordFixture(
      'auth-unlock',
      'idle',
      React.createElement(AuthScreen, {
        mode: 'locked',
        initialMode: 'unlock',
        error: null,
        onCreated: noop,
        onUnlocked: noop,
        onBalanceRefreshed: noop,
        onFail: noop,
      }),
    )
    expect(authUnlock).toContain('Welcome back')

    // Row 15: CreateKeysBackupPanel (onboarding step)
    const keysBackup = recordFixture(
      'create-keys-backup',
      'phrase',
      React.createElement(CreateKeysBackupPanel, {
        mnemonic: SAMPLE_MNEMONIC,
        rootKeyHex: SAMPLE_ROOT_KEY,
        onDone: noop,
      }),
    )
    expect(keysBackup).toContain('data-aeon-scope="create-keys-backup"')

    // Row 16: OnboardAcceptPanel
    const onboardAccept = recordFixture(
      'onboard-accept',
      'bitcoin',
      React.createElement(OnboardAcceptPanel, { onDone: noop }),
    )
    expect(onboardAccept).toContain('data-aeon-scope="onboard-accept"')

    // Row 17: OnboardFiatPanel
    const onboardFiat = recordFixture(
      'onboard-fiat',
      'usd',
      React.createElement(OnboardFiatPanel, { onDone: noop }),
    )
    expect(onboardFiat).toContain('data-aeon-scope="onboard-fiat"')

    // Row 18: OnboardProtectPanel
    const onboardProtect = recordFixture(
      'onboard-protect',
      'none',
      React.createElement(OnboardProtectPanel, {
        wrapPassword: 'Hc1WrapSecretPassword123456',
        initialChoice: { noneAllowed: true, defaultMode: 'none' },
        onDone: noop,
      }),
    )
    expect(onboardProtect).toContain('data-aeon-scope="onboard-protect"')
  })
})
