// 程序化草的密度图（离线烘焙，由 optimize-models.mjs 调用）
//   从原始模型的地形贴图判断「哪里是草地」：自上而下对地形 / 石头 / 石拱做射线，
//   命中地形时取贴图颜色的「绿度」作为密度；命中石头等其它物体、池塘（紫色）、暗部则为 0。
//   输出：public/models/env/<name>.grass.png（灰度密度图）+ <name>.grass.json（模型局部坐标下的 x/z 范围）
//   坐标用模型局部空间，运行时再套 config 的 env 变换，调整 env.scale / position 不需要重烘。

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, Raycaster, Vector3 } from 'three'
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh'

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
Mesh.prototype.raycast = acceleratedRaycast

/**
 * 每个模型的规则：
 * - terrain：长草的地形 mesh 名（取其贴图颜色）
 * - blockers：挡住草的 mesh（石头、石拱、大花等），射线先命中它们时该点不长草
 * - res：密度图分辨率
 */
export const GRASS_RULES = {
  garden: { terrain: ['8', '55'], blockers: ['54', '9', '13', '14', '53'], res: 256 },
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export async function bakeGrassMask(doc, name, outDir) {
  const rules = GRASS_RULES[name]
  if (!rules) return null

  const root = new Group()
  const textures = new Map()
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const meshName = mesh.getName()
    const isTerrain = rules.terrain.includes(meshName)
    if (!isTerrain && !rules.blockers.includes(meshName)) continue
    for (const prim of mesh.listPrimitives()) {
      const geo = new BufferGeometry()
      geo.setAttribute('position', new BufferAttribute(prim.getAttribute('POSITION').getArray().slice(), 3))
      const uv = prim.getAttribute('TEXCOORD_0')
      if (uv) geo.setAttribute('uv', new BufferAttribute(uv.getArray().slice(), 2))
      const idx = prim.getIndices()
      if (idx) geo.setIndex(new BufferAttribute(idx.getArray().slice(), 1))
      geo.applyMatrix4(new Matrix4().fromArray(node.getWorldMatrix()))
      geo.computeBoundsTree()
      const m = new Mesh(geo)
      m.name = meshName
      m.userData.terrain = isTerrain
      root.add(m)
      const tex = prim.getMaterial()?.getBaseColorTexture()
      if (isTerrain && tex && !textures.has(meshName)) {
        const { data, info } = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        textures.set(meshName, { data, info })
      }
    }
  }
  root.updateMatrixWorld(true)

  // 范围：长草地形的包围盒（模型局部坐标）
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const m of root.children) {
    if (!m.userData.terrain) continue
    m.geometry.computeBoundingBox()
    min.min(m.geometry.boundingBox.min)
    max.max(m.geometry.boundingBox.max)
  }
  const res = rules.res
  const sx = max.x - min.x
  const sz = max.z - min.z
  const out = new Uint8Array(res * res)
  const ray = new Raycaster()
  ray.firstHitOnly = true
  const down = new Vector3(0, -1, 0)
  const origin = new Vector3()
  let covered = 0

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      origin.set(min.x + ((i + 0.5) / res) * sx, max.y + 10, min.z + ((j + 0.5) / res) * sz)
      ray.set(origin, down)
      const hit = ray.intersectObject(root, true)[0]
      if (!hit || !hit.object.userData.terrain || !hit.uv) continue
      const t = textures.get(hit.object.name)
      if (!t) continue
      const px = Math.min(t.info.width - 1, Math.max(0, Math.floor(hit.uv.x * t.info.width)))
      const py = Math.min(t.info.height - 1, Math.max(0, Math.floor(hit.uv.y * t.info.height)))
      const k = (py * t.info.width + px) * t.info.channels
      const r = t.data[k] / 255
      const g = t.data[k + 1] / 255
      const b = t.data[k + 2] / 255
      // 绿度：绿通道高出红 / 蓝的程度；池塘（深紫）、石面（灰）、暗部都会落到 0 附近
      const green = g - Math.max(r, b * 0.85)
      const lum = 0.3 * r + 0.59 * g + 0.11 * b
      const d = smoothstep(-0.005, 0.06, green) * smoothstep(0.04, 0.1, lum)
      out[j * res + i] = Math.round(d * 255)
      if (d > 0.1) covered++
    }
  }

  const png = join(outDir, `${name}.grass.png`)
  // 轻微模糊：让草地边缘渐变，不出现锯齿状的整齐分界
  await sharp(Buffer.from(out), { raw: { width: res, height: res, channels: 1 } }).blur(1).png().toFile(png)
  writeFileSync(join(outDir, `${name}.grass.json`), JSON.stringify({ min: [min.x, min.z], size: [sx, sz] }, null, 2) + '\n')
  return { png, coverage: covered / (res * res) }
}
