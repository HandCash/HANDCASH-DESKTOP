/**
 * Environmental capabilities used by wallet features.
 *
 * Domain decisions accept the narrow port they need; they do not reach through
 * this interface as a service locator. The aggregate exists to make production
 * composition and hermetic integration tests explicit.
 */
export type DurablePort = {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export type ClockPort = {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export type NetworkPort = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export type LogPort = {
  info(scope: string, message: string): void
  warn(scope: string, message: string): void
  error(scope: string, message: string): void
}

export type WalletPorts = Readonly<{
  durable: DurablePort
  clock: ClockPort
  network: NetworkPort
  log: LogPort
}>
