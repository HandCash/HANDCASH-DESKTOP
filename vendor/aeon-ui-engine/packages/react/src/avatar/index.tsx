import { avatarAnatomy, partAttrs } from '@aeon-ui/core'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { mergeProps } from '../utils/merge-props.js'

export type AvatarStatus = 'idle' | 'loading' | 'loaded' | 'error'

interface AvatarContextValue {
  status: AvatarStatus
  setStatus: (status: AvatarStatus) => void
}

const AvatarCtx = createContext<AvatarContextValue | null>(null)

function useAvatarCtx() {
  const ctx = useContext(AvatarCtx)
  if (!ctx) throw new Error('Avatar parts must be used within Avatar.Root')
  return ctx
}

export interface AvatarRootProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLSpanElement, AvatarRootProps>(function AvatarRoot(
  { children, className, ...rest },
  ref,
) {
  const [status, setStatus] = useState<AvatarStatus>('idle')
  const value = useMemo(() => ({ status, setStatus }), [status])

  return (
    <AvatarCtx.Provider value={value}>
      <span
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(avatarAnatomy.scope, avatarAnatomy.root, {
            // `ready` alias keeps product CSS friendly; `loaded` stays for existing recipes.
            state: status === 'loaded' ? 'loaded ready' : status,
          }),
          rest,
        )}
      >
        {children}
      </span>
    </AvatarCtx.Provider>
  )
})

const Image = forwardRef<HTMLImageElement, ImgHTMLAttributes<HTMLImageElement>>(function AvatarImage(
  { src, alt, onLoad, onError, className, ...rest },
  ref,
) {
  const { status, setStatus } = useAvatarCtx()

  useEffect(() => {
    if (!src) setStatus('idle')
    else setStatus('loading')
  }, [src, setStatus])

  const handleLoad = useCallback(
    (e: SyntheticEvent<HTMLImageElement>) => {
      onLoad?.(e)
      setStatus('loaded')
    },
    [onLoad, setStatus],
  )

  const handleError = useCallback(
    (e: SyntheticEvent<HTMLImageElement>) => {
      onError?.(e)
      setStatus('error')
    },
    [onError, setStatus],
  )

  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      hidden={status !== 'loaded'}
      {...partAttrs(avatarAnatomy.scope, avatarAnatomy.image, { state: status })}
      className={className}
      {...mergeProps(rest, { onLoad: handleLoad, onError: handleError })}
    />
  )
})

const Fallback = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function AvatarFallback(
  { className, ...rest },
  ref,
) {
  const { status } = useAvatarCtx()
  const show = status !== 'loaded'

  return (
    <span
      ref={ref}
      hidden={!show}
      {...partAttrs(avatarAnatomy.scope, avatarAnatomy.fallback, { state: status })}
      className={className}
      {...rest}
    />
  )
})

export type PresenceState = 'idle' | 'active' | 'away' | 'busy' | 'offline'

const Badge = forwardRef<
  HTMLSpanElement,
  HTMLAttributes<HTMLSpanElement> & { presence?: PresenceState }
>(function AvatarBadge({ presence = 'idle', className, ...rest }, ref) {
  useAvatarCtx()
  return (
    <span
      ref={ref}
      data-aeon-presence={presence}
      {...partAttrs(avatarAnatomy.scope, avatarAnatomy.badge, { state: presence })}
      className={className}
      {...rest}
    />
  )
})

export const Avatar = {
  Root,
  Image,
  Fallback,
  Badge,
}
