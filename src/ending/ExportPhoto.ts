import type { EndingConfig } from '../config/schema'
import { AudioBus } from '../audio/AudioBus'
import type { BoxResult } from '../data/specimenBoxes'
import { getActiveCanvas } from '../scene/activeCanvas'
import { useEndingUi } from './useEndingUi'

// 照片导出（spec §8.4）：
//   1. 临时隐藏提示框
//   2. 以 photo.scale 倍像素比渲染一帧并立刻读取（同一个任务内完成，浏览器不会把放大的画布绘制到屏幕上）
//   3. 新建 2D canvas，按 config 绘制底色 / 边框 / 标题与描述 / logo，再把 3D 帧放进去
//   4. toBlob('image/png') → 下载 specimen-<boxId>-<时间戳>.png
//   5. 恢复

const FONT_DISPLAY = "'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif"
const FONT_BODY = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', system-ui, sans-serif"

const url = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

function timestamp() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** 按字符换行（中文没有空格分词） */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line)
      line = ch
    } else line += ch
  }
  if (line) lines.push(line)
  return lines
}

/** 以倍率渲染当前 3D 画布，返回一张独立的 canvas */
function captureScaled(scale: number): HTMLCanvasElement | null {
  const active = getActiveCanvas()
  if (!active) return null
  const { gl, scene, camera } = active
  const prev = gl.getPixelRatio()
  const shot = document.createElement('canvas')
  try {
    gl.setPixelRatio(prev * scale)
    gl.render(scene, camera)
    shot.width = gl.domElement.width
    shot.height = gl.domElement.height
    shot.getContext('2d')!.drawImage(gl.domElement, 0, 0)
  } finally {
    gl.setPixelRatio(prev)
    gl.render(scene, camera)
  }
  return shot
}

export async function exportPhoto(box: BoxResult, photo: EndingConfig['photo']): Promise<string | null> {
  AudioBus.playSfx('photoExport')
  useEndingUi.setState({ exporting: true, hoveredId: null })
  try {
    const shot = captureScaled(photo.scale)
    if (!shot) return null
    // 版面按「屏幕 1 倍像素 × scale × 设备像素比」统一放大
    const k = shot.width / (getActiveCanvas()!.gl.domElement.clientWidth || shot.width)
    const margin = photo.margin * k
    const gap = photo.textGap * k
    const titlePx = photo.titleSize * k
    const descPx = photo.descSize * k

    const out = document.createElement('canvas')
    const ctx = out.getContext('2d')!
    const width = shot.width + margin * 2
    let descLines: string[] = []
    if (photo.includeText) {
      ctx.font = `${descPx}px ${FONT_BODY}`
      descLines = wrap(ctx, box.description, shot.width * 0.8)
    }
    const textHeight = photo.includeText ? gap + titlePx * 1.3 + descLines.length * descPx * 1.7 : 0
    out.width = Math.round(width)
    out.height = Math.round(margin + shot.height + textHeight + margin)

    ctx.fillStyle = photo.background
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(shot, margin, margin)
    if (photo.borderWidth > 0) {
      const bw = photo.borderWidth * k
      ctx.strokeStyle = photo.borderColor
      ctx.lineWidth = bw
      ctx.strokeRect(margin / 2, margin / 2, out.width - margin, out.height - margin)
    }

    if (photo.includeText) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      let y = margin + shot.height + gap
      ctx.fillStyle = photo.textColor
      ctx.font = `${titlePx}px ${FONT_DISPLAY}`
      ctx.fillText(box.name, out.width / 2, y)
      y += titlePx * 1.3
      ctx.fillStyle = photo.descColor
      ctx.font = `${descPx}px ${FONT_BODY}`
      for (const line of descLines) {
        ctx.fillText(line, out.width / 2, y)
        y += descPx * 1.7
      }
    }

    if (photo.includeLogo && photo.logo) {
      const logo = await loadImage(url(photo.logo))
      if (logo) {
        const h = photo.logoSize * k
        const w = (logo.width / logo.height) * h
        ctx.drawImage(logo, out.width - margin - w, out.height - margin - h, w, h)
      }
    }

    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'))
    if (!blob) return null
    const filename = `specimen-${box.id}-${timestamp()}.png`
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
    return filename
  } finally {
    useEndingUi.setState({ exporting: false })
  }
}
