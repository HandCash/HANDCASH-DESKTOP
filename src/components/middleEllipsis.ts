const TAIL_CHARS = 6
const MAX_TAIL_CHARS = 10

/**
 * Splits a label so it can shorten in the middle: the head takes the ellipsis
 * and the tail always shows. The tail is a trailing `#number` or number when
 * there is one, since that is what tells similar names apart.
 */
export function middleEllipsisParts(label: string): [head: string, tail: string] {
  const numbered = /(?:#\s*|\s)[0-9][0-9A-Za-z]*$/.exec(label)
  if (numbered && numbered.index > 0 && numbered[0].length <= MAX_TAIL_CHARS) {
    return [label.slice(0, numbered.index), label.slice(numbered.index)]
  }
  if (label.length <= TAIL_CHARS * 2) return [label, '']
  return [label.slice(0, -TAIL_CHARS), label.slice(-TAIL_CHARS)]
}
