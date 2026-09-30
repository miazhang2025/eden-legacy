import { create } from 'zustand'

// 采集流程状态机：EXPLORING ⇄ INSPECTING(assetId) → CONFIRMED(assetId) → RESOLVED → EXIT
// 资产散落在场景各处，四个都看过（discovered）才能收集；收集后自动跳到下一个场景。
export type FlowPhase = 'EXPLORING' | 'INSPECTING' | 'CONFIRMED' | 'RESOLVED' | 'EXIT'

interface FlowState {
  phase: FlowPhase
  /** INSPECTING / CONFIRMED 时的资产 */
  assetId: string | null
  /** 本场景已靠近看过的资产（按发现顺序） */
  discovered: string[]
  /** 本场景资产总数，由 AssetFlow 在 reset 时写入 */
  total: number
  /** CONFIRMED 的时刻（performance.now() 秒），供动画计算进度 */
  confirmedAt: number
  reset(total: number): void
  inspect(id: string): void
  uninspect(): void
  /** 四个都看过才能收集 */
  canCollect(): boolean
  confirm(id: string): boolean
  resolve(): void
  exit(): void
}

export const nowSec = () => performance.now() / 1000

export const useFlowStore = create<FlowState>()((set, get) => ({
  phase: 'EXPLORING',
  assetId: null,
  discovered: [],
  total: 0,
  confirmedAt: 0,
  reset: (total) => set({ phase: 'EXPLORING', assetId: null, discovered: [], total, confirmedAt: 0 }),
  inspect: (id) => {
    const { phase, assetId, discovered } = get()
    if ((phase === 'EXPLORING' || phase === 'INSPECTING') && assetId !== id)
      set({
        phase: 'INSPECTING',
        assetId: id,
        discovered: discovered.includes(id) ? discovered : [...discovered, id],
      })
  },
  uninspect: () => {
    if (get().phase === 'INSPECTING') set({ phase: 'EXPLORING', assetId: null })
  },
  canCollect: () => {
    const { discovered, total } = get()
    return total > 0 && discovered.length >= total
  },
  confirm: (id) => {
    const { phase, assetId } = get()
    // 一个场景只能采集一次；只能收藏 proximity 内（即正在 INSPECTING）的资产，且需先看完全部
    if (phase !== 'INSPECTING' || assetId !== id || !get().canCollect()) return false
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
