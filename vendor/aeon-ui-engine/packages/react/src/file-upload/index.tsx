import { fileUploadAnatomy, partAttrs, partOnlyAttrs } from '@aeon-ui/core'
import { fileUploadMachine, getFileUploadPhase } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

function isFileTypeAccepted(file: File, acceptString: string) {
  if (!acceptString || acceptString === '*') return true
  const acceptedTypes = acceptString.split(',').map((type) => type.trim()).filter(Boolean)
  if (acceptedTypes.length === 0) return true
  return acceptedTypes.some((acceptedType) => {
    if (acceptedType.startsWith('.')) {
      return file.name.toLowerCase().endsWith(acceptedType.toLowerCase())
    }
    if (acceptedType.includes('*')) {
      const baseType = acceptedType.split('/')[0]
      return file.type.startsWith(`${baseType}/`)
    }
    return file.type === acceptedType
  })
}

interface FileUploadContextValue {
  phase: 'idle' | 'dragging' | 'rejected'
  accept: string
  disabled: boolean
  file: File | null
  inputId: string
  inputRef: React.RefObject<HTMLInputElement | null>
  send: ReturnType<typeof useAeonMachine<typeof fileUploadMachine>>[1]
  selectFile: (file: File | null) => void
  clear: () => void
  openPicker: () => void
}

const FileUploadCtx = createContext<FileUploadContextValue | null>(null)

function useFileUploadCtx() {
  const ctx = useContext(FileUploadCtx)
  if (!ctx) throw new Error('FileUpload parts must be used within FileUpload.Root')
  return ctx
}

export interface FileUploadRootProps {
  accept?: string
  disabled?: boolean
  /** Controlled selected file (bytes stay outside the machine). */
  file?: File | null
  defaultFile?: File | null
  onFileSelect?: (file: File | null) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, FileUploadRootProps>(function FileUploadRoot(
  {
    accept = '*',
    disabled = false,
    file: fileProp,
    defaultFile = null,
    onFileSelect,
    children,
    className,
    ...rest
  },
  ref,
) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [snapshot, send] = useAeonMachine(fileUploadMachine)
  const [uncontrolledFile, setUncontrolledFile] = useState<File | null>(defaultFile)
  const file = fileProp !== undefined ? fileProp : uncontrolledFile
  const phase = getFileUploadPhase(snapshot.value)

  const selectFile = useCallback(
    (next: File | null) => {
      if (fileProp === undefined) setUncontrolledFile(next)
      onFileSelect?.(next)
    },
    [fileProp, onFileSelect],
  )

  const clear = useCallback(() => {
    send({ type: 'RESET' })
    selectFile(null)
    if (inputRef.current) inputRef.current.value = ''
  }, [send, selectFile])

  const openPicker = useCallback(() => {
    if (disabled) return
    inputRef.current?.click()
  }, [disabled])

  const ctx = useMemo(
    () => ({
      phase,
      accept,
      disabled,
      file,
      inputId,
      inputRef,
      send,
      selectFile,
      clear,
      openPicker,
    }),
    [phase, accept, disabled, file, inputId, send, selectFile, clear, openPicker],
  )

  return (
    <FileUploadCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(fileUploadAnatomy.scope, fileUploadAnatomy.root, {
            state: phase,
            disabled,
          }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </FileUploadCtx.Provider>
  )
})

const Label = forwardRef<HTMLLabelElement, HTMLAttributes<HTMLLabelElement>>(function FileUploadLabel(
  props,
  ref,
) {
  const { inputId } = useFileUploadCtx()
  return (
    <label
      ref={ref}
      htmlFor={inputId}
      {...mergeProps(partOnlyAttrs(fileUploadAnatomy.label), props)}
    />
  )
})

const Dropzone = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function FileUploadDropzone(
  { onClick, onDragOver, onDragLeave, onDrop, ...rest },
  ref,
) {
  const { accept, disabled, send, selectFile, openPicker, phase } = useFileUploadCtx()

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openPicker()
        }
      }}
      {...mergeProps(
        partOnlyAttrs(fileUploadAnatomy.dropzone, {
          state: phase,
          disabled,
        }),
        {
          onClick: (e: MouseEvent<HTMLDivElement>) => {
            onClick?.(e)
            if (disabled || e.defaultPrevented) return
            openPicker()
          },
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            onDragOver?.(e)
            e.preventDefault()
            if (disabled) return
            send({ type: 'DRAG_OVER' })
          },
          onDragLeave: (e: DragEvent<HTMLDivElement>) => {
            onDragLeave?.(e)
            e.preventDefault()
            if (disabled) return
            send({ type: 'DRAG_LEAVE' })
          },
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            onDrop?.(e)
            e.preventDefault()
            if (disabled) return
            const next = Array.from(e.dataTransfer.files)[0]
            if (next && isFileTypeAccepted(next, accept)) {
              send({ type: 'DROP_ACCEPT' })
              selectFile(next)
            } else {
              send({ type: 'DROP_REJECT' })
            }
          },
        },
        rest,
      )}
    />
  )
})

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function FileUploadInput({ onChange, ...rest }, ref) {
    const { accept, disabled, inputId, inputRef, selectFile, send } = useFileUploadCtx()

    return (
      <input
        ref={(node) => {
          inputRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        id={inputId}
        type="file"
        accept={accept}
        disabled={disabled}
        {...mergeProps(
          partOnlyAttrs(fileUploadAnatomy.input),
          {
            onChange: (e: ChangeEvent<HTMLInputElement>) => {
              onChange?.(e)
              const next = e.target.files?.[0] ?? null
              if (next) {
                send({ type: 'RESET' })
                selectFile(next)
              }
            },
          },
          rest,
        )}
      />
    )
  },
)

const Hint = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function FileUploadHint(props, ref) {
    return <p ref={ref} {...mergeProps(partOnlyAttrs(fileUploadAnatomy.hint), props)} />
  },
)

const Preview = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function FileUploadPreview(
  { children, ...rest },
  ref,
) {
  const { file } = useFileUploadCtx()
  if (!file && !children) return null
  return (
    <div ref={ref} {...mergeProps(partOnlyAttrs(fileUploadAnatomy.preview), rest)}>
      {children ?? file?.name}
    </div>
  )
})

const ClearTrigger = forwardRef<HTMLButtonElement, HTMLAttributes<HTMLButtonElement>>(
  function FileUploadClearTrigger({ onClick, ...rest }, ref) {
    const { clear, disabled, file } = useFileUploadCtx()
    if (!file) return null
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        {...mergeProps(
          partOnlyAttrs(fileUploadAnatomy.clearTrigger),
          {
            onClick: (e: MouseEvent<HTMLButtonElement>) => {
              onClick?.(e)
              if (e.defaultPrevented) return
              clear()
            },
          },
          rest,
        )}
      />
    )
  },
)

const RejectionMessage = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function FileUploadRejectionMessage(props, ref) {
    const { phase } = useFileUploadCtx()
    if (phase !== 'rejected') return null
    return (
      <p
        ref={ref}
        role="alert"
        {...mergeProps(partOnlyAttrs(fileUploadAnatomy.rejectionMessage), props)}
      />
    )
  },
)

export const FileUpload = {
  Root,
  Label,
  Dropzone,
  Input,
  Hint,
  Preview,
  ClearTrigger,
  RejectionMessage,
}

export { useFileUploadCtx as useFileUpload }
