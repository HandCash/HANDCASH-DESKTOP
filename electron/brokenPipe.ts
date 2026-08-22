/**
 * Writing a log line must never be fatal.
 *
 * The app can outlive whatever was reading its stdout: launched from a terminal
 * that the holder then closed, from a shell pipeline whose reader exited, or by
 * a parent process that quit. The next write to that pipe fails with `EPIPE`,
 * and because nothing listens for the error Node escalates it to an uncaught
 * exception — which Electron shows as a crash dialog on top of a wallet that is
 * working perfectly. Losing a diagnostic line is not a wallet fault and must
 * not look like one.
 *
 * The file transport still has the log, so swallowing the stream error costs
 * nothing that support relies on.
 */

/** The reader is gone. Nothing to do and nothing worth reporting. */
export function isBrokenPipe(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
}

type ErrorSink = { on(event: 'error', listener: (err: unknown) => void): unknown }

/**
 * Keep stdio write failures away from the uncaught-exception path.
 *
 * `onWriteError` receives anything that is not a closed pipe, so a real logging
 * fault can still reach the file transport. It must not write to the guarded
 * streams itself.
 */
export function guardStdioWrites(
  streams: readonly ErrorSink[],
  onWriteError?: (err: unknown) => void,
): void {
  for (const stream of streams) {
    stream.on('error', (err) => {
      if (isBrokenPipe(err)) return
      try {
        onWriteError?.(err)
      } catch {
        // A logger that throws while reporting a logging failure is not worth
        // crashing the wallet for either.
      }
    })
  }
}
