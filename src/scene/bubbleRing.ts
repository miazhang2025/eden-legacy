import { useLayoutEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Matrix4, Mesh, Vector3, type Material, type Object3D } from 'three'
import type { Vec2 } from '../config/schema'
import { bubbleComponents, bubbleHash } from '../materials/BubbleMaterial'
import { useSceneCfg } from '../state/useConfigStore'
import { defaultRole } from './materialOverrides'

// 边界泡泡（ocean）：把叠加模型（env.extras，如 bubble.glb）里的泡泡沿可玩区边界线（岛的轮廓外扩 margin）重新排一圈。
// 美术的泡泡是合成一个 mesh 的一片球，这里按连通块拆出各个泡泡，按弧长等距摆到边界线上（泡泡不够就循环复用），
// 每个泡泡保留自己的大小和高度（半浮在水面上）。只换几何，材质照旧走 envMaterials 的泡泡流水线。
// 边界线在模型局部坐标（与 playArea.outline 一致），泡泡挂在主模型下面，跟着 env 变换走。

/** 轮廓外扩 r 后的闭合折线（凸角处画圆弧）及每点的外法线，模型局部 x/z */
function offsetOutline(outline: Vec2[], r: number): { p: Vec2; n: Vec2 }[] {
  const n = outline.length
  let area = 0
  for (let i = 0; i < n; i++) {
    const [ax, az] = outline[i]
    const [bx, bz] = outline[(i + 1) % n]
    area += ax * bz - bx * az
  }
  const sign = area >= 0 ? 1 : -1
  /** 边 i → i+1 的外法线角度 */
  const edgeAngle = (i: number) => {
    const [ax, az] = outline[i]
    const [bx, bz] = outline[(i + 1) % n]
    return Math.atan2(-(bx - ax) * sign, (bz - az) * sign)
  }
  const out: { p: Vec2; n: Vec2 }[] = []
  const STEP = Math.PI / 18
  for (let i = 0; i < n; i++) {
    const [x, z] = outline[i]
    const from = edgeAngle((i - 1 + n) % n)
    let delta = edgeAngle(i) - from
    delta = Math.atan2(Math.sin(delta), Math.cos(delta))
    // 凹角（凸包不会有）不画弧，直接接到下一条边
    const turn = delta * sign > 0 ? delta : 0
    const steps = Math.max(1, Math.ceil(Math.abs(turn) / STEP))
    for (let k = 0; k <= steps; k++) {
      const a = from + (turn * k) / steps
      const nx = Math.cos(a)
      const nz = Math.sin(a)
      out.push({ p: [x + nx * r, z + nz * r], n: [nx, nz] })
    }
  }
  return out
}

/** 沿闭合折线按弧长等距取 count 个点（带外法线与切线） */
function resample(line: { p: Vec2; n: Vec2 }[], spacing: number) {
  const lens: number[] = []
  let total = 0
  for (let i = 0; i < line.length; i++) {
    const a = line[i].p
    const b = line[(i + 1) % line.length].p
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    lens.push(l)
    total += l
  }
  const count = Math.max(3, Math.round(total / Math.max(0.1, spacing)))
  const step = total / count
  const out: { p: Vec2; n: Vec2; t: Vec2 }[] = []
  let seg = 0
  let start = 0
  for (let k = 0; k < count; k++) {
    const d = k * step
    while (seg < line.length - 1 && start + lens[seg] < d) start += lens[seg++]
    const a = line[seg]
    const b = line[(seg + 1) % line.length]
    const f = lens[seg] > 0 ? (d - start) / lens[seg] : 0
    const tx = b.p[0] - a.p[0]
    const tz = b.p[1] - a.p[1]
    const tl = Math.hypot(tx, tz) || 1
    let nx = a.n[0] + (b.n[0] - a.n[0]) * f
    let nz = a.n[1] + (b.n[1] - a.n[1]) * f
    const nl = Math.hypot(nx, nz) || 1
    nx /= nl
    nz /= nl
    out.push({ p: [a.p[0] + tx * f, a.p[1] + tz * f], n: [nx, nz], t: [tx / tl, tz / tl] })
  }
  return out
}

interface Source {
  geo: BufferGeometry
  /** 每个泡泡的顶点 / 三角形（原几何里的下标）与中心 */
  bubbles: { verts: number[]; tris: number[]; center: Vector3 }[]
}

const sources = new WeakMap<BufferGeometry, Source>()

function splitBubbles(geo: BufferGeometry): Source {
  let s = sources.get(geo)
  if (s) return s
  const { of, centers } = bubbleComponents(geo)
  const bubbles = centers.map((c) => ({ verts: [] as number[], tris: [] as number[], center: new Vector3(...c) }))
  for (let i = 0; i < of.length; i++) bubbles[of[i]].verts.push(i)
  const index = geo.getIndex()
  const triCount = index ? index.count : of.length
  for (let t = 0; t < triCount; t++) {
    const v = index ? index.getX(t) : t
    bubbles[of[v]].tris.push(v)
  }
  // 打乱顺序（固定种子）：美术摆的时候大小泡泡可能扎堆，循环复用时混开
  bubbles.sort((a, b) => bubbleHash(a.center.x, a.center.y, a.center.z) - bubbleHash(b.center.x, b.center.y, b.center.z))
  s = { geo, bubbles }
  sources.set(geo, s)
  return s
}

const rel = new Matrix4()
const inv = new Matrix4()
const tmp = new Vector3()
const target = new Vector3()

/** mesh 局部 → root 局部的矩阵 */
function relativeMatrix(mesh: Object3D, root: Object3D, out: Matrix4) {
  out.identity()
  for (let o: Object3D | null = mesh; o && o !== root; o = o.parent) {
    o.updateMatrix()
    out.premultiply(o.matrix)
  }
  return out
}

/** 按落点（root 局部 x/z）拼出新几何：第 k 个落点放第 k % n 个泡泡 */
function buildRing(src: Source, mesh: Mesh, root: Object3D, slots: Vec2[]): BufferGeometry {
  relativeMatrix(mesh, root, rel)
  inv.copy(rel).invert()
  const { geo, bubbles } = src
  const picks = slots.map((_, k) => bubbles[k % bubbles.length])
  const vertTotal = picks.reduce((s, b) => s + b.verts.length, 0)
  const triTotal = picks.reduce((s, b) => s + b.tris.length, 0)

  const out = new BufferGeometry()
  const names = Object.keys(geo.attributes).filter((n) => n !== 'aEdenBubblePhase')
  const arrays = names.map((name) => {
    const a = geo.getAttribute(name)
    const Ctor = a.array.constructor as new (n: number) => Float32Array
    return { name, a, arr: new Ctor(vertTotal * a.itemSize) }
  })
  const phase = new Float32Array(vertTotal)
  const index = vertTotal > 65535 ? new Uint32Array(triTotal) : new Uint16Array(triTotal)
  const remap = new Map<number, number>()
  let v = 0
  let t = 0
  picks.forEach((b, k) => {
    // 泡泡中心挪到落点，高度保持（在 root 局部里算，再换回 mesh 局部）
    tmp.copy(b.center).applyMatrix4(rel)
    target.set(slots[k][0], tmp.y, slots[k][1]).applyMatrix4(inv).sub(b.center)
    const ph = bubbleHash(slots[k][0], k, slots[k][1])
    remap.clear()
    for (const i of b.verts) {
      remap.set(i, v)
      for (const { name, a, arr } of arrays) {
        for (let c = 0; c < a.itemSize; c++) {
          let x = a.getComponent(i, c)
          if (name === 'position') x += c === 0 ? target.x : c === 1 ? target.y : target.z
          arr[v * a.itemSize + c] = x
        }
      }
      phase[v] = ph
      v++
    }
    for (const i of b.tris) index[t++] = remap.get(i)!
  })
  for (const { name, a, arr } of arrays) out.setAttribute(name, new BufferAttribute(arr, a.itemSize, a.normalized))
  out.setAttribute('aEdenBubblePhase', new BufferAttribute(phase, 1))
  out.setIndex(new BufferAttribute(index, 1))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

const isBubbleMesh = (o: Object3D): o is Mesh =>
  o instanceof Mesh &&
  (Array.isArray(o.material) ? o.material : [o.material]).some(
    (m: Material & { __edenRole?: string }) => m.__edenRole === 'bubble' || defaultRole(m.name) === 'bubble',
  )

/** root = 主环境模型（边界线所在的模型局部坐标），extras = 叠加模型里要重排的泡泡来源 */
export function useBubbleRing(root: Object3D, extras: Object3D[]) {
  const enabled = useSceneCfg((c) => !!c.playArea?.enabled && c.playArea.bubbles.enabled)
  const outline = useSceneCfg((c) => c.playArea?.outline)
  const margin = useSceneCfg((c) => c.playArea?.margin ?? 0)
  const { spacing, jitter, offset } = useSceneCfg((c) => c.playArea?.bubbles) ?? { spacing: 2, jitter: 0, offset: 0 }

  const meshes = useMemo(() => {
    const list: Mesh[] = []
    for (const s of extras) s.traverse((o) => isBubbleMesh(o) && list.push(o))
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, extras)

  useLayoutEffect(() => {
    if (!enabled || !outline || outline.length < 3 || !meshes.length) return
    const line = offsetOutline(outline, margin + offset)
    const points = resample(line, spacing)
    // 每个落点按自己的位置随机错开（沿边界线 / 里外各 ±jitter/2）
    const slots: Vec2[][] = meshes.map(() => [])
    points.forEach(({ p, n, t }, k) => {
      const a = (bubbleHash(p[0], 1, p[1]) - 0.5) * jitter
      const b = (bubbleHash(p[1], 2, p[0]) - 0.5) * jitter
      slots[k % meshes.length].push([p[0] + t[0] * a + n[0] * b, p[1] + t[1] * a + n[1] * b])
    })
    const restore = meshes.map((mesh, i) => {
      const original = mesh.geometry as BufferGeometry
      const ring = buildRing(splitBubbles(original), mesh, root, slots[i])
      mesh.geometry = ring
      return () => {
        mesh.geometry = original
        ring.dispose()
      }
    })
    return () => restore.forEach((f) => f())
  }, [root, meshes, enabled, outline, margin, spacing, jitter, offset])
}
