// HDRI 降采样：art/hdri/*.hdr → public/hdri/*.hdr（默认 1k，spec §12.3 要求 1k/2k，不用 4k）
// Radiance RGBE 格式自己解码 / 编码（sharp 不支持 .hdr）。
// 用法：npm run hdri [目标宽度]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const SRC = 'art/hdri'
const OUT = 'public/hdri'

/** 解码 Radiance .hdr → { width, height, data: Float32Array(rgb) } */
function decodeHDR(buf) {
  let pos = 0
  const readLine = () => {
    let line = ''
    while (pos < buf.length) {
      const ch = String.fromCharCode(buf[pos++])
      if (ch === '\n') break
      line += ch
    }
    return line
  }
  let line = readLine()
  if (!line.startsWith('#?')) throw new Error('不是 Radiance .hdr 文件')
  while ((line = readLine()) !== '') {
    /* 头部：FORMAT / EXPOSURE 等，这里不需要 */
  }
  const dim = readLine().match(/-Y (\d+) \+X (\d+)/)
  if (!dim) throw new Error('不支持的扫描线顺序')
  const height = Number(dim[1])
  const width = Number(dim[2])
  const rgbe = new Uint8Array(width * height * 4)

  for (let y = 0; y < height; y++) {
    const off = y * width * 4
    if (width < 8 || width > 0x7fff || buf[pos] !== 2 || buf[pos + 1] !== 2 || (buf[pos + 2] << 8 | buf[pos + 3]) !== width) {
      // 非 RLE：逐像素
      for (let x = 0; x < width; x++) {
        rgbe[off + x * 4] = buf[pos++]
        rgbe[off + x * 4 + 1] = buf[pos++]
        rgbe[off + x * 4 + 2] = buf[pos++]
        rgbe[off + x * 4 + 3] = buf[pos++]
      }
      continue
    }
    pos += 4
    // RLE：四个通道分别游程编码
    for (let c = 0; c < 4; c++) {
      let x = 0
      while (x < width) {
        let count = buf[pos++]
        if (count > 128) {
          const value = buf[pos++]
          count -= 128
          for (let i = 0; i < count; i++) rgbe[off + (x++) * 4 + c] = value
        } else {
          for (let i = 0; i < count; i++) rgbe[off + (x++) * 4 + c] = buf[pos++]
        }
      }
    }
  }

  const data = new Float32Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3]
    const f = e ? Math.pow(2, e - 136) : 0 // 2^(e-128) / 256
    data[i * 3] = rgbe[i * 4] * f
    data[i * 3 + 1] = rgbe[i * 4 + 1] * f
    data[i * 3 + 2] = rgbe[i * 4 + 2] * f
  }
  return { width, height, data }
}

/** 盒式降采样到目标宽度（等距柱状投影保持 2:1） */
function downsample(img, targetWidth) {
  const tw = Math.min(targetWidth, img.width)
  const th = Math.max(1, Math.round((tw / img.width) * img.height))
  const out = new Float32Array(tw * th * 3)
  const sx = img.width / tw
  const sy = img.height / th
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 3
          r += img.data[i]
          g += img.data[i + 1]
          b += img.data[i + 2]
          n++
        }
      }
      const o = (y * tw + x) * 3
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
    }
  }
  return { width: tw, height: th, data: out }
}

/** 编码为 Radiance .hdr（不做 RLE，文件略大但简单可靠） */
function encodeHDR(img) {
  const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${img.height} +X ${img.width}\n`, 'ascii')
  const body = Buffer.alloc(img.width * img.height * 4)
  for (let i = 0; i < img.width * img.height; i++) {
    const r = img.data[i * 3]
    const g = img.data[i * 3 + 1]
    const b = img.data[i * 3 + 2]
    const max = Math.max(r, g, b)
    if (max < 1e-32) continue
    const e = Math.ceil(Math.log2(max))
    const f = Math.pow(2, -e) * 256
    body[i * 4] = Math.min(255, Math.floor(r * f))
    body[i * 4 + 1] = Math.min(255, Math.floor(g * f))
    body[i * 4 + 2] = Math.min(255, Math.floor(b * f))
    body[i * 4 + 3] = e + 128
  }
  return Buffer.concat([header, body])
}

const targetWidth = Number(process.argv[2] ?? 1024)
if (!existsSync(SRC)) {
  console.error(`没有 ${SRC}，把原始 .hdr 放进去再运行`)
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`

for (const file of readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.hdr'))) {
  const src = join(SRC, file)
  const raw = readFileSync(src)
  const img = decodeHDR(raw)
  const small = downsample(img, targetWidth)
  // 文件名去掉括号空格等避免 URL 转义问题；顺手去掉原图的分辨率后缀（降采样后已经不是 4k 了）
  const clean = basename(file, '.hdr')
    .toLowerCase()
    .replace(/[_-]?\d+k$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') + '.hdr'
  const out = join(OUT, clean)
  const buf = encodeHDR(small)
  writeFileSync(out, buf)
  console.log(`▸ ${file} ${img.width}×${img.height} ${mb(raw.length)} → ${clean} ${small.width}×${small.height} ${mb(buf.length)}`)
}
