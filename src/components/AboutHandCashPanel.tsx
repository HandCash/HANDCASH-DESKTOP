import { openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { APP_VERSION } from '../version'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

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
          your control — split keys, a twelve-word phrase, and encrypted history backups.
        </p>
        <p>
          HandCash does not hold your seed or spend for you. If you lose this device without a
          backup, your funds cannot be recovered by support.
        </p>
        <p className="settings-row-desc">Version {APP_VERSION}</p>
      </div>

      <div className="actions about-handcash-actions">
        <button
          type="button"
          className="btn btn-ghost"
          data-aeon-part="view-statecharts"
          onClick={() => {
            playWalletSound('soft')
            openSetting('statecharts')
          }}
        >
          View statecharts
        </button>
      </div>

      <SettingsFeatureAbout tags={['BRC-100']}>
        Apps talk to this wallet over the local BRC-100 interface. Signing and permissions stay on
        your device.
      </SettingsFeatureAbout>
    </div>
  )
}
