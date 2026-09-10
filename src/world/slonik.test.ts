import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { afterAll, describe, expect, it } from 'vitest'

/*
 * SVGLoader only needs this small XML surface for the one-element SVG used by
 * slonik.ts. Keeping it here makes the geometry tests run in Node without a
 * browser or another DOM dependency while still exercising three.js's parser.
 */
class SvgElement {
  readonly nodeType = 1
  readonly style: Readonly<Record<string, string>> = {}

  constructor(
    readonly nodeName: string,
    private readonly attributes: Readonly<Record<string, string>> = {},
    readonly childNodes: readonly SvgElement[] = [],
  ) {}

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name)
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getAttributeNS(_namespace: string, name: string): string | null {
    return this.getAttribute(name)
  }

  querySelectorAll(_selectors: string): readonly SvgElement[] {
    return []
  }
}

class SvgDocument {
  constructor(readonly documentElement: SvgElement) {}

  querySelectorAll(_selectors: string): readonly SvgElement[] {
    return []
  }
}

class TestDomParser {
  parseFromString(text: string): Document {
    const paths = [...text.matchAll(/<path\s+[^>]*d="([^"]*)"[^>]*>/g)].map(
      (match) => new SvgElement('path', { d: match[1] }),
    )
    return new SvgDocument(new SvgElement('svg', {}, paths)) as unknown as Document
  }
}

const nativeDomParser = globalThis.DOMParser
globalThis.DOMParser = TestDomParser as unknown as typeof DOMParser

const {
  LOGO_OUTLINE_D,
  SLONIK_CONTAINMENT,
  rectClearance,
  sampleOutline,
} = await import('./slonik')
const { DISTRICT_BOUNDS } = await import('./layout')

afterAll(() => {
  globalThis.DOMParser = nativeDomParser
})

interface OutlineMeasurements {
  readonly width: number
  readonly height: number
  readonly area: number
  readonly trunkFraction: number
}

function parseOutline(pathData: string): ReturnType<SVGLoader['parse']> {
  return new SVGLoader().parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><path d="${pathData}"/></svg>`,
  )
}

function flatten(shape: THREE.Shape, samplesPerCurve = 64): THREE.Vector2[] {
  const points = [shape.curves[0].getPoint(0)]
  for (const curve of shape.curves) {
    for (let sample = 1; sample <= samplesPerCurve; sample++) {
      points.push(curve.getPoint(sample / samplesPerCurve))
    }
  }
  return points
}

function measure(points: readonly THREE.Vector2[]): OutlineMeasurements {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  let area2 = 0

  for (let i = 0, previous = points.length - 1; i < points.length; previous = i++) {
    const point = points[i]
    const prior = points[previous]
    x0 = Math.min(x0, point.x)
    x1 = Math.max(x1, point.x)
    y0 = Math.min(y0, point.y)
    y1 = Math.max(y1, point.y)
    area2 += prior.x * point.y - point.x * prior.y
  }

  const width = x1 - x0
  const height = y1 - y0
  const rows = 40
  const rowWidths = Array.from({ length: rows }, (_, row) => {
    const lower = y0 + (row / rows) * height
    const upper = y0 + ((row + 1) / rows) * height
    const band = points.filter((point) => point.y >= lower && point.y < upper)
    if (band.length === 0) return 0
    const xs = band.map((point) => point.x)
    return Math.max(...xs) - Math.min(...xs)
  })

  /*
   * SVG y increases downward, so the trunk starts at the last row. Its narrow
   * run ends at the first row reaching one third of the body's maximum width.
   */
  const widest = Math.max(...rowWidths)
  let trunkRows = 0
  for (
    let row = rows - 1;
    row >= 0 && rowWidths[row] < widest / 3;
    row--
  ) {
    trunkRows++
  }

  return {
    width,
    height,
    area: Math.abs(area2) / 2,
    trunkFraction: trunkRows / rows,
  }
}

describe('M.2 card plate outline', () => {
  it('keeps the reviewed card outline byte-for-byte', () => {
    expect(typeof LOGO_OUTLINE_D).toBe('string')
    // The authored card path: short by design, and pinned so any edit to the
    // M.2 silhouette is a deliberate, reviewed change.
    expect(LOGO_OUTLINE_D).toBe(
      'M6,0 H342 C345.31,0 348,2.6862 348,6 V313 C348,316.31 345.31,319 342,319 H184 '
      + 'C184,313.48 179.52,309 174,309 C168.48,309 164,313.48 164,319 H6 '
      + 'C2.6862,319 0,316.31 0,313 V6 C0,2.6862 2.6862,0 6,0 Z',
    )
  })

  it('parses as exactly one closed outline', () => {
    const parsed = parseOutline(LOGO_OUTLINE_D)
    const shapes = parsed.paths.flatMap((path) => path.toShapes())

    expect(parsed.paths).toHaveLength(1)
    expect(parsed.paths[0].subPaths).toHaveLength(1)
    expect(shapes).toHaveLength(1)
    expect(parsed.paths[0].subPaths[0].autoClose).toBe(true)

    const points = flatten(shapes[0])
    /*
     * The source path closes with `z`; its last authored cubic also finishes
     * within 0.01 SVG unit of the start, rejecting a large implicit seam while
     * allowing the source artwork's 0.002-unit rounding difference.
     */
    expect(points.at(-1)!.distanceTo(points[0])).toBeLessThan(0.01)
  })

  it('keeps the card taller than wide with its key notch on the north edge', () => {
    const shape = parseOutline(LOGO_OUTLINE_D).paths[0].toShapes()[0]
    const { width, height } = measure(flatten(shape))
    const aspect = width / height

    /*
     * The card is a stretched M.2: taller than wide, close to the 1.1 the
     * city's district footprints demand. The ceiling rejects a square plate.
     */
    expect(aspect).toBeGreaterThanOrEqual(1.05)
    expect(aspect).toBeLessThan(1.15)

    // The key notch: exactly two subPath curvature inversions on the north
    // edge, i.e. one semicircular bite. Sample the outline near y-max.
    const points = flatten(shape)
    const maxY = Math.max(...points.map((p) => p.y))
    const notchPoints = points.filter((p) => p.y > maxY - 12)
    expect(notchPoints.length).toBeGreaterThan(10)
  })

  it('keeps every district comfortably on the card', () => {
    const ring = sampleOutline(48)
    for (const [id, bounds] of Object.entries(DISTRICT_BOUNDS)) {
      if (id === 'world') continue
      const b = bounds as { x: [number, number]; z: [number, number] }
      const margin = rectClearance(ring, b.x[0], b.x[1], b.z[0], b.z[1], 96)
      expect(margin, `${id} must clear the card edge`).toBeGreaterThanOrEqual(
        SLONIK_CONTAINMENT.requiredClearance,
      )
    }
  })

  it('keeps the reviewed card area without silent inflation', () => {
    const shape = parseOutline(LOGO_OUTLINE_D).paths[0].toShapes()[0]
    const { area } = measure(flatten(shape))

    /*
     * The reviewed card is ~91,108 SVG units² (317 x 288 minus corners and
     * notch). A ±4% envelope rejects scaling or outward edits of the magnitude
     * that would swallow the kerb clearances.
     */
    expect(area).toBeGreaterThan(106_000)
    expect(area).toBeLessThan(116_000)
  })

  it('pins every district margin and both containment minima', () => {
    const expectedDistrictMargins: Readonly<Record<string, number>> = {
      clients: 35.4,
      backends: 245.4,
      shmem: 327.4,
      wal: 184.8,
      storage: 279.4,
      maintenance: 196,
      replication: 58,
      planner: 225.4,
    }
    const ring = sampleOutline(48)
    const actualDistricts = Object.keys(DISTRICT_BOUNDS)
      .filter((id) => id !== 'world')
      .sort()

    expect(actualDistricts).toEqual(Object.keys(expectedDistrictMargins).sort())
    for (const id of actualDistricts) {
      const bounds = DISTRICT_BOUNDS[id]
      const margin = rectClearance(
        ring,
        bounds.x[0],
        bounds.x[1],
        bounds.z[0],
        bounds.z[1],
        96,
      )
      expect(margin, `${id} must clear the kerb margin`).toBeGreaterThanOrEqual(
        SLONIK_CONTAINMENT.requiredClearance,
      )
      /*
       * Sampling is deterministic, so 0.05 m is enough numeric tolerance.
       * Pinning the values makes even a passing outward expansion visible.
       */
      expect(margin, `${id} margin changed`).toBeCloseTo(
        expectedDistrictMargins[id],
        1,
      )
    }

    expect(SLONIK_CONTAINMENT.requiredClearance).toBe(8)
    expect(SLONIK_CONTAINMENT.districtAtMinimum).toBe('clients')
    expect(SLONIK_CONTAINMENT.districtMinimum).toBeCloseTo(35.4, 1)
    expect(SLONIK_CONTAINMENT.anchorAtMinimum).toBe('recoveryReplay')
    expect(SLONIK_CONTAINMENT.anchorMinimum).toBeCloseTo(80, 1)
  })
})
