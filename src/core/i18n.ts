/* ============================================================================
 * SSDSimCity — RUNTIME LANGUAGE SWITCH
 *
 * English and Chinese (Simplified) share one key space. The dictionary covers
 * the teaching chrome: HUD vitals, scenario names, tour chapter titles, boot
 * copy, destination names, and the lesson headings. Long-form prose (scenario
 * beats, inspector docs) renders paired values through `pick()` where the
 * surface is bilingual; surfaces that have not migrated keep their English
 * literal and are untouched by this module.
 *
 * The language persists under the ssdsimcity.* storage convention. Rendering
 * modules read `currentLang()` each frame (the same per-frame discipline as
 * COLOR), so a switch re-labels live surfaces without a reload.
 * ==========================================================================*/

export type Lang = 'en' | 'zh'

export const LANG_STORAGE_KEY = 'ssdsimcity.lang'

type Dict = Record<string, string>

/** English is the source of truth: `t()` falls back to en, then to the key. */
const EN: Dict = {
  // HUD vitals
  'vital.iops': 'IOPS',
  'vital.latency': 'Latency',
  'vital.flashWrite': 'Flash writes',
  'vital.cacheDirty': 'Dirty cache',
  'vital.flowSkew': 'Flow skew',
  'vital.iops.hint':
    'Device requests completed per second over the trailing 5 model seconds. Falls below the offered rate when the controller or GC is saturated.',
  'vital.latency.hint':
    'Weighted end-to-end response-time quantiles over the rolling model window. Click for independent p99 component quantiles.',
  'vital.flashWrite.hint':
    'Bytes per second crossing the cache→flash destage boundary. Host writes are absorbed by the cache long before this moves — watch it during a GC cycle.',
  'vital.cacheDirty.hint':
    'Device DRAM cache lines holding writes not yet destaged to NAND. A full dirty pool forces evictions to do their own destaging first.',
  'vital.flowSkew.hint':
    'The slowest active flow’s mean latency versus the fleet’s. A rising skew is inter-flow interference: cache thrash, CMT eviction or GC sharing a die.',
  // health
  'health.ok': 'Nothing dramatic is happening',
  'health.warn': 'Device pressure is elevated',
  'health.gc': 'Garbage collection is running — user I/O shares the die with it',
  'health.gcEmpty': 'Free-page pool is nearly empty mid-GC — the device cannot allocate fresh pages',
  'health.thrash': 'The write cache is full and thrashing — every eviction pays a flash write',
  'health.hitLow': 'Write-cache hit ratio low — the working set outruns the cache',
  'health.freeLow': 'Free-page pool is low — GC will trigger soon',
  'health.skew': 'One flow’s latency is far above the fleet’s — inter-flow interference',
  // scenarios (names the chips render)
  'scenario.steady-state': 'Steady state',
  'scenario.work-mem-spill': 'The work_mem cliff',
  'scenario.checkpoint-storm': 'GC storm',
  'scenario.cache-thrash': 'Cache thrash',
  'scenario.bloat-and-vacuum': 'Bloat and vacuum',
  'scenario.xmin-horizon': 'The xmin horizon',
  'scenario.lock-pileup': 'Lock pile-up',
  'scenario.replication-lag': 'Replication lag',
  'scenario.wal-flood': 'The commit trade-off',
  'scenario.index-vs-seqscan': 'Index scan vs seq scan',
  'scenario.no-bgwriter': 'Without the bgwriter',
  'scenario.connection-storm': 'Pool a connection storm',
  'scenario.logical-replication': 'Logical decoding',
  'scenario.full-page-writes': 'Full-page writes',
  'scenario.slot-pressure': 'Slot pressure',
  'scenario.vacuum-blockade': 'Write-cache blockade',
  'scenario.failover-candidate': 'Choose the candidate',
  // destinations
  'dest.clients': 'Host clients',
  'dest.backends': 'Flow towers (SQ/CQ pairs)',
  'dest.shmem': 'Device DRAM data cache',
  'dest.wal': 'Write path (destage)',
  'dest.storage': 'NAND array',
  'dest.planner': 'FTL lab',
  'dest.maintenance': 'Garbage collection',
  'dest.replication': 'Multi-queue fairness',
  // tour chapter titles
  'tour.connect': 'A request is submitted',
  'tour.backend': 'One queue pair per flow',
  'tour.plan': 'The FTL translates the address',
  'tour.buffers': 'The DRAM data cache',
  'tour.page': 'What a NAND block actually is',
  'tour.wal': 'Writes land in the cache, then destage',
  'tour.commit': 'Completion is a queue position, not a write',
  'tour.checkpoint': 'Garbage collection begins',
  'tour.mvcc': 'Preemption: reads interrupt erases',
  'tour.vacuum': 'The CMT is the second bottleneck',
  'tour.horizon': 'When the write cache turns hostile',
  'tour.stream': 'Two flows, one device',
  'tour.lag': 'QueueFetchSize and fairness',
  'tour.city': 'The whole city again',
  'tour.eyebrow': 'Guided tour',
  // boot
  'boot.sub': 'A working model of a modern multi-queue SSD',
  'boot.honesty':
    'Early, reviewed prototype. Reviews have found and fixed inaccuracies in both the model and explanations. Found one?',
  'boot.report': 'Report a problem with an SSD claim on GitHub',
  'boot.loading': 'loading the city code…',
  // lesson
  'lesson.title': 'The device is busy. Why is the write cache still thrashing?',
  'lesson.causes': 'What is preventing the cache from recovering?',
  'lesson.cause.disabled': 'Destage is switched off',
  'lesson.cause.snapshot': 'A stale CMT mapping still pins the cache lines',
  'lesson.cause.capacity': 'The device only needs more overprovisioning',
  'lesson.intervene': 'Choose an intervention',
  'lesson.drain': 'Drain the deep-queue writer',
  'lesson.wait': 'Keep the flow running',
  // chrome
  'ui.lang': '中文',
  'ui.lang.aria': '切换到中文',
  'ui.paused': 'Paused',
  'ui.running': 'Running',
}

const ZH: Dict = {
  // HUD vitals
  'vital.iops': 'IOPS',
  'vital.latency': '延迟',
  'vital.flashWrite': '闪存写入',
  'vital.cacheDirty': '缓存脏行',
  'vital.flowSkew': '流间偏斜',
  'vital.iops.hint':
    '最近 5 个模型秒内设备每秒完成的请求数。控制器或垃圾回收饱和时会低于灌入速率。',
  'vital.latency.hint':
    '滚动模型窗口内的加权端到端响应时间分位数。点击可查看各组件独立的 p99 分位数。',
  'vital.flashWrite.hint':
    '每秒跨过缓存→闪存落盘(destage)边界的字节数。主机写入早已被缓存吸收,要等这里才动——观察一次 GC 周期。',
  'vital.cacheDirty.hint':
    '设备 DRAM 缓存中尚未写入 NAND 的脏行。脏池一满,逐出必须先自行落盘。',
  'vital.flowSkew.hint':
    '最慢活跃流的平均延迟相对全体的倍数。偏斜上升即流间干扰:缓存颠簸、CMT 驱逐或 GC 共享 die。',
  // health
  'health.ok': '一切平静',
  'health.warn': '设备压力升高',
  'health.gc': '垃圾回收进行中——用户 I/O 与它共享同一颗 die',
  'health.gcEmpty': '空闲页池在回收中途接近耗尽——设备无法分配新页',
  'health.thrash': '写缓存已满且在颠簸——每次逐出都要付出一次闪存写',
  'health.hitLow': '写缓存命中率偏低——工作集超出了缓存容量',
  'health.freeLow': '空闲页池偏低——垃圾回收即将触发',
  'health.skew': '某条流的延迟远高于整体——流间干扰',
  // scenarios
  'scenario.steady-state': '稳态运行',
  'scenario.work-mem-spill': 'work_mem 悬崖',
  'scenario.checkpoint-storm': 'GC 风暴',
  'scenario.cache-thrash': '缓存颠簸',
  'scenario.bloat-and-vacuum': '膨胀与回收',
  'scenario.xmin-horizon': 'xmin 视界',
  'scenario.lock-pileup': '锁堆积',
  'scenario.replication-lag': '复制延迟',
  'scenario.wal-flood': '提交的代价',
  'scenario.index-vs-seqscan': '索引扫描 vs 顺序扫描',
  'scenario.no-bgwriter': '没有后台写进程',
  'scenario.connection-storm': '连接风暴入池',
  'scenario.logical-replication': '逻辑解码',
  'scenario.full-page-writes': '全页写',
  'scenario.slot-pressure': '复制槽压力',
  'scenario.vacuum-blockade': '写缓存封锁',
  'scenario.failover-candidate': '选择候选者',
  // destinations
  'dest.clients': '主机客户端',
  'dest.backends': '流塔(SQ/CQ 队列对)',
  'dest.shmem': '设备 DRAM 数据缓存',
  'dest.wal': '写路径(落盘)',
  'dest.storage': 'NAND 阵列',
  'dest.planner': 'FTL 实验室',
  'dest.maintenance': '垃圾回收',
  'dest.replication': '多队列公平性',
  // tour chapter titles
  'tour.connect': '一条请求的提交',
  'tour.backend': '每流一对队列',
  'tour.plan': 'FTL 翻译地址',
  'tour.buffers': 'DRAM 数据缓存',
  'tour.page': 'NAND 块的真面目',
  'tour.wal': '先落缓存,再落盘',
  'tour.commit': '完成是队列位置,不是写入',
  'tour.checkpoint': '垃圾回收开始',
  'tour.mvcc': '抢占:读打断擦除',
  'tour.vacuum': 'CMT 是第二瓶颈',
  'tour.horizon': '当写缓存变得危险',
  'tour.stream': '两条流,一颗设备',
  'tour.lag': 'QueueFetchSize 与公平性',
  'tour.city': '重返全城',
  'tour.eyebrow': '引导巡览',
  // boot
  'boot.sub': '现代多队列 SSD 的可运行模型',
  'boot.honesty': '早期原型,已经评审。模型与解释中的不准确处均已修订。发现问题?',
  'boot.report': '在 GitHub 上报告 SSD 断言问题',
  'boot.loading': '正在载入城市…',
  // lesson
  'lesson.title': '设备很忙。写缓存为什么还在颠簸?',
  'lesson.causes': '是什么妨碍缓存恢复?',
  'lesson.cause.disabled': '落盘(destage)被关闭了',
  'lesson.cause.snapshot': '过期的 CMT 映射仍钉住缓存行',
  'lesson.cause.capacity': '设备需要的是更多预留空间(overprovisioning)',
  'lesson.intervene': '选择干预手段',
  'lesson.drain': '清空深队列写流',
  'lesson.wait': '让该流继续运行',
  // chrome
  'ui.lang': 'English',
  'ui.lang.aria': 'Switch to English',
  'ui.paused': '已暂停',
  'ui.running': '运行中',
}

const DICTS: Record<Lang, Dict> = { en: EN, zh: ZH }

let current: Lang = 'en'

function readStored(): Lang {
  try {
    const v = window.localStorage.getItem(LANG_STORAGE_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {
    /* storage unavailable — default stands */
  }
  return 'en'
}

/** Translate a key; unknown keys fall back to the English entry, then the key. */
export function t(key: string): string {
  return DICTS[current][key] ?? EN[key] ?? key
}

/**
 * Pick between paired prose values. Surfaces that carry long-form bilingual
 * copy (scenario blurbs, tour bodies) pass `{ en, zh }` and this resolves by
 * the live language without a dictionary round-trip.
 */
export function pick(pair: { en: string; zh: string }): string {
  return current === 'zh' ? pair.zh : pair.en
}

export function currentLang(): Lang {
  return current
}

export function isZh(): boolean {
  return current === 'zh'
}

export function setLang(lang: Lang): void {
  if (lang === current) return
  current = lang
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang)
  } catch {
    /* storage unavailable — session-only switch */
  }
  applyDocumentLang()
}

function applyDocumentLang(): void {
  try {
    document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en'
  } catch { /* non-DOM contexts (tests) */ }
}

/** Initialise from storage, then browser preference, at boot. */
export function initLang(): Lang {
  current = readStored()
  if (!readStored()) {
    try {
      if ((navigator.language ?? '').startsWith('zh')) current = 'zh'
    } catch { /* keep default */ }
  }
  applyDocumentLang()
  return current
}
