import { useEffect } from 'react'

// 统一输入层：上层只读 getMove() / consumeLook()，不区分设备。
// 桌面：键盘移动 + 鼠标拖拽转视角；移动端：左下虚拟摇杆（TouchControls 写入 joystick）+ 右半屏拖拽转视角。

const keys = new Set<string>()
const look = { dx: 0, dy: 0 }
/** 虚拟摇杆输出，x = 右，y = 前，长度 ≤ 1 */
export const joystick = { x: 0, y: 0 }
/** 触屏转视角灵敏度倍率，由场景 config 的 mobile.lookSensitivity 写入 */
export const inputSettings = { touchLookScale: 1 }

/** 触屏模式：粗指针设备，或 ?tier=mobile 强制模拟 */
export function isTouchMode(): boolean {
  const hashQuery = new URLSearchParams(location.hash.split('?')[1] ?? '')
  const query = new URLSearchParams(location.search)
  if (query.get('tier') === 'mobile' || hashQuery.get('tier') === 'mobile') return true
  return matchMedia('(pointer: coarse)').matches
}

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1], ArrowUp: [0, 1],
  KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
}

/** x = 右, y = 前，长度 ≤ 1 */
export function getMove(): { x: number; y: number; sprint: boolean } {
  let x = joystick.x
  let y = joystick.y
  for (const k of keys) {
    const v = MOVE_KEYS[k]
    if (v) {
      x += v[0]
      y += v[1]
    }
  }
  const len = Math.hypot(x, y)
  if (len > 1) {
    x /= len
    y /= len
  }
  return { x, y, sprint: keys.has('ShiftLeft') || keys.has('ShiftRight') }
}

/** 取出自上次以来累计的视角拖拽量（像素） */
export function consumeLook(): { dx: number; dy: number } {
  const out = { dx: look.dx, dy: look.dy }
  look.dx = 0
  look.dy = 0
  return out
}

/** 在场景 Canvas 上挂载键鼠监听 */
export function useInputListeners(target: HTMLElement) {
  useEffect(() => {
    let dragging = false
    // 触屏转视角：只认从右半屏按下的那根手指
    let touchId: number | null = null
    let lastX = 0
    let lastY = 0
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      keys.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)
    const onBlur = () => keys.clear()
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        dragging = true
      } else if (touchId === null && e.clientX > window.innerWidth / 2) {
        touchId = e.pointerId
        lastX = e.clientX
        lastY = e.clientY
      }
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        if (!dragging) return
        look.dx += e.movementX
        look.dy += e.movementY
      } else if (e.pointerId === touchId) {
        look.dx += (e.clientX - lastX) * inputSettings.touchLookScale
        look.dy += (e.clientY - lastY) * inputSettings.touchLookScale
        lastX = e.clientX
        lastY = e.clientY
      }
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') dragging = false
      else if (e.pointerId === touchId) touchId = null
    }
    const onContext = (e: MouseEvent) => e.preventDefault()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    target.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    target.addEventListener('contextmenu', onContext)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      target.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      target.removeEventListener('contextmenu', onContext)
      keys.clear()
      look.dx = look.dy = 0
      joystick.x = joystick.y = 0
    }
  }, [target])
}
