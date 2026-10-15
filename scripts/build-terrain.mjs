// 生成地形（替换美术地形 mesh，原始素材保留不动，config 里 terrain.enabled 一键换回）
//   art/env/<name>.glb 里的地形 mesh（从上往下看的最高面）──► 一张高度场，再向外延伸成「看不到边」的远景裙边
//
//   输出：
//     public/models/env/<name>.terrain.glb          渲染用：terrain_play（可玩区）+ terrain_far（远景裙边），Draco + KTX2
//     public/models/env/<name>.terrain.json         元数据：水位、范围（模型局部坐标）
//     public/models/env/<name>.terrain.bounds.png   可玩区有符号距离场（R 高 8 位 / G 低 8 位），运行时做软边界
//     public/models/env/<name>.terrain.bounds.json  距离场的范围与量程
//     public/models/colliders/<name>.terrain.glb    碰撞用：新地形可玩区 + 原模型里仍要站人的石头
//     art/terrain/<name>.terrain.glb                未压缩版本，可以直接拖进 Blender 看 / 改
//
//   地形顶点色（COLOR_0，运行时当遮罩读，不当颜色乘）：
//     r = 手绘贴图权重（原地形覆盖范围内为 1，边缘向内渐变到 0，外面是程序化材质）
//     g = 水域（池底：挖低 + 着色）
//
//   坐标一律是模型局部空间，运行时套 config 的 env 变换（与草地密度图一致）。
//
// 用法：npm run terrain            （默认 garden）
//       npm run terrain -- garden

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { draco, flatten, join as joinMeshes, prune, simplify, textureCompress, weld } from '@gltf-transform/functions'
import { checkKTXSoftware, toktx } from '@gltf-transform/cli'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three'
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh'
import { assignTextures } from './assign-textures.mjs'

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
Mesh.prototype.raycast = acceleratedRaycast

/**
 * 每个场景的规则：
 * - sources：合并成高度场的地形 mesh 名（取从上往下看的最高面）
 * - keepInCollider：原模型里仍要进碰撞体的 mesh（石头、汀步）
 * - step：可玩区网格间距（米）；裙边间距按 grow 倍率逐圈放大，直到 reach 米外
 * - paintRes：手绘贴图长边像素
 * - repaint：{ 源 mesh: { mesh, at } }，俯视最高面是源 mesh 时，颜色改取 mesh 的贴图（只换颜色，高度、水域判定照旧）：
 *            按 mesh 在地面上的比例（世界 xz → uv 的线性拟合）铺，源 mesh 的中心对到贴图里的 at（uv）。
 *            garden：湖心岛（55）换成最大那块地面（8）的草地；8 号贴图在岛正下方画的是池塘，所以取 at 处的一片草
 * - water：池塘在贴图里是紫色，按「蓝 − 绿」「红 − 绿」判断（0–255）；离水 darkReach 米内比 darkCut 暗的也算水；
 *          close 为补小洞的半径（米）；池底在水面下挖 bedDepth，岸坡宽约 bank 米；
 *          水面高度 = 原池面高度的平滑（半径 smooth 米）再降 drop；原高度比水面高出 surfaceTol 以上的不挖（横跨池塘的石脊）
 * - grass：程序化草密度图分辨率、出岛渐隐距离
 * - far：裙边地貌（过渡距离、远处抬升、起伏）；mounds = 中景圆丘；peaks = 远景尖峰（参考图背景那种石林状的山）
 */
const RULES = {
  garden: {
    sources: ['8', '9', '55'],
    keepInCollider: ['53', '54'],
    step: 0.25,
    grow: 1.09,
    reach: 160,
    paintRes: 2048,
    paintFade: 1.5,
    repaint: { 55: { mesh: '8', at: [0.3, 0.72] } },
    water: { blueOverGreen: [12, 28], redOverGreen: 6, darkCut: 0.09, darkReach: 0.8, band: 0.6, close: 0.4, bedDepth: 0.55, shore: 0.2, bank: 0.9, smooth: 0.6, surfaceTol: 0.08, drop: 0.03 },
    far: {
      blend: 12, rise: 4, riseStart: 20, riseEnd: 110, hills: 2.5,
      mounds: { seed: 7, count: 0, near: 12, far: 75, radius: [9, 20], height: [1.5, 6.5] },
      peaks: { seed: 11, clusters: 0, distance: [115, 190], height: [20, 42], radius: [9, 16], gap: 0.5 },
    },
    boundary: { res: 0.2, margin: 12, range: 16 },
    grass: { res: 512, fadeOut: 4 },
    colliderTriangles: 30000,
  },
}

const SRC = 'art/env'
const TEXTURES = 'art/textures'
const OUT_RENDER = 'public/models/env'
const OUT_COLLIDER = 'public/models/colliders'
const OUT_ART = 'art/terrain'

const name = process.argv[2] ?? 'garden'
const R = RULES[name]
if (!R) {
  console.error(`没有 ${name} 的地形规则（见 scripts/build-terrain.mjs 的 RULES）`)
  process.exit(1)
}

const KTX_BIN = process.env.KTX_BIN ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'tools', 'KTX', 'bin')
process.env.PATH = `${KTX_BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`
let hasKTX = false
try {
  await checkKTXSoftware({ debug() {}, info() {}, warn() {}, error() {} })
  hasKTX = true
} catch {
  console.warn('⚠ 没找到 KTX-Software，贴图回落为 WebP')
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
})

const t0 = Date.now()
const log = (msg) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

// ---------- 工具 ----------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const mix = (a, b, t) => a + (b - a) * t

// 值噪声 fbm（确定性，重跑结果一致）
function hash(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
function vnoise(x, z) {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  return mix(mix(hash(ix, iz), hash(ix + 1, iz), ux), mix(hash(ix, iz + 1), hash(ix + 1, iz + 1), ux), uz)
}
function fbm(x, z, octaves = 4) {
  let s = 0
  let a = 0.5
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    s += a * (vnoise(x, z) * 2 - 1)
    norm += a
    x = x * 2.03 + 17.1
    z = z * 2.03 - 9.7
    a *= 0.5
  }
  return s / norm
}

/** 双线性采样单通道 float 网格（坐标为像素中心空间） */
function sampleGrid(arr, w, h, px, pz) {
  const x = clamp(px - 0.5, 0, w - 1)
  const z = clamp(pz - 0.5, 0, h - 1)
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const x1 = Math.min(w - 1, x0 + 1)
  const z1 = Math.min(h - 1, z0 + 1)
  const fx = x - x0
  const fz = z - z0
  return mix(mix(arr[z0 * w + x0], arr[z0 * w + x1], fx), mix(arr[z1 * w + x0], arr[z1 * w + x1], fx), fz)
}

// ---------- 1. 读原模型，建射线场景 ----------
console.log(`\n▸ ${name} 地形`)
const srcDoc = await io.read(join(SRC, `${name}.glb`))
await assignTextures(srcDoc, name, TEXTURES)

const sources = []
const textures = new Map()
for (const node of srcDoc.getRoot().listNodes()) {
  const mesh = node.getMesh()
  if (!mesh || !R.sources.includes(mesh.getName())) continue
  for (const prim of mesh.listPrimitives()) {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(prim.getAttribute('POSITION').getArray().slice(), 3))
    geo.setAttribute('uv', new BufferAttribute(prim.getAttribute('TEXCOORD_0').getArray().slice(), 2))
    const idx = prim.getIndices()
    if (idx) geo.setIndex(new BufferAttribute(idx.getArray().slice(), 1))
    geo.applyMatrix4(new Matrix4().fromArray(node.getWorldMatrix()))
    geo.computeBoundsTree()
    // 双面：原地形有些面法线朝下，单面射线会穿过去
    const m = new Mesh(geo, new MeshBasicMaterial({ side: DoubleSide }))
    m.name = mesh.getName()
    m.updateMatrixWorld()
    sources.push(m)
    const tex = prim.getMaterial()?.getBaseColorTexture()
    if (tex && !textures.has(m.name)) {
      const { data, info } = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      textures.set(m.name, { data, w: info.width, h: info.height })
    }
  }
}
if (sources.length !== R.sources.length) console.warn(`  ⚠ 只找到 ${sources.length}/${R.sources.length} 个地形 mesh`)

const ray = new Raycaster()
ray.firstHitOnly = true
const DOWN = new Vector3(0, -1, 0)
const origin = new Vector3()
let topY = -Infinity
const bbMin = [Infinity, Infinity]
const bbMax = [-Infinity, -Infinity]
for (const m of sources) {
  m.geometry.computeBoundingBox()
  const b = m.geometry.boundingBox
  topY = Math.max(topY, b.max.y)
  bbMin[0] = Math.min(bbMin[0], b.min.x)
  bbMin[1] = Math.min(bbMin[1], b.min.z)
  bbMax[0] = Math.max(bbMax[0], b.max.x)
  bbMax[1] = Math.max(bbMax[1], b.max.z)
}

/** 从上往下的最高面：{ y, mesh, uv } 或 null */
function topHit(x, z) {
  origin.set(x, topY + 5, z)
  ray.set(origin, DOWN)
  const hits = ray.intersectObjects(sources, false)
  return hits[0] ?? null
}
const sourceByName = new Map(sources.map((m) => [m.name, m]))

/** 世界 xz → uv 的线性拟合（最小二乘）：u = a·x + b·z + c，v 同理 */
function fitUV(m) {
  const pos = m.geometry.getAttribute('position')
  const uv = m.geometry.getAttribute('uv')
  const N = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const ru = [0, 0, 0]
  const rv = [0, 0, 0]
  for (let i = 0; i < pos.count; i++) {
    const r = [pos.getX(i), pos.getZ(i), 1]
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) N[a * 3 + b] += r[a] * r[b]
      ru[a] += r[a] * uv.getX(i)
      rv[a] += r[a] * uv.getY(i)
    }
  }
  const M = new Matrix4().set(N[0], N[1], N[2], 0, N[3], N[4], N[5], 0, N[6], N[7], N[8], 0, 0, 0, 0, 1).invert().elements
  // elements 是列主序；只用左上 3×3
  const solve = (rhs) => [0, 1, 2].map((r) => M[r] * rhs[0] + M[4 + r] * rhs[1] + M[8 + r] * rhs[2])
  return { u: solve(ru), v: solve(rv) }
}

/** repaint 规则展开：源 mesh 名 → 取色函数 (x, z) → rgb */
const repaints = new Map()
for (const [from, rule] of Object.entries(R.repaint ?? {})) {
  const src = sourceByName.get(from)
  const target = sourceByName.get(rule.mesh)
  const tex = textures.get(rule.mesh)
  if (!src || !target || !tex) {
    console.warn(`  ⚠ repaint ${from} → ${rule.mesh}：找不到 mesh 或贴图，跳过`)
    continue
  }
  src.geometry.computeBoundingBox()
  const c = src.geometry.boundingBox.getCenter(new Vector3())
  const { u, v } = fitUV(target)
  repaints.set(from, (x, z) =>
    sampleTexture(tex, rule.at[0] + u[0] * (x - c.x) + u[1] * (z - c.z), rule.at[1] + v[0] * (x - c.x) + v[1] * (z - c.z)),
  )
}

function sampleTexture(t, u, v) {
  // glTF 的 uv 原点在左上，与图像行序一致；双线性
  const x = clamp(u * t.w - 0.5, 0, t.w - 1)
  const y = clamp(v * t.h - 0.5, 0, t.h - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(t.w - 1, x0 + 1)
  const y1 = Math.min(t.h - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const out = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const a = t.data[(y0 * t.w + x0) * 3 + c]
    const b = t.data[(y0 * t.w + x1) * 3 + c]
    const d = t.data[(y1 * t.w + x0) * 3 + c]
    const e = t.data[(y1 * t.w + x1) * 3 + c]
    out[c] = mix(mix(a, b, fx), mix(d, e, fx), fy)
  }
  return out
}

// ---------- 2. 俯视烘焙：手绘颜色 / 覆盖 / 高度 ----------
// 可玩区方框 = 原地形包围盒外扩一点；手绘贴图、细网格都覆盖这个方框
const PAD = 1
const box = { x0: bbMin[0] - PAD, z0: bbMin[1] - PAD, x1: bbMax[0] + PAD, z1: bbMax[1] + PAD }
const bw = box.x1 - box.x0
const bh = box.z1 - box.z0
const PW = Math.round((R.paintRes * Math.min(1, bw / bh)) / 4) * 4
const PH = Math.round((R.paintRes * Math.min(1, bh / bw)) / 4) * 4
const pix = bw / PW

const paint = new Float32Array(PW * PH * 3)
const cover = new Float32Array(PW * PH)
const height = new Float32Array(PW * PH)
// 输出的手绘贴图：在 paint 的基础上按 repaint 换色（paint 本身保持原样，水域按原贴图判定）
const paintOut = new Float32Array(PW * PH * 3)
let repainted = 0
for (let j = 0; j < PH; j++) {
  for (let i = 0; i < PW; i++) {
    const x = box.x0 + ((i + 0.5) / PW) * bw
    const z = box.z0 + ((j + 0.5) / PH) * bh
    const hit = topHit(x, z)
    if (!hit) continue
    const k = j * PW + i
    cover[k] = 1
    height[k] = hit.point.y
    const t = textures.get(hit.object.name)
    if (t && hit.uv) paint.set(sampleTexture(t, hit.uv.x, hit.uv.y), k * 3)
    paintOut.set(paint.subarray(k * 3, k * 3 + 3), k * 3)
    const repaint = repaints.get(hit.object.name)
    if (repaint) {
      paintOut.set(repaint(x, z), k * 3)
      repainted++
    }
  }
}
log(`俯视烘焙 ${PW}×${PH}（${(pix * 100).toFixed(1)}cm/像素）${repainted ? `，换色 ${repainted} 像素` : ''}`)

// ---------- 3. 水域：按贴图颜色找池塘，定水位 ----------
// 池塘是紫色（蓝、红都明显高于绿）；草地哪怕偏蓝也是绿通道占优，按「蓝 − 绿」「红 − 绿」判断比颜色距离稳
const purple = (k) => {
  const r = paint[k * 3]
  const g = paint[k * 3 + 1]
  const b = paint[k * 3 + 2]
  return smoothstep(R.water.blueOverGreen[0], R.water.blueOverGreen[1], b - g) * smoothstep(0, R.water.redOverGreen, r - g)
}

// 水位：明显是池塘色的像素的高度中位数
const strict = []
for (let k = 0; k < PW * PH; k++) if (cover[k] && purple(k) > 0.9) strict.push(height[k])
strict.sort((a, b) => a - b)
if (!strict.length) throw new Error('贴图里没找到池塘色，检查 RULES.water')
const level = strict[Math.floor(strict.length * 0.5)]
log(
  `水位（模型局部 y）= ${level.toFixed(3)}，池塘像素 ${strict.length}，高度 5%–95%：` +
    `${strict[Math.floor(strict.length * 0.05)].toFixed(2)} ~ ${strict[Math.floor(strict.length * 0.95)].toFixed(2)}`,
)

// 水域遮罩：池塘色且在水位附近的高度带里
const raw = (buf) => sharp(buf, { raw: { width: PW, height: PH, channels: 1 } })
const wetRaw = Buffer.alloc(PW * PH)
for (let k = 0; k < PW * PH; k++) {
  if (!cover[k]) continue
  const byHeight = 1 - smoothstep(R.water.band, R.water.band * 1.5, Math.abs(height[k] - level))
  wetRaw[k] = Math.round(purple(k) * byHeight * 255)
}
// 紧挨着水的暗像素也算水：岸边的阴影圈、溪流里汀步留下的黑洞（离水远的暗斑仍是陆地）
const nearWater = await raw(wetRaw).blur(R.water.darkReach / pix / 2).threshold(24).extractChannel(0).raw().toBuffer()
for (let k = 0; k < PW * PH; k++) {
  if (!cover[k] || !nearWater[k]) continue
  const lum = (0.3 * paint[k * 3] + 0.59 * paint[k * 3 + 1] + 0.11 * paint[k * 3 + 2]) / 255
  const dark = 1 - smoothstep(R.water.darkCut, R.water.darkCut * 1.6, lum)
  wetRaw[k] = Math.max(wetRaw[k], Math.round(dark * 255))
}
// 闭运算（先膨胀再腐蚀）：补上剩下的小洞，岸线不变
const closeSigma = R.water.close / pix / 2
const dilated = await raw(wetRaw).blur(closeSigma).threshold(64).extractChannel(0).raw().toBuffer()
const closed = await raw(dilated).blur(closeSigma).threshold(192).extractChannel(0).raw().toBuffer()
// 再轻微模糊，得到平滑的岸线
const wetBlur = await raw(closed).blur(Math.max(0.3, R.water.shore / pix / 2)).extractChannel(0).raw().toBuffer()
const wet = new Float32Array(PW * PH)
for (let k = 0; k < PW * PH; k++) wet[k] = smoothstep(0.3, 0.7, wetBlur[k] / 255) * cover[k]
// 挖池底用更宽的模糊：岸坡跨过好几个网格，水面与地形的交线才是平滑曲线，不是按网格走的锯齿
const bankBlur = await raw(closed).blur(R.water.bank / pix / 2).extractChannel(0).raw().toBuffer()
const bank = new Float32Array(PW * PH)
for (let k = 0; k < PW * PH; k++) bank[k] = (bankBlur[k] / 255) * cover[k]

// ---------- 4. 覆盖区边界点（用于外延高度、手绘渐变、可玩区距离场） ----------
// 在降采样的覆盖图上找边界像素，记录其位置与平滑后的高度
const DS = 4
const CW = Math.floor(PW / DS)
const CH = Math.floor(PH / DS)
const coarseCover = new Uint8Array(CW * CH)
const coarseH = new Float32Array(CW * CH)
for (let j = 0; j < CH; j++) {
  for (let i = 0; i < CW; i++) {
    let c = 0
    let hs = 0
    for (let dj = 0; dj < DS; dj++) {
      for (let di = 0; di < DS; di++) {
        const k = (j * DS + dj) * PW + i * DS + di
        if (cover[k]) {
          c++
          hs += height[k]
        }
      }
    }
    coarseCover[j * CW + i] = c > (DS * DS) / 2 ? 1 : 0
    coarseH[j * CW + i] = c ? hs / c : 0
  }
}
const edge = []
for (let j = 0; j < CH; j++) {
  for (let i = 0; i < CW; i++) {
    if (!coarseCover[j * CW + i]) continue
    const out = (ii, jj) => ii < 0 || jj < 0 || ii >= CW || jj >= CH || !coarseCover[jj * CW + ii]
    if (out(i - 1, j) || out(i + 1, j) || out(i, j - 1) || out(i, j + 1)) {
      edge.push({ x: box.x0 + ((i + 0.5) / CW) * bw, z: box.z0 + ((j + 0.5) / CH) * bh, y: coarseH[j * CW + i] })
    }
  }
}
// 边界高度沿边界平滑（半径 1.5m），裙边从这里接出去才不会有锯齿状的台阶
{
  const r2 = 1.5 * 1.5
  const ys = edge.map((p) => {
    let s = 0
    let n = 0
    for (const q of edge) {
      if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < r2) {
        s += q.y
        n++
      }
    }
    return s / n
  })
  edge.forEach((p, i) => (p.y = ys[i]))
}
const edgeMean = edge.reduce((s, p) => s + p.y, 0) / edge.length
log(`边界点 ${edge.length}，平均高度 ${edgeMean.toFixed(2)}`)

// ---------- 4b. 水面高度场 ----------
// 原池塘不是一个水平面（北池高、南边溪流一路往下），水面高度 = 原池面高度在水域内的平滑平均。
// 归一化卷积：blur(高度 × 水域) / blur(水域)，岸边也有定义（岸线外一点点，水面要伸进岸里藏住边）
function gaussBlur(src, w, h, sigma) {
  const r = Math.ceil(sigma * 3)
  const kernel = []
  let ks = 0
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel.push(v)
    ks += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ks
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0
      for (let q = -r; q <= r; q++) s += src[j * w + clamp(i + q, 0, w - 1)] * kernel[q + r]
      tmp[j * w + i] = s
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0
      for (let q = -r; q <= r; q++) s += tmp[clamp(j + q, 0, h - 1) * w + i] * kernel[q + r]
      out[j * w + i] = s
    }
  }
  return out
}
const coarseWet = new Float32Array(CW * CH)
for (let j = 0; j < CH; j++) {
  for (let i = 0; i < CW; i++) {
    let s = 0
    for (let dj = 0; dj < DS; dj++) for (let di = 0; di < DS; di++) s += wet[(j * DS + dj) * PW + i * DS + di]
    coarseWet[j * CW + i] = s / (DS * DS)
  }
}
const cellSize = bw / CW
// 只用不高于最高池面的像素估水面：石脊的阴影也被算进了水域，它的高度不能混进来
const surfaceW = coarseWet.map((w, k) => (coarseH[k] <= level + R.water.surfaceTol ? w : 0))
const wetNum = gaussBlur(coarseH.map((h, k) => h * surfaceW[k]), CW, CH, R.water.smooth / cellSize)
const wetDen = gaussBlur(surfaceW, CW, CH, R.water.smooth / cellSize)
/** 水面高度（模型局部 y）；附近没有水返回 null */
function waterAt(x, z) {
  if (!inBox(x, z)) return null
  const px = ((x - box.x0) / bw) * CW
  const pz = ((z - box.z0) / bh) * CH
  const den = sampleGrid(wetDen, CW, CH, px, pz)
  // 比原池面低一点：和池面一样高的平地（南边溪流两岸）留在水面之上，岸线落在挖出的缓坡上，不和地面打架
  return den > 0.002 ? sampleGrid(wetNum, CW, CH, px, pz) / den - R.water.drop : null
}

// 边界点空间哈希：最近点查询
const CELL = 2
const hashGrid = new Map()
for (const p of edge) {
  const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`
  const list = hashGrid.get(key)
  if (list) list.push(p)
  else hashGrid.set(key, [p])
}
/** 最近边界点：{ p, d }；先搜附近格子，搜不到再扩大 */
function nearestEdge(x, z) {
  const cx = Math.floor(x / CELL)
  const cz = Math.floor(z / CELL)
  let best = null
  let bd = Infinity
  for (let r = 0; r < 200; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const list = hashGrid.get(`${cx + dx},${cz + dz}`)
        if (!list) continue
        for (const p of list) {
          const d = (p.x - x) ** 2 + (p.z - z) ** 2
          if (d < bd) {
            bd = d
            best = p
          }
        }
      }
    }
    // 找到之后再多搜一圈即可保证最近（格子尺寸内的误差）
    if (best && (r - 1) * CELL > Math.sqrt(bd)) break
  }
  return { p: best, d: Math.sqrt(bd) }
}

// ---------- 5. 高度函数 ----------
const inBox = (x, z) => x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1
const paintPx = (x, z) => [((x - box.x0) / bw) * PW, ((z - box.z0) / bh) * PH]
const isCovered = (x, z) => {
  if (!inBox(x, z)) return false
  const [px, pz] = paintPx(x, z)
  return sampleGrid(cover, PW, PH, px, pz) > 0.5
}

// 可复现的随机数（mulberry32）：重跑脚本结果一致
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const boxCx = (box.x0 + box.x1) / 2
const boxCz = (box.z0 + box.z1) / 2

// 中景圆丘（参考图里池塘后面那几座长着树的绿色小山）：离岛边 near~far 米，越远越高越大
const mounds = []
{
  const M = R.far.mounds
  const rand = rng(M.seed)
  for (let tries = 0; tries < 4000 && mounds.length < M.count; tries++) {
    const a = rand() * Math.PI * 2
    const r = 20 + rand() * (M.far + 40)
    const x = boxCx + Math.cos(a) * r
    const z = boxCz + Math.sin(a) * r
    if (isCovered(x, z)) continue
    const { d } = nearestEdge(x, z)
    if (d < M.near || d > M.far) continue
    const k = (d - M.near) / (M.far - M.near)
    const radius = mix(M.radius[0], M.radius[1], k) * (0.8 + rand() * 0.4)
    if (mounds.some((q) => Math.hypot(q.x - x, q.z - z) < (q.radius + radius) * 0.55)) continue
    mounds.push({ x, z, radius, height: mix(M.height[0], M.height[1], k) * (0.7 + rand() * 0.6), d })
  }
}
/** 圆丘叠加高度：顶部圆润（(1 − r²)² 的圆顶，不是尖锥） */
function moundAt(x, z) {
  let h = 0
  for (const q of mounds) {
    const r2 = ((x - q.x) ** 2 + (z - q.z) ** 2) / (q.radius * q.radius)
    if (r2 < 1) h += q.height * (1 - r2) * (1 - r2) * (1 + 0.25 * fbm(x * 0.12 + q.x, z * 0.12 + q.z, 2))
  }
  return h
}

/**
 * 地形高度与遮罩：{ y, collide(碰撞高度), water(水面高度或 null), carve(挖池底权重), paint(原地形范围权重), wet(水域) }
 * 陆地一律保持原模型高度（植物、石头都是按原地形摆的）；只在原池面上往下挖池底。
 */
function terrainAt(x, z) {
  const covered = isCovered(x, z)
  const { p, d } = nearestEdge(x, z)
  if (covered) {
    const hit = topHit(x, z)
    const y0 = hit ? hit.point.y : p.y
    const [px, pz] = paintPx(x, z)
    const w = sampleGrid(wet, PW, PH, px, pz)
    const b = sampleGrid(bank, PW, PH, px, pz)
    const water = waterAt(x, z)
    // 只挖原来就是池面的地方：高出水面的（横跨池塘的石脊）不动
    const carve = water !== null && b > 0.02 && y0 <= water + R.water.surfaceTol ? smoothstep(0.35, 0.85, b) : 0
    const y = mix(y0, Math.min(y0, (water ?? y0) - R.water.bedDepth), carve)
    // 碰撞按水面走：和原来一样能走过池塘（原池面本来就是平的，玩家一直是踩着它走的）
    const collide = carve > 0 ? Math.max(y, water) : y
    return { y, collide, water, carve, paint: smoothstep(0, R.paintFade, d), wet: w }
  }
  // 裙边：从边界高度过渡到远处起伏的地貌
  // 边界高度不能只取最近的一个点（相邻顶点取到不同的点会出现台阶），按「比最近距离远多少」加权平均一片
  const sigma = 1 + d * 0.35
  let ws = 0
  let hs = 0
  for (const q of edge) {
    const dq = Math.sqrt((q.x - x) ** 2 + (q.z - z) ** 2) - d
    if (dq > sigma * 3) continue
    const w = Math.exp(-(dq * dq) / (2 * sigma * sigma))
    ws += w
    hs += w * q.y
  }
  const edgeY = ws > 0 ? hs / ws : p.y
  const t = smoothstep(0, R.far.blend, d)
  const hills = fbm(x * 0.03, z * 0.03, 4) * R.far.hills * smoothstep(3, 35, d)
  const bumps = fbm(x * 0.18, z * 0.18, 3) * 0.25 * smoothstep(0, 6, d)
  const far = edgeMean + R.far.rise * smoothstep(R.far.riseStart, R.far.riseEnd, d) + hills
  const y = mix(edgeY, far, t) + bumps + moundAt(x, z)
  return { y, collide: y, water: null, carve: 0, paint: 0, wet: 0 }
}

// ---------- 6. 网格：可玩区等间距，外面逐圈放大 ----------
function axis(a0, a1) {
  const inner = []
  const n = Math.ceil((a1 - a0) / R.step)
  for (let i = 0; i <= n; i++) inner.push(a0 + ((a1 - a0) * i) / n)
  const lo = []
  const hi = []
  let s = R.step
  let a = a0
  let b = a1
  while (a0 - a < R.reach) {
    s *= R.grow
    a -= s
    b += s
    lo.unshift(a)
    hi.push(b)
  }
  return { coords: [...lo, ...inner, ...hi], innerStart: lo.length, innerEnd: lo.length + n }
}
const ax = axis(box.x0, box.x1)
const az = axis(box.z0, box.z1)
const NX = ax.coords.length
const NZ = az.coords.length
const pos = new Float32Array(NX * NZ * 3)
const posCollide = new Float32Array(NX * NZ * 3)
const uv = new Float32Array(NX * NZ * 2)
const mask = new Uint8Array(NX * NZ * 4)
const waterY = new Float32Array(NX * NZ).fill(NaN)
const carveW = new Float32Array(NX * NZ)
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const x = ax.coords[i]
    const z = az.coords[j]
    const v = terrainAt(x, z)
    const k = j * NX + i
    pos.set([x, v.y, z], k * 3)
    posCollide.set([x, v.collide, z], k * 3)
    uv.set([(x - box.x0) / bw, (z - box.z0) / bh], k * 2)
    mask.set([Math.round(v.paint * 255), Math.round(v.wet * 255), 0, 255], k * 4)
    if (v.water !== null) waterY[k] = v.water
    carveW[k] = v.carve
  }
}
log(`地形网格 ${NX}×${NZ} = ${NX * NZ} 顶点，外延 ${R.reach}m`)

// 法线：用完整网格一次算好，拆成两块之后接缝处法线一致
const full = new BufferGeometry()
full.setAttribute('position', new BufferAttribute(pos, 3))
const fullIndex = []
for (let j = 0; j < NZ - 1; j++) {
  for (let i = 0; i < NX - 1; i++) {
    const a = j * NX + i
    const b = a + 1
    const c = a + NX
    const d = c + 1
    // 逆时针朝上（+y）
    fullIndex.push(a, c, b, b, c, d)
  }
}
full.setIndex(fullIndex)
full.computeVertexNormals()
const normal = full.getAttribute('normal').array

/** 按四边形所在范围拆成 play / far 两块，各自压缩顶点（positions 可换成碰撞高度） */
function extract(pred, positions = pos) {
  const remap = new Int32Array(NX * NZ).fill(-1)
  const idx = []
  const P = []
  const N = []
  const U = []
  const M = []
  const use = (k) => {
    if (remap[k] < 0) {
      remap[k] = P.length / 3
      P.push(positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2])
      N.push(normal[k * 3], normal[k * 3 + 1], normal[k * 3 + 2])
      U.push(uv[k * 2], uv[k * 2 + 1])
      M.push(mask[k * 4], mask[k * 4 + 1], mask[k * 4 + 2], mask[k * 4 + 3])
    }
    return remap[k]
  }
  for (let j = 0; j < NZ - 1; j++) {
    for (let i = 0; i < NX - 1; i++) {
      if (!pred(i, j)) continue
      const a = j * NX + i
      const b = a + 1
      const c = a + NX
      const d = c + 1
      idx.push(use(a), use(c), use(b), use(b), use(c), use(d))
    }
  }
  return {
    position: new Float32Array(P),
    normal: new Float32Array(N),
    uv: new Float32Array(U),
    mask: new Uint8Array(M),
    index: new Uint32Array(idx),
  }
}
const inner = (i, j) => i >= ax.innerStart && i < ax.innerEnd && j >= az.innerStart && j < az.innerEnd
const play = extract(inner)
const far = extract((i, j) => !inner(i, j))
const playCollide = extract(inner, posCollide)

// ---------- 6b. 水面网格：只盖挖过池底的格子，高度跟着原池面；顶点带水深（运行时算深浅色 / 岸边泡沫） ----------
const water = (() => {
  const remap = new Int32Array(NX * NZ).fill(-1)
  const P = []
  const D = []
  const idx = []
  const use = (k) => {
    if (remap[k] < 0) {
      remap[k] = P.length / 3
      P.push(pos[k * 3], waterY[k], pos[k * 3 + 2])
      D.push(Math.max(0, waterY[k] - pos[k * 3 + 1]))
    }
    return remap[k]
  }
  for (let j = az.innerStart; j < az.innerEnd; j++) {
    for (let i = ax.innerStart; i < ax.innerEnd; i++) {
      const a = j * NX + i
      const q = [a, a + 1, a + NX, a + NX + 1]
      // 四个角都要有水面高度；至少一个角挖过池底，或地面比水面低（水要一直铺到岸盖住它为止，否则水面边缘会露出网格锯齿）
      if (q.some((k) => Number.isNaN(waterY[k]))) continue
      if (q.every((k) => carveW[k] <= 0 && pos[k * 3 + 1] >= waterY[k])) continue
      idx.push(use(q[0]), use(q[2]), use(q[1]), use(q[1]), use(q[2]), use(q[3]))
    }
  }
  const normal = new Float32Array(P.length)
  for (let i = 1; i < normal.length; i += 3) normal[i] = 1
  return { position: new Float32Array(P), normal, depth: new Float32Array(D), index: new Uint32Array(idx) }
})()
// 水位：水面顶点高度的中位数（实时反射平面放在这里；多级水面的其它部分反射会略有偏差）
const levels = [...water.position.filter((_, i) => i % 3 === 1)].sort((a, b) => a - b)
const mainLevel = levels[Math.floor(levels.length / 2)]
log(`水面网格 ${water.position.length / 3} 顶点，高度 ${levels[0].toFixed(2)} ~ ${levels[levels.length - 1].toFixed(2)}，主水位 ${mainLevel.toFixed(3)}`)

// ---------- 6c. 远景尖峰：参考图背景的石林状山峰，一圈成簇的尖锥 ----------
// 单独一个 mesh（运行时用不吃雾的「空气透视」材质，远到雾里也能看见轮廓）。
// 顶点色 r = 高度比例（0 = 山脚，1 = 峰顶），运行时据此从雾色渐变到山色。
const peaks = (() => {
  const Pk = R.far.peaks
  const rand = rng(Pk.seed)
  const P = []
  const C = []
  const idx = []
  const RINGS = 24
  const SEG = 20
  function spire(cx, cz, height, radius) {
    const base = P.length / 3
    // 轮廓：超椭圆 r = (1 − tᵉ)^(1/e) 再乘向上收窄。e 越大侧面越直、顶越钝；
    // 取 1.3–2 之间 + taper：陡峭、往上收、顶部圆钝（参考图的喀斯特山），既不是尖锥也不是馒头
    const e = 1.3 + rand() * 0.7
    const taper = 0.35 + rand() * 0.25
    const leanA = rand() * Math.PI * 2
    const lean = (rand() - 0.3) * 0.08 * height
    const seed = rand() * 100
    const y0 = edgeMean - 8
    for (let k = 0; k <= RINGS; k++) {
      const t = k / RINGS
      const ox = Math.cos(leanA) * lean * t * t
      const oz = Math.sin(leanA) * lean * t * t
      for (let s = 0; s < SEG; s++) {
        const a = (s / SEG) * Math.PI * 2
        // 在圆周上取噪声，首尾无缝；越往上起伏越小
        const n = fbm(Math.cos(a) * 1.4 + seed, Math.sin(a) * 1.4 + t * 2.5, 3)
        // 竖向棱脊：高频的「山脊」噪声（|噪声| 翻折），剪影是参差的石林而不是光滑圆锥
        const ridge = 1 - Math.abs(fbm(Math.cos(a) * 4.5 + seed * 2, Math.sin(a) * 4.5 + t * 1.2, 3)) * 2
        const profile = Math.pow(Math.max(0, 1 - Math.pow(t, e)), 1 / e) * (1 - taper * t)
        const r = k === RINGS ? 0 : radius * profile * (1 + 0.3 * n + 0.15 * ridge)
        P.push(cx + ox + Math.cos(a) * r, y0 + t * (height + 8), cz + oz + Math.sin(a) * r)
        C.push(Math.round(t * 255), 0, 0, 255)
      }
    }
    for (let k = 0; k < RINGS; k++) {
      for (let s = 0; s < SEG; s++) {
        const a = base + k * SEG + s
        const b = base + k * SEG + ((s + 1) % SEG)
        const c = a + SEG
        const d = b + SEG
        idx.push(a, c, b, b, c, d)
      }
    }
  }
  for (let i = 0; i < Pk.clusters; i++) {
    // 大致均匀地绕一圈，留一些缺口（gap 概率），山不是一堵墙
    if (rand() < Pk.gap * 0.35) continue
    const a = ((i + rand() * 0.6) / Pk.clusters) * Math.PI * 2
    const dist = mix(Pk.distance[0], Pk.distance[1], rand())
    const cx = boxCx + Math.cos(a) * dist
    const cz = boxCz + Math.sin(a) * dist
    const h = mix(Pk.height[0], Pk.height[1], rand())
    const r = mix(Pk.radius[0], Pk.radius[1], rand())
    spire(cx, cz, h, r)
    // 主峰旁边 1–3 座小峰
    const n = 1 + Math.floor(rand() * 3)
    for (let j = 0; j < n; j++) {
      const aa = rand() * Math.PI * 2
      const off = r * (0.8 + rand() * 1.2)
      spire(cx + Math.cos(aa) * off, cz + Math.sin(aa) * off, h * (0.35 + rand() * 0.45), r * (0.45 + rand() * 0.35))
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(P), 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return {
    position: new Float32Array(P),
    normal: new Float32Array(geo.getAttribute('normal').array),
    color: new Uint8Array(C),
    index: new Uint32Array(idx),
  }
})()
log(`远景尖峰 ${peaks.position.length / 3} 顶点，中景圆丘 ${mounds.length} 座`)

// ---------- 7. 手绘贴图：覆盖区外用 push-pull 填色，边缘双线性不会渗黑 ----------
function pushPull(rgb, alpha, w, h) {
  if (w <= 1 && h <= 1) return
  const w2 = Math.max(1, w >> 1)
  const h2 = Math.max(1, h >> 1)
  const rgb2 = new Float32Array(w2 * h2 * 3)
  const a2 = new Float32Array(w2 * h2)
  for (let j = 0; j < h2; j++) {
    for (let i = 0; i < w2; i++) {
      let s = 0
      const c = [0, 0, 0]
      for (let dj = 0; dj < 2; dj++) {
        for (let di = 0; di < 2; di++) {
          const x = Math.min(w - 1, i * 2 + di)
          const y = Math.min(h - 1, j * 2 + dj)
          const k = y * w + x
          const a = alpha[k]
          s += a
          for (let q = 0; q < 3; q++) c[q] += rgb[k * 3 + q] * a
        }
      }
      const k2 = j * w2 + i
      a2[k2] = Math.min(1, s)
      if (s > 0) for (let q = 0; q < 3; q++) rgb2[k2 * 3 + q] = c[q] / s
    }
  }
  pushPull(rgb2, a2, w2, h2)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i
      const a = alpha[k]
      if (a >= 1) continue
      const k2 = Math.min(h2 - 1, j >> 1) * w2 + Math.min(w2 - 1, i >> 1)
      for (let q = 0; q < 3; q++) rgb[k * 3 + q] = rgb[k * 3 + q] * a + rgb2[k2 * 3 + q] * (1 - a)
    }
  }
}
pushPull(paintOut, cover.slice(), PW, PH)
const paintRGB = Buffer.alloc(PW * PH * 3)
for (let k = 0; k < PW * PH * 3; k++) paintRGB[k] = Math.round(clamp(paintOut[k], 0, 255))
const paintJpg = await sharp(paintRGB, { raw: { width: PW, height: PH, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()
log(`手绘贴图 ${PW}×${PH}`)

// ---------- 8. 可玩区距离场（正 = 在原地形覆盖范围内，单位米） ----------
const B = R.boundary
const sdfBox = { x0: box.x0 - B.margin, z0: box.z0 - B.margin, x1: box.x1 + B.margin, z1: box.z1 + B.margin }
const SW = Math.ceil((sdfBox.x1 - sdfBox.x0) / B.res)
const SH = Math.ceil((sdfBox.z1 - sdfBox.z0) / B.res)
const sdfRG = Buffer.alloc(SW * SH * 3)
for (let j = 0; j < SH; j++) {
  for (let i = 0; i < SW; i++) {
    const x = sdfBox.x0 + ((i + 0.5) / SW) * (sdfBox.x1 - sdfBox.x0)
    const z = sdfBox.z0 + ((j + 0.5) / SH) * (sdfBox.z1 - sdfBox.z0)
    const d = nearestEdge(x, z).d * (isCovered(x, z) ? 1 : -1)
    const v = Math.round(clamp((d + B.range) / (2 * B.range), 0, 1) * 65535)
    const k = (j * SW + i) * 3
    sdfRG[k] = v >> 8
    sdfRG[k + 1] = v & 255
  }
}
log(`可玩区距离场 ${SW}×${SH}`)

// ---------- 8b. 程序化草密度图（Grass.tsx 用，格式同 bake-grass-mask.mjs） ----------
// 岛内满密度，出岛 fadeOut 米内渐隐（草的高度来自碰撞体，碰撞体只盖可玩区方框）；水里和岸坡不长
const G = R.grass
const GW = G.res
const GH = Math.round((G.res * bh) / bw)
const grassPx = Buffer.alloc(GW * GH)
for (let j = 0; j < GH; j++) {
  for (let i = 0; i < GW; i++) {
    const x = box.x0 + ((i + 0.5) / GW) * bw
    const z = box.z0 + ((j + 0.5) / GH) * bh
    const d = nearestEdge(x, z).d * (isCovered(x, z) ? 1 : -1)
    const [px, pz] = paintPx(x, z)
    const dry = 1 - smoothstep(0.02, 0.3, sampleGrid(bank, PW, PH, px, pz))
    grassPx[j * GW + i] = Math.round(smoothstep(-G.fadeOut, 0, d) * dry * 255)
  }
}
await sharp(grassPx, { raw: { width: GW, height: GH, channels: 1 } }).blur(1).png().toFile(join(OUT_RENDER, `${name}.terrain.grass.png`))
writeFileSync(join(OUT_RENDER, `${name}.terrain.grass.json`), JSON.stringify({ min: [box.x0, box.z0], size: [bw, bh] }, null, 2) + '\n')
log(`草密度图 ${GW}×${GH}`)

// ---------- 9. 写文件 ----------
mkdirSync(OUT_ART, { recursive: true })

/** 水面网格加进文档（自定义属性 _DEPTH = 水深，米） */
function addWater(doc) {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const scene = doc.getRoot().listScenes()[0] ?? doc.createScene(name)
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer)
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', water.position))
    .setAttribute('NORMAL', acc('VEC3', water.normal))
    .setAttribute('_DEPTH', acc('SCALAR', water.depth))
    .setIndices(acc('SCALAR', water.index))
    .setMaterial(doc.createMaterial(`${name}_water`).setBaseColorFactor([0.3, 0.45, 0.6, 1]))
  scene.addChild(doc.createNode('water').setMesh(doc.createMesh('water').addPrimitive(prim)))
  return doc
}

function buildTerrainDoc(withTexture, playGeometry = play) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene(name)
  const mat = doc.createMaterial(`${name}_terrain`).setRoughnessFactor(0.92).setMetallicFactor(0)
  if (withTexture) mat.setBaseColorTexture(doc.createTexture(`${name}_terrain_paint`).setMimeType('image/jpeg').setImage(paintJpg))
  for (const [nodeName, g] of [['terrain_play', playGeometry], ['terrain_far', far]]) {
    const acc = (type, arr, normalized = false) =>
      doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer).setNormalized(normalized)
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', acc('VEC3', g.position))
      .setAttribute('NORMAL', acc('VEC3', g.normal))
      .setAttribute('TEXCOORD_0', acc('VEC2', g.uv))
      .setAttribute('COLOR_0', acc('VEC4', g.mask, true))
      .setIndices(acc('SCALAR', g.index))
      .setMaterial(mat)
    scene.addChild(doc.createNode(nodeName).setMesh(doc.createMesh(nodeName).addPrimitive(prim)))
  }
  // 远景尖峰：单独材质（运行时换成空气透视材质）；clusters = 0 时不生成
  if (!peaks.index.length) return doc
  const acc = (type, arr, normalized = false) =>
    doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer).setNormalized(normalized)
  const peakPrim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', peaks.position))
    .setAttribute('NORMAL', acc('VEC3', peaks.normal))
    .setAttribute('COLOR_0', acc('VEC4', peaks.color, true))
    .setIndices(acc('SCALAR', peaks.index))
    .setMaterial(doc.createMaterial(`${name}_peaks`).setBaseColorFactor([0.66, 0.6, 0.75, 1]))
  scene.addChild(doc.createNode('terrain_peaks').setMesh(doc.createMesh('terrain_peaks').addPrimitive(peakPrim)))
  return doc
}

// 未压缩版（Blender 用，含水面）+ 水域遮罩预览（检查池塘识别得对不对）
await io.write(join(OUT_ART, `${name}.terrain.glb`), addWater(buildTerrainDoc(true)))
// 水面单独一个文件（很小，不压缩：Draco 对自定义属性支持不稳）
await io.write(join(OUT_RENDER, `${name}.water.glb`), addWater(new Document()))
{
  const preview = Buffer.alloc(PW * PH * 3)
  for (let k = 0; k < PW * PH; k++) {
    const w = wet[k]
    for (let q = 0; q < 3; q++) preview[k * 3 + q] = Math.round(mix(paintRGB[k * 3 + q] * 0.6, [60, 160, 255][q], w))
  }
  await sharp(preview, { raw: { width: PW, height: PH, channels: 3 } }).resize(712).png().toFile(join(OUT_ART, `${name}.terrain.water.png`))
}

// 渲染版
const renderDoc = buildTerrainDoc(true)
await renderDoc.transform(
  hasKTX
    ? toktx({ encoder: sharp, mode: 'etc1s', quality: 200, compression: 2 })
    : textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 85 }),
  // 两块共用同一个量化网格（默认按 mesh 各自量化，交界处的顶点会错开，露出一条缝）
  draco({ quantizationVolume: 'scene', quantizePosition: 16 }),
)
await io.write(join(OUT_RENDER, `${name}.terrain.glb`), renderDoc)

// 碰撞体：新地形可玩区（池塘处按水面高度）+ 原模型里的石头 / 汀步
const colDoc = buildTerrainDoc(false, playCollide)
const colScene = colDoc.getRoot().listScenes()[0]
for (const node of colDoc.getRoot().listNodes()) if (['terrain_far', 'terrain_peaks'].includes(node.getName())) node.dispose()
const colBuffer = colDoc.getRoot().listBuffers()[0]
for (const node of srcDoc.getRoot().listNodes()) {
  const mesh = node.getMesh()
  if (!mesh || !R.keepInCollider.includes(mesh.getName())) continue
  const m = new Matrix4().fromArray(node.getWorldMatrix())
  const out = colDoc.createMesh(mesh.getName())
  for (const prim of mesh.listPrimitives()) {
    const p = prim.getAttribute('POSITION').getArray().slice()
    const v = new Vector3()
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m)
      p[i] = v.x
      p[i + 1] = v.y
      p[i + 2] = v.z
    }
    const np = colDoc.createPrimitive().setAttribute('POSITION', colDoc.createAccessor().setType('VEC3').setArray(p).setBuffer(colBuffer))
    const idx = prim.getIndices()
    if (idx) np.setIndices(colDoc.createAccessor().setType('SCALAR').setArray(idx.getArray().slice()).setBuffer(colBuffer))
    out.addPrimitive(np)
  }
  colScene.addChild(colDoc.createNode(mesh.getName()).setMesh(out))
}
for (const mesh of colDoc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    prim.setMaterial(null)
    for (const sem of prim.listSemantics()) if (sem !== 'POSITION') prim.setAttribute(sem, null)
  }
}
await MeshoptSimplifier.ready
await colDoc.transform(prune(), flatten(), joinMeshes({ keepNamed: false }), weld({ tolerance: 0.0001 }))
const tris = colDoc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((s, p) => s + p.getIndices().getCount() / 3, 0)
if (tris > R.colliderTriangles) {
  await colDoc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: R.colliderTriangles / tris, error: 0.005 }))
}
await colDoc.transform(prune(), draco())
await io.write(join(OUT_COLLIDER, `${name}.terrain.glb`), colDoc)

// 距离场 + 元数据
await sharp(sdfRG, { raw: { width: SW, height: SH, channels: 3 } }).png().toFile(join(OUT_RENDER, `${name}.terrain.bounds.png`))
writeFileSync(
  join(OUT_RENDER, `${name}.terrain.bounds.json`),
  JSON.stringify({ min: [sdfBox.x0, sdfBox.z0], size: [sdfBox.x1 - sdfBox.x0, sdfBox.z1 - sdfBox.z0], range: B.range }, null, 2) + '\n',
)
writeFileSync(
  join(OUT_RENDER, `${name}.terrain.json`),
  JSON.stringify(
    {
      // 模型局部 y；config 的 water.level = 这个 × env.scale + env.position.y（实时反射平面的高度）
      waterLevel: mainLevel,
      waterRange: [levels[0], levels[levels.length - 1]],
      box: { min: [box.x0, box.z0], max: [box.x1, box.z1] },
      edgeMean,
      // 中景圆丘（模型局部 x/z、半径、高度），build-scatter.mjs 在丘顶种树
      mounds,
    },
    null,
    2,
  ) + '\n',
)

log('完成')
console.log(`  water    → ${join(OUT_RENDER, `${name}.water.glb`)}（${water.index.length / 3} 三角面）`)
console.log(`  render   → ${join(OUT_RENDER, `${name}.terrain.glb`)}（play ${play.index.length / 3} / far ${far.index.length / 3} 三角面）`)
console.log(`  collider → ${join(OUT_COLLIDER, `${name}.terrain.glb`)}`)
console.log(`  blender  → ${join(OUT_ART, `${name}.terrain.glb`)}`)
