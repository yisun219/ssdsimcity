import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { ANCHOR, DISTRICT_BOUNDS } from './layout'

/* ============================================================================
 * THE M.2 CARD — the shape of the ground SSDSimCity stands on.
 *
 * The city is not reshaped. What is shaped is the *plate*: the poured slab the
 * districts are bolted to now ends in the outline of an M.2 2280 SSD — the
 * most recognisable consumer SSD form factor. Seen from an orbit it reads as
 * a bare drive; seen straight down (the `O` preset) it reads as the card.
 *
 * ---------------------------------------------------------------------------
 * THE ARTWORK
 *
 * `LOGO_OUTLINE_D` is a single closed path authored to the M.2 2280 form
 * factor's plan geometry (JEDEC MO-300: 22 mm x 80 mm, semicircular key notch
 * on the edge-contact end). The world plate keeps the card's proportions with
 * the long axis running north-south:
 *
 *   - the card body covers the device districts (towers, cache, NAND floor,
 *     write path, GC yard, FTL lab, replication quarter),
 *   - the edge-contact end (gold fingers) faces north, toward the host
 *     clients, the way the card plugs into a motherboard with the host
 *     standing beyond it,
 *   - the semicircular key notch on that end breaks the clients district the
 *     same way the mounting notch breaks a real card's edge.
 *
 * The path is authored with cubic beziers only (kappa-rounded corners), so
 * the existing LineCurve/CubicBezierCurve pipeline in this module consumes it
 * unchanged.
 *
 * three.js r0.185.1's SVGLoader.parse() returns ShapePath objects in `.paths`;
 * ShapePath.toShapes() is the current API (SVGLoader.createShapes is deprecated
 * in r185). Parsing happens once at module initialisation. There is no fetch at
 * runtime: the static bundle contains the path below.
 *
 * THE PLAN TRANSFORM
 *
 * SVG x is kept rightward and SVG y-down is flipped to world north (-Z). The
 * card is drawn axis-aligned (no rotation), uniformly scaled by 2.6, and
 * translated (-274, +360). Thus the world plate spans x -274..287 and
 * z -373..360 — every district footprint plus its 8 m kerb clearance.
 * ==========================================================================*/

/**
 * Outer blue fill path from the genuine SVG cited above. Keep this byte-for-byte
 * vector data rather than replacing it with hand-authored control points.
 */
export const LOGO_OUTLINE_D =
  'M6,0 H342 C345.31,0 348,2.6862 348,6 V313 C348,316.31 345.31,319 342,319 H184 C184,313.48 179.52,309 174,309 C168.48,309 164,313.48 164,319 H6 C2.6862,319 0,316.31 0,313 V6 C0,2.6862 2.6862,0 6,0 Z'

const SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${LOGO_OUTLINE_D}"/></svg>`
const SOURCE_SCALE = 2.6
const SOURCE_ANGLE = 0
const SOURCE_COS = Math.cos(SOURCE_ANGLE)
const SOURCE_SIN = Math.sin(SOURCE_ANGLE)
const SOURCE_TX = -452
const SOURCE_TZ = 408

/** Original SVG coordinates → world plan; a uniform rigid transform. */
function sourceToWorld(x: number, y: number): [number, number] {
  return [
    SOURCE_TX + SOURCE_SCALE * (x * SOURCE_COS + y * SOURCE_SIN),
    SOURCE_TZ + SOURCE_SCALE * (x * SOURCE_SIN - y * SOURCE_COS),
  ]
}

/**
 * Normalised logo space → world plan. Ground dressing uses this small,
 * source-independent coordinate frame; the plate itself uses sourceToWorld().
 */
export function logoToWorld(xe: number, ye: number): [number, number] {
  const k = 5.3
  return [
    k * (xe * SOURCE_COS - ye * SOURCE_SIN),
    k * (xe * SOURCE_SIN + ye * SOURCE_COS),
  ]
}

/**
 * The world direction that belongs at the top of frame in the overview shot.
 * The card is drawn axis-aligned, so SVG up is world north (-Z): the
 * edge-contact end of the M.2 card points at the top of the plan view.
 */
export const PLAN_UP: readonly [number, number] = [-SOURCE_SIN, SOURCE_COS]

/** One card-outline SVG segment transformed into world plan coordinates. */
export type PlanCurve =
  | { readonly kind: 'line'; readonly to: [number, number] }
  | {
      readonly kind: 'cubic'
      readonly c1: [number, number]
      readonly c2: [number, number]
      readonly to: [number, number]
    }

const parsed = new SVGLoader().parse(SVG_TEXT)
const sourceShapes = parsed.paths[0]?.toShapes() ?? []
if (parsed.paths.length !== 1 || sourceShapes.length !== 1) {
  throw new Error(`Slonik outline: expected one SVG path/shape, got ${parsed.paths.length}/${sourceShapes.length}`)
}
const sourceShape = sourceShapes[0]
const firstCurve = sourceShape.curves[0]
if (!(firstCurve instanceof THREE.LineCurve) && !(firstCurve instanceof THREE.CubicBezierCurve)) {
  throw new Error('Slonik outline: unsupported first SVG curve')
}
const firstPoint = firstCurve instanceof THREE.LineCurve ? firstCurve.v1 : firstCurve.v0

/** The outline as world-space SVG segments, starting from `PLAN_START`. */
export const PLAN_START: [number, number] = sourceToWorld(firstPoint.x, firstPoint.y)
export const PLAN_CURVES: readonly PlanCurve[] = sourceShape.curves.map((curve): PlanCurve => {
  if (curve instanceof THREE.LineCurve) {
    return { kind: 'line', to: sourceToWorld(curve.v2.x, curve.v2.y) }
  }
  if (curve instanceof THREE.CubicBezierCurve) {
    return {
      kind: 'cubic',
      c1: sourceToWorld(curve.v1.x, curve.v1.y),
      c2: sourceToWorld(curve.v2.x, curve.v2.y),
      to: sourceToWorld(curve.v3.x, curve.v3.y),
    }
  }
  throw new Error(`Slonik outline: unsupported SVG curve ${curve.type}`)
})

/* --------------------------------------------------------------------------
 * Sampling.
 * ------------------------------------------------------------------------*/

/**
 * The closed outline as a flat `[x0, z0, x1, z1, …]` ring in world plan
 * coordinates, `seg` samples per cubic. The start point is included once; the
 * ring is not repeated at the end.
 */
export function sampleOutline(seg = 16): Float64Array {
  const final = PLAN_CURVES[PLAN_CURVES.length - 1].to
  const closesItself = Math.hypot(final[0] - PLAN_START[0], final[1] - PLAN_START[1]) < 1e-7
  const pointCount = PLAN_CURVES.length * seg + (closesItself ? 0 : 1)
  const out = new Float64Array(pointCount * 2)
  let px = PLAN_START[0]
  let pz = PLAN_START[1]
  out[0] = px
  out[1] = pz
  let w = 2
  for (let ci = 0; ci < PLAN_CURVES.length; ci++) {
    const c = PLAN_CURVES[ci]
    // Do not duplicate the first point when an SVG happens to close explicitly.
    const last = ci === PLAN_CURVES.length - 1 && closesItself ? seg - 1 : seg
    for (let i = 1; i <= last; i++) {
      const t = i / seg
      if (c.kind === 'line') {
        out[w++] = px + (c.to[0] - px) * t
        out[w++] = pz + (c.to[1] - pz) * t
      } else {
        const u = 1 - t
        const a = u * u * u
        const b = 3 * u * u * t
        const d = 3 * u * t * t
        const e = t * t * t
        out[w++] = a * px + b * c.c1[0] + d * c.c2[0] + e * c.to[0]
        out[w++] = a * pz + b * c.c1[1] + d * c.c2[1] + e * c.to[1]
      }
    }
    px = c.to[0]
    pz = c.to[1]
  }
  return out
}

/** Axis-aligned world extent of the plate. */
export interface PlanBounds {
  x0: number
  x1: number
  z0: number
  z1: number
}

export function outlineBounds(ring: Float64Array): PlanBounds {
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i]
    const z = ring[i + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  return { x0, x1, z0, z1 }
}

/** Signed doubled area. Positive means counter-clockwise in (x, z). */
export function ringArea2(ring: Float64Array): number {
  let a = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  }
  return a
}

/* --------------------------------------------------------------------------
 * Queries. Used by the containment check and by the edge-distance field.
 * ------------------------------------------------------------------------*/

/** Crossing-number test against a sampled ring. */
export function contains(ring: Float64Array, x: number, z: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const zi = ring[i + 1]
    const zj = ring[j + 1]
    if (zi > z !== zj > z) {
      const t = (z - zi) / (zj - zi)
      if (x < ring[i] + t * (ring[j] - ring[i])) inside = !inside
    }
  }
  return inside
}

/** Unsigned distance from (x, z) to the outline, in metres. */
export function distanceToEdge(ring: Float64Array, x: number, z: number): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j]
    const az = ring[j + 1]
    const dx = ring[i] - ax
    const dz = ring[i + 1] - az
    const l2 = dx * dx + dz * dz
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = x - (ax + t * dx)
    const ez = z - (az + t * dz)
    const d = ex * ex + ez * ez
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

/** Positive inside the plate, negative outside. Metres. */
export function clearance(ring: Float64Array, x: number, z: number): number {
  const d = distanceToEdge(ring, x, z)
  return contains(ring, x, z) ? d : -d
}

/**
 * Smallest clearance anywhere on the perimeter of an axis-aligned district
 * footprint. Negative means part of the district hangs over the void.
 */
export function rectClearance(
  ring: Float64Array,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  samples = 24,
): number {
  let worst = Infinity
  for (let i = 0; i <= samples; i++) {
    const f = i / samples
    const x = x0 + (x1 - x0) * f
    const z = z0 + (z1 - z0) * f
    worst = Math.min(
      worst,
      clearance(ring, x, z0),
      clearance(ring, x, z1),
      clearance(ring, x0, z),
      clearance(ring, x1, z),
    )
  }
  return worst
}

/* --------------------------------------------------------------------------
 * Static containment audit.
 * ------------------------------------------------------------------------*/

/** Eight metres keeps district plinths comfortably inside the 2.2 m kerb. */
const REQUIRED_CLEARANCE = 8
const CONTINUITY_ANCHORS = [
  'archiveGate',
  'timelineYard',
  'objectStore',
  'backupVault',
  'recoveryGate',
  'recoveryPad',
  'restoreWinch',
  'recoveryClock',
  'recoveryReplay',
  'rejoinBay',
  'endpoint',
  'consensus',
  'haPrimarySite',
  'haStandbyASite',
  'haStandbyBSite',
  'patroniNode1',
  'patroniNode2',
  'patroniNode3',
  'leaseNode1',
  'leaseNode2',
  'leaseNode3',
  'standbyB',
  'standbyBDeck',
  'standbyBRecv',
] as const

export interface SlonikContainmentAudit {
  readonly requiredClearance: number
  readonly union: PlanBounds
  readonly districtMinimum: number
  readonly districtAtMinimum: string
  readonly anchorMinimum: number
  readonly anchorAtMinimum: (typeof CONTINUITY_ANCHORS)[number]
}

/**
 * Verify the live layout, not a stale hand-copied box. `world` is intentionally
 * excluded: layout.ts defines it as the whole minimap, not a physical district.
 * This runs once when the static world module loads and fails loudly if layout
 * changes ever push a district or continuity work over the kerb.
 */
function auditContainment(): SlonikContainmentAudit {
  const ring = sampleOutline(48)
  const union: PlanBounds = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }
  let districtMinimum = Infinity
  let districtAtMinimum = ''

  for (const [id, bounds] of Object.entries(DISTRICT_BOUNDS)) {
    if (id === 'world') continue
    union.x0 = Math.min(union.x0, bounds.x[0])
    union.x1 = Math.max(union.x1, bounds.x[1])
    union.z0 = Math.min(union.z0, bounds.z[0])
    union.z1 = Math.max(union.z1, bounds.z[1])
    const c = rectClearance(ring, bounds.x[0], bounds.x[1], bounds.z[0], bounds.z[1], 96)
    if (c < districtMinimum) {
      districtMinimum = c
      districtAtMinimum = id
    }
  }

  let anchorMinimum = Infinity
  let anchorAtMinimum: (typeof CONTINUITY_ANCHORS)[number] = CONTINUITY_ANCHORS[0]
  for (const id of CONTINUITY_ANCHORS) {
    const [x, , z] = ANCHOR[id]
    union.x0 = Math.min(union.x0, x)
    union.x1 = Math.max(union.x1, x)
    union.z0 = Math.min(union.z0, z)
    union.z1 = Math.max(union.z1, z)
    const c = clearance(ring, x, z)
    if (c < anchorMinimum) {
      anchorMinimum = c
      anchorAtMinimum = id
    }
  }

  if (districtMinimum < REQUIRED_CLEARANCE || anchorMinimum < REQUIRED_CLEARANCE) {
    throw new Error(
      `Slonik containment failed: district ${districtAtMinimum}=${districtMinimum.toFixed(2)} m, ` +
        `anchor ${anchorAtMinimum}=${anchorMinimum.toFixed(2)} m; required ${REQUIRED_CLEARANCE} m`,
    )
  }

  return {
    requiredClearance: REQUIRED_CLEARANCE,
    union,
    districtMinimum,
    districtAtMinimum,
    anchorMinimum,
    anchorAtMinimum,
  }
}

export const SLONIK_CONTAINMENT = auditContainment()

/* --------------------------------------------------------------------------
 * Geometry helpers.
 * ------------------------------------------------------------------------*/

/**
 * Lay the outline into a THREE.Shape. Shape space is XY and the plate is laid
 * down with a -90° rotation about X, so shape Y is world -Z.
 */
export function writeShape(shape: THREE.Shape): void {
  shape.moveTo(PLAN_START[0], -PLAN_START[1])
  for (const c of PLAN_CURVES) {
    if (c.kind === 'line') {
      shape.lineTo(c.to[0], -c.to[1])
    } else {
      shape.bezierCurveTo(c.c1[0], -c.c1[1], c.c2[0], -c.c2[1], c.to[0], -c.to[1])
    }
  }
  shape.closePath()
}

/**
 * Offset a ring inward by `d` metres, as a new flat ring. Vertex normals are
 * the average of the two adjacent edge normals, which is exact for a straight
 * run and good enough for a curve sampled this finely. `ccw` must say which way
 * the ring winds so "inward" means inward.
 */
export function offsetRing(ring: Float64Array, d: number, ccw: boolean): Float64Array {
  const n = ring.length / 2
  const out = new Float64Array(ring.length)
  const s = ccw ? 1 : -1
  for (let i = 0; i < n; i++) {
    const p = i * 2
    const prev = ((i - 1 + n) % n) * 2
    const next = ((i + 1) % n) * 2
    // Rotating an edge by +90° points inward for a ring that winds CCW in (x, z).
    let nx = 0
    let nz = 0
    for (let e = 0; e < 2; e++) {
      const a = e === 0 ? prev : p
      const b = e === 0 ? p : next
      const ex = ring[b] - ring[a]
      const ez = ring[b + 1] - ring[a + 1]
      const l = Math.hypot(ex, ez) || 1
      nx += (-ez / l) * s
      nz += (ex / l) * s
    }
    const l = Math.hypot(nx, nz) || 1
    out[p] = ring[p] + (nx / l) * d
    out[p + 1] = ring[p + 1] + (nz / l) * d
  }
  return out
}
