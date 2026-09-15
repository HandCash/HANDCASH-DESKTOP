/**
 * The element that actually scrolls a feed.
 *
 * Activity's `<ul>` is its own scroll container; the collectables grid scrolls
 * inside a panel ancestor. Both hooks must listen where the scroll happens.
 */
export function resolveScrollRoot(el: HTMLElement | null): HTMLElement | Window {
  let node: HTMLElement | null = el
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return window
}

export function scrollRootHeight(root: HTMLElement | Window): number {
  return root === window ? window.innerHeight : (root as HTMLElement).clientHeight
}

export function scrollRootTop(root: HTMLElement | Window): number {
  return root === window ? 0 : (root as HTMLElement).getBoundingClientRect().top
}
