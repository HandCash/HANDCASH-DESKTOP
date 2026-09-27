/**
 * Exact facts about wallet UI components, read from source — no model involved.
 *
 * Shared by `scripts/jev-ui-review.mjs` (which hands these facts to Jev for the
 * judgment calls) and `src/machines/aeonAdherence.test.ts` (which ratchets the
 * proven ones). One definition of "exclusive busy set" and "raw projection", so
 * the review and the gate cannot drift apart.
 */
import fs from 'node:fs'
import path from 'node:path'

export const COMPONENT_ROOTS = ['src/components', 'src/App.tsx']
export const STYLE_SHEETS = ['src/styles/handcash.css', 'src/styles/layout-compact.css']

const AEON_COMPOUNDS =
  'Button|Field|Dialog|Prompt|StatusBanner|Accordion|Menu|Tabs|Identity|ListRow|MetricStrip|Panel|Thread|Toast|AppNav|AppShell'

const MACHINE_BINDERS = /\b(useMachine|useAeonMachine|useActorRef|useActivityAction)\(\s*([A-Za-z0-9_]*)/g

export function isComponentPath(p) {
  return (
    p.endsWith('.tsx') &&
    !p.endsWith('.test.tsx') &&
    COMPONENT_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))
  )
}

export function allComponents(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (isComponentPath(path.relative(root, p))) out.push(path.relative(root, p))
    }
  }
  walk(path.join(root, 'src/components'))
  out.push('src/App.tsx')
  return out.sort()
}

/** Flat rule index: selector text → important count. */
export function loadCss(root) {
  const rules = []
  for (const sheet of STYLE_SHEETS) {
    const text = fs.readFileSync(path.join(root, sheet), 'utf8')
    // Strip comments; split on braces. @media wrappers become empty-selector
    // fragments and are ignored — good enough for keying counts.
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '')
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m
    while ((m = re.exec(stripped))) {
      const selector = m[1].trim().split(/\s*@media[^{]*$/)[0].trim()
      if (!selector || selector.startsWith('@')) continue
      rules.push({ sheet, selector, important: (m[2].match(/!important/g) ?? []).length })
    }
  }
  return rules
}

const escapeRe = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')

export function extractFacts(root, rel, css = loadCss(root)) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  const lines = text.split('\n')
  const at = (idx) => idx + 1
  const count = (re) => (text.match(re) ?? []).length

  // Boolean state twins and how they are consumed.
  const booleanStates = []
  lines.forEach((line, i) => {
    const m = line.match(/const \[(\w+),\s*(set\w+)\]\s*=\s*useState(?:<boolean>)?\((true|false)\)/)
    if (!m) return
    const [, name, setter, initial] = m
    booleanStates.push({
      name,
      line: at(i),
      initial: initial === 'true',
      gatesDisabled: new RegExp(`disabled=\\{[^}]*\\b${name}\\b`).test(text),
      togglesLabel: new RegExp(`\\{${name}\\s*\\?\\s*['"\`][^'"\`]*…`).test(text),
      setInFinally: new RegExp(`finally\\s*\\{[^}]*\\b${setter}\\(false\\)`).test(text),
      earlyReturnGuard: new RegExp(`if\\s*\\([^)]*\\b${name}\\b[^)]*\\)\\s*return`).test(text),
      setterCalls: count(new RegExp(`\\b${setter}\\(`, 'g')),
    })
  })

  // Charts bound in this file.
  const machines = []
  let mm
  while ((mm = MACHINE_BINDERS.exec(text))) machines.push({ hook: mm[1], machine: mm[2] || null })
  MACHINE_BINDERS.lastIndex = 0

  // Aeon projection.
  const scopes = [...new Set([...text.matchAll(/data-aeon-scope=["']([^"']+)["']/g)].map((m) => m[1]))]
  const stateExprs = []
  lines.forEach((line, i) => {
    const m =
      line.match(/data-aeon-state=\{([^}]+(?:\}[^}]*)*)\}/) ?? line.match(/data-aeon-state=(["'][^"']+["'])/)
    if (!m) return
    const expr = m[1].trim()
    const viaStateToAttr = /stateToAttr\(/.test(expr)
    stateExprs.push({
      line: at(i),
      expr,
      viaStateToAttr,
      // A machine `.value` reaching the attribute without stateToAttr.
      rawMachineValue: !viaStateToAttr && /(?:snapshot|state|snap)\.value\b|String\(\w+\.value\)/.test(expr),
      literal: /^["']/.test(expr),
    })
  })

  // Chrome the product hand-rolls instead of composing.
  const chrome = {
    windowConfirm: count(/window\.confirm\(/g),
    windowAlert: count(/window\.alert\(/g),
    rawBtnButtons: count(/<button[^>]*className=["'][^"']*\bbtn\b/g),
    nativeDialog: count(/<dialog\b/g),
    modalPortal: /ModalPortal/.test(text),
    inlineStyle: count(/style=\{\{/g),
  }

  // Render-cost signals.
  const render = {
    linesOfCode: lines.length,
    bytes: Buffer.byteLength(text),
    hooks: {
      useState: count(/\buseState(?:<[^>]+>)?\(/g),
      useEffect: count(/\buseEffect\(/g),
      useMemo: count(/\buseMemo\(/g),
      useCallback: count(/\buseCallback\(/g),
      useRef: count(/\buseRef(?:<[^>]+>)?\(/g),
    },
    jsxMaps: count(/\.map\(\([^)]*\)\s*=>\s*(?:\(|<)/g),
    windowed: /padStart|padEnd|useChunkedCount|windowed|IntersectionObserver/.test(text),
    subscriptions: count(/\bsubscribe\w*\(/g),
    timers: count(/\bset(?:Interval|Timeout)\(/g),
    storeReadsInRender: count(/^\s*const \w+ = get[A-Z]\w*\(/gm),
    deferredImages: count(/<(?:DeferredImage|AppAvatar)\b/g),
    rawImg: count(/<img\b/g),
    modelViewer: /model-viewer|DeferredModelViewer/.test(text),
  }

  // Which of this file's class names the brand sheet styles, and whether it
  // keys on the chart instead.
  const classNames = [
    ...new Set(
      [...text.matchAll(/className=["']([^"']+)["']/g)]
        .flatMap((m) => m[1].split(/\s+/))
        .filter((c) => c && !/^\$\{/.test(c)),
    ),
  ]
  const styledClasses = classNames.filter((c) =>
    css.some((r) => new RegExp(`\\.${escapeRe(c)}(?![\\w-])`).test(r.selector)),
  )
  const scopeRules = Object.fromEntries(
    scopes.map((s) => [
      s,
      css.filter((r) => r.selector.includes(`data-aeon-scope="${s}"`) || r.selector.includes(`data-aeon-scope='${s}'`))
        .length,
    ]),
  )
  const importantInOwnRules = css
    .filter((r) => styledClasses.some((c) => r.selector.includes(`.${c}`)))
    .reduce((n, r) => n + r.important, 0)
  const attrKeyedRules = css.filter(
    (r) =>
      /data-aeon-(?:state|part)/.test(r.selector) &&
      (styledClasses.some((c) => r.selector.includes(`.${c}`)) ||
        scopes.some((s) => r.selector.includes(`"${s}"`) || r.selector.includes(`'${s}'`))),
  ).length

  const aeonImports = [...new Set([...text.matchAll(/from ['"](@aeon-ui\/[a-z-]+)['"]/g)].map((m) => m[1]))]
  const compoundsUsed = [
    ...new Set([...text.matchAll(new RegExp(`<(${AEON_COMPOUNDS})\\b`, 'g'))].map((m) => m[1])),
  ]

  const exclusiveBusySet = booleanStates.filter((b) => b.gatesDisabled && b.setInFinally).map((b) => b.name)

  const facts = {
    file: rel,
    booleanStates,
    /** Booleans code proved gate a button and reset in `finally`: phases held as flags. */
    exclusiveBusySet,
    /** Booleans with no gating, lifecycle, or guard semantics — presentation toggles, not phases. */
    presentationOnlyBooleans: booleanStates
      .filter((b) => !b.gatesDisabled && !b.setInFinally && !b.earlyReturnGuard && !b.togglesLabel)
      .map((b) => b.name),
    machines,
    aeon: {
      imports: aeonImports,
      compoundsUsed,
      scopes,
      parts: count(/data-aeon-part=/g),
      stateExprs,
      rawMachineValueProjections: stateExprs.filter((s) => s.rawMachineValue).map((s) => s.line),
    },
    chrome,
    render,
    css: {
      classNames: classNames.length,
      styledClasses: styledClasses.length,
      unstyledClasses: classNames.filter((c) => !styledClasses.includes(c)).slice(0, 12),
      scopeRules,
      attrKeyedRules,
      importantInOwnRules,
    },
  }

  return { facts, lines }
}
