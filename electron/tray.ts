/**
 * System tray — real HandCash mark SVG (monochrome), no coloured disc.
 * White on dark panels, black on light panels.
 */
import {
  Tray,
  Menu,
  app,
  nativeImage,
  nativeTheme,
  type BrowserWindow,
  type NativeImage,
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import log from 'electron-log'

const here = path.dirname(fileURLToPath(import.meta.url))

let tray: Tray | null = null
let themeUnsub: (() => void) | null = null

function resolveAsset(name: string): string | null {
  const candidates = [
    path.join(here, 'assets', name),
    path.join(here, '../electron/assets', name),
    path.join(here, '../build', name),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

function panelWantsLightIcon(): boolean {
  // Dark desktop chrome → white glyph; light chrome → black glyph.
  return nativeTheme.shouldUseDarkColors
}

/** Prefer PNG for Linux StatusNotifier; SVG is the source of truth. */
export function loadTrayImage(lightGlyph = panelWantsLightIcon()): NativeImage {
  const pngName = lightGlyph ? 'tray-icon.png' : 'tray-icon-black.png'
  const png32 = lightGlyph ? 'tray-icon-32.png' : 'tray-icon-black-32.png'
  const png = resolveAsset(pngName) ?? resolveAsset(png32)
  if (png) {
    const img = nativeImage.createFromPath(png)
    if (!img.isEmpty()) return img
  }

  const svgName = lightGlyph ? 'handcash-tray.svg' : 'handcash-tray-black.svg'
  const svg = resolveAsset(svgName) ?? resolveAsset('handcash-tray.svg')
  if (svg) {
    try {
      const buf = fs.readFileSync(svg)
      const dataUrl = `data:image/svg+xml;base64,${buf.toString('base64')}`
      const img = nativeImage.createFromDataURL(dataUrl)
      if (!img.isEmpty()) return img
    } catch (err) {
      log.warn('tray SVG load failed', err)
    }
  }
  return nativeImage.createEmpty()
}

function sizedTrayIcon(): NativeImage {
  // macOS menu bar: black silhouette as template — system flips for dark/light bar.
  if (process.platform === 'darwin') {
    const image = loadTrayImage(false)
    if (image.isEmpty()) return image
    const icon = image.resize({ width: 18, height: 18 })
    icon.setTemplateImage(true)
    return icon
  }

  const image = loadTrayImage()
  if (image.isEmpty()) return image
  return image.resize({ width: 24, height: 24 })
}

function applyTrayIcon(): void {
  if (!tray) return
  const icon = sizedTrayIcon()
  if (!icon.isEmpty()) tray.setImage(icon)
}

export type TrayHost = {
  getMainWindow: () => BrowserWindow | null
  showMainWindow: () => void
  /** Soft-hide when the user closes the window; Quit still exits. */
  isQuitting: () => boolean
}

export function createAppTray(host: TrayHost): Tray | null {
  if (tray) return tray

  const icon = sizedTrayIcon()
  if (icon.isEmpty()) {
    log.warn('HandCash tray icon missing — tray not created')
    return null
  }

  tray = new Tray(icon)
  tray.setToolTip('HandCash')

  const rebuildMenu = () => {
    const win = host.getMainWindow()
    const visible = Boolean(win && win.isVisible() && !win.isMinimized())
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? 'Hide HandCash' : 'Show HandCash',
        click: () => {
          const w = host.getMainWindow()
          if (w && w.isVisible() && !w.isMinimized()) {
            w.hide()
          } else {
            host.showMainWindow()
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit HandCash',
        click: () => {
          app.quit()
        },
      },
    ])
    tray?.setContextMenu(menu)
  }

  rebuildMenu()

  tray.on('click', () => {
    const w = host.getMainWindow()
    if (w && w.isVisible() && !w.isMinimized()) {
      w.hide()
    } else {
      host.showMainWindow()
    }
    rebuildMenu()
  })

  tray.on('right-click', () => rebuildMenu())

  const onTheme = () => applyTrayIcon()
  nativeTheme.on('updated', onTheme)
  themeUnsub = () => {
    nativeTheme.removeListener('updated', onTheme)
  }

  return tray
}

/** Close button → tray (except when quitting). Returns true if close was swallowed. */
export function handleWindowCloseToTray(
  event: { preventDefault: () => void },
  win: BrowserWindow,
  isQuitting: () => boolean,
): boolean {
  if (isQuitting() || !tray) return false
  event.preventDefault()
  win.hide()
  return true
}

export function destroyAppTray(): void {
  themeUnsub?.()
  themeUnsub = null
  try {
    tray?.destroy()
  } catch {
    /* ignore */
  }
  tray = null
}
