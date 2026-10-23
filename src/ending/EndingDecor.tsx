import { Suspense, useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { create } from 'zustand'
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
import { fitInside, footprint } from './fitInside'
import { useFrameInner } from './FrameModel'
import { useSpecimenLayout } from './specimenLayout'

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
const placeMatrix = new Matrix4()
const vtx = new Vector3()

/** 装饰花草往里挪时至少保留原尺寸的多少：够了就不再往里挪 */
const KEEP_SCALE = 0.7
/** 为了让开标本缩到比这还小，就整株不显示 */
const MIN_SCALE = 0.45

/** 一圈草的「无草区」按角度分成多少格 */
const CLEAR_BINS = 90

/**
 * 一圈草的「无草区」：把标本盒 xy 按 frame.size 归一成单位圆（u = x / 半宽，v = y / 半高），
 * 每个角度格里离中心最近的草叶顶点的半径 = 这个方向上草从哪里开始。标本伸进去就会被草挡住（见 SpecimenSlot）。
 * clear = null：还没铺草（或关掉了），不限制。
 */
export const useGrassClear = create<{ clear: Float32Array | null; halfW: number; halfH: number }>()(() => ({
  clear: null,
  halfW: 1,
  halfH: 1,
}))

/** (x, y) 在不在无草区里（离草至少 margin，归一半径）；相邻两格一起看，免得卡在格子边上 */
export function clearOfGrass(x: number, y: number, margin: number) {
  const { clear, halfW, halfH } = useGrassClear.getState()
  if (!clear) return true
  const u = x / halfW
  const v = y / halfH
  const n = clear.length
  const bin = Math.floor(((Math.atan2(v, u) / (Math.PI * 2) + 1) % 1) * n) % n
  const limit = Math.min(clear[bin], clear[(bin + 1) % n], clear[(bin + n - 1) % n])
  return Math.hypot(u, v) <= limit - margin
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

  // 无草区：每丛草抽样约 60 个顶点，按实例矩阵摆好后记下每个角度格里的最小归一半径
  useEffect(() => {
    if (!meshes.length) return
    const clear = new Float32Array(CLEAR_BINS).fill(Infinity)
    const m = new Matrix4()
    for (const mesh of meshes) {
      const p = mesh.geometry.getAttribute('position')
      const step = Math.max(1, Math.floor(p.count / 60))
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m)
        for (let j = 0; j < p.count; j += step) {
          vtx.fromBufferAttribute(p, j).applyMatrix4(m)
          const u = vtx.x / (w / 2)
          const v = vtx.y / (h / 2)
          const bin = Math.floor(((Math.atan2(v, u) / (Math.PI * 2) + 1) % 1) * CLEAR_BINS) % CLEAR_BINS
          clear[bin] = Math.min(clear[bin], Math.hypot(u, v))
        }
      }
    }
    useGrassClear.setState({ clear, halfW: w / 2, halfH: h / 2 })
    return () => useGrassClear.setState({ clear: null })
  }, [meshes, w, h])

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
  // 标本排好之后才摆（要让开标本，见 specimenLayout.ts）
  const occupied = useSpecimenLayout((s) => s.occupied)

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
    if (!names.length || !occupied) return []
    const sx = mirror ? -1 : 1
    const out: { key: string; object: Object3D; position: [number, number, number]; rotation: [number, number, number]; scale: number }[] = []
    cfg.slots.forEach((slot, i) => {
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
      // 收进画框内框（不和画框穿模）、让开标本：往中心挪、以根部为中心缩小；缩得太小就不放
      // （画框模型还没量出内框时只让开标本，以画框中心为准）
      placeMatrix.compose(pos.set(...position), quat.setFromEuler(rot.set(...rotation)), scl.setScalar(scale))
      const a = inner ? Math.max(inner.halfW - cfg.fitMargin, 0.01) : w / 2
      const b = inner ? Math.max(inner.halfH - cfg.fitMargin, 0.01) : h / 2
      const cx = inner?.cx ?? 0
      const cy = inner?.cy ?? 0
      const ok = (x: number, y: number) => ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1 && !occupied(x, y)
      const fit = fitInside(position[0], position[1], footprint(o, placeMatrix), cx, cy, ok, KEEP_SCALE)
      if (fit.k < MIN_SCALE) return
      position[0] = fit.x
      position[1] = fit.y
      scale *= fit.k
      out.push({ key: `${i}-${names[i % names.length]}`, object: o, position, rotation, scale })
    })
    return out
  }, [scene, cfg.pieces, cfg.slots, cfg.fitMargin, seed, mirror, materials, inner, occupied, w, h, d])

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
