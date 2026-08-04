type Props = {
  /** Spec ids, e.g. BRC-39 */
  tags: string[]
  /** Short “about this feature” copy. */
  children: string
}

/** Footer for a settings detail screen — BRC context lives here, not in row titles. */
export function SettingsFeatureAbout({ tags, children }: Props) {
  return (
    <footer className="settings-feature-about" data-aeon-scope="feature-about">
      <div className="settings-feature-about-tags">
        {tags.map((tag) => (
          <span key={tag} className="spec-tag">
            {tag}
          </span>
        ))}
      </div>
      <p className="settings-feature-about-copy">{children}</p>
    </footer>
  )
}
