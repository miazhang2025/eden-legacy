import type { WebGLRenderer } from 'three'
import { AudioBus } from '../audio/AudioBus'

// M1 简版：直接把当前 canvas 存成 PNG。
// TODO(M6)：按 §8.4 完整实现 —— 隐藏 UI、exportScale 离屏渲染、2D canvas 合成边框与标题。
export function exportPhoto(gl: WebGLRenderer, boxSlug: string) {
  AudioBus.playSfx('photoExport')
  gl.domElement.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `specimen-${boxSlug}-${Date.now()}.png`
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}
