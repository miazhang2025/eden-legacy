import { useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import type { SceneId } from '../config/schema'
import { useRunStore } from '../state/useRunStore'

// 路由 guard：只在进入路由时判定一次（采集完成后 store 会变，但不应当场重定向，要等 fade 完成）。
// - 前面的场景未完成 → 回到第一个未完成的场景
// - 本场景已完成（如浏览器后退回来）→ 暂定跳到下一个未完成的页面，见 spec §15-F（待定）
export function SceneGuard({ scene, children }: { scene: SceneId; children: ReactNode }) {
  const [redirect] = useState(() => {
    const run = useRunStore.getState()
    const first = run.firstIncomplete()
    return first === scene ? null : run.nextRoute()
  })
  return redirect ? <Navigate to={redirect} replace /> : <>{children}</>
}

export function EndingGuard({ children }: { children: ReactNode }) {
  const [redirect] = useState(() => {
    const run = useRunStore.getState()
    return run.isComplete() ? null : run.nextRoute()
  })
  return redirect ? <Navigate to={redirect} replace /> : <>{children}</>
}
