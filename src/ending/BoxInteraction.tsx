import { useEffect, useRef, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MathUtils, Vector3, type Group } from 'three'
import { dampFactor } from '../scene/rig'
import { useConfigStore } from '../state/useConfigStore'
import { useEndingUi } from './useEndingUi'

// 标本盒的有限交互（spec §8.3）：拖拽旋转 yaw / pitch 各限制在 ±N 度，滚轮小幅缩放（min / max clamp）。
// 不做自由 orbit，不允许转到背面。松手一段时间后缓慢回正；静止时有轻微呼吸摆动。

const DEG = Math.PI / 180
const camPos = new Vector3()
const lookAt = new Vector3()

export function BoxInteraction({ children }: { children: ReactNode }) {
  const group = useRef<Group>(null)
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const state = useRef({ yaw: 0, pitch: 0, zoom: 1, tYaw: 0, tPitch: 0, tZoom: 1, lastInput: -1e9 })

  useEffect(() => {
    const el = gl.domElement
    let pointer: number | null = null
    let lastX = 0
    let lastY = 0
    let moved = 0
    const cfg = () => useConfigStore.getState().endingEffective.interaction

    const onDown = (e: PointerEvent) => {
      if (pointer !== null) return
      pointer = e.pointerId
      lastX = e.clientX
      lastY = e.clientY
      moved = 0
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return
      const c = cfg()
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      moved += Math.abs(dx) + Math.abs(dy)
      if (moved > 4) useEndingUi.setState({ dragging: true, hoveredId: null })
      const s = state.current
      s.tYaw = MathUtils.clamp(s.tYaw + dx * c.dragSensitivity * DEG, -c.yawLimitDeg * DEG, c.yawLimitDeg * DEG)
      s.tPitch = MathUtils.clamp(s.tPitch + dy * c.dragSensitivity * DEG, -c.pitchLimitDeg * DEG, c.pitchLimitDeg * DEG)
      s.lastInput = performance.now() / 1000
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return
      pointer = null
      useEndingUi.setState({ dragging: false })
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const c = cfg()
      const s = state.current
      s.tZoom = MathUtils.clamp(s.tZoom * Math.exp(e.deltaY * c.zoomSpeed), c.zoomMin, c.zoomMax)
      s.lastInput = performance.now() / 1000
    }
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
    }
  }, [gl])

  useFrame((clock, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const { interaction: c, camera: camCfg } = useConfigStore.getState().endingEffective
    const s = state.current
    const now = performance.now() / 1000
    // 松手一段时间后缓慢回正（缩放不回正）
    if (c.returnDelay > 0 && !useEndingUi.getState().dragging && now - s.lastInput > c.returnDelay) {
      const k = dampFactor(1.5, dt)
      s.tYaw = MathUtils.lerp(s.tYaw, 0, k)
      s.tPitch = MathUtils.lerp(s.tPitch, 0, k)
    }
    const k = dampFactor(c.damping, dt)
    s.yaw = MathUtils.lerp(s.yaw, s.tYaw, k)
    s.pitch = MathUtils.lerp(s.pitch, s.tPitch, k)
    s.zoom = MathUtils.lerp(s.zoom, s.tZoom, k)
    const t = clock.clock.elapsedTime
    const sway = Math.sin(t * c.idleSwaySpeed * Math.PI * 2) * c.idleSwayDeg * DEG
    if (group.current) {
      group.current.rotation.set(s.pitch, s.yaw + sway, 0)
    }
    // 缩放 = 沿视线方向调整相机距离
    lookAt.set(...camCfg.lookAt)
    camPos.set(...camCfg.position).sub(lookAt).multiplyScalar(s.zoom).add(lookAt)
    camera.position.copy(camPos)
    camera.lookAt(lookAt)
  })

  return <group ref={group}>{children}</group>
}
