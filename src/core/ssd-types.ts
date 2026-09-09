/* ============================================================================
 * SSDSimCity — SSD-domain shared contracts.
 *
 * The device model follows the MQSim FAST 2018 paper (Tavakkol et al.) at
 * teaching scale:
 *
 *   Host interface   NVMe multi-queue; per-flow SQ/CQ pairs; QueueFetchSize
 *                    caps how many entries of ONE submission queue the device
 *                    fetches concurrently (paper §4.2.1).
 *   Front end        DRAM data cache (LRU write cache), cached mapping table
 *                    (CMT) for the page-level FTL, per-flow sharing modes.
 *   Back end         Flash channels × chips × dies × planes; one-die transaction
 *                    scheduling; preemptible GC with suspend/resume.
 *   Steady state     Preconditioning fills every physical page valid or invalid
 *                    per the steady-state valid/invalid distribution; only a
 *                    small free-block pool remains (paper §4.4).
 *
 * Every count here is a TEACHING SAMPLE, like SSDSimCity's 1,024-frame buffer
 * plaza: the real device is orders of magnitude larger, and the world modules
 * render one representative object per modelled unit.
 * ==========================================================================*/

/** NAND page data bytes per physical page (MQSim default 8 KiB, like a PG block). */
export const FLASH_PAGE_BYTES = 8 * 1024

/** Visible channel count in the city (MQSim config default: 8). */
export const N_CHANNELS = 8
/** Chips per channel (MQSim Table 3: 4). */
export const N_CHIPS_PER_CHANNEL = 4
/** Dies per chip. */
export const N_DIES_PER_CHIP = 2
/** Planes per die. */
export const N_PLANES_PER_DIE = 2
/** Blocks per plane — sampled; the city renders the first BLOCK_SAMPLE blocks. */
export const N_BLOCKS_PER_PLANE = 128
/** Pages per block (MQSim Table 3: 256). */
export const N_PAGES_PER_BLOCK = 64
/** How many physical blocks one die renders in the excavation (sampled). */
export const BLOCK_SAMPLE_PER_PLANE = 32

/** Total physical pages across the sampled estate, for occupancy math. */
export const SAMPLE_PHYSICAL_PAGES =
  N_CHANNELS * N_CHIPS_PER_CHANNEL * N_DIES_PER_CHIP * N_PLANES_PER_DIE * BLOCK_SAMPLE_PER_PLANE



/** One NVMe priority class (URGENT/HIGH/MEDIUM/LOW per the NVMe spec). */
export type NvmePriorityClass = 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW'

/** How the device DRAM cache treats reads vs writes for one flow. */
export type DeviceCachingMode = 'WRITE_CACHE' | 'READ_CACHE' | 'WRITE_READ_CACHE' | 'TURNED_OFF'

/** FTL address mapping family (paper §4.2.3). */
export type AddressMapping = 'PAGE_LEVEL' | 'HYBRID'

/** GC victim-block selection policies MQSim implements. */
export type GcPolicy = 'GREEDY' | 'RGA' | 'RANDOM' | 'FIFO'

/** Backend transaction scheduling policy. */
export type SchedulingPolicy = 'OUT_OF_ORDER' | 'PRIORITY_OUT_OF_ORDER'

/** Suspend/erase support level of the modelled NAND die. */
export type CommandSuspension = 'NONE' | 'PROGRAM' | 'PROGRAM_ERASE' | 'ERASE'

/** NAND cell technology. */
export type FlashTechnology = 'SLC' | 'MLC' | 'TLC'

/** A host I/O request travelling the full end-to-end path (paper Figure 4). */
export type IoRequestState =
  | 'enqueued'      // 1: parked in the submission queue
  | 'pcie_cmd'      // 2: command TLP over PCIe
  | 'ftl_map'       // 3: FTL address translation — CMT hit or miss
  | 'cache_access'  //   write/read cache probe (variable latency)
  | 'flash_read'    // 4/5: address + command transfer, cell read
  | 'onfi_xfer'     // 6: NV-DDR2 data transfer over the channel
  | 'pcie_data'     // 7: completion data path back to host
  | 'done'

/** What one device-side request is doing, in one place, at one time. */
export interface IoRequestSim {
  id: number
  /** Which submission queue (city: which backend tower) issued it. */
  flow: number
  read: boolean
  /** Logical page address. */
  lpa: number
  /** Translated physical page address, valid once mapped. */
  channel: number
  chip: number
  die: number
  plane: number
  page: number
  state: IoRequestState
  stateT: number
  /** Expected model seconds for the current state. */
  stateDur: number
  /** CMT miss adds a mapping-read round trip before the data access. */
  cmtMiss: boolean
  /** Byte count transferred (sector-granular reads, page-granular writes). */
  bytes: number
  priority: NvmePriorityClass
}


/* ---------------------------------------------------------------------------
 * FTL state — one page-level mapping, one hybrid log, one GC engine.
 * -------------------------------------------------------------------------*/

export interface CmtEntry {
  lpa: number
  /** Physical block index inside the sampled space. */
  ppn: number
  lastTouch: number
}

export interface CachedMappingTable {
  /** LRU slots; index is recency order 0 = most recent. */
  lpa: Int32Array
  ppn: Int32Array
  /** LRU clock position. */
  hand: number
  capacity: number
  hits: number
  misses: number
  hitRatio: number
  /** Mapping reads currently servicing a CMT miss, per flow. */
  inFlightMisses: number
}

export interface FlashBlock {
  channel: number
  chip: number
  die: number
  plane: number
  block: number
  /** Valid logical pages residing here. */
  valid: number
  /** Invalid (stale) pages awaiting erase. */
  invalid: number
  /** Erase-cycle count for wear-leveling and the heat shader. */
  eraseCount: number
  /** Current write cursor within an active (partially written) block. */
  writeCursor: number
  /** true once this block holds data and is not in the free list. */
  inUse: boolean
  /** GC marked this block for collection on the next victim sweep. */
  gcCandidate: boolean
}

export type GcPhase =
  | 'idle'
  | 'victim_selection'
  | 'valid_copy'
  | 'erase'
  | 'merge'

export interface GcState {
  phase: GcPhase
  /** 0..1 through the current phase. */
  progress: number
  /** Block currently being cleaned, expressed in sample-space indices. */
  victimChannel: number
  victimChip: number
  victimDie: number
  victimPlane: number
  victimBlock: number
  /** Pages that had to be copied before the erase could run. */
  pagesToCopy: number
  pagesCopied: number
  /** How many erase operations have completed since reset. */
  erasesCompleted: number
  /** True while this GC cycle is preemptible (suspend-able for reads). */
  preemptible: boolean
  /** True while suspended in favor of a user read. */
  suspendedForRead: boolean
  /** Cycles of suspend/resume seen in the current erase, for the HUD. */
  suspensions: number
  /** Free-page pool fill 0..1; the GC trigger watches this. */
  freePageRatio: number
}

/* ---------------------------------------------------------------------------
 * NAND timing — MQSim's three flash-latency components (paper §4.1).
 * Values are the FAST'18 Table 3 device, stretched ~100× like SSDSimCity's
 * backend lifecycle stretch, so a 75 µs read renders at observable pace.
 * Rates and queues are NOT stretched.
 * -------------------------------------------------------------------------*/

export interface FlashTiming {
  readLatencyUs: number
  programLatencyUs: number
  eraseLatencyUs: number
  channelTransferMtps: number
}

/** Host interface state — the NVMe front door. */
export interface HostInterfaceState {
  /** Total submission queue depth across flows (city: 16 slot pairs). */
  queueDepth: number
  /** QueueFetchSize: max in-flight entries fetched per SQ (paper §4.2.1). */
  queueFetchSize: number
  /** Commands currently in flight device-side. */
  inFlight: number
  /** PCIe gen3 x4 style link, modelled as bytes/sec. */
  pcieBytesPerSec: number
}

/** Per-flow (per submission queue) live counters. */
export interface IoFlowSim {
  slot: number
  active: boolean
  /** Submission queue fill, 0..queueDepth. */
  sqDepth: number
  /** Entries this flow has in device service right now (≤ queueFetchSize). */
  inFlight: number
  /** Cumulative completed reads/writes. */
  reads: number
  writes: number
  /** Bytes transferred. */
  bytes: number
  /** Rolling mean end-to-end latency in stretched model ms. */
  latencyMs: number
  /** 0..1 heat for the tower shader. */
  activity: number
  /** Last request served, for the flow particle. */
  lastRequest: IoRequestSim | null
}

/* ---------------------------------------------------------------------------
 * Device-wide runtime state the whole city renders.
 * -------------------------------------------------------------------------*/

export interface SsdDeviceState {
  hostInterface: HostInterfaceState
  /** One flow per city backend slot. */
  flows: IoFlowSim[]
  /** Device DRAM data cache (write cache), LRU, shared or partitioned. */
  writeCache: {
    capacityBytes: number
    usedBytes: number
    hits: number
    misses: number
    hitRatio: number
    dirtyBytes: number
    /** Bytes per second crossing the cache→flash destage boundary. */
    destageBytesPerSec: number
  }
  cmt: CachedMappingTable
  gc: GcState
  /** Sampled NAND blocks, one per visible block cell. */
  blocks: FlashBlock[]
  /** Free-page pool level, 0..1 — the GC trigger watches this. */
  freePageRatio: number
  /** Overprovisioning ratio knob echo (0..1). */
  overprovisioning: number
  /** Steady-state occupancy the preconditioner installed. */
  preconditioned: boolean
  /** Inter-flow fairness ledger: per-flow slowdown vs alone. */
  fairness: {
    flowSlowdown: number[]
    fairness: number
  }
}

/** Derived helper: total logical pages of the sampled space. */
export function sampledLogicalPages(): number {
  return SAMPLE_PHYSICAL_PAGES
}
