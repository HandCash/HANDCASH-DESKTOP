/**
 * Electron-side of `build-tray-icons.mjs`: render each tray SVG offscreen and
 * write a transparent PNG. Electron is used deliberately — it is the renderer
 * that ships the app, so what we rasterize is what the tray would draw if
 * `nativeImage` could read SVG at all.
 *
 * Jobs arrive as JSON on TRAY_JOBS: [{ svg, out, size }].
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')

async function render(job) {
  const svg = fs
    .readFileSync(job.svg, 'utf8')
    .replace(/<svg /, `<svg width="${job.size}" height="${job.size}" `)
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`
  const win = new BrowserWindow({
    width: job.size,
    height: job.size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true },
  })
  // Chromium refuses top-level navigation to a data: URL, so stage a real file.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-raster-'))
  const page = path.join(stage, 'icon.html')
  fs.writeFileSync(page, html)
  try {
    await win.loadFile(page)
    // One frame after load so the path is painted before capture.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const image = await win.capturePage()
    if (image.isEmpty()) throw new Error(`empty capture for ${job.out}`)
    // A Retina host captures at 2x; normalise so the output size does not depend
    // on which display generated it (and the downsample keeps edges smooth).
    const sized =
      image.getSize().width === job.size
        ? image
        : image.resize({ width: job.size, height: job.size, quality: 'best' })
    fs.writeFileSync(job.out, sized.toPNG())
  } finally {
    win.destroy()
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

app.whenReady().then(async () => {
  try {
    for (const job of JSON.parse(process.env.TRAY_JOBS || '[]')) await render(job)
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
