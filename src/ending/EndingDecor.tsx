import { Suspense, useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import {
  Box3,
  Euler,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three'
import type { EndingConfig } from '../config/schema'
import { DRACO_PATH, url, useKTX2Extension } from '../scene/EnvModel'
import { useEndingCfg } from '../state/useConfigStore'
import { hash01, isMirrored } from './composition'
import { relativeMatrix } from './flatten'
import { useFrameInner, type FrameInner } from './FrameModel'

type DecorCfg = EndingConfig['decor']

/** 按组合 id 洗牌（同一组合每次一样，不同组合摆出来的花草不同） */
function shuffle<T>(list: T[], seed: string): T[] {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed, 200 + i) * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const box = new Box3()
const pos = new Vector3()
const quat = new Quaternion()
const scl = new Vector3()
const euler = new Euler(0, 0, 0, 'ZYX')
const rot = new Euler()
const rel = new Matrix4()
const placeMatrix = new Matrix4()
const vtx = new Vector3()

/** 花草摆好后在标本盒 xy 平面上的投影（每个网格抽样约 400 个顶点）；m = 摆位矩阵 */
function footprint(o: Object3D, m: Matrix4): [number, number][] {
  const out: [number, number][] = []
  o.updateMatrixWorld(true)
  o.traverse((x) => {
    if (!(x instanceof Mesh)) return
    const p = x.geometry.getAttribute('position')
    if (!p) return
    relativeMatrix(x, o, rel).premultiply(m)
    const step = Math.max(1, Math.floor(p.count / 400))
    for (let i = 0; i < p.count; i += step) {
      vtx.fromBufferAttribute(p, i).applyMatrix4(rel)
      out.push([vtx.x, vtx.y])
    }
  })
  return out
}

/** 往里挪的根部至少保留原尺寸的多少：够了就不再往里挪 */
const KEEP_SCALE = 0.7

/**
 * 把一株花草收进内框椭圆（半轴各减 margin）：先把根部 (px, py) 沿径向往里挪（最多挪到原半径的一半），
 * 挪到以根部为中心缩小后还能保留 KEEP_SCALE 的尺寸为止；都不够就取尺寸最大的那个位置。
 * 返回新的根部与缩放系数 k（≤ 1），所有投影点都在框内。
 */
function fitInside(px: number, py: number, pts: [number, number][], inner: FrameInner, margin: number) {
  const a = Math.max(inner.halfW - margin, 0.01)
  const b = Math.max(inner.halfH - margin, 0.01)
  const e = (x: number, y: number) => ((x - inner.cx) / a) ** 2 + ((y - inner.cy) / b) ** 2
  // 根部离中心的「椭圆半径」，起点不超过 0.9（贴边或在框外的先挪进来）
  const er = Math.sqrt(e(px, py)) || 1
  const start = Math.min(1, 0.9 / er)
  let best = { x: px, y: py, k: -1 }
  for (let f = start; f >= start * 0.5 - 1e-6; f -= start * 0.05) {
    const x = inner.cx + (px - inner.cx) * f
    const y = inner.cy + (py - inner.cy) * f
    const inside = (k: number) => pts.every(([vx, vy]) => e(x + k * (vx - px), y + k * (vy - py)) <= 1)
    let k = 1
    if (!inside(1)) {
      let lo = 0
      let hi = 1
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2
        if (inside(mid)) lo = mid
        else hi = mid
      }
      k = lo
    }
    if (k > best.k) best = { x, y, k }
    if (k >= KEEP_SCALE) break
  }
  return best
}

/**
 * 沿内框铺一圈草：两种草丛各一个 InstancedMesh。
 * 角度 θ 以正下方为中心、在 arcDeg 范围内取，bottomBias 让下沿密、上沿疏（密度按余弦平滑过渡）；越往上越小。
 * 每丛「朝上」的方向在世界向上与指向中心之间按 lean 混合，两侧的草会向里倾。
 */
function GrassBed({ scene, cfg, seed, brightness }: { scene: Object3D; cfg: DecorCfg['grass']; seed: string; brightness: number }) {
  const [w, h, d] = useEndingCfg((c) => c.frame.size)

  const tufts = useMemo(() => {
    const out: { geometry: BufferGeometry; material: Material; width: number }[] = []
    scene.traverse((o) => {
      if (!(o instanceof Mesh) || !(o.name.startsWith('grass_') || o.parent?.name.startsWith('grass_'))) return
      const material = (o.material as MeshStandardMaterial).clone()
      material.color.multiplyScalar(brightness)
      o.geometry.computeBoundingBox()
      const b = o.geometry.boundingBox!
      out.push({ geometry: o.geometry, material, width: Math.max(b.max.x - b.min.x, b.max.z - b.min.z) || 1 })
    })
    return out
  }, [scene, brightness])
  useEffect(() => () => tufts.forEach((t) => t.material.dispose()), [tufts])

  const meshes = useMemo(() => {
    if (!tufts.length) return []
    const lists: Matrix4[][] = tufts.map(() => [])
    const r = (i: number, k: number) => hash01(seed, 300 + i * 7 + k)
    const half = (cfg.arcDeg * Math.PI) / 360
    // 离正下方 φ 处的密度 1 - b·(1 - cos φ)/2（正下方 1，正上方 1 - b），其累积分布 F 是奇函数、单调递增
    const b = Math.min(cfg.bottomBias, 0.95)
    const cdf = (p: number) => p * (1 - b / 2) + (b / 2) * Math.sin(p)
    const total = cdf(half)
    for (let i = 0; i < cfg.count; i++) {
      // 分层抖动：每丛在累积分布上占一小格、在格中心附近随机（只抖半格，稀疏处间距也匀，不会空出一大块）；再反解出角度（二分）
      const target = (((i + 0.25 + 0.5 * r(i, 0)) / cfg.count) * 2 - 1) * total
      let lo = -half
      let hi = half
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2
        if (cdf(mid) < target) lo = mid
        else hi = mid
      }
      const phi = (lo + hi) / 2
      const uw = half > 0 ? phi / half : 0
      const theta = -Math.PI / 2 + phi
      const rad = cfg.radius - cfg.inset * r(i, 1)
      const cx = Math.cos(theta)
      const cy = Math.sin(theta)
      // 椭圆在该点的内法线（指向中心）
      const nx = -cx / w
      const ny = -cy / h
      const nl = Math.hypot(nx, ny) || 1
      const upX = (nx / nl) * cfg.lean
      const upY = 1 - cfg.lean + (ny / nl) * cfg.lean
      const tilt = Math.atan2(-upX, upY)
      const t = Math.abs(uw)
      const size = (cfg.size[1] + (cfg.size[0] - cfg.size[1]) * t) * (0.7 + 0.6 * r(i, 2)) * h
      const kind = Math.floor(r(i, 3) * tufts.length)
      pos.set(cx * rad * w, cy * rad * h, (cfg.depth[0] + (cfg.depth[1] - cfg.depth[0]) * r(i, 4)) * d)
      euler.set(0, r(i, 5) * Math.PI * 2, tilt)
      quat.setFromEuler(euler)
      scl.setScalar(size / tufts[kind].width)
      lists[kind].push(new Matrix4().compose(pos, quat, scl))
    }
    return tufts.map((t, k) => {
      const mesh = new InstancedMesh(t.geometry, t.material, Math.max(1, lists[k].length))
      mesh.count = lists[k].length
      lists[k].forEach((m, i) => mesh.setMatrixAt(i, m))
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.castShadow = true
      mesh.receiveShadow = true
      return mesh
    })
  }, [tufts, cfg, seed, w, h, d])
  useEffect(() => () => meshes.forEach((m) => m.dispose()), [meshes])

  return (
    <group>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </group>
  )
}

function DecorPieces({ cfg, seed }: { cfg: DecorCfg; seed: string }) {
  const [w, h, d] = useEndingCfg((c) => c.frame.size)
  const composition = useEndingCfg((c) => c.composition)
  const { scene } = useGLTF(url(cfg.model), DRACO_PATH, undefined, useKTX2Extension())
  const mirror = isMirrored(composition, seed)
  const inner = useFrameInner((s) => s.inner)

  // 材质整体压暗：每种原材质克隆一份，颜色乘 brightness
  const materials = useMemo(() => {
    const map = new Map<Material, Material>()
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return
      for (const m of ([] as Material[]).concat(o.material)) {
        if (map.has(m)) continue
        const c = m.clone()
        if (c instanceof MeshStandardMaterial) c.color.multiplyScalar(cfg.brightness)
        map.set(m, c)
      }
    })
    return map
  }, [scene, cfg.brightness])
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials])

  const placed = useMemo(() => {
    const names = shuffle(
      cfg.pieces
        .split(',')
        .map((s) => s.trim())
        .filter((n) => n && !n.startsWith('grass_') && scene.getObjectByName(n)),
      seed,
    )
    if (!names.length) return []
    const sx = mirror ? -1 : 1
    return cfg.slots.map((slot, i) => {
      const src = scene.getObjectByName(names[i % names.length]) as Object3D
      const o = src.clone(true)
      o.position.set(0, 0, 0)
      o.traverse((m) => {
        if (!(m instanceof Mesh)) return
        m.material = Array.isArray(m.material) ? m.material.map((x) => materials.get(x) ?? x) : (materials.get(m.material) ?? m.material)
        m.castShadow = true
        m.receiveShadow = true
      })
      // 几何已在 npm run decor 里挪到底部中心，这里只按高度缩放
      const height = box.setFromObject(o).max.y - box.min.y || 1
      const position: [number, number, number] = [sx * slot.anchor[0] * w, slot.anchor[1] * h, slot.anchor[2] * d]
      const rotation: [number, number, number] = [slot.rotation[0], sx * slot.rotation[1], sx * slot.rotation[2]]
      let scale = (slot.height * h) / height
      // 收进画框内框，不和画框穿模（画框模型还没量出内框时先按原样摆）
      if (inner) {
        placeMatrix.compose(pos.set(...position), quat.setFromEuler(rot.set(...rotation)), scl.setScalar(scale))
        const fit = fitInside(position[0], position[1], footprint(o, placeMatrix), inner, cfg.fitMargin)
        position[0] = fit.x
        position[1] = fit.y
        scale *= fit.k
      }
      return { key: `${i}-${names[i % names.length]}`, object: o, position, rotation, scale }
    })
  }, [scene, cfg.pieces, cfg.slots, cfg.fitMargin, seed, mirror, materials, inner, w, h, d])

  return (
    <group>
      {placed.map((p) => (
        <group key={p.key} position={p.position} rotation={p.rotation} scale={p.scale}>
          <primitive object={p.object} />
        </group>
      ))}
      {cfg.grass.enabled && <GrassBed scene={scene} cfg={cfg.grass} seed={seed} brightness={cfg.brightness} />}
    </group>
  )
}

/** 标本盒里的装饰花草：从三个场景拆出来的几株（npm run decor），贴着画框边缘，点缀用 */
export function EndingDecor({ seed }: { seed: string }) {
  const cfg = useEndingCfg((c) => c.decor)
  if (!cfg.enabled || !cfg.model) return null
  return (
    <Suspense fallback={null}>
      <DecorPieces cfg={cfg} seed={seed} />
    </Suspense>
  )
}
