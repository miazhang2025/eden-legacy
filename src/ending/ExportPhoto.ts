import { Box3, Vector3, type Object3D } from 'three'
import type { EndingConfig } from '../config/schema'
import { AudioBus } from '../audio/AudioBus'
import { copy } from '../data/copy'
import type { BoxResult } from '../data/specimenBoxes'
import { getActiveCanvas } from '../scene/activeCanvas'
import { useLangStore } from '../state/useLangStore'
import { useEndingUi } from './useEndingUi'

// 照片导出（spec §8.4）：
//   1. 临时隐藏提示框
//   2. 以 photo.scale 倍像素比渲染一帧并立刻读取（同一个任务内完成，浏览器不会把放大的画布绘制到屏幕上）
//   3. photo.crop 时只保留画框在屏幕上的投影区域
//   4. 新建 2D canvas，按 config 绘制底色 / 边框 / 标题与描述 / logo，再把 3D 帧放进去
//   5. toBlob('image/png') → 交给照片卡片展示（useEndingUi.photo），由卡片上的「保存」按钮下载
//   6. 恢复

/** 照片裁切的参照物（标本盒画框），由 SpecimenBox 注册 */
export const photoSubject: { current: Object3D | null } = { current: null }

export interface Photo {
  url: string
  filename: string
}

const FONT_DISPLAY = "'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif"
/** 英文标题用页面上同一款花体（结尾页已加载过） */
const FONT_SCRIPT = "'Pinyon Script', 'Songti SC', serif"
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

/** 不能出现在行首的标点：超宽时也挂在上一行末尾 */
const NO_LINE_START = new Set('，。、；：？！）」』》”’…—,.;:?!)')

/** 换行：英文按单词（连同后面的空格算一个单位），中文按字符（没有空格分词） */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const tokens = text.match(/[\p{Script=Latin}\d'’-]+\s*|\s+|./gu) ?? []
  const lines: string[] = []
  let line = ''
  for (const t of tokens) {
    if (ctx.measureText((line + t).trimEnd()).width > maxWidth && line.trim() && !NO_LINE_START.has(t[0])) {
      lines.push(line.trimEnd())
      line = t.trimStart()
    } else line += t
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines
}

const bounds = new Box3()
const corner = new Vector3()

/** photoSubject 在画布上的投影矩形（0–1，左上为原点），外扩 padding（占自身尺寸的比例） */
function subjectRect(padding: number): { x: number; y: number; w: number; h: number } | null {
  const active = getActiveCanvas()
  const subject = photoSubject.current
  if (!active || !subject) return null
  bounds.setFromObject(subject)
  if (bounds.isEmpty()) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < 8; i++) {
    corner
      .set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z)
      .project(active.camera)
    x0 = Math.min(x0, corner.x)
    x1 = Math.max(x1, corner.x)
    y0 = Math.min(y0, corner.y)
    y1 = Math.max(y1, corner.y)
  }
  const px = ((x1 - x0) / 2) * padding
  const py = ((y1 - y0) / 2) * padding
  const left = Math.max(0, (x0 + 1) / 2 - px)
  const right = Math.min(1, (x1 + 1) / 2 + px)
  const top = Math.max(0, (1 - y1) / 2 - py)
  const bottom = Math.min(1, (1 - y0) / 2 + py)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 以倍率渲染当前 3D 画布，返回一张独立的 canvas；crop 时只保留画框区域 */
function captureScaled(scale: number, crop: boolean, cropPadding: number): HTMLCanvasElement | null {
  const active = getActiveCanvas()
  if (!active) return null
  const { gl, scene, camera } = active
  const prev = gl.getPixelRatio()
  const shot = document.createElement('canvas')
  try {
    gl.setPixelRatio(prev * scale)
    gl.render(scene, camera)
    const W = gl.domElement.width
    const H = gl.domElement.height
    const r = (crop && subjectRect(cropPadding)) || { x: 0, y: 0, w: 1, h: 1 }
    shot.width = Math.round(r.w * W)
    shot.height = Math.round(r.h * H)
    shot.getContext('2d')!.drawImage(gl.domElement, -Math.round(r.x * W), -Math.round(r.y * H))
  } finally {
    gl.setPixelRatio(prev)
    gl.render(scene, camera)
  }
  return shot
}

export async function exportPhoto(box: BoxResult, photo: EndingConfig['photo']): Promise<Photo | null> {
  AudioBus.playSfx('photoExport')
  useEndingUi.setState({ exporting: true, hoveredId: null })
  try {
    const shot = captureScaled(photo.scale, photo.crop, photo.cropPadding)
    if (!shot) return null
    // 版面按「屏幕 1 倍像素 × scale × 设备像素比」统一放大
    const dom = getActiveCanvas()!.gl.domElement
    const k = (dom.width / (dom.clientWidth || dom.width)) * photo.scale
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
    const textHeight = photo.includeText ? gap + titlePx * 1.7 + descLines.length * descPx * 1.7 : 0
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

    // 项目名压在底边框正中，底色挖出一段让它「断开」边框
    if (photo.includeBrand) {
      const brandPx = photo.brandSize * k
      ctx.font = `${brandPx}px ${FONT_BODY}`
      ctx.letterSpacing = `${brandPx * 0.4}px`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const text = `✦  ${copy('app.brand')}  ✦`
      const w = ctx.measureText(text).width + brandPx * 2
      const y = out.height - margin / 2
      ctx.fillStyle = photo.background
      ctx.fillRect(out.width / 2 - w / 2, y - brandPx, w, brandPx * 2)
      ctx.fillStyle = photo.borderColor
      ctx.fillText(text, out.width / 2, y)
      ctx.letterSpacing = '0px'
    }

    if (photo.includeText) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      let y = margin + shot.height + gap
      ctx.fillStyle = photo.textColor
      const zh = useLangStore.getState().lang === 'zh'
      ctx.font = zh ? `${titlePx}px ${FONT_DISPLAY}` : `${titlePx * 1.3}px ${FONT_SCRIPT}`
      ctx.shadowColor = photo.textColor
      ctx.shadowBlur = titlePx * 0.35
      ctx.fillText(box.name, out.width / 2, y)
      ctx.shadowBlur = 0
      y += titlePx * 1.7
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
    return { url: URL.createObjectURL(blob), filename: `specimen-${box.id}-${timestamp()}.png` }
  } finally {
    useEndingUi.setState({ exporting: false })
  }
}

/** 下载照片 */
export function savePhoto(photo: Photo) {
  const a = document.createElement('a')
  a.href = photo.url
  a.download = photo.filename
  a.click()
}
