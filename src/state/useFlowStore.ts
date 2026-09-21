import { create } from 'zustand'

// §6.3 四选一流程状态机：IDLE → PROMPTED → INSPECTING(assetId) → CONFIRMED(assetId) → RESOLVED → EXIT
export type FlowPhase = 'IDLE' | 'PROMPTED' | 'INSPECTING' | 'CONFIRMED' | 'RESOLVED' | 'EXIT'

interface FlowState {
  phase: FlowPhase
  /** INSPECTING / CONFIRMED 时的资产 */
  assetId: string | null
  /** CONFIRMED 的时刻（performance.now() 秒），供动画计算进度 */
  confirmedAt: number
  reset(): void
  enterZone(): void
  inspect(id: string): void
  uninspect(): void
  confirm(id: string): boolean
  resolve(): void
  exit(): void
}

export const nowSec = () => performance.now() / 1000

export const useFlowStore = create<FlowState>()((set, get) => ({
  phase: 'IDLE',
  assetId: null,
  confirmedAt: 0,
  reset: () => set({ phase: 'IDLE', assetId: null, confirmedAt: 0 }),
  enterZone: () => {
    if (get().phase === 'IDLE') set({ phase: 'PROMPTED' })
  },
  inspect: (id) => {
    const { phase, assetId } = get()
    if ((phase === 'PROMPTED' || phase === 'INSPECTING') && assetId !== id)
      set({ phase: 'INSPECTING', assetId: id })
  },
  uninspect: () => {
    if (get().phase === 'INSPECTING') set({ phase: 'PROMPTED', assetId: null })
  },
  confirm: (id) => {
    const { phase, assetId } = get()
    // 一个场景只能采集一次；只能收藏 proximity 内（即正在 INSPECTING）的资产
    if (phase !== 'INSPECTING' || assetId !== id) return false
    set({ phase: 'CONFIRMED', assetId: id, confirmedAt: nowSec() })
    return true
  },
  resolve: () => {
    if (get().phase === 'CONFIRMED') set({ phase: 'RESOLVED' })
  },
  exit: () => set({ phase: 'EXIT' }),
}))

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__flowStore = useFlowStore
