import { Matrix4, Mesh, Quaternion, Vector3, type Object3D } from 'three'

// 标本「摊平」：找一个观察方向，使模型在垂直于它的平面上的投影面积最大（像钉在标本盒里那样平展），
// 再把这个方向转到 +Z（正对镜头 / 垂直于背板）。
// 投影面积用 Σ 三角面积 × |法线 · 方向| 估算（不扣除自遮挡），在半球上均匀取样找最大值。

/** 半球上的取样方向数 */
const SAMPLES = 400
/** 参与计算的三角面上限（大模型抽样） */
const MAX_TRIS = 6000

const a = new Vector3()
const b = new Vector3()
const c = new Vector3()
const n = new Vector3()
const rel = new Matrix4()

/** 斐波那契半球（y ≥ 0 一侧即可：|n·d| 对 d 与 -d 相同） */
const DIRECTIONS: Vector3[] = (() => {
  const out: Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < SAMPLES; i++) {
    const z = 1 - i / (SAMPLES - 1) // 1 → 0：上半球
    const r = Math.sqrt(1 - z * z)
    const t = golden * i
    out.push(new Vector3(Math.cos(t) * r, Math.sin(t) * r, z))
  }
  return out
})()

/**
 * o 相对 root 的变换：沿父级链乘局部矩阵。
 * 不用 root.matrixWorld 求逆：标本盒入场时从缩放 0 放大，那一刻 matrixWorld 不可逆，算出来全是 0。
 */
export function relativeMatrix(o: Object3D, root: Object3D, out: Matrix4): Matrix4 {
  out.identity()
  for (let n: Object3D | null = o; n && n !== root; n = n.parent) out.premultiply(n.matrix)
  return out
}

/** root 局部空间里的面积加权法线（长度 = 三角面积） */
function collectNormals(root: Object3D): Vector3[] {
  root.updateMatrixWorld(true)
  const normals: Vector3[] = []
  let total = 0
  root.traverse((o) => {
    if (o instanceof Mesh && o.geometry.index) total += o.geometry.index.count / 3
    else if (o instanceof Mesh) total += o.geometry.getAttribute('position').count / 3
  })
  const step = Math.max(1, Math.floor(total / MAX_TRIS))
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const pos = o.geometry.getAttribute('position')
    if (!pos) return
    const idx = o.geometry.index
    const count = idx ? idx.count : pos.count
    relativeMatrix(o, root, rel)
    for (let t = 0; t + 2 < count; t += 3 * step) {
      const i0 = idx ? idx.getX(t) : t
      const i1 = idx ? idx.getX(t + 1) : t + 1
      const i2 = idx ? idx.getX(t + 2) : t + 2
      // getVertexPosition 带上骨骼 / 形变（停在展翅姿态的蝴蝶要按摆好的姿态算）
      o.getVertexPosition(i0, a).applyMatrix4(rel)
      o.getVertexPosition(i1, b).applyMatrix4(rel)
      o.getVertexPosition(i2, c).applyMatrix4(rel)
      n.subVectors(b, a).cross(c.sub(a)).multiplyScalar(0.5)
      if (n.lengthSq() > 0) normals.push(n.clone())
    }
  })
  return normals
}

/**
 * 摊平用的旋转（root 局部空间）：投影面积最大的方向 → +Z；
 * 平面内再转一下，让模型原本的「上」（+Y）尽量朝上，原本平躺的（上方向正对镜头）则让原本的前方（+Z）朝上。
 * 两个相反方向投影面积相同，取原本更朝上 / 朝前的那一面对着镜头。
 */
export function flatteningQuaternion(root: Object3D): Quaternion {
  const normals = collectNormals(root)
  if (!normals.length) return new Quaternion()

  let best = DIRECTIONS[0]
  let bestArea = -1
  for (const d of DIRECTIONS) {
    let area = 0
    for (const v of normals) area += Math.abs(v.dot(d))
    if (area > bestArea) {
      bestArea = area
      best = d
    }
  }
  const face = best.clone()
  // 朝镜头的那一面：原本朝上的优先，其次原本朝前的
  if (face.y * 2 + face.z < 0) face.negate()

  const q = new Quaternion().setFromUnitVectors(face, new Vector3(0, 0, 1))

  // 平面内转正
  const up = new Vector3(0, 1, 0).applyQuaternion(q)
  if (up.x * up.x + up.y * up.y < 0.04) up.set(0, 0, 1).applyQuaternion(q) // 原本平躺：用原来的前方当上
  const twist = Math.atan2(up.x, up.y)
  q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), twist))
  return q
}
