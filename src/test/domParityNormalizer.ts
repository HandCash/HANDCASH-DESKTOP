/**
 * Canonical HTML DOM normalizer for TS <-> Rust Aeon UI parity testing.
 *
 * Keeps element structure, classes, `data-aeon-*` / `data-*`, `role`, `aria-*`,
 * semantic form attributes, and text copy. Drops React/bundler-only attributes,
 * inline styles, raw SVG vector path geometry, and insignificant whitespace.
 *
 * Paired 1:1 with `native-desktop/crates/handcash-app/src/parity.rs`.
 */

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const BOOLEAN_HTML_ATTRS = new Set([
  'checked',
  'disabled',
  'hidden',
  'multiple',
  'readonly',
  'required',
])

const BOOLEAN_DATA_ATTRS = new Set([
  'data-active',
  'data-activity-failed',
  'data-before-selected',
  'data-has-crumbs',
  'data-has-detail-actions',
  'data-hc',
  'data-highlight',
  'data-highlighted',
  'data-native',
  'data-permission',
  'data-ready',
  'data-selected',
])

const KEPT_EXACT_ATTRS = new Set([
  'accept',
  'alt',
  'class',
  'for',
  'id',
  'name',
  'placeholder',
  'role',
  'rows',
  'title',
  'type',
  'value',
])

export type DomNode =
  | {
      kind: 'el'
      tag: string
      attrs: [string, string][]
      children: DomNode[]
    }
  | {
      kind: 'text'
      text: string
    }

function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function encodeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function encodeText(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function normalizeAttr(
  tag: string,
  rawName: string,
  rawVal: string | null,
): [string, string] | null {
  const name = rawName.toLowerCase()
  const decoded = rawVal == null ? '' : decodeEntities(rawVal)

  if (BOOLEAN_HTML_ATTRS.has(name)) {
    if (decoded === 'false') return null
    return [name, '']
  }

  if (name === 'aria-hidden') {
    if (decoded === 'false') return null
    return ['aria-hidden', 'true']
  }

  if (name.startsWith('aria-')) {
    return [name, decoded.trim()]
  }

  if (BOOLEAN_DATA_ATTRS.has(name)) {
    if (decoded === 'false') return null
    return [name, '']
  }

  if (name.startsWith('data-aeon-') || name.startsWith('data-')) {
    return [name, decoded.trim()]
  }

  if (name === 'class') {
    const cls = decoded.trim().replace(/\s+/g, ' ')
    if (!cls) return null
    return ['class', cls]
  }

  if (name === 'value' && (tag === 'textarea' || tag === 'input') && decoded === '') {
    return null
  }

  if (KEPT_EXACT_ATTRS.has(name)) {
    return [name, decoded]
  }

  return null
}

function parseAttrs(tag: string, rawAttrStr: string): [string, string][] {
  const map = new Map<string, string>()
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(rawAttrStr)) !== null) {
    const name = match[1]!
    const val =
      match[2] !== undefined
        ? match[2]
        : match[3] !== undefined
          ? match[3]
          : match[4] !== undefined
            ? match[4]
            : null
    const norm = normalizeAttr(tag, name, val)
    if (norm) {
      map.set(norm[0], norm[1])
    }
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
}

export function parseAndNormalizeHtml(html: string): DomNode[] {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '')
  const root: { tag: string; attrs: [string, string][]; children: DomNode[] } = {
    tag: '__root__',
    attrs: [],
    children: [],
  }
  const stack: { tag: string; attrs: [string, string][]; children: DomNode[]; inSvg: boolean }[] = [
    { ...root, inSvg: false },
  ]

  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(\/?)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(cleaned)) !== null) {
    const textChunk = m[5]
    if (textChunk !== undefined) {
      const top = stack[stack.length - 1]!
      if (top.inSvg) continue
      const collapsed = decodeEntities(textChunk).replace(/\s+/g, ' ').trim()
      if (collapsed) {
        const prev = top.children[top.children.length - 1]
        if (prev && prev.kind === 'text') {
          prev.text = `${prev.text} ${collapsed}`
        } else {
          top.children.push({ kind: 'text', text: collapsed })
        }
      }
      continue
    }

    const isClosing = m[1] === '/'
    const rawTag = m[2]!.toLowerCase()
    const attrChunk = m[3] ?? ''
    const selfClosing = m[4] === '/' || VOID_TAGS.has(rawTag)

    const top = stack[stack.length - 1]!

    if (rawTag === 'link') {
      continue
    }

    if (isClosing) {
      if (top.inSvg && rawTag !== top.tag) {
        continue
      }
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tag === rawTag) {
          stack.splice(i)
          break
        }
      }
      continue
    }

    if (top.inSvg) {
      continue
    }

    let attrs = parseAttrs(rawTag, attrChunk)
    let effectiveTag = rawTag
    // AuthMeshBackground canvas in TS and payment-mesh SVG in Rust share data-aeon-part="mesh"
    if (
      rawTag === 'canvas' &&
      attrs.some(([k, v]) => k === 'data-aeon-part' && v === 'mesh')
    ) {
      effectiveTag = 'svg'
    }

    if (effectiveTag === 'svg') {
      // Keep only structural/accessibility attributes on <svg>, drop geometry attrs
      attrs = attrs.filter(
        ([k]) =>
          k === 'class' ||
          k === 'id' ||
          k === 'role' ||
          k.startsWith('aria-') ||
          k.startsWith('data-'),
      )
    }

    const node: DomNode & { kind: 'el' } = {
      kind: 'el',
      tag: effectiveTag,
      attrs,
      children: [],
    }
    top.children.push(node)

    if (!selfClosing) {
      stack.push({
        tag: rawTag,
        attrs: node.attrs,
        children: node.children,
        inSvg: effectiveTag === 'svg',
      })
    }
  }

  return root.children
}

function formatNode(node: DomNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth)
  if (node.kind === 'text') {
    lines.push(`${indent}${encodeText(node.text)}`)
    return
  }
  const attrStr = node.attrs
    .map(([k, v]) => `${k}="${encodeAttr(v)}"`)
    .join(' ')
  const openTag = attrStr ? `<${node.tag} ${attrStr}` : `<${node.tag}`
  if (node.children.length === 0) {
    lines.push(`${indent}${openTag}/>`)
    return
  }
  if (node.children.length === 1 && node.children[0]!.kind === 'text') {
    lines.push(
      `${indent}${openTag}>${encodeText(node.children[0]!.text)}</${node.tag}>`,
    )
    return
  }
  lines.push(`${indent}${openTag}>`)
  for (const child of node.children) {
    formatNode(child, depth + 1, lines)
  }
  lines.push(`${indent}</${node.tag}>`)
}

export function normalizeHtml(html: string): string {
  const nodes = parseAndNormalizeHtml(html)
  const lines: string[] = []
  for (const node of nodes) {
    formatNode(node, 0, lines)
  }
  return lines.join('\n')
}
