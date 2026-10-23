import { Matrix4, Mesh, Vector3, type Object3D } from 'three'
import { relativeMatrix } from './flatten'

// 把一件东西（装饰花草 / 标本）收进标本盒里的某个区域：不和画框穿模、不被一圈草挡住。
// 只看 xy 平面上的投影（镜头正对标本盒）。

const vtx = new Vector3()
const rel = new Matrix4()

/**
 * root 摆好后在标本盒 xy 平面上的投影：每个网格抽样约 perMesh 个顶点（带骨骼 / 形变的按当前姿态）。
 * m = root 自身到标本盒局部空间的变换（root 自己的 matrix 不算在内）。
 */
export function footprint(root: Object3D, m: Matrix4, perMesh = 400): [number, number][] {
  const out: [number, number][] = []
  root.updateMatrixWorld(true)
  root.traverse((x) => {
    if (!(x instanceof Mesh)) return
    const p = x.geometry.getAttribute('position')
    if (!p) return
    relativeMatrix(x, root, rel).premultiply(m)
    const step = Math.max(1, Math.floor(p.count / perMesh))
    for (let i = 0; i < p.count; i += step) {
      x.getVertexPosition(i, vtx).applyMatrix4(rel)
      out.push([vtx.x, vtx.y])
    }
  })
  return out
}

/**
 * 根部 (px, py) 沿径向往 (cx, cy) 挪（最多挪到一半），每个位置上以根部为中心等比缩小到所有投影点都 inside；
 * 尺寸能保留 keep 以上就停，否则取尺寸最大的那个位置。返回新的根部与缩放系数 k（≤ 1）。
 * 根部本身不 inside 的位置跳过（在区域外的先挪进来）；一个可用位置都没有就返回原位、k = 0。
 */
export function fitInside(
  px: number,
  py: number,
  pts: [number, number][],
  cx: number,
  cy: number,
  inside: (x: number, y: number) => boolean,
  keep: number,
) {
  let best = { x: px, y: py, k: -1 }
  for (let f = 1; f >= 0.5 - 1e-6; f -= 0.05) {
    const x = cx + (px - cx) * f
    const y = cy + (py - cy) * f
    if (!inside(x, y)) continue
    const ok = (k: number) => pts.every(([vx, vy]) => inside(x + k * (vx - px), y + k * (vy - py)))
    let k = 1
    if (!ok(1)) {
      let lo = 0
      let hi = 1
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2
        if (ok(mid)) lo = mid
        else hi = mid
      }
      k = lo
    }
    if (k > best.k) best = { x, y, k }
    if (k >= keep) break
  }
  return best.k < 0 ? { x: px, y: py, k: 0 } : best
}
