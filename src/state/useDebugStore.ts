import { create } from 'zustand'

// 调试开关（仅 look dev 面板在 DEV 下写入；不属于 config，不导出）。生产环境始终为默认值。
interface DebugState {
  /** 自由飞行相机（OrbitControls）替代跟随相机 */
  freeFly: boolean
  /** Ending 模拟组合（category 三元组 id，如 'ore_shell_flower'），null = 用真实选择 */
  simulateCombo: string | null
}

export const useDebugStore = create<DebugState>()(() => ({ freeFly: false, simulateCombo: null }))

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__debugStore = useDebugStore
