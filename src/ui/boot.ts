export interface BootStep {
  pct: number
  label: string
}

function bootLabel(en: string, zh: string): string {
  try {
    const lang = (window.localStorage.getItem('ssdsimcity.lang') ?? 'en')
    return lang === 'zh' ? zh : en
  } catch { return en }
}

export const BOOT_STEPS = {
  renderer: { pct: 8, label: bootLabel('starting the renderer…', '正在启动渲染器…') },
  camera: { pct: 16, label: bootLabel('placing the camera…', '正在安放相机…') },
  simulation: { pct: 24, label: bootLabel('warming up the cluster…', '正在预热设备…') },
  ground: { pct: 32, label: bootLabel('grading the ground…', '正在平整地面…') },
  sharedMemory: { pct: 42, label: bootLabel('pouring the shared memory plaza…', '正在浇筑缓存广场…') },
  backends: { pct: 52, label: bootLabel('forking backends…', '正在架起流塔…') },
  wal: { pct: 62, label: bootLabel('laying the write-ahead log…', '正在铺设写路径…') },
  storage: { pct: 70, label: bootLabel('excavating the data directory…', '正在开挖 NAND 阵列…') },
  maintenance: { pct: 78, label: bootLabel('opening the maintenance yard…', '正在打开 GC 场…') },
  standby: { pct: 85, label: bootLabel('connecting the standby…', '正在连接公平性观测区…') },
  roads: { pct: 90, label: bootLabel('painting the roads…', '正在绘制道路…') },
  console: { pct: 96, label: bootLabel('wiring the console…', '正在接通控制台…') },
  firstFrame: { pct: 100, label: bootLabel('rendering the first frame…', '正在渲染第一帧…') },
} as const satisfies Record<string, BootStep>
export type FrameScheduler = (callback: () => void) => void

/**
 * Resume only after the updated boot state has crossed a paint boundary.
 * Resolving inside one animation frame resumes its microtasks before paint.
 */
export function waitForNextPaint(
  schedule: FrameScheduler = (callback) => requestAnimationFrame(callback),
): Promise<void> {
  return new Promise((resolve) => schedule(() => schedule(resolve)))
}

export interface BootSurface {
  root: HTMLElement | null
  fill: HTMLElement | null
  status: HTMLElement | null
}

export function presentBootStep(
  surface: BootSurface,
  step: BootStep,
  wait: () => Promise<void> = waitForNextPaint,
): Promise<void> {
  if (surface.fill) surface.fill.style.width = `${step.pct}%`
  if (surface.status) surface.status.textContent = step.label
  return wait()
}

export function finishBoot(surface: BootSurface): void {
  if (surface.fill) surface.fill.style.width = '100%'
  if (surface.status) surface.status.textContent = 'ready'
  surface.root?.classList.add('done')
}

export function failBoot(surface: BootSurface, message: string): void {
  if (surface.status) {
    surface.status.textContent = message
    surface.status.style.color = 'var(--c-crit)'
  }
  if (surface.fill) surface.fill.style.background = 'var(--c-crit)'
}
