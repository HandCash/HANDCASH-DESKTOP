import { openSetting, type SettingId } from '../wallet/navStore'

type SettingItem = {
  id: SettingId
  label: string
  description: string
}

type SettingGroup = {
  title: string
  items: SettingItem[]
}

const SETTING_GROUPS: SettingGroup[] = [
  {
    title: 'Security',
    items: [
      {
        id: 'change-password',
        label: 'Change password',
        description: 'Update your wallet unlock password',
      },
    ],
  },
]

export function settingLabel(id: SettingId): string {
  for (const group of SETTING_GROUPS) {
    const item = group.items.find((entry) => entry.id === id)
    if (item) return item.label
  }
  return 'Setting'
}

export function SettingsPanel() {
  return (
    <div className="nav-section-body settings-nav" data-aeon-scope="settings">
      <div className="connected-panel-head">
        <h2>Settings</h2>
      </div>

      {SETTING_GROUPS.map((group) => (
        <section key={group.title} className="settings-group">
          <h3 className="settings-group-title">{group.title}</h3>
          <ul className="settings-list">
            {group.items.map(({ id, label, description }) => (
              <li key={id} className="settings-row">
                <button
                  type="button"
                  className="settings-row-main"
                  onClick={() => openSetting(id)}
                >
                  <span className="settings-row-body">
                    <strong className="settings-row-label">{label}</strong>
                    <span className="settings-row-desc">{description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
