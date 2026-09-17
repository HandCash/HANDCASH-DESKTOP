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

/**
 * How far the list's content has moved past the viewport.
 *
 * Activity's `<ul>` is itself the scroll root. Geometry subtraction there is
 * `list.top - list.top = 0` forever, so windowing kept the first rows mounted
 * while the scrollbar travelled through the end spacer: visible white space.
 */
export function scrollRootScrolledPast(
  root: HTMLElement | Window,
  list: HTMLElement,
): number {
  if (root === list) return list.scrollTop
  return Math.max(0, scrollRootTop(root) - list.getBoundingClientRect().top)
}
