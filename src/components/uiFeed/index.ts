/**
 * List/grid scroll and image deferral (windowing is `useWindowedRange` in @aeon-ui/react) — Desktop and Mobile.
 */

export { shouldAttachDeferredSrc } from './attachSrc'
export { useScrollIdle } from './useScrollIdle'
export {
  feedIsScrolling,
  noteFeedScroll,
  subscribeFeedScroll,
} from './scrollActivity'
