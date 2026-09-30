import { create } from 'zustand'
import type { Photo } from './ExportPhoto'

// Ending 页的 UI 状态：悬停中的标本（提示框）、是否正在拖拽 / 导出、拍好的照片
interface EndingUiState {
  hoveredId: string | null
  /** 提示框位置（视口像素） */
  x: number
  y: number
  dragging: boolean
  exporting: boolean
  /** 每按一次快门 +1，用来重播闪光动画 */
  shutter: number
  /** 照片卡片当前展示的照片 */
  photo: Photo | null
  hover(id: string | null, x?: number, y?: number): void
  showPhoto(photo: Photo | null): void
}

export const useEndingUi = create<EndingUiState>()((set, get) => ({
  hoveredId: null,
  x: 0,
  y: 0,
  dragging: false,
  exporting: false,
  shutter: 0,
  photo: null,
  hover: (hoveredId, x = 0, y = 0) => set({ hoveredId, x, y }),
  showPhoto: (photo) => {
    const prev = get().photo
    if (prev && prev.url !== photo?.url) URL.revokeObjectURL(prev.url)
    set({ photo })
  },
}))

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__endingUi = useEndingUi
