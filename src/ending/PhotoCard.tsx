import { useEffect } from 'react'
import { copy } from '../data/copy'
import { savePhoto } from './ExportPhoto'
import { useEndingUi } from './useEndingUi'

/** 快门：取景框四角收拢 + 白色闪光。shutter 变化时用 key 重挂载来重播动画 */
export function ShutterFlash() {
  const shutter = useEndingUi((s) => s.shutter)
  if (!shutter) return null
  return (
    <div key={shutter} className="shutter" aria-hidden>
      <div className="shutter__frame">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="shutter__flash" />
    </div>
  )
}

/** 拍好的照片：像相纸一样落下并慢慢显影，可以保存或关闭 */
export function PhotoCard() {
  const photo = useEndingUi((s) => s.photo)
  const close = () => useEndingUi.getState().showPhoto(null)

  useEffect(() => {
    if (!photo) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photo])

  // 离开 Ending 时释放最后一张照片
  useEffect(() => close, [])

  if (!photo) return null
  return (
    <div className="photo-card" role="dialog" aria-modal="true" aria-label={copy('ending.photo.title')} onClick={close}>
      <figure key={photo.url} className="photo-card__paper" onClick={(e) => e.stopPropagation()}>
        {/* 蕾丝花边相框（参考图里白色蕾丝边框） */}
        <div className="photo-card__lace">
          <img className="photo-card__image" src={photo.url} alt={copy('ending.photo.title')} draggable={false} />
        </div>
        <figcaption className="photo-card__actions">
          <button className="btn" onClick={close}>
            {copy('ending.photo.close')}
          </button>
          <button className="btn btn--primary" onClick={() => savePhoto(photo)} autoFocus>
            {copy('ending.photo.save')}
          </button>
        </figcaption>
      </figure>
    </div>
  )
}
