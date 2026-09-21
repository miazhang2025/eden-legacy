import { create } from 'zustand'

// Ending 页的 UI 状态：悬停中的标本（提示框）、是否正在拖拽 / 导出
interface EndingUiState {
  hoveredId: string | null
  /** 提示框位置（视口像素） */
  x: number
  y: number
  dragging: boolean
  exporting: boolean
  hover(id: string | null, x?: number, y?: number): void
}

export const useEndingUi = create<EndingUiState>()((set) => ({
  hoveredId: null,
  x: 0,
  y: 0,
  dragging: false,
  exporting: false,
  hover: (hoveredId, x = 0, y = 0) => set({ hoveredId, x, y }),
}))

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__endingUi = useEndingUi
