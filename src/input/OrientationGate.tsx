import { useEffect, useState } from 'react'
import { copy } from '../data/copy'
import { isTouchMode } from './useInput'

// 仅横屏：触屏设备竖屏时铺满遮罩提示旋转。不卸载下面的场景。
export function OrientationGate() {
  const [portrait, setPortrait] = useState(false)

  useEffect(() => {
    const mq = matchMedia('(orientation: portrait)')
    const update = () => setPortrait(isTouchMode() && mq.matches)
    update()
    mq.addEventListener('change', update)
    window.addEventListener('hashchange', update)
    return () => {
      mq.removeEventListener('change', update)
      window.removeEventListener('hashchange', update)
    }
  }, [])

  if (!portrait) return null
  return (
    <div className="orientation-gate" role="alert">
      <svg className="orientation-gate__icon" viewBox="0 0 64 64" aria-hidden="true">
        <rect x="20" y="8" width="24" height="42" rx="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M50 44 a18 18 0 0 1 -14 12" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M36 52 l0 5 l5 -1" fill="none" stroke="currentColor" strokeWidth="2.5" />
      </svg>
      <p>{copy('orientation.hint')}</p>
    </div>
  )
}
