import { BufferGeometry, Mesh, Raycaster, Vector3, type Object3D } from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

// 手写碰撞（spec §6.1，不引入物理引擎）：只对低模碰撞体做射线检测，BVH 加速。
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
Mesh.prototype.raycast = acceleratedRaycast

let colliders: Object3D[] = []

export function registerCollider(root: Object3D) {
  // 连同父级一起更新，保证 env 变换已生效
  root.updateWorldMatrix(true, true)
  root.traverse((o) => {
    if (o instanceof Mesh && !o.geometry.boundsTree) o.geometry.computeBoundsTree()
  })
  colliders = [...colliders, root]
  return () => {
    colliders = colliders.filter((c) => c !== root)
  }
}

export const hasCollider = () => colliders.length > 0

/**
 * 水底：渲染模型里的地形 mesh（全精度），只给水深图烘焙用（GPU 从正上方画一遍，见 WaterMaterial.ts 的 bakeDepthMap）。
 * 碰撞体减过面、还把小块地面当小物件剔掉了，用它烘出的岸线和实际看到的地形对不上（岸边一块块硬边）。
 */
let waterBeds: Mesh[] = []
let waterBedVersion = 0
export const getWaterBedVersion = () => waterBedVersion

export function registerWaterBed(root: Object3D, accept: (mesh: Mesh) => boolean) {
  const meshes: Mesh[] = []
  root.traverse((o) => {
    if (o instanceof Mesh && accept(o)) meshes.push(o)
  })
  if (!meshes.length) return () => {}
  waterBeds = [...waterBeds, ...meshes]
  waterBedVersion++
  return () => {
    waterBeds = waterBeds.filter((m) => !meshes.includes(m))
    waterBedVersion++
  }
}

const shown = (o: Object3D | null): boolean => !o || (o.visible && shown(o.parent))

/** 烘水深用的网格：当前显示的水底 mesh；没有登记水底时回落到碰撞体的 mesh */
export function waterBedMeshes(): Mesh[] {
  const beds = waterBeds.filter(shown)
  if (beds.length) return beds
  const out: Mesh[] = []
  for (const c of colliders) c.traverse((o) => o instanceof Mesh && out.push(o))
  return out
}

/** 可行走的水面高度（water.walkable 时由 Water.tsx 设置），null = 水面不能走 */
let walkPlane: number | null = null
export function setWalkPlane(level: number | null) {
  walkPlane = level
}

const ray = new Raycaster()
ray.firstHitOnly = true
const DOWN = new Vector3(0, -1, 0)
const origin = new Vector3()

/** 只看地形：从 (x, fromY, z) 向下找碰撞体，maxDist 内未命中返回 null */
export function terrainHeight(x: number, z: number, fromY: number, maxDist = Infinity): number | null {
  if (!colliders.length) return 0
  origin.set(x, fromY, z)
  ray.set(origin, DOWN)
  ray.far = maxDist
  const hit = ray.intersectObjects(colliders, true)[0]
  return hit ? hit.point.y : null
}

/** 可站立的地面：地形与可行走水面中较高的那个（水面在 [fromY - maxDist, fromY] 内才算） */
export function groundHeight(x: number, z: number, fromY: number, maxDist = Infinity): number | null {
  const t = terrainHeight(x, z, fromY, maxDist)
  if (walkPlane === null || walkPlane > fromY || walkPlane < fromY - maxDist) return t
  return t === null ? walkPlane : Math.max(t, walkPlane)
}

/** 从高处向下找地面（用于出生点、资产贴地） */
export function groundHeightFromSky(x: number, z: number): number | null {
  return groundHeight(x, z, 1e4)
}

/** 从 from 沿 dir（单位向量）方向 dist 内是否撞到碰撞体 */
export function isBlocked(from: Vector3, dir: Vector3, dist: number): boolean {
  if (!colliders.length) return false
  ray.set(from, dir)
  ray.far = dist
  return ray.intersectObjects(colliders, true).length > 0
}

/** 从 from 沿 dir（单位向量）方向 dist 内第一个命中的距离；未命中返回 null */
export function hitDistance(from: Vector3, dir: Vector3, dist: number): number | null {
  if (!colliders.length) return null
  ray.set(from, dir)
  ray.far = dist
  return ray.intersectObjects(colliders, true)[0]?.distance ?? null
}
