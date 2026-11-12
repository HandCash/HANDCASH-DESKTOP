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
        Your Bitcoin SV keys stay here; you approve app access through the local bridge.
      </p>

      <div className="about-handcash-body">
        <p>
          HandCash cannot recover your funds if you lose this device without a backup.
        </p>
        <p>
          This BETA is for a small group of testers. It uses BSV Association code under the Open BSV
          License, which BSVA is moving to Apache 2.0. Litecoin, Bitcoin, Bitcoin Cash, Dogecoin and
          swaps assume that move; public release waits for BSVA's Apache 2.0 packages.
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
