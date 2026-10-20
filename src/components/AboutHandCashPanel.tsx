import { openSetting } from '../wallet/navStore'
import { APP_VERSION } from '../version'
import { SETTINGS_APPLICATION_ICONS, SettingsControlRow, SettingsNavRow, SettingsSection, settingIconFor } from './settings'

export function AboutHandCashPanel() {
  return (
    <div
      className="nav-section-body settings-scroll about-handcash"
      data-aeon-scope="about-handcash"
    >
      <p className="settings-hint about-handcash-lead">
        HandCash is a self-custodial Bitcoin SV wallet. Keys stay on this device; apps connect
        through a local bridge, and you approve what they can do.
      </p>

      <div className="about-handcash-body">
        <p>
          Use it to hold BSV, pay friends and apps, manage collectables, and keep recovery under
          your control — split keys, a recovery phrase, and encrypted history backups.
        </p>
        <p>
          HandCash does not hold your seed or spend for you. If you lose this device without a
          backup, your funds cannot be recovered by support.
        </p>
      </div>

      <SettingsSection title="This app" part="app">
        <ul className="settings-list">
          <SettingsControlRow label="Version" icon={SETTINGS_APPLICATION_ICONS.version}>
            <span className="settings-row-desc mono">{APP_VERSION}</span>
          </SettingsControlRow>
          <SettingsNavRow
            label="Statecharts"
            description="The state machines behind each flow"
            icon={settingIconFor('statecharts').icon}
            onClick={() => openSetting('statecharts')}
          />
        </ul>
      </SettingsSection>
    </div>
  )
}
