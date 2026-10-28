/**
 * The browser side of call recording: everyone's audio mixed into one track
 * (Web Audio), and on a video call everyone's video drawn as a grid on one
 * canvas, a name in place of a camera that is off. Colours are the palette's
 * own tokens, read from the page.
 */

import type { RecorderLike, RecordingMixer, RecordingSource } from './callRecorder'

const WIDTH = 1280
const HEIGHT = 720
const FPS = 15
const GAP = 8

export type Tile = { x: number; y: number; w: number; h: number }

/** `n` equal tiles filling a `width` by `height` frame, row by row. */
export function tileLayout(n: number, width: number, height: number, gap = GAP): Tile[] {
  if (n <= 0) return []
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const w = (width - gap * (cols + 1)) / cols
  const h = (height - gap * (rows + 1)) / rows
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / cols)
    const inRow = row === rows - 1 ? n - row * cols : cols
    const offset = ((cols - inRow) * (w + gap)) / 2
    return { x: gap + offset + (i % cols) * (w + gap), y: gap + row * (h + gap), w, h }
  })
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function recordingMime(video: boolean): string {
  const choices = video ? ['video/webm;codecs=vp8,opus', 'video/webm'] : ['audio/webm;codecs=opus', 'audio/webm']
  return choices.find((m) => MediaRecorder.isTypeSupported(m)) ?? choices.at(-1)!
}

export function browserRecorder(stream: MediaStream, mime: string): RecorderLike {
  return new MediaRecorder(stream, { mimeType: mime }) as unknown as RecorderLike
}

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof AudioContext !== 'undefined'
}

export function browserMixer(video: boolean): RecordingMixer {
  const audio = new AudioContext()
  const out = audio.createMediaStreamDestination()
  const voices = new Map<string, { track: string; node: MediaStreamAudioSourceNode }>()
  const faces = new Map<string, { track: string | null; el: HTMLVideoElement }>()
  let current: RecordingSource[] = []
  let canvasTrack: MediaStreamTrack | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  if (video) {
    const canvas = document.createElement('canvas')
    canvas.width = WIDTH
    canvas.height = HEIGHT
    const g = canvas.getContext('2d')!
    const back = token('--hc-bg')
    const tile = token('--hc-bg-elevated')
    const ink = token('--hc-muted')
    const draw = () => {
      g.fillStyle = back
      g.fillRect(0, 0, WIDTH, HEIGHT)
      const tiles = tileLayout(current.length, WIDTH, HEIGHT)
      current.forEach((source, i) => {
        const t = tiles[i]!
        const el = faces.get(source.key)?.el
        if (source.video && el && el.readyState >= 2 && el.videoWidth > 0) {
          const scale = Math.max(t.w / el.videoWidth, t.h / el.videoHeight)
          const sw = t.w / scale
          const sh = t.h / scale
          g.drawImage(el, (el.videoWidth - sw) / 2, (el.videoHeight - sh) / 2, sw, sh, t.x, t.y, t.w, t.h)
        } else {
          g.fillStyle = tile
          g.fillRect(t.x, t.y, t.w, t.h)
          g.fillStyle = ink
          g.font = '600 28px system-ui, sans-serif'
          g.textAlign = 'center'
          g.textBaseline = 'middle'
          g.fillText(source.label, t.x + t.w / 2, t.y + t.h / 2, t.w - 24)
        }
      })
    }
    canvasTrack = canvas.captureStream(FPS).getVideoTracks()[0] ?? null
    timer = setInterval(draw, 1000 / FPS)
  }

  const stream = new MediaStream([...out.stream.getAudioTracks(), ...(canvasTrack ? [canvasTrack] : [])])

  return {
    stream,
    sync(sources) {
      current = sources
      const keys = new Set(sources.map((s) => s.key))
      for (const source of sources) {
        const voice = source.stream?.getAudioTracks()[0]
        const had = voices.get(source.key)
        if (had && had.track !== voice?.id) {
          had.node.disconnect()
          voices.delete(source.key)
        }
        if (voice && !voices.has(source.key)) {
          const node = audio.createMediaStreamSource(new MediaStream([voice]))
          node.connect(out)
          voices.set(source.key, { track: voice.id, node })
        }
        if (!video) continue
        const face = source.stream?.getVideoTracks()[0] ?? null
        let shown = faces.get(source.key)
        if (!shown) {
          const el = document.createElement('video')
          el.muted = true
          el.playsInline = true
          shown = { track: null, el }
          faces.set(source.key, shown)
        }
        if (shown.track !== (face?.id ?? null)) {
          shown.track = face?.id ?? null
          shown.el.srcObject = face ? new MediaStream([face]) : null
          if (face) void shown.el.play().catch(() => undefined)
        }
      }
      for (const [key, voice] of voices) {
        if (keys.has(key)) continue
        voice.node.disconnect()
        voices.delete(key)
      }
      for (const [key, face] of faces) {
        if (keys.has(key)) continue
        face.el.srcObject = null
        faces.delete(key)
      }
    },
    stop() {
      clearInterval(timer)
      canvasTrack?.stop()
      for (const voice of voices.values()) voice.node.disconnect()
      for (const face of faces.values()) face.el.srcObject = null
      voices.clear()
      faces.clear()
      void audio.close().catch(() => undefined)
    },
  }
}
