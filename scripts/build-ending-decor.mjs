// 结尾标本盒里的装饰花草：从三个场景的原模型里拆几株，合成一个小 glb（结尾页不用加载整个场景）
//   art/env/<scene>.glb（贴图规则同 npm run models）──► public/models/ending/decor.glb
//
//   每株一个根节点，名字 = <scene>_<原 mesh 名>（运行时按名字取）；几何已烘进世界变换并挪到原点（底部中心），
//   材质沿用原材质名。运行时按 ending.json 的 decor 配置缩放 / 摆放。
//   另有两种草丛（花园同款 grass_single.glb，减面 + 根部暗 → 叶尖亮的顶点色），节点名 grass_<名字>，
//   运行时沿画框内框铺一圈。
//
// 用法：npm run decor

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, draco, prune, simplify, textureCompress } from '@gltf-transform/functions'
import { checkKTXSoftware, toktx } from '@gltf-transform/cli'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { Box3, BufferAttribute, BufferGeometry, Color, Matrix3, Matrix4, Vector3 } from 'three'
import { assignTextures } from './assign-textures.mjs'

/** 每个场景拆哪些 mesh（原模型里的 mesh 名） */
const PICK = {
  cave: ['50', '55', '57'], // 紫蕨、两簇小蘑菇
  garden: ['2', '5', '32'], // 粉野花、红罂粟、一枝绿叶
  ocean: ['25', '19'], // 白珊瑚枝、小水晶簇
}

/** 草丛：原型（文件 / mesh 名）、减面上限（三角面）、根部 → 叶尖颜色（与花园 build-scatter 一致） */
const GRASS = {
  file: 'public/models/assets/grass_single.glb',
  tufts: { tuftC: 'Grass C.12', tuftB: 'Grass B' },
  maxTris: 600,
  color: { base: '#2c3d16', tip: '#9db25a' },
}

const SRC = 'art/env'
const TEXTURES = 'art/textures'
const OUT = 'public/models/ending'

const KTX_BIN = process.env.KTX_BIN ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'tools', 'KTX', 'bin')
process.env.PATH = `${KTX_BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`
let hasKTX = false
try {
  await checkKTXSoftware({ debug() {}, info() {}, warn() {}, error() {} })
  hasKTX = true
} catch {
  console.warn('⚠ 没找到 KTX-Software，贴图回落为 WebP')
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
})

const out = new Document()
const buffer = out.createBuffer()
const outScene = out.createScene('decor')
const acc = (type, arr) => out.createAccessor().setType(type).setArray(arr).setBuffer(buffer)
const materials = new Map()
const textures = new Map()

function copyMaterial(src) {
  const key = src?.getName() || 'untextured'
  if (materials.has(key)) return materials.get(key)
  const mat = out
    .createMaterial(key)
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.9)
    .setMetallicFactor(0)
    .setDoubleSided(true)
    .setAlphaMode(src?.getAlphaMode() ?? 'OPAQUE')
    .setAlphaCutoff(src?.getAlphaCutoff() ?? 0.5)
  const tex = src?.getBaseColorTexture()
  if (tex) {
    let t = textures.get(tex)
    if (!t) {
      t = out.createTexture(tex.getName()).setMimeType(tex.getMimeType()).setImage(tex.getImage())
      textures.set(tex, t)
    }
    mat.setBaseColorTexture(t)
  }
  materials.set(key, mat)
  return mat
}

for (const [scene, names] of Object.entries(PICK)) {
  const doc = await io.read(join(SRC, `${scene}.glb`))
  await assignTextures(doc, scene, TEXTURES)
  for (const name of names) {
    const node = doc.getRoot().listNodes().find((n) => n.getMesh() && (n.getMesh().getName() || n.getName()) === name)
    if (!node) throw new Error(`${scene}.glb 里没有 mesh ${name}`)
    const world = new Matrix4().fromArray(node.getWorldMatrix())
    const normalMat = new Matrix3().getNormalMatrix(world)
    const v = new Vector3()
    const bb = new Box3()
    const parts = node.getMesh().listPrimitives().map((prim) => {
      const P = prim.getAttribute('POSITION').getArray().slice()
      for (let i = 0; i < P.length; i += 3) {
        v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(world)
        P.set([v.x, v.y, v.z], i)
        bb.expandByPoint(v)
      }
      const N = prim.getAttribute('NORMAL')?.getArray().slice()
      if (N) {
        for (let i = 0; i < N.length; i += 3) {
          v.set(N[i], N[i + 1], N[i + 2]).applyMatrix3(normalMat).normalize()
          N.set([v.x, v.y, v.z], i)
        }
      }
      return { prim, P, N }
    })
    // 挪到原点：底部中心
    const c = bb.getCenter(new Vector3())
    const mesh = out.createMesh(`${scene}_${name}`)
    for (const { prim, P, N } of parts) {
      for (let i = 0; i < P.length; i += 3) {
        P[i] -= c.x
        P[i + 1] -= bb.min.y
        P[i + 2] -= c.z
      }
      const p = out.createPrimitive().setAttribute('POSITION', acc('VEC3', P)).setMaterial(copyMaterial(prim.getMaterial()))
      if (N) p.setAttribute('NORMAL', acc('VEC3', N))
      const uv = prim.getAttribute('TEXCOORD_0')
      if (uv) p.setAttribute('TEXCOORD_0', acc('VEC2', uv.getArray().slice()))
      const idx = prim.getIndices()
      if (idx) p.setIndices(acc('SCALAR', idx.getArray().slice()))
      mesh.addPrimitive(p)
    }
    outScene.addChild(out.createNode(`${scene}_${name}`).setMesh(mesh))
    const size = bb.getSize(new Vector3())
    console.log(`  ${scene}_${name}  ${size.toArray().map((x) => x.toFixed(2)).join(' × ')}  ${[...materials.keys()].at(-1)}`)
  }
}

// ---------- 草丛 ----------
{
  const doc = await io.read(GRASS.file)
  const grassMat = out.createMaterial('grass_clump').setRoughnessFactor(0.85).setMetallicFactor(0).setDoubleSided(true)
  const base = new Color(GRASS.color.base) // Color.set 把 sRGB 转成线性，glTF 顶点色就是线性
  const tip = new Color(GRASS.color.tip)
  for (const [key, meshName] of Object.entries(GRASS.tufts)) {
    const node = doc.getRoot().listNodes().find((n) => n.getMesh()?.getName() === meshName)
    if (!node) throw new Error(`${GRASS.file} 里没有 mesh ${meshName}`)
    const world = new Matrix4().fromArray(node.getWorldMatrix())
    const v = new Vector3()
    const bb = new Box3()
    const prims = node.getMesh().listPrimitives().map((prim) => {
      const P = prim.getAttribute('POSITION').getArray().slice()
      for (let i = 0; i < P.length; i += 3) {
        v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(world)
        P.set([v.x, v.y, v.z], i)
        bb.expandByPoint(v)
      }
      return { P, idx: prim.getIndices()?.getArray() ?? Uint32Array.from({ length: P.length / 3 }, (_, i) => i) }
    })
    const height = bb.max.y - bb.min.y
    const c = bb.getCenter(new Vector3())
    const mesh = out.createMesh(`grass_${key}`)
    for (const { P, idx } of prims) {
      // 草是三角面汤，先按位置焊接，减面器才下得去刀；挪到底部中心
      const remap = new Map()
      const WP = []
      const I = new Uint32Array(idx.length)
      for (let i = 0; i < idx.length; i++) {
        const s = idx[i]
        const x = P[s * 3] - c.x
        const y = P[s * 3 + 1] - bb.min.y
        const z = P[s * 3 + 2] - c.z
        const k = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`
        let w = remap.get(k)
        if (w === undefined) {
          w = WP.length / 3
          remap.set(k, w)
          WP.push(x, y, z)
        }
        I[i] = w
      }
      const tmp = new Document()
      const tb = tmp.createBuffer()
      const tp = tmp
        .createPrimitive()
        .setAttribute('POSITION', tmp.createAccessor().setType('VEC3').setArray(new Float32Array(WP)).setBuffer(tb))
        .setIndices(tmp.createAccessor().setType('SCALAR').setArray(I).setBuffer(tb))
      tmp.createScene().addChild(tmp.createNode(key).setMesh(tmp.createMesh(key).addPrimitive(tp)))
      if (I.length / 3 > GRASS.maxTris) {
        await tmp.transform(simplify({ simplifier: MeshoptSimplifier, ratio: GRASS.maxTris / (I.length / 3), error: 1, lockBorder: false }))
      }
      const Pf = tp.getAttribute('POSITION').getArray().slice()
      const If = tp.getIndices().getArray().slice()
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(Pf, 3))
      g.setIndex(new BufferAttribute(If, 1))
      g.computeVertexNormals()
      const C = new Float32Array(Pf.length)
      for (let i = 0; i < Pf.length / 3; i++) {
        const t = Math.pow(Math.min(1, Pf[i * 3 + 1] / height), 0.6)
        C.set([base.r + (tip.r - base.r) * t, base.g + (tip.g - base.g) * t, base.b + (tip.b - base.b) * t], i * 3)
      }
      mesh.addPrimitive(
        out
          .createPrimitive()
          .setAttribute('POSITION', acc('VEC3', Pf))
          .setAttribute('NORMAL', acc('VEC3', new Float32Array(g.getAttribute('normal').array)))
          .setAttribute('COLOR_0', acc('VEC3', C))
          .setIndices(acc('SCALAR', If))
          .setMaterial(grassMat),
      )
      console.log(`  grass_${key}  高 ${height.toFixed(3)}  ${If.length / 3} 三角面`)
    }
    outScene.addChild(out.createNode(`grass_${key}`).setMesh(mesh))
  }
}

await out.transform(
  prune(),
  dedup(),
  hasKTX
    ? toktx({ encoder: sharp, mode: 'etc1s', quality: 200, compression: 2 })
    : textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 85 }),
  draco(),
)
mkdirSync(OUT, { recursive: true })
const file = join(OUT, 'decor.glb')
await io.write(file, out)
console.log(`完成 → ${file}`)
