import { useEffect } from 'react'
import { useThree, type RootState } from '@react-three/fiber'

// 当前页面的 r3f 画布（截图、性能监视用）。每页同时只有一个 Canvas。
let active: Pick<RootState, 'gl' | 'scene' | 'camera'> | null = null

export const getActiveCanvas = () => active

/** 放在 Canvas 内：挂载时登记为当前画布 */
export function RegisterCanvas() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    const entry = { gl, scene, camera }
    active = entry
    return () => {
      if (active === entry) active = null
    }
  }, [gl, scene, camera])
  return null
}

/** 用当前相机重新渲染一帧并截成 PNG（渲染后同步读取，不依赖 preserveDrawingBuffer） */
export function captureActiveCanvas(): string | null {
  if (!active) return null
  active.gl.render(active.scene, active.camera)
  return active.gl.domElement.toDataURL('image/png')
}

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__canvas = getActiveCanvas
