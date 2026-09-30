import type { Vector3 } from 'three'
import { getSceneCfg } from '../state/useConfigStore'

// 可玩区软边界（scripts/build-terrain.mjs 烘的有符号距离场，正 = 在原地形范围内，单位米）。
// 靠近边缘时，移动里「往外」的分量按距离逐渐削掉，只留沿边的分量：玩家会贴着边滑走，不会撞上空气墙。
// 距离场在模型局部坐标，查询时套 config 的 env 变换。

interface Field {
  data: Float32Array
  w: number
  h: number
  min: [number, number]
  size: [number, number]
  range: number
}

let field: Field | null = null

export function setBoundaryField(f: Field | null) {
  field = f
}

const url = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

/** 读距离场 png（R 高 8 位 / G 低 8 位）与旁边的范围 json */
export async function loadBoundaryField(map: string): Promise<Field> {
  const meta = (await fetch(url(map.replace(/\.png$/, '.json'))).then((r) => r.json())) as Pick<Field, 'min' | 'size' | 'range'>
  const img = new Image()
  img.src = url(map)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, img.width, img.height).data
  const data = new Float32Array(img.width * img.height)
  for (let i = 0; i < data.length; i++) {
    const v = (px[i * 4] * 256 + px[i * 4 + 1]) / 65535
    data[i] = v * 2 * meta.range - meta.range
  }
  return { data, w: img.width, h: img.height, ...meta }
}

/** 世界坐标 → 模型局部 x/z（env 变换的逆），返回缩放倍数用于把距离换回世界单位 */
function toLocal(x: number, z: number): [number, number, number] {
  const env = getSceneCfg().env
  const dx = (x - env.position[0]) / env.scale
  const dz = (z - env.position[2]) / env.scale
  const c = Math.cos(env.rotationY)
  const s = Math.sin(env.rotationY)
  return [dx * c - dz * s, dx * s + dz * c, env.scale]
}

/** 世界坐标处到可玩区边缘的有符号距离（世界单位）；没有距离场时返回 Infinity */
export function boundaryDistance(x: number, z: number): number {
  const f = field
  if (!f) return Infinity
  const [lx, lz, scale] = toLocal(x, z)
  const u = ((lx - f.min[0]) / f.size[0]) * f.w - 0.5
  const v = ((lz - f.min[1]) / f.size[1]) * f.h - 0.5
  if (u < 0 || v < 0 || u > f.w - 1 || v > f.h - 1) return -f.range * scale
  const i = Math.floor(u)
  const j = Math.floor(v)
  const i1 = Math.min(f.w - 1, i + 1)
  const j1 = Math.min(f.h - 1, j + 1)
  const fu = u - i
  const fv = v - j
  const a = f.data[j * f.w + i] + (f.data[j * f.w + i1] - f.data[j * f.w + i]) * fu
  const b = f.data[j1 * f.w + i] + (f.data[j1 * f.w + i1] - f.data[j1 * f.w + i]) * fu
  return (a + (b - a) * fv) * scale
}

const EPS = 0.2
/** 指向可玩区内部的单位方向（距离场梯度） */
function inward(x: number, z: number): [number, number] {
  const gx = boundaryDistance(x + EPS, z) - boundaryDistance(x - EPS, z)
  const gz = boundaryDistance(x, z + EPS) - boundaryDistance(x, z - EPS)
  const len = Math.hypot(gx, gz)
  return len > 1e-6 ? [gx / len, gz / len] : [0, 0]
}

const active = () => {
  const t = getSceneCfg().terrain
  return field !== null && t.enabled && t.boundary.enabled ? t.boundary : null
}

/** 修正本帧的水平位移 move（原地修改）：越靠近边缘，往外的分量削得越多 */
export function constrainMove(pos: Vector3, move: Vector3) {
  const b = active()
  if (!b) return
  const nx = pos.x + move.x
  const nz = pos.z + move.z
  const s = boundaryDistance(nx, nz) - b.inset
  if (s >= b.softWidth) return
  const [gx, gz] = inward(nx, nz)
  const outward = -(move.x * gx + move.z * gz)
  if (outward <= 0) return
  const k = 1 - Math.min(1, Math.max(0, s / b.softWidth))
  move.x += gx * outward * k
  move.z += gz * outward * k
}

/** 已经在边界外（出生点 / 传送 / 大步长冲出去）时缓慢推回 */
export function pushInside(pos: Vector3, dt: number) {
  const b = active()
  if (!b) return
  const s = boundaryDistance(pos.x, pos.z) - b.inset
  if (s >= 0) return
  const [gx, gz] = inward(pos.x, pos.z)
  const amount = Math.min(-s, b.pushBack * dt)
  pos.x += gx * amount
  pos.z += gz * amount
}
