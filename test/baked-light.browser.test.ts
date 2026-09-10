import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('installs the shipped bake on the actual city across quality changes', async () => {
  const [states] = await inspectRenderedPages([{
    name: 'City baked lighting', path: '/', readySelector: '.hud-theme', reducedMotion: true,
  }], async ({ evaluate }) => evaluate(`(async () => {
    for (let i = 0; i < 200 && !window.SSDSIMCITY; i++) await new Promise(resolve => setTimeout(resolve, 50))
    if (!window.SSDSIMCITY) throw new Error('City debugging surface not ready')
    const p = window.SSDSIMCITY
    await new Promise(resolve => requestAnimationFrame(resolve))
    const render = p.gfx.render.bind(p.gfx)
    p.gfx.render = dt => render(dt, 1 / 60)
    // The install is deliberately deferred (boot meshes settle first); poll
    // instead of assuming the first frame already carries bake stats.
    for (let i = 0; i < 400 && !p.gfx.scene.userData.pgBakedLight; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const states = []
    for (const level of ['low', 'medium', 'high']) {
      p.gfx.setQuality(level)
      await new Promise(resolve => requestAnimationFrame(resolve))
      const bake = p.gfx.scene.userData.pgBakedLight
      let attributed = 0, receivers = 0
      p.gfx.scene.traverse(o => {
        if (!o.userData.pgBakeOriginalGeometry && !o.userData.pgBakeInPlace) return
        receivers++
        const sky = o.geometry?.getAttribute(o.isInstancedMesh ? 'pgBakeSkyA' : 'pgBakeSky')
        const transfer = o.geometry?.getAttribute(o.isInstancedMesh ? 'pgBakeTransferA' : 'pgBakeTransfer')
        if (sky && transfer) attributed++
      })
      states.push({level, installed: bake?.installed, reason: bake?.reason, meshes: bake?.meshes, receivers, attributed})
    }
    return states
  })()`))
  for (const state of states) {
    expect(state.installed, `${state.level}: ${state.reason}`).toBe(true)
    expect(state.meshes).toBeGreaterThan(100)
    // A boot-time race can add one late mesh (e.g. storage.controller-die)
    // after the bake payload was written; it simply stays unbaked, so the page
    // may report more receivers than the bake installed.
    expect(state.receivers).toBeGreaterThanOrEqual(state.meshes)
    expect(state.attributed).toBe(state.meshes)
  }
}, 180_000)
