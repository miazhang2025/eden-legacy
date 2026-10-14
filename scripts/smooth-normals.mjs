// 平滑着色：同一位置的顶点共用周围三角面按面积加权的平均法线。
// 顶点本身不合并（UV 接缝、不同贴图坐标照样分开），只把法线抹平，硬边 / 面片感就没了。
// 只和「朝同一侧」的面一起平均（与顶点自己所在面的夹角 < 90°）：
// 双面片 / 内外两层皮在同一位置上有方向相反的面，混在一起平均会互相抵消成乱的法线。
// 用于美术导出时带了硬边法线的模型（洞穴岩壁、裸海蝶）。

/** 位置量化精度（模型局部单位）：小于它的位置差视为同一点 */
const EPSILON = 1e-4

/**
 * @param {import('@gltf-transform/core').Document} doc
 * @param {(mesh: import('@gltf-transform/core').Mesh, prim: import('@gltf-transform/core').Primitive) => boolean} filter
 * @returns {number} 处理的图元数
 */
export function smoothNormals(doc, filter) {
  let count = 0
  const done = new Set()
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')
      if (!pos || done.has(prim) || !filter(mesh, prim)) continue
      done.add(prim)
      const n = pos.getCount()
      const idx = prim.getIndices()
      const corners = idx ? idx.getCount() : n
      const at = (t) => (idx ? idx.getScalar(t) : t)

      // 每个顶点对应的「位置组」
      const p = pos.getArray()
      const group = new Uint32Array(n)
      const keys = new Map()
      for (let i = 0; i < n; i++) {
        const k = `${Math.round(p[i * 3] / EPSILON)},${Math.round(p[i * 3 + 1] / EPSILON)},${Math.round(p[i * 3 + 2] / EPSILON)}`
        let g = keys.get(k)
        if (g === undefined) keys.set(k, (g = keys.size))
        group[i] = g
      }

      // 面法线（叉积长度 = 两倍面积，天然按面积加权）；顶点自己所在面的法线和；每个位置组挂了哪些面
      const faces = Math.floor(corners / 3)
      const fn = new Float64Array(faces * 3)
      const own = new Float64Array(n * 3)
      const groupFaces = Array.from({ length: keys.size }, () => [])
      for (let f = 0; f < faces; f++) {
        const a = at(f * 3), b = at(f * 3 + 1), c = at(f * 3 + 2)
        const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
        const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
        fn[f * 3] = uy * vz - uz * vy
        fn[f * 3 + 1] = uz * vx - ux * vz
        fn[f * 3 + 2] = ux * vy - uy * vx
        for (const v of [a, b, c]) {
          own[v * 3] += fn[f * 3]
          own[v * 3 + 1] += fn[f * 3 + 1]
          own[v * 3 + 2] += fn[f * 3 + 2]
          const list = groupFaces[group[v]]
          if (list[list.length - 1] !== f) list.push(f)
        }
      }

      const old = prim.getAttribute('NORMAL')
      const out = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        let ox = own[i * 3], oy = own[i * 3 + 1], oz = own[i * 3 + 2]
        // 没挂任何面的孤立顶点：保留原法线
        if (ox === 0 && oy === 0 && oz === 0) {
          if (old) old.getElement(i, out.subarray(i * 3, i * 3 + 3))
          continue
        }
        let sx = 0, sy = 0, sz = 0
        for (const f of groupFaces[group[i]]) {
          const x = fn[f * 3], y = fn[f * 3 + 1], z = fn[f * 3 + 2]
          if (x * ox + y * oy + z * oz <= 0) continue
          sx += x
          sy += y
          sz += z
        }
        const len = Math.hypot(sx, sy, sz) || 1
        out[i * 3] = sx / len
        out[i * 3 + 1] = sy / len
        out[i * 3 + 2] = sz / len
      }
      // 新建一个法线 accessor（原来的可能被别的图元共用）
      prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setBuffer(pos.getBuffer()).setArray(out))
      count++
    }
  }
  return count
}
