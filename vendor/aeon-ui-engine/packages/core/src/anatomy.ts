/** Part keys for compound components — scope + named parts for styling and docs. */
export function anatomy<const T extends readonly string[]>(scope: string, parts: T) {
  return Object.fromEntries(parts.map((p) => [p, p])) as Record<T[number], T[number]> & {
    scope: typeof scope
  }
}

export const buttonAnatomy = anatomy('button', [
  'root',
  'group',
  'label',
  'icon',
] as const)

export const switchAnatomy = anatomy('switch', [
  'root',
  'control',
  'thumb',
  'label',
  'hiddenInput',
] as const)

export const checkboxAnatomy = anatomy('checkbox', [
  'root',
  'control',
  'indicator',
  'label',
  'hiddenInput',
] as const)

export const dialogAnatomy = anatomy('dialog', [
  'root',
  'trigger',
  'portal',
  'backdrop',
  'positioner',
  'content',
  'title',
  'description',
  'closeTrigger',
] as const)

/**
 * Prompt — confirm / permission / update-style dialog on top of Dialog.
 * Universal parts: eyebrow, meta, amount, actions (primary + secondary).
 * Command-confirm face (BRC-218 §4): verb, recipient, effect.
 */
export const promptAnatomy = anatomy('prompt', [
  'root',
  'eyebrow',
  'meta',
  'amount',
  'verb',
  'recipient',
  'effect',
  'actions',
  'primary',
  'secondary',
] as const)

/**
 * AppNav — section + detail stack (list→detail, settings drill-in).
 */
export const appNavAnatomy = anatomy('appNav', [
  'root',
  'rail',
  'section',
  'stage',
  'breadcrumb',
  'crumb',
  'back',
] as const)

/**
 * StatusBanner — non-blocking top-of-app notice (update ready, syncing, offline).
 */
export const statusBannerAnatomy = anatomy('statusBanner', [
  'root',
  'copy',
  'title',
  'body',
  'actions',
] as const)

export const tabsAnatomy = anatomy('tabs', [
  'root',
  'list',
  'trigger',
  'content',
  'indicator',
] as const)

export const accordionAnatomy = anatomy('accordion', [
  'root',
  'item',
  'itemTrigger',
  'itemContent',
  'itemIndicator',
] as const)

/** Async data region — track shows every lifecycle state; readout + actions mirror snapshot. */
export const asyncAnatomy = anatomy('async', [
  'root',
  'track',
  'segment',
  'readout',
  'readoutRail',
  'readoutBody',
  'actions',
] as const)

/** Form field — orthogonal interaction × validation × submission (see STATES.md). */
export const fieldAnatomy = anatomy('field', [
  'root',
  'label',
  'control',
  'textarea',
  'message',
  'hint',
] as const)

/** Scroll viewport — overflow axis + edge position on data-aeon-state. */
export const scrollAnatomy = anatomy('scroll', ['root', 'viewport', 'content'] as const)

/**
 * Spatial play surface — universal mat + regions + entities (not a specific game).
 * App logic names regions; entity labels come from compose `items`. See LAYOUT_COORDINATES.md.
 */
export const playSurfaceAnatomy = anatomy('play', ['root', 'mat', 'region', 'entity'] as const)

export const selectAnatomy = anatomy('select', [
  'root',
  'trigger',
  'value',
  'icon',
  'positioner',
  'content',
  'item',
] as const)

/** Typeahead listbox — extends select with filter input and empty state. */
export const comboboxAnatomy = anatomy('combobox', [
  'root',
  'input',
  'icon',
  'content',
  'item',
  'empty',
] as const)

export const popoverAnatomy = anatomy('popover', [
  'root',
  'trigger',
  'positioner',
  'content',
  'arrow',
  'closeTrigger',
] as const)

export const menuAnatomy = anatomy('menu', [
  'root',
  'trigger',
  'positioner',
  'content',
  'item',
  'separator',
] as const)

export const tooltipAnatomy = anatomy('tooltip', [
  'root',
  'trigger',
  'positioner',
  'content',
  'arrow',
] as const)

export const toastAnatomy = anatomy('toast', [
  'viewport',
  'root',
  'title',
  'description',
  'closeTrigger',
] as const)

/** Profile image — loaded / loading / error on root `data-aeon-state`. Badge = presence / status corner. */
export const avatarAnatomy = anatomy('avatar', ['root', 'image', 'fallback', 'badge'] as const)

/**
 * Identity strip — avatar + primary/secondary text (items-market AvatarWithName).
 * Presentational; compose into ProfileHeader / ListRow / AccountCluster.
 */
export const identityAnatomy = anatomy('identity', [
  'root',
  'avatar',
  'title',
  'subtitle',
  'meta',
  'trailing',
] as const)

/**
 * Profile header — dense account hero (not dating). Media optional; metrics + actions zones.
 * Spatial: identity leading, metrics inline, actions trailing / bottom leading pair.
 */
export const profileHeaderAnatomy = anatomy('profileHeader', [
  'root',
  'media',
  'identity',
  'metrics',
  'actions',
  'body',
] as const)

/**
 * Entry — compact multi-value content card (feed post, catalog listing, activity item).
 * Universal layout only — not a social/marketplace niche.
 * List stacks cards; Root is one card (idle | selected | muted).
 * Zones: header (leading · heading · meta) · media · body · values · actions · footer.
 */
export const entryAnatomy = anatomy('entry', [
  'list',
  'root',
  'header',
  'leading',
  'heading',
  'title',
  'subtitle',
  'meta',
  'media',
  'body',
  'values',
  'value',
  'actions',
  'footer',
] as const)

/**
 * Metric strip — ultra-dense value/label chips (items-market im-stat cluster).
 * Generic stats only — not wallet/currency product niches.
 */
export const metricStripAnatomy = anatomy('metricStrip', [
  'root',
  'chip',
  'value',
  'label',
] as const)

/**
 * List row — settings / account menu row (h-12 hit target, leading icon, trailing control).
 */
export const listRowAnatomy = anatomy('listRow', [
  'root',
  'leading',
  'label',
  'description',
  'trailing',
] as const)

/**
 * Conversation — inbox / DM list row (universal messaging chrome, not dating).
 * Leading avatar · title · preview · meta (time) · badge (unread).
 * Item state: idle | unread | selected.
 */
export const conversationAnatomy = anatomy('conversation', [
  'root',
  'item',
  'leading',
  'body',
  'title',
  'preview',
  'meta',
  'badge',
] as const)

/**
 * Thread — message stream.
 * Item state: mine | theirs | pending | failed | command-result | payment-card | request-card.
 * Bind = reply/message binding (BRC-218 §4.9–4.10, touch-reachable).
 * Card parts = structured in-thread command results (pay / request / escrow / whois).
 */
export const threadAnatomy = anatomy('thread', [
  'root',
  'list',
  'item',
  'bubble',
  'meta',
  'day',
  'bind',
  'card',
  'cardTitle',
  'cardBody',
  'cardActions',
] as const)

/**
 * Composer — bottom compose chrome for threads.
 * Root state: idle | sending | disabled | error | chat | command | lookup.
 * Suggestions = slash-command / recipient palette (BRC-218 §4.4).
 * Toolbar = verb shortcuts (/ pay request) without hover-only affordances.
 */
export const composerAnatomy = anatomy('composer', [
  'root',
  'input',
  'actions',
  'send',
  'suggestions',
  'suggestion',
  'toolbar',
] as const)

export const separatorAnatomy = anatomy('separator', ['root'] as const)

/** Progress bar — idle / loading / complete on root `data-aeon-state`. */
export const progressAnatomy = anatomy('progress', ['root', 'track', 'range', 'label'] as const)

export const radioGroupAnatomy = anatomy('radioGroup', [
  'root',
  'item',
  'itemControl',
  'itemIndicator',
  'itemLabel',
] as const)

export const sliderAnatomy = anatomy('slider', [
  'root',
  'track',
  'range',
  'thumb',
  'valueText',
] as const)

export const pinInputAnatomy = anatomy('pinInput', ['root', 'input'] as const)

/**
 * Bar — horizontal layout primitive for toolbars, headers, footers.
 * Enforces safe flex behavior: no overlap, responsive collapse via overflow.
 * Parts: root (flex row), leading, center, trailing, optional seam (sticky stack join).
 * Drive sticky lifecycle with stickyBarMachine → data-aeon-state on root.
 */
export const barAnatomy = anatomy('bar', [
  'root',
  'leading',
  'center',
  'trailing',
  'seam',
] as const)

/**
 * Panel — collapsible layout region for split views.
 * Group lays out siblings; Root is expanded|collapsed; Label rails vertically when collapsed.
 */
export const panelAnatomy = anatomy('panel', [
  'group',
  'root',
  'trigger',
  'label',
  'content',
] as const)

/**
 * App shell — layered application chrome (items-market MainLayout pattern).
 * header / subheader / content / aside / footer / dock / scrim under root.
 */
export const appShellAnatomy = anatomy('appShell', [
  'root',
  'header',
  'subheader',
  'content',
  'aside',
  'footer',
  'dock',
  'scrim',
] as const)

/**
 * Content region — status-slotted body. Every contentRegionMachine state has a part.
 * Pair with Async for fetch; use slots for idle/pending/empty/error/ready/loadingMore/success.
 */
export const contentAnatomy = anatomy('content', [
  'root',
  'toolbar',
  'body',
  'pending',
  'empty',
  'error',
  'success',
  'sentinel',
] as const)

/**
 * Nav — navigational collection (top links, bottom tabs, side rail).
 * Selection reuses tabsMachine; items project inactive|active|disabled.
 */
export const navAnatomy = anatomy('nav', [
  'root',
  'item',
  'indicator',
  'label',
  'icon',
  'badge',
] as const)

/**
 * ThemeSwitcher — mode toggle (light/dark) + theme preset selector.
 * Parts: root, modes (button group), modeBtn, themeSelect, themeTrigger.
 */
export const themeSwitcherAnatomy = anatomy('themeSwitcher', [
  'root',
  'modes',
  'modeBtn',
  'themeSelect',
  'themeTrigger',
] as const)
