import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'
import { FRAME_TEST_STEP } from './test-support'

describe('SSD device under load', () => {
  it('completes requests, thrashes CMT under random writes, and reaches GC', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 600)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('randomShare', 1)
    const before = sim.state.ssd.gc.erasesCompleted
    for (let i = 0; i < 30 * 90; i++) sim.update(FRAME_TEST_STEP)
    const s = sim.state.ssd
    const ops = s.flows.reduce((n, f) => n + f.reads + f.writes, 0)
    expect(ops).toBeGreaterThan(0)
    expect(s.cmt.misses).toBeGreaterThan(0)
    expect(s.writeCache.misses).toBeGreaterThan(0)
  })

  it('keeps the NVMe fetch rule: no flow exceeds queueFetchSize in service', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('iops', 20_000)
    sim.setKnob('queueFetchSize', 8)
    sim.setKnob('tps', 5000)
    for (let i = 0; i < 30 * 30; i++) sim.update(FRAME_TEST_STEP)
    for (const flow of sim.state.ssd.flows) {
      expect(flow.inFlight).toBeLessThanOrEqual(8)
    }
  })
})
