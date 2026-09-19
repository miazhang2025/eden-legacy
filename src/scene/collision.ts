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

const ray = new Raycaster()
ray.firstHitOnly = true
const DOWN = new Vector3(0, -1, 0)
const origin = new Vector3()

/** 从 (x, fromY, z) 向下找地面，返回地面高度；maxDist 内未命中返回 null */
export function groundHeight(x: number, z: number, fromY: number, maxDist = Infinity): number | null {
  if (!colliders.length) return 0
  origin.set(x, fromY, z)
  ray.set(origin, DOWN)
  ray.far = maxDist
  const hit = ray.intersectObjects(colliders, true)[0]
  return hit ? hit.point.y : null
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
