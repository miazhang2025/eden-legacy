// 场景里的人物（环境的一部分，不是玩家角色）
//   art/character/<scene>.glb  ──►  public/models/env/<scene>.character.glb        渲染用：由场景 config 的 env.extras 加载
//                              └─►  public/models/colliders/<scene>.character.glb  碰撞用：由 env.extraColliders 加载（玩家不能穿过人物）
// 两者都挂在环境模型的变换下（美术在 Blender 里对着环境模型摆好的位置原样保留）。
//
// 美术给的是 Daz（Genesis 9）+ Mixamo 骨骼摆好姿势的蒙皮模型，约 70 万面 / 60MB，动画只有一帧（就是这个姿势）。
// 处理：
//   1. 把骨骼姿势烘进顶点（蒙皮 → 静态网格）：去掉骨骼 / 蒙皮 / 动画，运行时不用每帧算蒙皮
//   2. 删掉看不见又会出错的部件：眼球湿润层、泪腺（alpha 0.05 的透明壳，排序会闪）、口腔（牙齿舌头，嘴是闭着的）
//   3. 透明材质：头发 / 睫毛 / 蝴蝶翅膀从 BLEND 改成 alpha 裁切（大量交叠的透明面片排序必乱；有 MSAA 时运行时开 alpha-to-coverage）
//   4. 材质改名：统一 char_ 前缀（面板里一眼认出来；Pool_Water 会被认成水面而隐藏，改成 char_droplet）
//   5. 按部件减面（PARTS），同材质的 mesh 合并（省 draw call）
//   6. 贴图（所有槽位：颜色 / 法线 / AO / 粗糙度 / specular）按部件限尺寸；
//      KTX2：法线贴图用 UASTC（ETC1S 压法线会出色块），其余 ETC1S；没装 KTX-Software 时回落 WebP。最后 Draco
//   7. 碰撞体：只留身体 / 头发 / 裙子（COLLIDER），合并后减到 COLLIDER_TRIANGLES 面，无材质
//   9. Idle 动画数据（运行时顶点着色器用，见 src/materials/figure.ts，不做物理模拟）：
//      _IDLE 顶点属性 = (呼吸权重, 头部权重, 布料权重, 眨眼权重)，前两项取自原骨骼的蒙皮权重；
//      眨眼权重带符号（+ 上眼皮 / 上睫毛，- 下眼皮 / 下睫毛），按到眼球中心的距离和高度从头部 mesh 里挑出来（BLINK）；
//      颈部位置 / 点头轴 / 两只眼球中心 / 眨眼轴 / 脸朝向 / 两只眼的视线方向写进 pivot 节点的 extras（运行时在 userData 里）
//   8. 轴心：顶点移到以人物脚底中心为原点，挂在一个平移到原位置的 pivot 节点下（渲染 / 碰撞体用同一个轴心）。
//      位置不变；运行时 env.extrasTransform 调这个节点，旋转 / 缩放就绕人物自己转，而不是绕场景原点
//
// 用法：npm run character            处理 art/character 下全部场景人物
//       npm run character -- garden  只处理指定场景

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { NodeIO, getBounds } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  dedup, draco, flatten, join as joinMeshes, prune, simplify, simplifyPrimitive, textureCompress, transformMesh, weld,
} from '@gltf-transform/functions'
import { checkKTXSoftware, toktx } from '@gltf-transform/cli'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { smoothNormals } from './smooth-normals.mjs'

const KTX_BIN = process.env.KTX_BIN ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'tools', 'KTX', 'bin')
process.env.PATH = `${KTX_BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`
let hasKTX = false
try {
  await checkKTXSoftware({ debug() {}, info() {}, warn() {}, error() {} })
  hasKTX = true
} catch {
  console.warn('⚠ 没找到 KTX-Software（ktx / toktx），贴图回落为 WebP：下载体积会变小，但显存占用不降。')
}

const SRC = 'art/character'
const OUT = 'public/models/env'
const OUT_COLLIDER = 'public/models/colliders'

/** 进碰撞体的部件（按 mesh 名）：花、蝴蝶、水珠、眼睛这些小件不挡路 */
const COLLIDER = /Hair|^Genesis9\.Shape|tripo_part|衣服/i
const COLLIDER_TRIANGLES = 4000

/** 整个 mesh 删掉（按 mesh 名匹配） */
const DROP_MESH = /Genesis9Tear|Genesis9Mouth/i
/** 删掉的图元（按材质名匹配） */
const DROP_MATERIAL = /EyeMoisture|Tear/i

/**
 * 按部件：减面比例（ratio）/ 允许的形状误差（error，占 mesh 尺寸的比例）/ 贴图边长上限（texture）。
 * 第一条匹配 mesh 名的生效。人物躺在远处当环境，脸和身体是视觉重点，保留得多一些；
 * Tripo 生成的裙子、花是均匀的高密度网格，减得最多。
 * rebuildNormals：导出时是硬边（每个三角面顶点都单独一份），焊不上就减不动 —— 先丢掉法线焊接，减完再重算平滑法线。
 */
const PARTS = [
  { match: /Hair/i, ratio: 0.35, error: 0.004, texture: 1024 },
  { match: /^Genesis9\.Shape/i, ratio: 0.6, error: 0.002, texture: 2048 },
  { match: /Eyes|Eyelashes/i, ratio: 1, error: 0, texture: 512 },
  { match: /tripo_part_1/i, ratio: 0.2, error: 0.01, texture: 2048 },
  { match: /tripo_part/i, ratio: 0.3, error: 0.01, texture: 1024 },
  { match: /^Mesh_0/i, ratio: 0.3, error: 0.01, texture: 1024, rebuildNormals: true },
  { match: /球体/, ratio: 0.15, error: 0.05, texture: 256, rebuildNormals: true },
  { match: /.*/, ratio: 1, error: 0, texture: 1024 },
]
/** 头部贴图（脸）单独保留 2048，其余身体贴图 1024 */
const TEXTURE_BY_MATERIAL = [
  { match: /HD_Head/i, texture: 2048 },
  { match: /HD_(Body|Arms|Legs|Toenails|Mouth)/i, texture: 1024 },
]

/** Idle 权重：骨骼名 → 系数（Mixamo 骨骼）。呼吸 = 胸腔起伏；头部 = 绕颈部轻微摆动（头发 / 头饰蒙在头骨上，跟着动） */
const BREATH_JOINTS = { 'mixamorig:Spine': 0.3, 'mixamorig:Spine1': 0.7, 'mixamorig:Spine2': 1 }
const HEAD_JOINTS = { 'mixamorig:Neck': 0.5, 'mixamorig:Head': 1, 'mixamorig:HeadTop_End': 1 }
/** 布料（按 mesh 名）：顶点着色器里做低频波动 */
const CLOTH = /tripo_part|衣服/i

/**
 * 眨眼（Genesis 9 没导出表情变形，Mixamo 骨骼也没有眼皮骨骼）：眼皮顶点绕眼球中心、沿左右轴转（真实眼皮也是贴着眼球滑下来）。
 * 按材质名找：眼球（算中心 / 半径）、眼皮所在的头部皮肤、上下睫毛。
 * lid：皮肤顶点到眼球中心的距离（以眼球半径为单位）在 [inner, outer] 之间从全权重衰减到 0；lower = 下眼皮相对上眼皮的转动比例
 */
const BLINK = {
  eyeLeft: /(^|_)Eye_Left/i,
  eyeRight: /(^|_)Eye_Right/i,
  skin: /HD_Head/i,
  upperLash: /Eyelashes_Upper/i,
  lowerLash: /Eyelashes_Lower/i,
  lid: { inner: 1.2, outer: 1.8 },
  lash: { inner: 2.0, outer: 2.6 },
  lower: 0.3,
}

/** 头发 / 睫毛 / 蝴蝶翅膀：BLEND → MASK 的裁切阈值 */
const CUTOUT = [
  { match: /Hair.*scalp/i, cutoff: 0.5 },
  { match: /Hair/i, cutoff: 0.35 },
  { match: /Eyelashes/i, cutoff: 0.3 },
  { match: /.*/, cutoff: 0.5 },
]

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`
const countTriangles = (doc) =>
  doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
    .reduce((sum, p) => sum + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0)

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  })

// ── 4×4 列主序矩阵小工具 ──────────────────────────────────────────────
function mul(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  return o
}

/**
 * 蒙皮烘焙：顶点 = Σ 权重 × (骨骼世界矩阵 × 逆绑定矩阵) × 绑定姿势顶点，结果直接是世界坐标。
 * （glTF 规定蒙皮 mesh 忽略自身节点变换，所以烘完把节点挂到场景根、变换归零即可）
 */
function bakeSkin(doc, node) {
  const skin = node.getSkin()
  const joints = skin.listJoints()
  const breathOf = joints.map((j) => BREATH_JOINTS[j.getName()] ?? 0)
  const headOf = joints.map((j) => HEAD_JOINTS[j.getName()] ?? 0)
  const cloth = CLOTH.test(node.getMesh().getName()) ? 1 : 0
  const idleOf = new Map()
  const ibm = skin.getInverseBindMatrices()
  const mats = joints.map((j, i) => {
    const inv = []
    ibm.getElement(i, inv)
    return mul(j.getWorldMatrix(), inv)
  })
  const baked = new Set()
  for (const prim of node.getMesh().listPrimitives()) {
    const pos = prim.getAttribute('POSITION')
    if (baked.has(pos)) continue
    baked.add(pos)
    const nrm = prim.getAttribute('NORMAL')
    const J = prim.getAttribute('JOINTS_0')
    const W = prim.getAttribute('WEIGHTS_0')
    const n = pos.getCount()
    const P = new Float32Array(n * 3)
    const N = nrm ? new Float32Array(n * 3) : null
    const I = new Float32Array(n * 4)
    const p = [], q = [], j = [], w = []
    for (let i = 0; i < n; i++) {
      pos.getElement(i, p)
      J.getElement(i, j)
      W.getElement(i, w)
      if (N) nrm.getElement(i, q)
      let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, breath = 0, head = 0
      for (let k = 0; k < 4; k++) {
        if (!w[k]) continue
        breath += w[k] * breathOf[j[k]]
        head += w[k] * headOf[j[k]]
        const m = mats[j[k]]
        x += w[k] * (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12])
        y += w[k] * (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13])
        z += w[k] * (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14])
        if (N) {
          nx += w[k] * (m[0] * q[0] + m[4] * q[1] + m[8] * q[2])
          ny += w[k] * (m[1] * q[0] + m[5] * q[1] + m[9] * q[2])
          nz += w[k] * (m[2] * q[0] + m[6] * q[1] + m[10] * q[2])
        }
      }
      P.set([x, y, z], i * 3)
      I.set([Math.min(1, breath), Math.min(1, head), cloth, 0], i * 4)
      if (N) {
        const l = Math.hypot(nx, ny, nz) || 1
        N.set([nx / l, ny / l, nz / l], i * 3)
      }
    }
    // 其它图元可能共用同一组顶点属性，所以直接改写访问器数据
    pos.setArray(P)
    if (N) nrm.setArray(N)
    idleOf.set(pos, doc.createAccessor().setType('VEC4').setBuffer(pos.getBuffer()).setArray(I))
  }
  for (const prim of node.getMesh().listPrimitives()) {
    prim.setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null)
    prim.setAttribute('_IDLE', idleOf.get(prim.getAttribute('POSITION')))
  }
}

async function build(src, name) {
  const doc = await io.read(src)
  const root = doc.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]

  // 1. 烘焙蒙皮：先全部算完（骨骼矩阵要用原始层级），再把 mesh 挪到场景根
  const skinned = root.listNodes().filter((n) => n.getMesh() && n.getSkin())
  for (const node of skinned) bakeSkin(doc, node)
  const idle = idleRig(root)
  const eyes = bakeBlink(root)
  if (eyes && idle) Object.assign(idle, eyes)
  else console.warn('  ⚠ 没找到眼球 / 头部骨骼，不做眨眼')
  for (const node of skinned) {
    node.setSkin(null)
    for (const parent of node.listParents()) if (parent.propertyType === 'Node') parent.removeChild(node)
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1])
    scene.addChild(node)
  }
  for (const a of root.listAnimations()) a.dispose()
  for (const s of root.listSkins()) s.dispose()
  for (const n of root.listNodes()) if (!n.getMesh()) n.dispose()

  // 2. 删除部件
  for (const node of root.listNodes()) {
    const mesh = node.getMesh()
    if (DROP_MESH.test(mesh.getName())) {
      node.dispose()
      continue
    }
    for (const prim of mesh.listPrimitives()) if (DROP_MATERIAL.test(prim.getMaterial()?.getName() ?? '')) prim.dispose()
    if (!mesh.listPrimitives().length) node.dispose()
  }

  // 3–4. 材质
  for (const mat of root.listMaterials()) {
    const old = mat.getName()
    if (mat.getAlphaMode() === 'BLEND') {
      mat.setAlphaMode('MASK').setAlphaCutoff(CUTOUT.find((c) => c.match.test(old)).cutoff)
    }
    // 去掉 Blender 的重名后缀（.002 之类）：每次重新导出后缀都会变，材质名要稳定，面板里的覆盖才对得上
    const short = old
      .replace(/\.\d{3}$/, '')
      .replace(/^aprilyshElathlaenHair_\d+_/, 'hair_')
      .replace(/^Victoria_9_HD_/, '')
      .replace(/^Genesis_9_/, '')
    mat.setName(/Pool_Water/i.test(old) ? 'char_droplet' : `char_${short}`)
  }

  await doc.transform(prune(), dedup())

  // 5. 减面（逐 mesh 按部件规则）
  const before = countTriangles(doc)
  const partOf = (mesh) => PARTS.find((p) => p.match.test(mesh.getName()))
  for (const mesh of root.listMeshes()) {
    if (partOf(mesh).rebuildNormals) for (const prim of mesh.listPrimitives()) prim.setAttribute('NORMAL', null)
  }
  await doc.transform(weld())
  await MeshoptSimplifier.ready
  for (const mesh of root.listMeshes()) {
    const rule = partOf(mesh)
    if (rule.ratio >= 1) continue
    for (const prim of mesh.listPrimitives()) {
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: rule.ratio, error: rule.error })
    }
  }
  smoothNormals(doc, (mesh) => !!partOf(mesh).rebuildNormals)
  // 同材质的 mesh 合并成一个 draw call（22 颗水珠、9 只蝴蝶原本各自一个；烘焙后都在世界坐标，可以直接合并）
  await doc.transform(prune(), flatten(), joinMeshes({ keepNamed: false }), prune())
  console.log(`  减面     ${Math.round(before)} → ${Math.round(countTriangles(doc))} 三角面`)

  // 轴心 = 包围盒底面中心（此时所有 mesh 都已烘到世界坐标、挂在场景根）
  const { min, max } = getBounds(root.getDefaultScene() ?? root.listScenes()[0])
  const pivot = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2]
  const collider = await buildCollider(await io.readBinary(await io.writeBinary(doc)), name, pivot)
  setPivot(doc, pivot, idle)

  // 6. 贴图尺寸：每个材质的上限 = 用到它的部件里最大的；每张贴图的上限 = 用到它的材质里最大的
  const matLimit = new Map()
  for (const mesh of root.listMeshes()) {
    const rule = partOf(mesh)
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()
      if (!mat) continue
      const byMat = TEXTURE_BY_MATERIAL.find((t) => t.match.test(mat.getName()))
      matLimit.set(mat, Math.max(matLimit.get(mat) ?? 0, byMat?.texture ?? rule.texture))
    }
  }
  const limit = new Map()
  for (const tex of root.listTextures()) {
    const sizes = [...materialsOf(tex)].map((m) => matLimit.get(m) ?? 0)
    if (sizes.length) limit.set(tex, Math.max(...sizes))
  }
  for (const [tex, size] of limit) {
    const [w, h] = tex.getSize() ?? [0, 0]
    if (Math.max(w, h) <= size) continue
    const s = size / Math.max(w, h)
    // 尺寸取 4 的倍数（块压缩要求）
    const img = await sharp(tex.getImage())
      .resize(Math.max(4, Math.round((w * s) / 4) * 4), Math.max(4, Math.round((h * s) / 4) * 4))
      .toFormat(tex.getMimeType() === 'image/png' ? 'png' : 'jpeg', { quality: 95 })
      .toBuffer()
    tex.setImage(img)
  }

  await doc.transform(
    dedup(),
    prune(),
    ...(hasKTX
      ? [
          toktx({ encoder: sharp, mode: 'uastc', slots: /^normalTexture$/, level: 2, rdo: true, zstd: 18 }),
          toktx({ encoder: sharp, mode: 'etc1s', quality: 255, compression: 2 }),
        ]
      : [textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 85 })]),
    draco(),
  )
  const out = join(OUT, `${name}.character.glb`)
  await io.write(out, doc)
  return { out, triangles: countTriangles(doc), collider }
}

/** 用到这张贴图的材质（核心槽位直接挂在材质上；specular 之类挂在材质的扩展属性上，再往上找一层） */
function materialsOf(tex) {
  const out = new Set()
  for (const p of tex.listParents()) {
    if (p.propertyType === 'Material') out.add(p)
    else if (p.propertyType !== 'Root') for (const pp of p.listParents()) if (pp.propertyType === 'Material') out.add(pp)
  }
  return out
}

/** 颈部位置（世界坐标）与点头轴：头部摆动的旋转中心 / 轴 */
function idleRig(root) {
  const find = (name) => root.listNodes().find((n) => n.getName() === name)
  const neck = find('mixamorig:Neck')
  const head = find('mixamorig:Head')
  if (!neck || !head) return null
  const a = neck.getWorldTranslation()
  const b = head.getWorldTranslation()
  // 点头轴 = 头的朝向 × 竖直方向（头几乎竖直时退回 x 轴）
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const axis = [-d[2], 0, d[0]]
  const len = Math.hypot(axis[0], axis[2])
  return { neck: a, nodAxis: len > 1e-4 ? axis.map((v) => v / len) : [1, 0, 0] }
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = (a) => {
  const l = Math.hypot(...a) || 1
  return a.map((v) => v / l)
}

/** 图元用到的顶点下标（同一组顶点属性可能被几个材质的图元共用，只改属于自己的那部分） */
function primVertices(prim) {
  const idx = prim.getIndices()
  const out = new Set()
  if (!idx) for (let i = 0; i < prim.getAttribute('POSITION').getCount(); i++) out.add(i)
  else for (let i = 0; i < idx.getCount(); i++) out.add(idx.getScalar(i))
  return out
}

/**
 * 眨眼权重写进 _IDLE.w，返回两只眼球中心 / 半径和眨眼轴（世界坐标；此时蒙皮已烘焙、骨骼节点还在）。
 * 坐标系：左右轴 = 左眼 → 右眼；上 = 头骨 → 头顶（去掉左右分量）；前 = 左右 × 上，朝眼睛那一侧。
 * 上眼皮闭眼 = 从「上」往「前」转，转轴 = 上 × 前。
 */
function bakeBlink(root) {
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives())
  const matName = (p) => p.getMaterial()?.getName() ?? ''
  const eye = (re) => {
    const prim = prims.find((p) => re.test(matName(p)))
    if (!prim) return null
    const pos = prim.getAttribute('POSITION')
    const verts = [...primVertices(prim)].map((i) => pos.getElement(i, []))
    const c = verts.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]).map((v) => v / verts.length)
    const r = verts.reduce((a, v) => a + Math.hypot(...sub(v, c)), 0) / verts.length
    // 视线方向：角膜是眼球上唯一凸出来的地方，取离中心最远的 2% 顶点的平均方向
    const far = verts.map((v) => [Math.hypot(...sub(v, c)), v]).sort((a, b) => b[0] - a[0])
    const top = far.slice(0, Math.max(1, Math.round(far.length * 0.02)))
    const gaze = normalize(top.reduce((a, [, v]) => a.map((x, i) => x + v[i] - c[i]), [0, 0, 0]))
    return { c, r, gaze }
  }
  const L = eye(BLINK.eyeLeft)
  const R = eye(BLINK.eyeRight)
  const find = (name) => root.listNodes().find((n) => n.getName() === name)
  const head = find('mixamorig:Head')
  const top = find('mixamorig:HeadTop_End')
  if (!L || !R || !head || !top) return null

  const side = normalize(sub(R.c, L.c))
  const up0 = sub(top.getWorldTranslation(), head.getWorldTranslation())
  const up = normalize(sub(up0, side.map((v) => v * dot(up0, side))))
  const mid = L.c.map((v, i) => (v + R.c[i]) / 2)
  let forward = normalize(cross(side, up))
  if (dot(forward, sub(mid, head.getWorldTranslation())) < 0) forward = forward.map((v) => -v)
  const axis = normalize(cross(up, forward))

  let lids = 0
  for (const prim of prims) {
    const name = matName(prim)
    const kind = BLINK.skin.test(name) ? 'lid' : BLINK.upperLash.test(name) ? 'upper' : BLINK.lowerLash.test(name) ? 'lower' : null
    if (!kind) continue
    const pos = prim.getAttribute('POSITION')
    const idle = prim.getAttribute('_IDLE')
    const v = [], e = []
    for (const i of primVertices(prim)) {
      pos.getElement(i, v)
      const near = Math.hypot(...sub(v, L.c)) < Math.hypot(...sub(v, R.c)) ? L : R
      const rel = sub(v, near.c)
      const d = Math.hypot(...rel) / near.r
      // 眼球后面的不动（颅内 / 太阳穴一侧）
      if (dot(rel, forward) / near.r < -0.3) continue
      const h = dot(rel, up) / near.r
      let w = 0
      if (kind === 'lid') {
        const radial = 1 - smoothstep(BLINK.lid.inner, BLINK.lid.outer, d)
        w = radial * (smoothstep(0, 0.3, h) - BLINK.lower * smoothstep(0, 0.3, -h))
      } else {
        const radial = 1 - smoothstep(BLINK.lash.inner, BLINK.lash.outer, d)
        w = kind === 'upper' ? radial : -BLINK.lower * radial
      }
      if (!w) continue
      idle.getElement(i, e)
      e[3] = w
      idle.setElement(i, e)
      lids++
    }
  }
  console.log(`  眨眼     → ${lids} 个眼皮 / 睫毛顶点，眼球半径 ${L.r.toFixed(3)}`)
  return { eyeLeft: L.c, eyeRight: R.c, blinkAxis: axis, headForward: forward, gazeLeft: L.gaze, gazeRight: R.gaze }
}

/** 顶点平移 -pivot，所有 mesh 节点挂到一个位于 pivot 的节点下（整体位置不变） */
function setPivot(doc, pivot, idle = null) {
  const root = doc.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  const holder = doc.createNode('pivot').setTranslation(pivot)
  if (idle) {
    // 运行时 GLTFLoader 放进 userData；坐标换到轴心节点的局部空间
    const local = (p) => p.map((v, i) => v - pivot[i])
    holder.setExtras({
      idleNeck: local(idle.neck),
      idleNodAxis: idle.nodAxis,
      ...(idle.eyeLeft && {
        idleEyeLeft: local(idle.eyeLeft),
        idleEyeRight: local(idle.eyeRight),
        idleBlinkAxis: idle.blinkAxis,
        idleHeadForward: idle.headForward,
        idleGazeLeft: idle.gazeLeft,
        idleGazeRight: idle.gazeRight,
      }),
    })
  }
  const offset = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -pivot[0], -pivot[1], -pivot[2], 1]
  for (const node of scene.listChildren()) {
    if (node.getMesh()) transformMesh(node.getMesh(), offset)
    scene.removeChild(node)
    holder.addChild(node)
  }
  scene.addChild(holder)
}

async function buildCollider(doc, name, pivot) {
  const root = doc.getRoot()
  for (const node of root.listNodes()) if (node.getMesh() && !COLLIDER.test(node.getMesh().getName())) node.dispose()
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      prim.setMaterial(null)
      for (const sem of prim.listSemantics()) if (sem !== 'POSITION') prim.setAttribute(sem, null)
    }
  }
  // 材质扩展（specular 等）引用的贴图 prune 清不掉，直接全部删掉
  for (const m of root.listMaterials()) m.dispose()
  for (const t of root.listTextures()) t.dispose()
  for (const ext of root.listExtensionsUsed()) ext.dispose()
  await doc.transform(prune(), flatten(), joinMeshes({ keepNamed: false }), weld({ tolerance: 0.0001 }))
  const before = countTriangles(doc)
  if (before > COLLIDER_TRIANGLES) {
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: COLLIDER_TRIANGLES / before, error: 0.02 }))
  }
  setPivot(doc, pivot)
  await doc.transform(prune(), draco())
  const out = join(OUT_COLLIDER, `${name}.character.glb`)
  await io.write(out, doc)
  return { out, triangles: countTriangles(doc) }
}

const only = process.argv[2]
const files = readdirSync(SRC).filter((f) => f.endsWith('.glb') && (!only || basename(f, '.glb') === only))
if (!files.length) {
  console.error(`没有找到模型：${only ?? SRC}`)
  process.exit(1)
}
for (const f of files) {
  const name = basename(f, '.glb')
  const src = join(SRC, f)
  console.log(`\n▸ ${name}  (${mb(statSync(src).size)})`)
  const { out, triangles, collider } = await build(src, name)
  console.log(`  render   → ${out}  ${mb(statSync(out).size)}  ${Math.round(triangles)} 三角面`)
  console.log(`  collider → ${collider.out}  ${mb(statSync(collider.out).size)}  ${Math.round(collider.triangles)} 三角面`)
}
