import { describe, expect, it } from 'vitest'
import {
  createQrFrameAssembler,
  isQrFrame,
  parseQrFrame,
  reassembleQrFrames,
  splitQrFrames,
} from './qrFrames'

const SAMPLE = `{"v":1,"kind":"handcash-device-key-backup","fromDeviceId":"dev-a","ciphertextB64":"${'A'.repeat(240)}"}`

describe('qrFrames', () => {
  it('splits a dense payload into 80–120 char chunks with a reassembly header', () => {
    const frames = splitQrFrames(SAMPLE, 100)
    expect(frames.length).toBeGreaterThan(1)
    const parsed = frames.map((raw) => parseQrFrame(raw))
    expect(parsed.every(Boolean)).toBe(true)
    expect(parsed[0]?.count).toBe(frames.length)
    expect(parsed[0]?.index).toBe(0)
    expect(parsed.at(-1)?.index).toBe(frames.length - 1)
    for (const frame of parsed) {
      expect(frame!.payload.length).toBeGreaterThan(0)
      expect(frame!.payload.length).toBeLessThanOrEqual(100)
    }
  })

  it('reassembles a complete sequence in order', () => {
    const frames = splitQrFrames(SAMPLE, 100)
    expect(reassembleQrFrames(frames)).toBe(SAMPLE)
  })

  it('reassembles frames delivered out of order', () => {
    const frames = splitQrFrames(SAMPLE, 90)
    const shuffled = [...frames].sort((a, b) => b.localeCompare(a))
    expect(shuffled).not.toEqual(frames)
    expect(reassembleQrFrames(shuffled)).toBe(SAMPLE)
  })

  it('does not complete when a frame is missing', () => {
    const frames = splitQrFrames(SAMPLE, 80)
    expect(frames.length).toBeGreaterThan(2)
    const missing = frames.filter((_, i) => i !== 1)
    expect(reassembleQrFrames(missing)).toBeNull()

    const assembler = createQrFrameAssembler()
    let last: ReturnType<typeof assembler.add> = null
    for (const raw of missing) last = assembler.add(raw)
    expect(last?.complete).toBe(false)
    expect(last && !last.complete ? last.got : 0).toBe(frames.length - 1)
  })

  it('completes once the missing frame arrives', () => {
    const frames = splitQrFrames(SAMPLE, 80)
    const assembler = createQrFrameAssembler()
    const skipped = frames[1]!
    for (const raw of frames.filter((_, i) => i !== 1)) {
      expect(assembler.add(raw)?.complete).toBe(false)
    }
    const done = assembler.add(skipped)
    expect(done).toEqual({
      complete: true,
      payload: SAMPLE,
      got: frames.length,
      count: frames.length,
      id: parseQrFrame(frames[0]!)!.id,
    })
  })

  it('starts a new sequence when the frame id changes', () => {
    const first = splitQrFrames('alpha-payload-one'.repeat(20), 80)
    const second = splitQrFrames('beta-payload-two'.repeat(20), 80)
    expect(parseQrFrame(first[0]!)!.id).not.toBe(parseQrFrame(second[0]!)!.id)
    const assembler = createQrFrameAssembler()
    assembler.add(first[0]!)
    const afterSwitch = assembler.add(second[0]!)
    expect(afterSwitch?.complete).toBe(false)
    expect(afterSwitch && !afterSwitch.complete ? afterSwitch.got : 0).toBe(1)
    expect(reassembleQrFrames(second)).toBe('beta-payload-two'.repeat(20))
  })

  it('does not treat full JSON as a frame, so paste-as-JSON still works', () => {
    expect(isQrFrame(SAMPLE)).toBe(false)
    expect(parseQrFrame(SAMPLE)).toBeNull()
    expect(isQrFrame(splitQrFrames(SAMPLE)[0]!)).toBe(true)
  })
})
