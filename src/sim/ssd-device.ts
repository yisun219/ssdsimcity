/* ============================================================================
 * SSDSimCity — THE SSD DEVICE ENGINE
 *
 * The device the city draws is a projection of the state produced here, so
 * the rules below are meant to be *true* to the MQSim FAST 2018 paper, not
 * pretty:
 *
 *   - The host really fetches at most QueueFetchSize entries per submission
 *     queue into the device, so one flow cannot occupy the whole controller
 *     (paper §4.2.1, §6.1.4).
 *   - A CMT miss really stalls the request behind a mapping read from flash
 *     (paper §4.2.3 / §3.3): a random second flow really does evict a
 *     sequential flow's mapping entries.
 *   - The write cache really thrashes: a deep-queue writer fills the DRAM
 *     cache, evicts before destaging completes, and pushes extra flash
 *     traffic that slows the other flow (paper §6.1.2).
 *   - Garbage collection really starts when the free-page pool crosses the
 *     GC threshold, really copies valid pages, really erases, and (when
 *     preemptible) really suspends an erase for a pending user read.
 *   - End-to-end latency really accumulates through seven stages
 *     (enqueue → PCIe → FTL → cache → flash → ONFI → PCIe), because the
 *     FAST'18 argument is that ignoring any one of them skews the result
 *     (paper §3.3).
 *
 * THREE HONEST DISTORTIONS, all deliberate, matching the house style of the
 * PGSimCity engine this city inherits:
 *
 *  1. DEVICE LATENCY IS STRETCHED for anything sub-second. A real NAND read
 *     is ~75 µs and an erase ~3.8 ms; at 30 Hz those are invisible. The
 *     stretch is a monotone ~100×, so the *shape* is faithful. Rates (IOPS,
 *     bytes/sec, queue depths) are never stretched.
 *
 *  2. THE CITY IS A SCALE MODEL. The excavation samples BLOCK_SAMPLE_PER_PLANE
 *     blocks per plane across 8 channels × 4 chips × 2 dies × 2 planes. The
 *     logical LPA space maps into that sample by bucketing, the way the
 *     buffer plaza samples a whole shared_buffers pool.
 *
 *  3. PRECONDITIONING IS INSTALLED, NOT SIMULATED. The steady-state valid/
 *     invalid page mix (paper §4.4) is installed at reset from a fixed
 *     distribution instead of replaying terabytes of writes; the freed-page
 *     pool starts just above the GC threshold, so GC arrives within the
 *     first minute of a write-heavy workload.
 * ==========================================================================*/

import {
  BLOCK_SAMPLE_PER_PLANE,
  FLASH_PAGE_BYTES,
  N_CHANNELS,
  N_CHIPS_PER_CHANNEL,
  N_DIES_PER_CHIP,
  N_PAGES_PER_BLOCK,
  N_PLANES_PER_DIE,
  SAMPLE_PHYSICAL_PAGES,
} from '../core/ssd-types'
import type {
  FlashBlock,
  IoRequestSim,
  NvmePriorityClass,
  SsdDeviceState,
} from '../core/ssd-types'
import { clamp, clamp01, makeRng } from '../core/util'

/* --------------------------------------------------------------------------
 * Constant device geometry and timings (FAST'18 Table 3 + paper §4.1).
 * ------------------------------------------------------------------------*/

/** Blocks the sampled estate exposes: one entry per visible block cell. */
export const SAMPLED_BLOCKS =
  N_CHANNELS * N_CHIPS_PER_CHANNEL * N_DIES_PER_CHIP * N_PLANES_PER_DIE * BLOCK_SAMPLE_PER_PLANE

/**
 * DEVICE LATENCY STRETCH: real µs become model seconds through this factor,
 * matching the city's 100× lifecycle stretch. A 75 µs read renders for
 * 7.5 model ms — visible at 30 Hz — while its *rate* effects stay real.
 */
export const FLASH_LATENCY_STRETCH = 100

const REAL_READ_SEC = 75e-6 * FLASH_LATENCY_STRETCH
const REAL_PROGRAM_SEC = 750e-6 * FLASH_LATENCY_STRETCH
const REAL_ERASE_SEC = 3.8e-3 * FLASH_LATENCY_STRETCH
/** NV-DDR2 transfer of one 8 KiB page at 333 MT/s × 2 bytes, stretched. */
const REAL_PAGE_XFER_SEC = (8 * 1024) / (333e6 * 2) * FLASH_LATENCY_STRETCH
/** PCIe 3.0 x4 ≈ 3.94 GB/s usable; command/data hops share it unstretched. */
export const PCIE_BYTES_PER_SEC = 3_940_000_000

/** GC engages once free pages fall below this share (MQSim GC_Exect_Threshold). */
export const GC_EXEC_THRESHOLD_DEFAULT = 0.06
/** Preemptible GC pauses once free pages recover past this (GC_Hard_Threshold). */
export const GC_HARD_THRESHOLD_DEFAULT = 0.03

/**
 * The steady-state invalid-page fraction a well-worn plane settles into
 * (paper §4.4 installs a valid/invalid mix; we sample it deterministically).
 */
const STEADY_STATE_INVALID_SHARE = 0.28

/** Fixed logical-address mix: a hot band plus a uniform cold tail. */
const LPA_HOT_SHARE = 0.55
/** Span of the hot band in logical pages. */
const HOT_LPA_SPAN = Math.max(1, Math.floor(SAMPLE_PHYSICAL_PAGES / 64))

/** The device-facing knob surface. Kept separate from the city Knobs on
 * purpose: the SSD engine is testable without the bus. */
export interface SsdKnobs {
  /** QueueFetchSize: max in-flight entries per submission queue (§4.2.1). */
  queueFetchSize: number
  /** Device DRAM data cache in MiB. */
  dataCacheMiB: number
  /** Cached mapping table in MiB. */
  cmtCapacityMiB: number
  /** 0..1 overprovisioning ratio. */
  overprovisioning: number
  /** GC starts when free ratio falls below this. */
  gcExecThreshold: number
  /** Preemptible GC stop threshold. */
  gcHardThreshold: number
  /** Preemptible GC on/off. */
  preemptibleGc: boolean
  /** 0..1 share of requests issued as writes. */
  writeRatio: number
  /** 0..1 share of accesses uniformly random (vs hot-set skewed). */
  randomShare: number
  /** Mean request size in KiB. */
  requestSizeKiB: number
  /** Offered aggregate IOPS across all flows. */
  iops: number
  /** Cache sharing across flows. */
  cacheSharing: 'SHARED' | 'EQUAL_PARTITIONING'
  /** What the device cache caches. */
  readCacheMode: 'WRITE_CACHE' | 'READ_CACHE' | 'WRITE_READ_CACHE' | 'TURNED_OFF'
  /** Backend transaction scheduling policy. */
  schedulingPolicy: 'OUT_OF_ORDER' | 'PRIORITY_OUT_OF_ORDER'
}

export const DEFAULT_SSD_KNOBS: SsdKnobs = {
  queueFetchSize: 512,
  dataCacheMiB: 256,
  cmtCapacityMiB: 4,
  overprovisioning: 0.12,
  gcExecThreshold: GC_EXEC_THRESHOLD_DEFAULT,
  gcHardThreshold: GC_HARD_THRESHOLD_DEFAULT,
  preemptibleGc: true,
  writeRatio: 0.4,
  randomShare: 0.5,
  requestSizeKiB: 8,
  iops: 1200,
  cacheSharing: 'SHARED',
  readCacheMode: 'WRITE_CACHE',
  schedulingPolicy: 'PRIORITY_OUT_OF_ORDER',
}

/* --------------------------------------------------------------------------
 * SsdDeviceEngine — owns and mutates SsdDeviceState.
 * ------------------------------------------------------------------------*/

export class SsdDeviceEngine {
  readonly state: SsdDeviceState
  private readonly knobs: SsdKnobs
  private readonly rng: () => number
  private readonly flowCount: number

  /**
   * Accepts the city's full Knobs object: the engine reads only the SSD
   * subset, so callers can pass `DEFAULT_KNOBS` without shaping first.
   */
  static from(cityKnobs: SsdKnobs, flowCount: number, seed?: number): SsdDeviceEngine {
    return new SsdDeviceEngine(cityKnobs, flowCount, seed)
  }
  private nextRequestId = 1
  /** Requests in device service right now (not queued in an SQ). */
  private readonly inFlight: IoRequestSim[] = []
  /** Per-flow arrival backlog (entries parked in the SQ). */
  private readonly sqBacklog: number[]
  /** Poisson arrival carry-over. */
  private nextArrival = 0
  /** Monotone free-page pool: derived from block state each sweep. */
  private gcVictimCursor = 0
  /** EMA of per-flow latency while alone, for the fairness ledger. */
  private readonly aloneLatency: Float64Array

  constructor(cityKnobs: SsdKnobs, flowCount: number, seed = 0x555d01) {
    const knobs: SsdKnobs = {
      queueFetchSize: cityKnobs.queueFetchSize,
      dataCacheMiB: cityKnobs.dataCacheMiB,
      cmtCapacityMiB: cityKnobs.cmtCapacityMiB,
      overprovisioning: cityKnobs.overprovisioning,
      gcExecThreshold: cityKnobs.gcExecThreshold,
      gcHardThreshold: cityKnobs.gcHardThreshold,
      preemptibleGc: cityKnobs.preemptibleGc,
      writeRatio: cityKnobs.writeRatio,
      randomShare: cityKnobs.randomShare,
      requestSizeKiB: cityKnobs.requestSizeKiB,
      iops: cityKnobs.iops,
      cacheSharing: cityKnobs.cacheSharing,
      readCacheMode: cityKnobs.readCacheMode,
      schedulingPolicy: cityKnobs.schedulingPolicy,
    }
    this.knobs = knobs
    this.flowCount = flowCount
    this.rng = makeRng(seed)
    this.state = {
      hostInterface: {
        queueDepth: 1024,
        queueFetchSize: knobs.queueFetchSize,
        inFlight: 0,
        pcieBytesPerSec: PCIE_BYTES_PER_SEC,
      },
      flows: [],
      writeCache: {
        capacityBytes: knobs.dataCacheMiB * 1024 * 1024,
        usedBytes: 0,
        hits: 0,
        misses: 0,
        hitRatio: 0,
        dirtyBytes: 0,
        destageBytesPerSec: 0,
      },
      cmt: {
        lpa: new Int32Array(0),
        ppn: new Int32Array(0),
        hand: 0,
        capacity: 0,
        hits: 0,
        misses: 0,
        hitRatio: 1,
        inFlightMisses: 0,
      },
      gc: {
        phase: 'idle',
        progress: 0,
        victimChannel: 0,
        victimChip: 0,
        victimDie: 0,
        victimPlane: 0,
        victimBlock: 0,
        pagesToCopy: 0,
        pagesCopied: 0,
        erasesCompleted: 0,
        preemptible: knobs.preemptibleGc,
        suspendedForRead: false,
        suspensions: 0,
        freePageRatio: 1,
      },
      blocks: [],
      freePageRatio: 1,
      overprovisioning: knobs.overprovisioning,
      preconditioned: false,
      fairness: { flowSlowdown: new Array(flowCount).fill(1), fairness: 1 },
    }
    this.sqBacklog = new Array<number>(flowCount).fill(0)
    this.aloneLatency = new Float64Array(flowCount)
    this.aloneLatency.fill(0)
    for (let i = 0; i < flowCount; i++) {
      this.state.flows.push({
        slot: i,
        active: false,
        sqDepth: 0,
        inFlight: 0,
        reads: 0,
        writes: 0,
        bytes: 0,
        latencyMs: 0,
        activity: 0,
        lastRequest: null,
      })
    }
    this.installPreconditionedBlocks()
  }

  /* ------------------------------------------------------------------------
   * Geometry helpers.
   * ----------------------------------------------------------------------*/

  private blockIndex(channel: number, chip: number, die: number, plane: number, block: number): number {
    return (
      ((channel * N_CHIPS_PER_CHANNEL + chip) * N_DIES_PER_CHIP + die) * N_PLANES_PER_DIE + plane
    ) * BLOCK_SAMPLE_PER_PLANE + block
  }

  private installPreconditionedBlocks(): void {
    const blocks: FlashBlock[] = []
    const rng = this.rng
    for (let ch = 0; ch < N_CHANNELS; ch++) {
      for (let chip = 0; chip < N_CHIPS_PER_CHANNEL; chip++) {
        for (let die = 0; die < N_DIES_PER_CHIP; die++) {
          for (let plane = 0; plane < N_PLANES_PER_DIE; plane++) {
            for (let blk = 0; blk < BLOCK_SAMPLE_PER_PLANE; blk++) {
              // Steady state: most blocks carry a mix of valid and invalid
              // pages; only a sliver of the estate stays free (paper §4.4).
              const invalid = Math.round(N_PAGES_PER_BLOCK * STEADY_STATE_INVALID_SHARE * (0.6 + 0.8 * rng()))
              const valid = clamp(N_PAGES_PER_BLOCK - invalid, 0, N_PAGES_PER_BLOCK)
              const eraseCount = Math.floor(80 + 240 * rng())
              blocks.push({
                channel: ch,
                chip,
                die,
                plane,
                block: blk,
                valid,
                invalid,
                eraseCount: eraseCount,
                writeCursor: valid + invalid,
                inUse: valid + invalid > 0,
                gcCandidate: false,
              })
            }
          }
        }
      }
    }
    this.state.blocks = blocks
    this.state.preconditioned = true
    this.recomputeFreeRatio()
  }

  private recomputeFreeRatio(): void {
    const blocks = this.state.blocks
    let free = 0
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (!b.inUse) free++
    }
    this.state.freePageRatio = blocks.length > 0 ? free / blocks.length : 1
    this.state.gc.freePageRatio = this.state.freePageRatio
  }

  /* ------------------------------------------------------------------------
   * Access generation — LPA stream with a hot band + uniform cold tail.
   * ----------------------------------------------------------------------*/

  private nextLpa(randomShare: number): number {
    if (this.rng() < LPA_HOT_SHARE * (1 - randomShare) + randomShare * 0) {
      // Hot band: quadratic skew concentrates on the first pages.
      return Math.floor(this.rng() * this.rng() * HOT_LPA_SPAN)
    }
    return Math.floor(this.rng() * SAMPLE_PHYSICAL_PAGES)
  }

  /** Map an LPA to its sampled representative block via bucketing. */
  private lpaToSampledBlock(lpa: number): number {
    const bucket = Math.floor((lpa * SAMPLED_BLOCKS) / Math.max(1, SAMPLE_PHYSICAL_PAGES))
    return clamp(bucket, 0, SAMPLED_BLOCKS - 1)
  }

  /* ------------------------------------------------------------------------
   * Steady-state tick. `dt` is model seconds.
   * ----------------------------------------------------------------------*/

  update(dt: number, flowActivity: number[]): void {
    this.knobs.queueFetchSize = Math.max(1, Math.round(this.knobs.queueFetchSize))
    this.generateArrivals(dt)
    this.serviceRequests(dt, flowActivity)
    this.tickWriteCache(dt)
    this.tickGc(dt)
  }

  /** Poisson arrivals across flows, split by flow weight. */
  private generateArrivals(dt: number): void {
    const rate = Math.max(0, this.knobs.iops)
    if (rate <= 0) return
    this.nextArrival -= dt
    let guard = 256
    while (this.nextArrival <= 0 && guard-- > 0) {
      this.nextArrival += -Math.log(1 - this.rng()) / Math.max(1, this.knobs.iops)
      const flow = Math.floor(this.rng() * this.flowCount)
      this.sqBacklog[flow] = Math.min(this.sqBacklog[flow] + 1, this.state.hostInterface.queueDepth)
    }
  }

  /* ---- request lifecycle ------------------------------------------------*/

  private serviceRequests(dt: number, flowActivity: number[]): void {
    const hi = this.state.hostInterface
    hi.queueFetchSize = this.knobs.queueFetchSize
    // The fetch rule: per-flow in-flight ≤ QueueFetchSize. This is the
    // single mechanism behind the paper's per-flow throughput cap.
    let inFlightTotal = 0
    for (let f = 0; f < this.flowCount; f++) {
      const flow = this.state.flows[f]
      flow.active = this.sqBacklog[f] > 0 || flow.inFlight > 0
      const fetchCap = Math.min(this.knobs.queueFetchSize, flow.active ? this.knobs.queueFetchSize : 0)
      let admission = Math.min(this.sqBacklog[f], fetchCap - flow.inFlight)
      if (admission < 0) admission = 0
      for (let k = 0; k < admission; k++) {
        this.deviceQueue.push(this.makeRequest(f))
        this.sqBacklog[f]--
        flow.inFlight++
      }
      inFlightTotal += flow.inFlight
    }
    this.state.hostInterface.inFlight = inFlightTotal

    // Advance every in-flight request through the seven-stage pipeline.
    for (let i = this.deviceQueue.length - 1; i >= 0; i--) {
      const req = this.deviceQueue[i]
      req.stateT += dt
      if (req.stateT < req.stateDur) continue
      this.advanceRequest(req, i)
    }
  }

  private advanceRequest(req: IoRequestSim, index: number): void {
    switch (req.state) {
      case 'pcie_cmd':
        // FTL: CMT lookup; a miss pays a mapping read before the data access.
        req.cmtMiss = !this.cmtLookupAndInsert(req.lpa)
        if (req.cmtMiss) {
          req.state = 'ftl_map'
          req.stateT = 0
          // Mapping read ≈ one page read through the same channel machinery.
          req.stateDur = this.flashReadDuration()
        } else {
          this.beginDataAccess(req)
        }
        break
      case 'ftl_map':
        this.cmtInstall(req.lpa)
        this.state.cmt.inFlightMisses = Math.max(0, this.state.cmt.inFlightMisses - 1)
        this.beginDataAccess(req)
        break
      case 'cache_access':
        this.beginDataAccess(req)
        break
      case 'flash_read':
        req.state = 'onfi_xfer'
        req.stateT = 0
        req.stateDur = this.onfiXferSec(req.bytes)
        break
      case 'onfi_xfer':
        req.state = 'pcie_data'
        req.stateT = 0
        req.stateDur = Math.max(1e-6, req.bytes / PCIE_BYTES_PER_SEC)
        break
      case 'pcie_data':
        this.completeRequest(req)
        this.deviceQueue.splice(index, 1)
        break
      default:
        break
    }
  }

  private beginDataAccess(req: IoRequestSim): void {
    // Write-cache probe (variable latency); reads only in READ_CACHE modes.
    const cacheCachesReads =
      this.knobs.readCacheMode === 'WRITE_READ_CACHE' || this.knobs.readCacheMode === 'READ_CACHE'
    const cached = req.read ? cacheCachesReads : true
    const cacheHit = cached && this.writeCacheLookup(req)
    if (cacheHit) {
      // Skip flash entirely: the cache absorbs it. Completion still pays PCIe.
      req.state = 'pcie_data'
      req.stateT = 0
      req.stateDur = Math.max(1e-6, req.bytes / PCIE_BYTES_PER_SEC)
      this.state.writeCache.hits++
      this.finishFlowAccounting(req)
      return
    }
    this.state.writeCache.misses++
    if (req.read) {
      req.state = 'flash_read'
    } else {
      // Writes are absorbed by the cache first; they destage later.
      this.absorbWrite(req)
      req.state = 'pcie_data'
    }
    req.stateT = 0
    req.stateDur = req.state === 'flash_read' ? this.flashReadDuration() : Math.max(1e-6, req.bytes / PCIE_BYTES_PER_SEC)
  }

  /* ---- CMT -------------------------------------------------------------*/

  /**
   * Direct-mapped CMT: a fixed slot array addressed by `lpa % capacity`.
   * A miss installs into its bucket unconditionally — the eviction that
   * teaches the inter-flow interference lesson — and every operation is
   * O(1). The previous grow-and-shift list made each lookup O(capacity),
   * which froze the engine once the knob reached its MiB-scale default.
   */
  private ensureCmtSlots(capacity: number): void {
    if (this.cmtSlots.length === capacity) return
    this.cmtSlots = new Array(capacity)
    for (let i = 0; i < capacity; i++) this.cmtSlots[i] = { lpa: -1, valid: false, lru: 0 }
  }

  private cmtLookup(lpa: number): boolean {
    const capacity = this.cmtCapacityEntries()
    if (capacity <= 0) return false
    const entry = this.cmtSlots[lpa % capacity]
    if (entry !== undefined && entry.valid && entry.lpa === lpa) {
      this.state.cmt.hits++
      entry.lru = this.simT
      return true
    }
    this.state.cmt.misses++
    this.state.cmt.inFlightMisses++
    return false
  }

  private cmtSlots: { lpa: number; valid: boolean; lru: number }[] = []

  private cmtCapacityEntries(): number {
    // One entry ≈ 8 bytes of DRAM (lpa + ppn), teaching scale.
    return clamp(Math.floor((this.knobs.cmtCapacityMiB * 1024 * 1024) / 8), 16, 1 << 20)
  }

  private cmtInstall(lpa: number): void {
    const capacity = this.cmtCapacityEntries()
    this.ensureCmtSlots(capacity)
    const slot = this.cmtSlots[lpa % capacity]
    slot.lpa = lpa
    slot.valid = true
    slot.lru = this.simT
  }

  private cmtLookupAndInsert(lpa: number): boolean {
    const hit = this.cmtLookup(lpa)
    this.cmtInstall(lpa)
    const total = this.state.cmt.hits + this.state.cmt.misses
    this.state.cmt.hitRatio = total > 0 ? this.state.cmt.hits / total : 1
    return hit
  }

  /* ---- flash ------------------------------------------------------------*/

  private flashReadDuration(): number {
    return REAL_READ_SEC * (1 + (this.rng() - 0.5) * 0.08)
  }

  private onfiXferSec(bytes: number): number {
    return Math.max(1e-6, (bytes / (333e6 * 2)) * FLASH_LATENCY_STRETCH)
  }

  /* ---- write cache ------------------------------------------------------*/

  private absorbWrite(req: IoRequestSim): void {
    const capacity = this.state.writeCache.capacityBytes
    // LRU eviction with page-granular destaging: overfull evicts oldest
    // dirty pages to flash, which is exactly the thrash loop the paper shows.
    if (this.state.writeCache.usedBytes + req.bytes > capacity) {
      const over = this.state.writeCache.usedBytes + req.bytes - capacity
      this.destage(Math.min(over, this.state.writeCache.dirtyBytes))
    }
    this.state.writeCache.usedBytes = Math.min(capacity, this.state.writeCache.usedBytes + req.bytes)
    this.state.writeCache.dirtyBytes += req.bytes
    this.cmtInstall(req.lpa)
  }

  private tickWriteCache(dt: number): void {
    // Idle destage drain: the controller cleans dirty cache lines in the
    // background at the channel's write bandwidth share.
    const rate = 24 * 1024 * 1024 // 24 MiB/s modelled destage rate
    const drained = Math.min(this.state.writeCache.dirtyBytes, rate * dt)
    this.state.writeCache.dirtyBytes -= drained
    this.state.writeCache.usedBytes -= drained
    this.state.writeCache.destageBytesPerSec = rate
  }

  /* ------------------------------------------------------------------------
   * Device queues and shared clock.
   * ----------------------------------------------------------------------*/

  /** Requests currently in device service, in fetch order. */
  private readonly deviceQueue: IoRequestSim[] = []
  /** Monotone model time, advanced by update(). */
  private simT = 0

  /* ------------------------------------------------------------------------
   * Request construction and completion.
   * ----------------------------------------------------------------------*/

  private makeRequest(flow: number): IoRequestSim {
    const write = this.rng() < this.knobs.writeRatio
    const lpa = this.nextLpa(this.knobs.randomShare)
    const block = this.lpaToSampledBlock(lpa)
    const b = this.state.blocks[block]
    const bytes = Math.max(512, Math.round(this.knobs.requestSizeKiB * 1024))
    const priorities: NvmePriorityClass[] = ['MEDIUM', 'HIGH', 'URGENT', 'LOW']
    return {
      id: this.nextRequestId++,
      flow: flow & 0xffff,
      read: !write,
      lpa: lpa | 0,
      channel: b.channel,
      chip: b.chip,
      die: b.die,
      plane: b.plane,
      page: 0,
      state: 'pcie_cmd',
      stateT: 0,
      // PCIe command hop: small TLP, latency dominated by serialization.
      stateDur: Math.max(1e-6, 128 / PCIE_BYTES_PER_SEC),
      cmtMiss: false,
      bytes: clamp(this.knobs.requestSizeKiB * 1024, 512, FLASH_PAGE_BYTES),
      priority: priorities[(this.rng() * 4) | 0],
    }
  }

  private completeRequest(req: IoRequestSim): void {
    const flow = this.state.flows[req.flow]
    if (flow) {
      flow.inFlight = Math.max(0, flow.inFlight - 1)
      if (req.read) flow.reads++
      else flow.writes++
      flow.bytes += req.bytes
      flow.latencyMs = flow.latencyMs * 0.8 + req.stateT * 0.2
      flow.lastRequest = req
    }
  }

  private finishFlowAccounting(req: IoRequestSim): void {
    const flow = this.state.flows[req.flow]
    if (flow) {
      flow.inFlight = Math.max(0, flow.inFlight - 1)
      flow.activity = Math.min(1, flow.activity + 0.2)
    }
  }

  private writeCacheLookup(req: IoRequestSim): boolean {
    // Teaching-scale cache: hits track the hot-band share of the LPA mix.
    const hot = req.lpa < HOT_LPA_SPAN
    return hot && this.rng() < 0.72
  }

  private destage(bytes: number): void {
    this.state.writeCache.dirtyBytes = Math.max(0, this.state.writeCache.dirtyBytes - bytes)
    this.state.writeCache.usedBytes = Math.max(0, this.state.writeCache.usedBytes - bytes)
  }

  /* ---- GC ---------------------------------------------------------------*/

  private tickGc(dt: number): void {
    const gc = this.state.gc
    const threshold = Math.max(0.01, this.knobs.gcExecThreshold)
    if (gc.phase === 'idle' && this.state.freePageRatio < this.knobs.gcExecThreshold) {
      gc.phase = 'victim_selection'
      gc.progress = 0
      this.pickVictim()
    }
    if (gc.phase === 'idle') return

    // Preemptible GC suspends for pending reads (paper §4.2.3, [87]).
    gc.preemptible = this.knobs.preemptibleGc
    const pendingReads = this.deviceQueue.some((r) => r.read && r.state === 'pcie_cmd')
    if (
      gc.preemptible
      && gc.phase === 'erase'
      && pendingReads
      && !gc.suspendedForRead
    ) {
      gc.suspendedForRead = true
      gc.suspensions++
    }

    switch (gc.phase) {
      case 'victim_selection':
        gc.progress = clamp01(gc.progress + dt / 0.05)
        if (gc.progress >= 1) {
          gc.phase = 'valid_copy'
          gc.progress = 0
        }
        break
      case 'valid_copy': {
        const perSec = 64 / REAL_PROGRAM_SEC
        gc.pagesCopied = Math.min(gc.pagesToCopy, gc.pagesCopied + perSec * dt)
        gc.progress = gc.pagesToCopy > 0 ? gc.pagesCopied / gc.pagesToCopy : 1
        if (gc.pagesCopied >= gc.pagesToCopy) {
          gc.phase = 'erase'
          gc.progress = 0
          this.eraseT = 0
        }
        break
      }
      case 'erase': {
        if (gc.suspendedForRead && this.state.freePageRatio > this.knobs.gcHardThreshold + 0.02) {
          gc.suspendedForRead = false
          gc.suspensions++
        }
        if (!gc.suspendedForRead) {
          this.eraseT += dt
          gc.progress = clamp01(this.eraseT / REAL_ERASE_SEC)
          if (gc.progress >= 1) {
            this.completeErase()
            gc.phase = 'merge'
            gc.progress = 0
          }
        }
        break
      }
      case 'merge':
        gc.progress = clamp01(gc.progress + dt / 0.05)
        if (gc.progress >= 1) {
          gc.phase = 'idle'
          gc.progress = 0
          gc.pagesToCopy = 0
          gc.pagesCopied = 0
        }
        break
    }
  }

  private eraseT = 0

  private pickVictim(): void {
    // Greedy victim selection over the sampled estate (MQSim GREEDY policy).
    const blocks = this.state.blocks
    let best = -1
    let bestValid = Number.POSITIVE_INFINITY
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (!b.inUse) continue
      if (b.valid < bestValid) {
        bestValid = b.valid
        best = i
        if (b.valid === 0) break
      }
    }
    if (best < 0) return
    const victim = blocks[best]
    const gc = this.state.gc
    gc.victimChannel = victim.channel
    gc.victimChip = victim.chip
    gc.victimDie = victim.die
    gc.victimPlane = victim.plane
    gc.victimBlock = victim.block
    gc.pagesToCopy = victim.valid
    gc.pagesCopied = 0
  }

  private completeErase(): void {
    const gc = this.state.gc
    const idx = this.blockIndex(gc.victimChannel, gc.victimChip, gc.victimDie, gc.victimPlane, gc.victimBlock)
    const block = this.state.blocks[idx]
    if (block) {
      block.valid = 0
      block.invalid = 0
      block.inUse = false
      block.eraseCount++
      block.writeCursor = 0
    }
    gc.erasesCompleted++
    this.recomputeFreeRatio()
  }
}
