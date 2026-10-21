import { describe, expect, it } from 'vitest'
import { createSoundPlayer, soundPresets, type SoundContext } from './sound.js'

function fakeContext() {
  const peaks: number[] = []
  let oscillators = 0
  const param = (onRamp?: (v: number) => void) => ({
    setValueAtTime() {},
    linearRampToValueAtTime(v: number) {
      onRamp?.(v)
    },
    exponentialRampToValueAtTime() {},
  })
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    resume: async () => {},
    createOscillator: () => {
      oscillators++
      return { type: 'sine', frequency: param(), connect() {}, start() {}, stop() {} }
    },
    createGain: () => ({ gain: param((v) => peaks.push(v)), connect() {} }),
    createBiquadFilter: () => ({ type: 'lowpass', frequency: { value: 0 }, connect() {} }),
  }
  return { ctx, peaks, count: () => oscillators }
}

const playerWith = (fake: ReturnType<typeof fakeContext>, enabled = true, volume = 0.5) =>
  createSoundPlayer(() => fake.ctx as unknown as SoundContext, { enabled, volume })

describe('sound player', () => {
  it('stays silent until enabled', () => {
    const fake = fakeContext()
    const player = playerWith(fake, false)
    player.play('copy')
    expect(fake.count()).toBe(0)
    player.configure({ enabled: true })
    player.play('copy')
    expect(fake.count()).toBe(soundPresets.copy.length)
  })

  it('stays silent at zero volume', () => {
    const fake = fakeContext()
    playerWith(fake, true, 0).play('success')
    expect(fake.count()).toBe(0)
  })

  it('scales every tone by the master volume', () => {
    const fake = fakeContext()
    playerWith(fake, true, 0.5).play('ready')
    expect(fake.peaks).toEqual(soundPresets.ready.map((t) => t.gain * 0.5))
  })

  it('clamps volume to 0..1', () => {
    const player = createSoundPlayer(() => null, { volume: 4 })
    expect(player.settings().volume).toBe(1)
    player.configure({ volume: -1 })
    expect(player.settings().volume).toBe(0)
  })

  it('drops the same sound fired twice at once, but not a different one', () => {
    const fake = fakeContext()
    const player = playerWith(fake)
    player.play('tap')
    player.play('tap')
    player.play('send')
    expect(fake.count()).toBe(soundPresets.tap.length + soundPresets.send.length)
    fake.ctx.currentTime = 1
    player.play('tap')
    expect(fake.count()).toBe(soundPresets.tap.length * 2 + soundPresets.send.length)
  })

  it('does nothing without Web Audio', () => {
    expect(() => createSoundPlayer(() => null, { enabled: true }).play('error')).not.toThrow()
    expect(() => createSoundPlayer(() => { throw new Error('no audio') }, { enabled: true }).play('error')).not.toThrow()
  })
})
