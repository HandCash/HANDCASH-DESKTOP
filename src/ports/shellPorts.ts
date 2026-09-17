/** Stable shell boundary shared by Electron and Capacitor adapters. */
export type ShellPlatform = 'desktop' | 'android' | 'ios' | 'web'

export type DeviceUnlockResult =
  | { kind: 'unlocked'; secret: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable'; reason: string }

export type ShellPorts = Readonly<{
  platform: ShellPlatform
  openExternal(url: string): Promise<void>
  deviceUnlock(): Promise<DeviceUnlockResult>
}>
