// 散布植被（实例化），依赖 npm run terrain 的输出（地形 / 水面 / 可玩区距离场）
//
//   可走动范围内：只长草。草丛模型来自 public/models/assets/grass_single.glb，
//     摆法照 public/models/assets/grass_scatter.glb：把那块样本里 48 丛草的相对位置 / 大小 / 种类拆出来当「印章」，
//     放大 grassScale 倍后，随机旋转着一枚枚盖满可走动范围（避开水面、石头）
//   走动范围边缘及更外面：原模型（art/env/<name>.glb）里的花草、盆景树，减面后散布
//
//   输出：public/models/env/<name>.scatter.glb
//     每个「原型 × 区域 × 扇区」一个节点，EXT_mesh_gpu_instancing（运行时是 InstancedMesh，一个节点一个 draw call）
//     草：材质 grass_clump，顶点色 = 根部 → 叶尖渐变，实例色 = 每丛色差；花草：沿用原材质名（风动 / SSS / look dev 覆盖）
//     节点名 <原型>_<区域>_<扇区>；实例顺序打乱，运行时按密度截断数量就是随机抽稀
//
// 用法：npm run scatter            （默认 garden）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions'
import { dedup, draco, prune, simplify, textureCompress } from '@gltf-transform/functions'
import { checkKTXSoftware, toktx } from '@gltf-transform/cli'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, Euler, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Raycaster, Vector3 } from 'three'
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh'
import { assignTextures } from './assign-textures.mjs'

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
Mesh.prototype.raycast = acceleratedRaycast

/**
 * grass：草丛原型（file / mesh）与摆法样本（sample 文件里 mesh 名 → 原型）
 *   grassScale = 样本整体放大倍数（样本里一丛只有几厘米）；stampSpacing = 印章中心的间距（米）
 *   inset = 离原地形边缘多远以内才长草（与软边界停下的位置对齐）
 * plants：花草原型（原模型里的 mesh 名）
 * lod：三级减面上限（三角面）；budget 里的原型按倍数放宽
 * zones：rim / meadow 的 band = 到原地形边缘的距离范围（米，正 = 岛外，负 = 岛内）
 */
const RULES = {
  garden: {
    seed: 3,
    lod: { hi: 150, mid: 600, lo: 350 },
    budget: { tree: 3, tree2: 3 },
    grass: {
      prototypes: {
        tuftC: { file: 'public/models/assets/grass_single.glb', mesh: 'Grass C.12' },
        tuftB: { file: 'public/models/assets/grass_single.glb', mesh: 'Grass B' },
      },
      sample: { file: 'public/models/assets/grass_scatter.glb', meshes: { 'Grass C.12': 'tuftC', 'Grass B.2': 'tuftB' } },
      grassScale: 4.6,
      stampSpacing: 2.6,
      inset: 0.4,
      // 往地面手绘贴图的苔绿（色相 ~105°）靠，叶尖不要太亮太黄，否则一丛丛草在地上很跳
      color: { base: '#2b4224', tip: '#6a8c55', variation: 0.18 },
    },
    plants: {
      // SC14 大罂粟（bigpoppy）不撒：块面太硬，远处看着丑
      poppy: '7', poppy2: '5', poppy3: '3',
      lupin: '16', lupin2: '17', hydrangea: '28',
      archangel: '33', archangel2: '37', arrowhead: '46', arrowhead2: '43',
      pineapple: '19', snakeplant: '51', bud: '15',
      // SC23–26 名字叫 tree，其实是叠石塔，不撒；真正的盆景树只有 SC21 / SC22
      tree: '21', tree2: '22',
    },
    zones: {
      rim: {
        lod: 'mid', count: 700, spacing: 0.75, scale: [0.9, 1.5], band: [-1.5, 11],
        types: { hydrangea: 3, lupin: 3, lupin2: 2, poppy: 3, poppy2: 2, poppy3: 2, pineapple: 1, snakeplant: 1, archangel: 2, arrowhead: 2 },
      },
      meadow: {
        lod: 'lo', count: 480, spacing: 2, scale: [1.2, 2.2], band: [11, 55],
        types: { hydrangea: 3, lupin: 2, poppy: 2, pineapple: 1, snakeplant: 1, tree: 1, tree2: 1 },
      },
    },
    /** 原模型里这些 mesh 周围不长东西（石头、汀步、叠石塔） */
    avoidProps: ['53', '54', '23', '24', '25', '26'],
    sectors: 4,
  },
}

const name = process.argv[2] ?? 'garden'
const R = RULES[name]
if (!R) {
  console.error(`没有 ${name} 的散布规则`)
  process.exit(1)
}

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
await MeshoptSimplifier.ready

const t0 = Date.now()
const log = (msg) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(R.seed)
const pick = (weights) => {
  const entries = Object.entries(weights)
  let s = rand() * entries.reduce((a, [, w]) => a + w, 0)
  for (const [k, w] of entries) if ((s -= w) <= 0) return k
  return entries[0][0]
}

// ---------- 1. 读输入 ----------
console.log(`\n▸ ${name} 散布植被`)
const meta = JSON.parse(readFileSync(`public/models/env/${name}.terrain.json`, 'utf8'))
const boundsMeta = JSON.parse(readFileSync(`public/models/env/${name}.terrain.bounds.json`, 'utf8'))
const sdfImg = await sharp(`public/models/env/${name}.terrain.bounds.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true })

/** 到原地形边缘的有符号距离（正 = 岛内）；距离场范围外按离范围框的距离估一个负值 */
function edgeDistance(x, z) {
  const { data, info } = sdfImg
  const u = Math.floor(((x - boundsMeta.min[0]) / boundsMeta.size[0]) * info.width)
  const v = Math.floor(((z - boundsMeta.min[1]) / boundsMeta.size[1]) * info.height)
  if (u < 0 || v < 0 || u >= info.width || v >= info.height) {
    const ox = Math.max(boundsMeta.min[0] - x, 0, x - boundsMeta.min[0] - boundsMeta.size[0])
    const oz = Math.max(boundsMeta.min[1] - z, 0, z - boundsMeta.min[1] - boundsMeta.size[1])
    return -(boundsMeta.range + Math.hypot(ox, oz))
  }
  const k = (v * info.width + u) * info.channels
  return ((data[k] * 256 + data[k + 1]) / 65535) * 2 * boundsMeta.range - boundsMeta.range
}

// 生成地形 + 水面（射线找地面高度 / 坡度 / 是否在水里）
const terrainDoc = await io.read(`art/terrain/${name}.terrain.glb`)
const ground = []
let waterMesh = null
for (const node of terrainDoc.getRoot().listNodes()) {
  const mesh = node.getMesh()
  if (!mesh || node.getName() === 'terrain_peaks') continue
  const prim = mesh.listPrimitives()[0]
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(prim.getAttribute('POSITION').getArray().slice(), 3))
  g.setIndex(new BufferAttribute(prim.getIndices().getArray().slice(), 1))
  g.computeBoundsTree()
  const m = new Mesh(g, new MeshBasicMaterial({ side: DoubleSide }))
  m.updateMatrixWorld()
  if (node.getName() === 'water') waterMesh = m
  else ground.push(m)
}
const ray = new Raycaster()
ray.firstHitOnly = true
const DOWN = new Vector3(0, -1, 0)
const origin = new Vector3()
function groundAt(x, z) {
  origin.set(x, 200, z)
  ray.set(origin, DOWN)
  const hit = ray.intersectObjects(ground, false)[0]
  if (!hit) return null
  return { y: hit.point.y, up: Math.abs(hit.face.normal.y) }
}
function waterAt(x, z) {
  if (!waterMesh) return null
  origin.set(x, 200, z)
  ray.set(origin, DOWN)
  return ray.intersectObject(waterMesh, false)[0]?.point.y ?? null
}
/** 这一点或附近 probe 米内在水里（水面比地面高） */
function wet(x, z, probe) {
  for (const [dx, dz] of [[0, 0], [probe, 0], [-probe, 0], [0, probe], [0, -probe]]) {
    const w = waterAt(x + dx, z + dz)
    if (w !== null && w > (groundAt(x + dx, z + dz)?.y ?? -Infinity) - 0.02) return true
  }
  return false
}

// 原模型：花草原型 + 石头等位置（撒的时候避开）
const srcDoc = await io.read(`art/env/${name}.glb`)
await assignTextures(srcDoc, name, 'art/textures')
const props = []
const box = new Box3()
for (const node of srcDoc.getRoot().listNodes()) {
  const mesh = node.getMesh()
  if (!mesh || !R.avoidProps.includes(mesh.getName())) continue
  const p = mesh.listPrimitives()[0].getAttribute('POSITION')
  box.set(new Vector3(...p.getMin([])), new Vector3(...p.getMax([]))).applyMatrix4(new Matrix4().fromArray(node.getWorldMatrix()))
  // 汀步那种细长的一串按包围盒挡会挡掉一大片，只取中心附近
  const c = box.getCenter(new Vector3())
  props.push({ x: c.x, z: c.z, r: Math.min(0.9, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2) })
}
const nearProp = (x, z, pad) => props.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < (q.r + pad) ** 2)

// ---------- 2. 原型 ----------
const out = new Document()
const buffer = out.createBuffer()
const outScene = out.createScene(name)
const batchExt = out.createExtension(EXTMeshGPUInstancing).setRequired(true)
const acc = (d, b, type, arr) => d.createAccessor().setType(type).setArray(arr).setBuffer(b)

const materials = new Map()
const textures = new Map()
function copyMaterial(src) {
  const key = src?.getName() ?? 'untextured'
  if (materials.has(key)) return materials.get(key)
  const mat = out.createMaterial(key).setRoughnessFactor(src?.getRoughnessFactor() ?? 0.9).setMetallicFactor(0)
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
const grassMaterial = out.createMaterial('grass_clump').setRoughnessFactor(0.85).setMetallicFactor(0).setDoubleSided(true)
const baseLin = new Color(R.grass.color.base) // Color.set 把 sRGB 转成线性，glTF 顶点色就是线性
const tipLin = new Color(R.grass.color.tip)

/**
 * 原型的一级 LOD：挪到原点（底部中心），按位置焊接后减面。
 * 植物是按法线 / UV 拆开的三角面汤，不焊接的话每条边都是「边界」，减面器下不去刀；接缝处贴图略糊，远看没影响。
 * grass = true：无贴图，写根部 → 叶尖的顶点色，材质用 grass_clump；否则每个 primitive 沿用原材质。
 */
async function buildPrototype(key, node, maxTris, grass) {
  const world = new Matrix4().fromArray(node.getWorldMatrix())
  const bb = new Box3()
  const v = new Vector3()
  const parts = []
  for (const prim of node.getMesh().listPrimitives()) {
    const P = prim.getAttribute('POSITION').getArray().slice()
    for (let i = 0; i < P.length; i += 3) {
      v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(world)
      P.set([v.x, v.y, v.z], i)
      bb.expandByPoint(v)
    }
    parts.push({ prim, P })
  }
  const cx = (bb.min.x + bb.max.x) / 2
  const cz = (bb.min.z + bb.max.z) / 2
  const height = bb.max.y - bb.min.y
  const mesh = out.createMesh(key)
  let tris = 0
  for (const { prim, P } of parts) {
    const uvSrc = grass ? null : prim.getAttribute('TEXCOORD_0')?.getArray()
    const src = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: P.length / 3 }, (_, i) => i)
    const remap = new Map()
    const WP = []
    const WU = []
    const idx = new Uint32Array(src.length)
    for (let i = 0; i < src.length; i++) {
      const s = src[i]
      const x = P[s * 3] - cx
      const y = P[s * 3 + 1] - bb.min.y
      const z = P[s * 3 + 2] - cz
      const k = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`
      let w = remap.get(k)
      if (w === undefined) {
        w = WP.length / 3
        remap.set(k, w)
        WP.push(x, y, z)
        if (uvSrc) WU.push(uvSrc[s * 2], uvSrc[s * 2 + 1])
      }
      idx[i] = w
    }
    const tmp = new Document()
    const tb = tmp.createBuffer()
    const tp = tmp.createPrimitive().setAttribute('POSITION', acc(tmp, tb, 'VEC3', new Float32Array(WP))).setIndices(acc(tmp, tb, 'SCALAR', idx))
    if (uvSrc) tp.setAttribute('TEXCOORD_0', acc(tmp, tb, 'VEC2', new Float32Array(WU)))
    tmp.createScene().addChild(tmp.createNode(key).setMesh(tmp.createMesh(key).addPrimitive(tp)))
    const budget = maxTris * (src.length / 3 / parts.reduce((s, q) => s + (q.prim.getIndices()?.getCount() ?? q.P.length / 3) / 3, 0))
    if (src.length / 3 > budget) await tmp.transform(simplify({ simplifier: MeshoptSimplifier, ratio: budget / (src.length / 3), error: 1, lockBorder: false }))

    const Pf = tp.getAttribute('POSITION').getArray()
    const If = tp.getIndices().getArray()
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(Pf.slice(), 3))
    g.setIndex(new BufferAttribute(If.slice(), 1))
    g.computeVertexNormals()
    const op = out
      .createPrimitive()
      .setAttribute('POSITION', acc(out, buffer, 'VEC3', Pf.slice()))
      .setAttribute('NORMAL', acc(out, buffer, 'VEC3', new Float32Array(g.getAttribute('normal').array)))
      .setIndices(acc(out, buffer, 'SCALAR', If.slice()))
    if (grass) {
      // 根部暗 → 叶尖亮（ease-in：大部分叶片偏亮，只有根部一圈暗）
      const C = new Float32Array(Pf.length)
      for (let i = 0; i < Pf.length / 3; i++) {
        const t = Math.pow(Math.min(1, Pf[i * 3 + 1] / height), 0.6)
        C.set([baseLin.r + (tipLin.r - baseLin.r) * t, baseLin.g + (tipLin.g - baseLin.g) * t, baseLin.b + (tipLin.b - baseLin.b) * t], i * 3)
      }
      op.setAttribute('COLOR_0', acc(out, buffer, 'VEC3', C)).setMaterial(grassMaterial)
    } else {
      if (tp.getAttribute('TEXCOORD_0')) op.setAttribute('TEXCOORD_0', acc(out, buffer, 'VEC2', tp.getAttribute('TEXCOORD_0').getArray().slice()))
      op.setMaterial(copyMaterial(prim.getMaterial()))
    }
    mesh.addPrimitive(op)
    tris += If.length / 3
  }
  return { mesh, tris, height, radius: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 }
}

const findNode = (doc, meshName, file) => {
  const n = doc.getRoot().listNodes().find((x) => x.getMesh()?.getName() === meshName)
  if (!n) throw new Error(`${file} 里没有 mesh ${meshName}`)
  return n
}

// 草：只要一级（都在可走动范围内，离相机不远）
const protos = {}
const grassDocs = new Map()
for (const [key, def] of Object.entries(R.grass.prototypes)) {
  if (!grassDocs.has(def.file)) grassDocs.set(def.file, await io.read(def.file))
  const p = await buildPrototype(key, findNode(grassDocs.get(def.file), def.mesh, def.file), R.lod.hi, true)
  protos[key] = { hi: p }
}
for (const [key, meshName] of Object.entries(R.plants)) {
  const node = findNode(srcDoc, meshName, `art/env/${name}.glb`)
  const b = R.budget[key] ?? 1
  protos[key] = {
    mid: await buildPrototype(key, node, R.lod.mid * b, false),
    lo: await buildPrototype(key, node, R.lod.lo * b, false),
  }
}
log(`原型：草 ${Object.keys(R.grass.prototypes).length} 种，花草 ${Object.keys(R.plants).length} 种`)

// ---------- 3. 草的摆法样本：grass_scatter 里每根草叶是一个连通块，按种类 k-means 聚回草丛 ----------
async function readSample() {
  const S = R.grass.sample
  const doc = await io.read(S.file)
  const tufts = []
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    const proto = mesh && S.meshes[mesh.getName()]
    if (!proto) continue
    const W = new Matrix4().fromArray(node.getWorldMatrix())
    const prim = mesh.listPrimitives()[0]
    const P = prim.getAttribute('POSITION').getArray()
    const I = prim.getIndices().getArray()
    const N = P.length / 3
    // 按位置焊接后 union-find，求每根草叶的底部中心
    const weld = new Map()
    const id = new Int32Array(N)
    for (let i = 0; i < N; i++) {
      const k = `${Math.round(P[i * 3] * 1e5)},${Math.round(P[i * 3 + 1] * 1e5)},${Math.round(P[i * 3 + 2] * 1e5)}`
      let w = weld.get(k)
      if (w === undefined) {
        w = weld.size
        weld.set(k, w)
      }
      id[i] = w
    }
    const par = Int32Array.from({ length: weld.size }, (_, i) => i)
    const find = (a) => {
      while (par[a] !== a) a = par[a] = par[par[a]]
      return a
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = find(id[I[t]])
      par[find(id[I[t + 1]])] = a
      par[find(id[I[t + 2]])] = a
    }
    const blades = new Map()
    for (let i = 0; i < N; i++) {
      v3.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(W)
      const r = find(id[i])
      const b = blades.get(r) ?? { sx: 0, sz: 0, n: 0 }
      b.sx += v3.x
      b.sz += v3.z
      b.n++
      blades.set(r, b)
    }
    const pts = [...blades.values()].map((b) => ({ x: b.sx / b.n, z: b.sz / b.n }))
    // 草丛数 = 顶点数 / 单丛顶点数（样本是单丛模型的整数份拷贝）
    const single = protos[proto]
    const singleDef = R.grass.prototypes[proto]
    const singleVerts = findNode(grassDocs.get(singleDef.file), singleDef.mesh, singleDef.file).getMesh().listPrimitives()[0].getAttribute('POSITION').getCount()
    const K = Math.max(1, Math.round(N / singleVerts))
    const cs = [{ ...pts[0] }]
    while (cs.length < K) {
      let best = pts[0]
      let bd = -1
      for (const p of pts) {
        const d = Math.min(...cs.map((c) => (c.x - p.x) ** 2 + (c.z - p.z) ** 2))
        if (d > bd) {
          bd = d
          best = p
        }
      }
      cs.push({ ...best })
    }
    const asg = new Int32Array(pts.length)
    for (let it = 0; it < 30; it++) {
      pts.forEach((p, i) => {
        let b = 0
        let bd = Infinity
        cs.forEach((c, j) => {
          const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2
          if (d < bd) {
            bd = d
            b = j
          }
        })
        asg[i] = b
      })
      cs.forEach((c, j) => {
        let sx = 0
        let sz = 0
        let n = 0
        pts.forEach((p, i) => {
          if (asg[i] === j) {
            sx += p.x
            sz += p.z
            n++
          }
        })
        if (n) {
          c.x = sx / n
          c.z = sz / n
        }
        c.n = n
      })
    }
    // 草丛大小：分到的草叶数相对单丛草叶数（草叶多 = 两丛叠在一起，按面积换算成更大的一丛）
    const perTuft = pts.length / K
    for (const c of cs) tufts.push({ proto, x: c.x, z: c.z, size: Math.sqrt(Math.max(0.4, c.n / perTuft)), height: single.hi.height })
  }
  const cx = tufts.reduce((s, t) => s + t.x, 0) / tufts.length
  const cz = tufts.reduce((s, t) => s + t.z, 0) / tufts.length
  for (const t of tufts) {
    t.x -= cx
    t.z -= cz
  }
  return tufts
}
const v3 = new Vector3()
const sample = await readSample()
const sampleExtent = Math.max(...sample.map((t) => Math.hypot(t.x, t.z))) * R.grass.grassScale
log(`草摆法样本：${sample.length} 丛，放大后印章半径 ${sampleExtent.toFixed(1)}m`)

// ---------- 4. 撒点（空间哈希避让） ----------
const CELL = 1
const grid = new Map()
function tooClose(x, z, r, factor, owner) {
  const cx = Math.floor(x / CELL)
  const cz = Math.floor(z / CELL)
  const reach = Math.ceil((r * 2) / CELL)
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) {
      for (const q of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (owner !== undefined && q.owner === owner) continue
        if ((q.x - x) ** 2 + (q.z - z) ** 2 < ((q.r + r) * factor) ** 2) return true
      }
    }
  }
  return false
}
function occupy(x, z, r, owner) {
  const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`
  if (!grid.has(k)) grid.set(k, [])
  grid.get(k).push({ x, z, r, owner })
}

const instances = [] // { zone, proto, x, y, z, yaw, scale, color? }
const cx0 = (meta.box.min[0] + meta.box.max[0]) / 2
const cz0 = (meta.box.min[1] + meta.box.max[1]) / 2
const bw = meta.box.max[0] - meta.box.min[0]
const bh = meta.box.max[1] - meta.box.min[1]

// 4a. 草：印章铺满可走动范围（抖动网格上盖章，每枚随机旋转 / 镜像）
const G = R.grass
let grassN = 0
let stamp = 0
for (let gz = meta.box.min[1] - sampleExtent; gz < meta.box.max[1] + sampleExtent; gz += G.stampSpacing) {
  for (let gx = meta.box.min[0] - sampleExtent; gx < meta.box.max[0] + sampleExtent; gx += G.stampSpacing) {
    const sx = gx + (rand() - 0.5) * G.stampSpacing
    const sz = gz + (rand() - 0.5) * G.stampSpacing
    const a = rand() * Math.PI * 2
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const mirror = rand() < 0.5 ? -1 : 1
    stamp++
    for (const t of sample) {
      const lx = t.x * mirror * G.grassScale
      const lz = t.z * G.grassScale
      const x = sx + lx * ca - lz * sa
      const z = sz + lx * sa + lz * ca
      if (edgeDistance(x, z) < G.inset) continue
      const scale = G.grassScale * t.size * (0.85 + rand() * 0.3)
      const r = protos[t.proto].hi.radius * scale
      // 同一枚印章里照样本原样（草丛本来就互相挨着）；和别的印章重叠的地方别叠两层
      if (tooClose(x, z, r, 0.5, stamp)) continue
      const g = groundAt(x, z)
      if (!g || g.up < 0.75 || wet(x, z, 0.12) || nearProp(x, z, 0.1)) continue
      occupy(x, z, r, stamp)
      const vv = G.color.variation
      const bright = 1 + (rand() * 2 - 1) * vv
      const hue = (rand() * 2 - 1) * vv * 0.6
      instances.push({ zone: 'lawn', proto: t.proto, x, y: g.y - 0.01, z, yaw: rand() * Math.PI * 2, scale, color: [bright * (1 + hue), bright, bright * (1 - hue * 0.5)] })
      grassN++
    }
  }
}

// 4b. 花草：走动范围边缘及更外面；成片出现（先撒片心，附近几株同种）
function scatterZone(zoneName) {
  const Z = R.zones[zoneName]
  const [b0, b1] = Z.band
  const inBand = (x, z) => {
    const d = -edgeDistance(x, z)
    return d > b0 && d < b1
  }
  let n = 0
  for (let tries = 0; tries < Z.count * 40 && n < Z.count; tries++) {
    const a0 = rand() * Math.PI * 2
    const r0 = rand() * (Math.max(bw, bh) / 2 + b1 + 10)
    const cx = cx0 + Math.cos(a0) * r0
    const cz = cz0 + Math.sin(a0) * r0
    if (!inBand(cx, cz)) continue
    // 离岛越远越稀
    if (rand() > 1 - ((-edgeDistance(cx, cz) - b0) / (b1 - b0)) * 0.6) continue
    const proto = pick(Z.types)
    const members = 1 + Math.floor(rand() * 4)
    for (let m = 0; m < members && n < Z.count; m++) {
      const a = rand() * Math.PI * 2
      const d = m === 0 ? 0 : Z.spacing * (1 + rand() * 1.5)
      const x = cx + Math.cos(a) * d
      const z = cz + Math.sin(a) * d
      if (!inBand(x, z)) continue
      const scale = Z.scale[0] + rand() * (Z.scale[1] - Z.scale[0])
      const r = Math.max(Z.spacing, protos[proto][Z.lod].radius * scale * 0.8)
      if (tooClose(x, z, r, 0.5)) continue
      const g = groundAt(x, z)
      if (!g || g.up < 0.8 || wet(x, z, 0.4) || nearProp(x, z, 0.3)) continue
      occupy(x, z, r)
      instances.push({ zone: zoneName, proto, x, y: g.y - 0.03 * scale, z, yaw: rand() * Math.PI * 2, scale })
      n++
    }
  }
  return n
}
const rimN = scatterZone('rim')
const meadowN = scatterZone('meadow')
log(`实例：草 ${grassN}，边缘花草 ${rimN}，远处花草 ${meadowN}，共 ${instances.length}`)

// ---------- 5. 写实例化节点（原型 × 区域 × 扇区） ----------
// 洗牌：运行时按密度截断 count 时，留下的是随机子集
for (let i = instances.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1))
  ;[instances[i], instances[j]] = [instances[j], instances[i]]
}
const groups = new Map()
for (const it of instances) {
  // 按方位分成几块，视锥外的整块剔除
  const sector = Math.floor(((Math.atan2(it.z - cz0, it.x - cx0) / (Math.PI * 2) + 1) % 1) * R.sectors)
  const key = `${it.proto}_${it.zone}_${sector}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(it)
}
const q = new Quaternion()
let totalTris = 0
for (const [key, list] of groups) {
  const [proto, zone] = key.split('_')
  const p = zone === 'lawn' ? protos[proto].hi : protos[proto][R.zones[zone].lod]
  const T = new Float32Array(list.length * 3)
  const Q = new Float32Array(list.length * 4)
  const S = new Float32Array(list.length * 3)
  list.forEach((it, i) => {
    T.set([it.x, it.y, it.z], i * 3)
    q.setFromEuler(new Euler(0, it.yaw, 0))
    Q.set([q.x, q.y, q.z, q.w], i * 4)
    S.set([it.scale, it.scale, it.scale], i * 3)
  })
  const batch = batchExt
    .createInstancedMesh()
    .setAttribute('TRANSLATION', acc(out, buffer, 'VEC3', T))
    .setAttribute('ROTATION', acc(out, buffer, 'VEC4', Q))
    .setAttribute('SCALE', acc(out, buffer, 'VEC3', S))
  if (list[0].color) batch.setAttribute('_COLOR_0', acc(out, buffer, 'VEC3', Float32Array.from(list.flatMap((it) => it.color))))
  outScene.addChild(out.createNode(key).setMesh(p.mesh).setExtension('EXT_mesh_gpu_instancing', batch))
  totalTris += p.tris * list.length
}
log(`${groups.size} 个实例化节点，满密度约 ${(totalTris / 1000).toFixed(0)}k 三角面`)

await out.transform(
  prune(),
  dedup(),
  hasKTX
    ? toktx({ encoder: sharp, mode: 'etc1s', quality: 200, compression: 2 })
    : textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 85 }),
  draco(),
)
const file = join('public/models/env', `${name}.scatter.glb`)
await io.write(file, out)
log(`完成 → ${file}`)
