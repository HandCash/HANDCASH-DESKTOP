#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const AEON_TAG_MAP = new Map([
  ['Button.Root', 'button::Root'],
  ['Button.Label', 'button::Label'],
  ['Field.Root', 'field::Root'],
  ['Field.Label', 'field::Label'],
  ['Field.Control', 'input'],
  ['Field.Textarea', 'textarea'],
  ['ListRow.Root', 'list_row::Root'],
  ['ListRow.Leading', 'list_row::Leading'],
  ['ListRow.Label', 'list_row::Label'],
  ['ListRow.Description', 'list_row::Description'],
  ['ListRow.Trailing', 'list_row::Trailing'],
  ['Switch.Root', 'switch::Root'],
  ['RadioGroup.Root', 'div'],
  ['RadioGroup.Item', 'div'],
  ['RadioGroup.ItemControl', 'button'],
])

const ATTR_NAME_MAP = new Map([
  ['className', 'class'],
  ['htmlFor', 'r#for'],
  ['type', 'r#type'],
  ['tabIndex', 'tabindex'],
  ['autoFocus', 'autofocus'],
  ['autoComplete', 'autocomplete'],
  ['autoCapitalize', 'autocapitalize'],
  ['spellCheck', 'spellcheck'],
  ['readOnly', 'readonly'],
  ['maxLength', 'maxlength'],
  ['minLength', 'minlength'],
  ['viewBox', 'view_box'],
  ['preserveAspectRatio', 'preserve_aspect_ratio'],
  ['strokeWidth', 'stroke_width'],
  ['strokeLinecap', 'stroke_linecap'],
  ['strokeLinejoin', 'stroke_linejoin'],
  ['fillRule', 'fill_rule'],
  ['clipRule', 'clip_rule'],
  ['onClick', 'onclick'],
  ['onChange', 'oninput'],
  ['onSubmit', 'onsubmit'],
  ['onKeyDown', 'onkeydown'],
  ['onFocus', 'onfocus'],
  ['onBlur', 'onblur'],
  ['onMouseEnter', 'onmouseenter'],
  ['onMouseLeave', 'onmouseleave'],
  ['onPointerEnter', 'onmouseenter'],
  ['onPointerLeave', 'onmouseleave'],
])

export function convertTsxToRsx(source) {
  let out = source
  for (const [reactTag, rsxTag] of AEON_TAG_MAP.entries()) {
    out = out.replaceAll(`<${reactTag}`, `<${rsxTag}`)
    out = out.replaceAll(`</${reactTag}>`, `</${rsxTag}>`)
  }
  out = out.replace(
    /variant=["'](solid|ghost|outline)["']/g,
    (_, v) => `variant: button::ButtonVariant::${v.charAt(0).toUpperCase() + v.slice(1)}`,
  )
  for (const [reactAttr, rsxAttr] of ATTR_NAME_MAP.entries()) {
    out = out.replaceAll(`${reactAttr}=`, `${rsxAttr}: `)
  }
  out = out.replace(/((?:data|aria)-[a-z0-9-]+)=/g, '"$1": ')
  out = out.replace(
    /\{\s*([^{}&?]+?)\s*&&\s*\(([\s\S]*?)\)\s*\}/g,
    (_, cond, body) => `if ${cond} { ${body} }`,
  )
  out = out.replace(
    /\{\s*([^{}?]+?)\s*\?\s*\(([\s\S]*?)\)\s*:\s*null\s*\}/g,
    (_, cond, body) => `if ${cond} { ${body} }`,
  )
  out = out.replace(
    /\{\s*([a-zA-Z0-9_.]+)\.map\(\((\w+)(?:,\s*(\w+))?\)\s*=>\s*\(([\s\S]*?)\)\)\s*\}/g,
    (_, list, item, idx, body) =>
      idx
        ? `for (${idx}, ${item}) in ${list}.iter().enumerate() { ${body} }`
        : `for ${item} in ${list}.iter() { ${body} }`,
  )
  out = out.replace(/<([a-zA-Z0-9_:]+)([^>]*?)\/>/g, (_, tag, attrs) => {
    const trimmed = attrs.trim()
    return trimmed ? `${tag} { ${trimmed} }` : `${tag} {}`
  })
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (files.length === 0) {
    console.error('Usage: node scripts/tsx-to-rsx.mjs <component.tsx> [...]')
    process.exit(1)
  }
  for (const file of files) {
    const abs = path.resolve(process.cwd(), file)
    const src = fs.readFileSync(abs, 'utf8')
    console.log(`// === rsx! skeleton for ${file} ===`)
    console.log(convertTsxToRsx(src))
  }
}
