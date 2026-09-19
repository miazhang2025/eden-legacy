import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useSceneCfg } from '../state/useConfigStore'
import { inputSettings, joystick } from './useInput'

// 移动端虚拟摇杆（左下）。右半屏拖拽转视角在 useInputListeners 里处理。仅在触屏模式挂载。
export function TouchControls() {
  const { joystickRadius, joystickSensitivity, lookSensitivity } = useSceneCfg((c) => c.mobile)
  const base = useRef<HTMLDivElement>(null)
  const pointer = useRef<number | null>(null)
  const [knob, setKnob] = useState<[number, number]>([0, 0])

  useEffect(() => {
    inputSettings.touchLookScale = lookSensitivity
  }, [lookSensitivity])

  const update = (e: ReactPointerEvent) => {
    const rect = base.current!.getBoundingClientRect()
    let dx = e.clientX - (rect.left + rect.width / 2)
    let dy = e.clientY - (rect.top + rect.height / 2)
    const len = Math.hypot(dx, dy)
    if (len > joystickRadius) {
      dx = (dx / len) * joystickRadius
      dy = (dy / len) * joystickRadius
    }
    setKnob([dx, dy])
    const k = joystickSensitivity / joystickRadius
    joystick.x = Math.max(-1, Math.min(1, dx * k))
    joystick.y = Math.max(-1, Math.min(1, -dy * k))
  }

  const release = () => {
    pointer.current = null
    setKnob([0, 0])
    joystick.x = joystick.y = 0
  }

  useEffect(() => release, [])

  const size = joystickRadius * 2
  return (
    <div
      ref={base}
      className="joystick"
      style={{ width: size, height: size }}
      onPointerDown={(e) => {
        if (pointer.current !== null) return
        pointer.current = e.pointerId
        e.currentTarget.setPointerCapture(e.pointerId)
        update(e)
      }}
      onPointerMove={(e) => e.pointerId === pointer.current && update(e)}
      onPointerUp={(e) => e.pointerId === pointer.current && release()}
      onPointerCancel={(e) => e.pointerId === pointer.current && release()}
    >
      <div className="joystick__knob" style={{ transform: `translate(${knob[0]}px, ${knob[1]}px)` }} />
    </div>
  )
}
