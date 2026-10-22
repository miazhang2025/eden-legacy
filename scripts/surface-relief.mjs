// 表面起伏：低模图元细分后，按底色贴图的亮度沿法线做位移（亮 = 凸），把贴图里画的纹路（如笠螺的放射纹）变成真实的凹凸。
//   细分用 Phong 曲面插值（新点往两端顶点的切平面上拉），细分后外形是圆的，不会露出原来的大平面
//   同一位置的顶点（UV 接缝两侧）共用法线和位移，接缝不会裂开；位移完重算平滑法线

import sharp from 'sharp'
import { smoothNormals } from './smooth-normals.mjs'

/** 位置量化精度（模型局部单位）：小于它的位置差视为同一点 */
const EPSILON = 1e-4
/** Phong 插值强度（0 = 平面细分，1 = 完全拉到切平面） */
const PHONG = 0.75

/**
 * @param {import('@gltf-transform/core').Document} doc
 * @param {import('@gltf-transform/core').Primitive} prim
 * @param {{ levels: number, amplitude: number, blur?: number, detail?: number, detailSigma?: number }} opts
 *   levels：细分次数（每次三角面 ×4）；amplitude：亮度 0→1 对应的位移（模型局部单位）；blur：贴图先模糊（像素），去掉噪点
 *   detail：局部细节的位移（亮度减去 detailSigma 像素大范围模糊后的差，0→1 对应的位移）：
 *     整体亮度差不多的区域（如笠螺的蓝色面）也按纹路凹凸，不只是亮暗两大块有高低
 */
export async function addRelief(doc, prim, { levels, amplitude, blur = 2, detail = 0, detailSigma = 24 }) {
  const posAcc = prim.getAttribute('POSITION')
  const uvAcc = prim.getAttribute('TEXCOORD_0')
  const nAcc = prim.getAttribute('NORMAL')
  const tex = prim.getMaterial()?.getBaseColorTexture()
  if (!posAcc || !uvAcc || !nAcc || !tex) throw new Error('表面起伏需要 POSITION / NORMAL / TEXCOORD_0 和底色贴图')
  const extra = prim.listSemantics().filter((s) => !['POSITION', 'NORMAL', 'TEXCOORD_0'].includes(s))
  if (extra.length) throw new Error(`表面起伏只处理 POSITION / NORMAL / TEXCOORD_0，图元还带了 ${extra.join(', ')}`)

  const n0 = posAcc.getCount()
  const P = []
  const N = []
  const UV = []
  const G = []
  const v3 = [0, 0, 0]
  const v2 = [0, 0]
  const groupKeys = new Map()
  for (let i = 0; i < n0; i++) {
    const p = posAcc.getElement(i, v3).slice()
    P.push(p)
    N.push(nAcc.getElement(i, v3).slice())
    UV.push(uvAcc.getElement(i, v2).slice())
    const k = p.map((x) => Math.round(x / EPSILON)).join()
    if (!groupKeys.has(k)) groupKeys.set(k, groupKeys.size)
    G.push(groupKeys.get(k))
  }
  // 位置组：共用位置 / 法线（原法线平均）
  const gPos = []
  const gNor = []
  for (let i = 0; i < n0; i++) {
    const g = G[i]
    gPos[g] ??= P[i]
    const s = (gNor[g] ??= [0, 0, 0])
    const len = Math.hypot(...N[i]) || 1
    for (let c = 0; c < 3; c++) s[c] += N[i][c] / len
  }
  const norm = (v) => {
    const l = Math.hypot(...v) || 1
    return v.map((x) => x / l)
  }
  for (let g = 0; g < gNor.length; g++) gNor[g] = norm(gNor[g])

  const idx = prim.getIndices()
  let tris = []
  const corners = idx ? idx.getCount() : n0
  for (let t = 0; t < corners; t++) tris.push(idx ? idx.getScalar(t) : t)

  // 细分：每条边取中点（按位置组算，接缝两侧算出来的位置一样），一个三角形拆成四个
  const midGroup = new Map()
  for (let level = 0; level < levels; level++) {
    const midVert = new Map()
    const mid = (i, j) => {
      const vk = i < j ? `${i},${j}` : `${j},${i}`
      let m = midVert.get(vk)
      if (m !== undefined) return m
      const gi = G[i]
      const gj = G[j]
      const gk = gi < gj ? `${gi},${gj}` : `${gj},${gi}`
      let g = midGroup.get(gk)
      if (g === undefined) {
        const a = gPos[gi]
        const b = gPos[gj]
        const na = gNor[gi]
        const nb = gNor[gj]
        const p = [0, 1, 2].map((c) => (a[c] + b[c]) / 2)
        const da = (p[0] - a[0]) * na[0] + (p[1] - a[1]) * na[1] + (p[2] - a[2]) * na[2]
        const db = (p[0] - b[0]) * nb[0] + (p[1] - b[1]) * nb[1] + (p[2] - b[2]) * nb[2]
        const q = [0, 1, 2].map((c) => p[c] + PHONG * (-(da * na[c] + db * nb[c]) / 2))
        g = gPos.length
        gPos.push(q)
        gNor.push(norm([0, 1, 2].map((c) => na[c] + nb[c])))
        midGroup.set(gk, g)
      }
      m = P.length
      P.push(gPos[g])
      N.push(gNor[g])
      UV.push([(UV[i][0] + UV[j][0]) / 2, (UV[i][1] + UV[j][1]) / 2])
      G.push(g)
      midVert.set(vk, m)
      return m
    }
    const next = []
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]]
      const ab = mid(a, b)
      const bc = mid(b, c)
      const ca = mid(c, a)
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca)
    }
    tris = next
  }

  // 贴图亮度 → 高度（双线性采样，UV 重复平铺）
  const meta = await sharp(tex.getImage()).metadata()
  const w = meta.width
  const h = meta.height
  const grey = await sharp(tex.getImage()).removeAlpha().greyscale().raw().toBuffer()
  const raw = { raw: { width: w, height: h, channels: 1 } }
  const lum = blur > 0.3 ? await sharp(grey, raw).blur(blur).raw().toBuffer() : grey
  const low = detail ? await sharp(grey, raw).blur(detailSigma).raw().toBuffer() : null
  // 高度图：整体亮度 × amplitude + 局部细节 × detail（单位已经是位移）
  const height = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) height[i] = (lum[i] / 255) * amplitude + (low ? ((lum[i] - low[i]) / 255) * detail : 0)
  const sample = ([u, v]) => {
    const x = (((u % 1) + 1) % 1) * w - 0.5
    const y = (((v % 1) + 1) % 1) * h - 0.5
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(w - 1, x0 + 1)
    const y1 = Math.min(h - 1, y0 + 1)
    const fx = Math.min(1, Math.max(0, x - x0))
    const fy = Math.min(1, Math.max(0, y - y0))
    const top = height[y0 * w + x0] * (1 - fx) + height[y0 * w + x1] * fx
    const bot = height[y1 * w + x0] * (1 - fx) + height[y1 * w + x1] * fx
    return top * (1 - fy) + bot * fy
  }
  // 同一位置组取平均高度（接缝两侧的 UV 不同，各采一次再平均）
  const gSum = new Float64Array(gPos.length)
  const gCnt = new Uint32Array(gPos.length)
  for (let i = 0; i < P.length; i++) {
    gSum[G[i]] += sample(UV[i])
    gCnt[G[i]]++
  }
  let mean = 0
  let used = 0
  for (let g = 0; g < gPos.length; g++) {
    if (!gCnt[g]) continue
    mean += gSum[g] / gCnt[g]
    used++
  }
  mean /= used || 1

  const pos = new Float32Array(P.length * 3)
  const nor = new Float32Array(P.length * 3)
  const uv = new Float32Array(P.length * 2)
  for (let i = 0; i < P.length; i++) {
    const g = G[i]
    const d = gSum[g] / gCnt[g] - mean
    for (let c = 0; c < 3; c++) {
      pos[i * 3 + c] = gPos[g][c] + gNor[g][c] * d
      nor[i * 3 + c] = gNor[g][c]
    }
    uv[i * 2] = UV[i][0]
    uv[i * 2 + 1] = UV[i][1]
  }
  const buffer = posAcc.getBuffer()
  const acc = (type, array) => doc.createAccessor().setType(type).setBuffer(buffer).setArray(array)
  prim.setAttribute('POSITION', acc('VEC3', pos))
  prim.setAttribute('NORMAL', acc('VEC3', nor))
  prim.setAttribute('TEXCOORD_0', acc('VEC2', uv))
  prim.setIndices(acc('SCALAR', new Uint32Array(tris)))
  smoothNormals(doc, (_, p) => p === prim)
  return { before: corners / 3, after: tris.length / 3 }
}
