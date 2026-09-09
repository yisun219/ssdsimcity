import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

interface BrowserProbe {
  kind: string
  modelSeconds: number
  tailCommits: number
  maxTailTps: number
  finalTps: number
  paused: boolean
  restoredTps: number
  leader: string | null
  sheets: number
  storedKnobs: Record<string, unknown>
  terminalToasts: string[]
  errors: string[]
}

interface StoredPage {
  name: string
  path: string
  readySelector: string
  kind: string
  warmSeconds: number
  probeSeconds: number
  beforeLoad: string
  prepare: string
}

const TERMINAL_TOAST = String.raw`(?:pg_wal reached.*writes rejected|ERROR: no unpinned|commits (?:will|are) wait|cannot acknowledge commits)`

function storedPage(
  kind: string,
  knobs: Record<string, unknown>,
  warmSeconds: number,
  probeSeconds: number,
  auxiliary: Record<string, string> = {},
): StoredPage {
  const records = {
    'ssdsimcity.knobs': JSON.stringify(knobs),
    ...auxiliary,
  }
  return {
    name: kind,
    path: '/',
    readySelector: '#hud-top',
    kind,
    warmSeconds,
    probeSeconds,
    beforeLoad: `(() => {
      localStorage.clear()
      const records = ${JSON.stringify(records)}
      for (const [key, value] of Object.entries(records)) localStorage.setItem(key, value)
      window.__pgSessionStateErrors = []
      addEventListener('error', (event) => window.__pgSessionStateErrors.push(String(event.error || event.message)))
      addEventListener('unhandledrejection', (event) => window.__pgSessionStateErrors.push(String(event.reason)))
      const context = WebGL2RenderingContext.prototype
      for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        context[method] = () => {}
      }
    })()`,
    prepare: `(async () => {
      for (let attempt = 0; attempt < 120 && !window.SSDSIMCITY; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!window.SSDSIMCITY) throw new Error('SSDSimCity did not initialise')
    })()`,
  }
}

describe('persisted state in a production phone bootstrap', () => {
  it('loads the minimized accumulated-state recipes into a live city', async () => {
    const pages = [
      storedPage('sanitised auxiliary state', { paused: true, tps: 0 }, 0, 10, {
        'ssdsimcity.theme': 'retired-neon-theme',
        'ssdsimcity.audio': JSON.stringify({ enabled: 'yes', volume: 'loud' }),
        'ssdsimcity.seen': 'corrupt',
        'ssdsimcity.rotate-hint.dismissed': 'corrupt',
        'ssdsimcity.console.open': '1',
        'ssdsimcity.inspector.open': '1',
      }),
      storedPage('remaining failover candidate', {
        tps: 120,
        writeRatio: 1,
        synchronousStandbyNames: 'none',
        standbyAEnabled: false,
        standbyBEnabled: true,
        haPartition: 'isolate_node',
      }, 20, 10),
      storedPage('cold sequential scans', {
        tps: 5_000,
        seqScanRatio: 1,
        sharedBuffers: 128,
      }, 80, 40),
      storedPage('aggregate WAL buffer pressure', {
        tps: 5_000,
        writeRatio: 1,
        sharedBuffers: 128,
        synchronousCommit: 'off',
      }, 0, 30),
    ]

    const reports = await inspectRenderedPages(pages, async ({ evaluate, page }): Promise<BrowserProbe> => {
      return evaluate(`(() => {
        const { bus, sim } = window.SSDSIMCITY
        const toasts = []
        const dispose = bus.on('toast', ({ text }) => toasts.push(text))
        const step = 1 / 15
        const advance = (seconds, sample) => {
          let maxTps = 0
          for (let tick = 0; tick < Math.ceil(seconds / step); tick += 1) {
            sim.update(step)
            if (sample) maxTps = Math.max(maxTps, sim.state.stats.tps)
          }
          return maxTps
        }
        const startedAt = sim.state.t
        advance(${page.warmSeconds}, false)
        const beforeCommits = sim.state.stats.commits
        const maxTailTps = advance(${page.probeSeconds}, true)
        dispose()
        return {
          kind: ${JSON.stringify(page.kind)},
          modelSeconds: sim.state.t - startedAt,
          tailCommits: sim.state.stats.commits - beforeCommits,
          maxTailTps,
          finalTps: sim.state.stats.tps,
          paused: sim.state.knobs.paused,
          restoredTps: sim.state.knobs.tps,
          leader: sim.state.highAvailability.currentLeader,
          sheets: document.querySelectorAll('.pgc-host.is-compact.is-open').length,
          storedKnobs: JSON.parse(localStorage.getItem('ssdsimcity.knobs') || '{}'),
          terminalToasts: toasts.filter((text) => /${TERMINAL_TOAST}/i.test(text)),
          errors: window.__pgSessionStateErrors,
        }
      })()`) as Promise<BrowserProbe>
    })

    for (const report of reports) {
      expect(report.errors, `${report.kind}: browser exception`).toEqual([])
      expect(report.modelSeconds, `${report.kind}: model clock`).toBeGreaterThan(0)
      expect(report.tailCommits, `${report.kind}: late commits`).toBeGreaterThan(0)
      expect(report.maxTailTps, `${report.kind}: throughput never registered`).toBeGreaterThan(0)
      expect(Number.isFinite(report.finalTps), `${report.kind}: finite throughput`).toBe(true)
      expect(report.terminalToasts, `${report.kind}: terminal toast`).toEqual([])
    }

    const sanitised = reports[0]
    expect(sanitised.paused).toBe(false)
    expect(sanitised.restoredTps).toBeGreaterThanOrEqual(1)
    expect(sanitised.sheets).toBe(1)
    expect(sanitised.storedKnobs).not.toHaveProperty('paused')
    expect(sanitised.storedKnobs).not.toHaveProperty('tps')

    expect(reports[1].leader).toBe('standbyB')
  }, 16 * 60_000)
})
