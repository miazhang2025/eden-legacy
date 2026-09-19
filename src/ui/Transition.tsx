import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { create } from 'zustand'
import { getGlobalCfg, useGlobalCfg } from '../state/useConfigStore'

interface TransitionState {
  /** 遮罩是否盖住画面 */
  covered: boolean
  busy: boolean
  navigate: ((path: string) => void) | null
  go(path: string): void
  reveal(): void
}

// 首次加载时遮罩是盖着的，由目标页面在就绪后调用 reveal()
export const useTransition = create<TransitionState>()((set, get) => ({
  covered: true,
  busy: false,
  navigate: null,
  go: (path) => {
    const { busy, navigate } = get()
    if (busy || !navigate) return
    set({ covered: true, busy: true })
    window.setTimeout(() => navigate(path), getGlobalCfg().transition.fadeOut * 1000)
  },
  reveal: () => set({ covered: false, busy: false }),
}))

/** 2D 页面挂载即 reveal；3D 页面在 Canvas 内容就绪后调用 */
export function useRevealOnMount() {
  useEffect(() => {
    // 下一帧再 reveal，确保新页面已绘制
    const id = requestAnimationFrame(() => useTransition.getState().reveal())
    return () => cancelAnimationFrame(id)
  }, [])
}

/** 全屏 fade 遮罩，挂在 Router 内 */
export function Transition() {
  const navigate = useNavigate()
  const covered = useTransition((s) => s.covered)
  const cfg = useGlobalCfg((c) => c.transition)

  useEffect(() => {
    useTransition.setState({ navigate })
  }, [navigate])

  return (
    <div
      className="transition-overlay"
      style={{
        background: cfg.color,
        opacity: covered ? 1 : 0,
        transitionDuration: `${covered ? cfg.fadeOut : cfg.fadeIn}s`,
        pointerEvents: covered ? 'auto' : 'none',
      }}
    />
  )
}
