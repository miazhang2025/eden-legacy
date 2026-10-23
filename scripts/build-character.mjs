// 场景里的人物（环境的一部分，不是玩家角色）
//   art/character/<scene>.glb  ──►  public/models/env/<scene>.character.glb        渲染用：由场景 config 的 env.extras 加载
//                              └─►  public/models/colliders/<scene>.character.glb  碰撞用：由 env.extraColliders 加载（玩家不能穿过人物）
// 两者都挂在环境模型的变换下（美术在 Blender 里对着环境模型摆好的位置原样保留）。
//
// 美术给的是 Daz（Genesis 9）+ Mixamo 骨骼摆好姿势的蒙皮模型，约 70 万面 / 60MB，动画只有一帧（就是这个姿势）。
// 处理：
//   1. 把骨骼姿势烘进顶点（蒙皮 → 静态网格）：去掉骨骼 / 蒙皮 / 动画，运行时不用每帧算蒙皮。
//      姿势取第一个动画的第一帧（有的导出把姿势只存在动画里，骨骼节点上是绑定姿势）
//   0. 材质名里的空格换成下划线（不同导出设置下 Daz 材质名有时带空格，后面的规则统一按下划线写）；
//      按人物的配置（CHARACTERS）向别的模型借贴图（导出时丢了贴图的头发）
//   1b. 没蒙皮、挂在骨架下的 mesh：把节点的世界变换烘进顶点
//   2. 删掉看不见又会出错的部件：眼球湿润层、泪腺（alpha 0.05 的透明壳，排序会闪）、口腔（牙齿舌头，嘴是闭着的）
//   3a. 皮肤（Victoria 9 HD_*）的粗糙度贴图换成常数（取贴图平均值）：基本是均匀的灰，省一张 4K 贴图；
//      平均值低得离谱的（脸那张实际是嘴唇湿润遮罩，平均 0.01，整张脸会像打了蜡）按正常皮肤取值
//      睫毛 / 眼球的法线贴图去掉（看不出来）
//   3. 透明材质：头发 / 睫毛 / 蝴蝶翅膀从 BLEND 改成 alpha 裁切（大量交叠的透明面片排序必乱；有 MSAA 时运行时开 alpha-to-coverage）
//   4. 材质改名：统一 char_ 前缀（面板里一眼认出来；Pool_Water 会被认成水面而隐藏，改成 char_droplet）
//   5. 按部件减面（PARTS），同材质的 mesh 合并（省 draw call）
//   6. 贴图（所有槽位：颜色 / 法线 / AO / 粗糙度 / specular）按部件限尺寸；
//      KTX2：法线贴图用 UASTC（ETC1S 压法线会出色块），其余 ETC1S；没装 KTX-Software 时回落 WebP。最后 Draco
//   7. 碰撞体：只留身体 / 头发 / 裙子（COLLIDER），合并后减到 COLLIDER_TRIANGLES 面，无材质
//   9. Idle 动画数据（运行时顶点着色器用，见 src/materials/figure.ts，不做物理模拟）：
//      _IDLE 顶点属性 = (呼吸权重, 头部权重, 布料权重, 眨眼权重)，前两项取自原骨骼的蒙皮权重；
//      眨眼权重带符号（+ 上眼皮 / 上睫毛，- 下眼皮 / 下睫毛），按到眼球中心的距离和高度从头部 mesh 里挑出来（BLINK）；
//      颈部位置 / 点头轴 / 两只眼球中心 / 眨眼轴 / 脸朝向写进 pivot 节点的 extras（运行时在 userData 里）
//   8. 轴心：顶点移到以人物脚底中心为原点，挂在一个平移到原位置的 pivot 节点下（渲染 / 碰撞体用同一个轴心）。
//      位置不变；运行时 env.extrasTransform 调这个节点，旋转 / 缩放就绕人物自己转，而不是绕场景原点
//
// 用法：npm run character            处理 art/character 下全部场景人物
//       npm run character -- garden  只处理指定场景

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { NodeIO, getBounds } from '@gltf-transform/core'
import {
  ALL_EXTENSIONS, KHRMaterialsClearcoat, KHRMaterialsIOR, KHRMaterialsIridescence, KHRMaterialsSheen, KHRMaterialsSpecular,
  KHRMaterialsTransmission, KHRMaterialsVolume,
} from '@gltf-transform/extensions'
import {
  cloneDocument, dedup, draco, flatten, join as joinMeshes, prune, simplify, simplifyPrimitive, textureCompress, transformMesh, weld,
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

/** 整个 mesh 删掉（按 mesh 名匹配）。UCX_ 开头的是游戏引擎用的碰撞盒（Blender 里隐藏），不该渲染 */
const DROP_MESH = /Genesis9Tear|Genesis9Mouth|^UCX_/i
/** 删掉的图元（按规范化后的材质名匹配）：眼球湿润层 / 泪腺（透明壳），口腔里的牙齿舌头。脸上雕刻的泪滴（Sculpted_Tears）保留 */
const DROP_MATERIAL = /EyeMoisture|^Genesis_9_Tear|^Genesis_9_Mouth_(Mouth|Teeth)/i

/**
 * 按部件：减面比例（ratio）/ 允许的形状误差（error，占 mesh 尺寸的比例）/ 贴图边长上限（texture）。
 * 第一条匹配 mesh 名的生效。人物躺在远处当环境，脸和身体是视觉重点，保留得多一些；
 * Tripo 生成的裙子、花是均匀的高密度网格，减得最多。
 * rebuildNormals：导出时是硬边（每个三角面顶点都单独一份），焊不上就减不动 —— 先丢掉法线焊接，减完再重算平滑法线。
 * 没有贴图的材质顺带丢掉 UV（用不上，UV 接缝也会挡住焊接）。
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
/**
 * 按人物（文件名）的额外配置：
 *   parts：排在 PARTS 前面的部件规则（各人物的 Tripo 部件编号不一样，哪个是主裙要单独指定）。
 *          规则可以写 material（按改名后的 char_ 材质名匹配图元）代替 match（按 mesh 名）：整个人物合成一个网格时按材质分
 *   borrow：导出时贴图丢了 / 坏了的材质，从另一个模型里同名（去掉 .002 后缀）的材质借底色贴图和参数（替换掉自己的）
 *   copyTextures：导出时挂错了贴图的材质，从同一模型里另一个材质复制底色 / 粗糙度贴图（材质名按规范化后的写）。
 *           只在目标底色贴图几乎全黑时才换（挂错的是嘴唇遮罩），贴图正常就不动
 *   collider：进碰撞体的 mesh（按 mesh 名），默认 COLLIDER
 *   cloth：做布料波动的 mesh（按 mesh 名），默认 CLOTH；null = 不做
 *   clothMaterials：做布料波动的图元（按材质名，规范化后的原名），和 cloth 叠加
 *   drop：额外删掉的图元（按规范化后的原材质名）
 *   keepBlend：保留半透明混合（BLEND）的材质（按规范化后的原名）。默认 BLEND 会改成 alpha 裁切（头发面片排序会乱），
 *              但真正半透明的薄纱、玻璃泪滴裁切后会变成镂空的洞或整个消失
 *   normalSize：法线贴图边长上限（比部件规则更严；法线贴图走 UASTC，体积大）
 *   tweaks：改面板调不到的材质参数（按规范化后的原名）：sheenColor（灰度）/ sheenRoughness / clearcoatRoughness /
 *           saturation（底色贴图的饱和度倍数，烘进贴图；贴图被几个材质共用时只处理一次）/
 *           glass（改成透射材质 —— 透明液体 / 玻璃，透出后面的东西并折射；不透明、单面，运行时走 three 的透射通道，
 *                  场景里已经有透射材质时几乎不增加开销）：
 *                  { ior, thickness（0 = 不加体积，可合并网格）, roughness, color（透射染色，线性 RGB）, transmission（<1 颜色更实）,
 *                    iridescence（薄膜干涉，彩色反光）, specular（镜面反射倍数，可 >1）, sheen（白色边缘光泽） }。
 *           颜色、金属度、清漆强度、环境反射这些面板能调的写在场景 config 的 materials 里
 */
const CHARACTERS = {
  garden: {
    // 头上的蝴蝶翅膀（材质 78 / 80）太艳。花园的紫色环境光 + 后期调色会把饱和度推回去，所以贴图要降得多一些
    tweaks: [{ match: /^(78|80)(\.\d+)?$/, saturation: 0.25 }],
  },
  ocean: {
    // 按材质分（网格名每次导出都在变：Mesh_0.001 / Ocean_Charactermesh …）。海洋要多画一遍水面反射，面数压在 25 万左右。
    // 主裙（tripo_part_0）113 万面、珍珠贝母饰物 4 块共 33 万、上衣（tripo_part_1）22 万、头发 25 万
    parts: [
      { material: /tripo_part_0/i, ratio: 0.05, error: 0.02, texture: 2048, rebuildNormals: true },
      { material: /珍珠贝母/, ratio: 0.08, error: 0.02, texture: 512, rebuildNormals: true },
      { material: /tripo_part_1/i, ratio: 0.15, error: 0.02, texture: 2048, rebuildNormals: true },
      { material: /tripo_part/i, ratio: 0.15, error: 0.02, texture: 1024, rebuildNormals: true },
      { material: /Hair/i, ratio: 0.15, error: 0.008, texture: 1024 },
      { material: /Eyes|Eyelashes/i, ratio: 1, error: 0, texture: 512 },
      { material: /.*/, ratio: 1, error: 0, texture: 1024 },
    ],
    collider: /Ocean_Character|^Mesh_0/i,
    // 头发在 Blender 里是程序化头发材质，导不出来（白色金属片）；睫毛贴图导出成了纯白不透明（透明度在另一张图里，丢了）。
    // 与花园人物是同一套 Daz 资产，借它的贴图
    borrow: { from: 'art/character/garden.glb', materials: /Hair|Eyelashes/i },
    // 脸和口腔的贴图挂反了：脸上是嘴唇妆容遮罩（整张黑，只有嘴唇亮），正常的脸部底色 / 粗糙度在口腔材质上
    copyTextures: [{ to: /HD_Head/i, from: /HD_Mouth_Cavity/i }],
  },
  cave: {
    // 按材质分（网格名每次导出都在变）。最新导出 146 万面：礼服裙摆 65 万、雕刻发束 40 万、银纱垂饰 14 万、上身 9 万
    parts: [
      { material: /sculpted_strands/i, ratio: 0.12, error: 0.012, texture: 1024, rebuildNormals: true },
      { material: /Hair/i, ratio: 0.25, error: 0.006, texture: 1024 },
      { material: /珍珠/, ratio: 0.2, error: 0.01, texture: 512 },
      { material: /银蓝珠饰裙摆/, ratio: 0.1, error: 0.008, texture: 1024 },
      { material: /礼服|袖饰/, ratio: 0.2, error: 0.006, texture: 1024 },
      { material: /发带/, ratio: 0.5, error: 0.01, texture: 512 },
      { material: /Tears/i, ratio: 0.3, error: 0.01, texture: 256 },
      { material: /Eyes|Eyelashes/i, ratio: 1, error: 0, texture: 512 },
      // 皮肤贴图尺寸由 TEXTURE_BY_MATERIAL 定
      { material: /.*/, ratio: 1, error: 0, texture: 1024 },
    ],
    collider: /Dress|Skirt|内裙|外层礼服|Genesis9\.Shape|FullDensity|tripo_part/i,
    // 头发根部的头皮罩（Hair_Root_Cap）在 Blender 里靠程序化透明度只露出发际线，导出后是整块不透明的黑色、盖住整张脸；
    // 雕刻发束和两侧补发已经把头盖全了，直接删掉
    drop: /soft_scalp/i,
    cloth: null,
    clothMaterials: /礼服|袖饰/,
    // 礼服每块都带一张 1024 法线贴图（UASTC 每张 1.2MB），远看看不出来
    normalSize: 512,
    // 礼服 / 袖饰的贴图 alpha 是设计好的透明度（袖纱只有 18–35% 不透明）
    keepBlend: /礼服|袖饰/,
    // 礼服导出时是白色满强度天鹅绒光泽 + 近乎镜面的清漆层，在洞穴里整件发白：光泽压到 35%、清漆磨砂一些
    tweaks: [
      { match: /礼服|袖饰｜(垂坠透明纱|水晶薄纱)/, sheenColor: 0.35, sheenRoughness: 0.5, clearcoatRoughness: 0.35 },
      // 脸上的泪滴：导出是 15% 不透明的白色、双面，好几层叠起来成了乳白色的膏状条纹。改成透射的水
      // 清澈透明的泪水：几乎无色（极淡的紫），全透射，只靠高光和一点彩色反光显形；和紫色的钻石区分开
      {
        match: /Tears/,
        glass: { ior: 1.4, thickness: 0.08, roughness: 0, color: [0.9, 0.87, 1], transmission: 1, iridescence: 0.3, specular: 2.5 },
      },
      // 泪痕上的紫水晶钻：导出是近白色、全透射的玻璃，贴在皮肤上完全透明、看不见。降低透射显出紫色，加强高光和彩色反光
      {
        match: /Dual_Color_Glass/,
        glass: { ior: 1.5, thickness: 0, roughness: 0, color: [0.48, 0.15, 1], transmission: 0.35, iridescence: 1, specular: 3 },
      },
    ],
    // 同花园 / 海洋人物的 Daz 资产：睫毛贴图导出成纯白不透明，借花园的；脸和口腔的贴图挂反了
    borrow: { from: 'art/character/garden.glb', materials: /Eyelashes/i },
    copyTextures: [{ to: /HD_Head/i, from: /HD_Mouth_Cavity/i }],
  },
}

/**
 * 淡化雀斑（皮肤底色贴图里画的小颗橙褐色点），在缩图之后做：
 *   和高斯模糊后的「平均肤色」比，比周围略深、色相接近肤色的像素往平均肤色拉 strength。
 *   很深的（鼻孔、眼线）、色相不同的（眼影、唇彩、彩色眼线）不动；大块妆容模糊前后差不多，也基本不动。
 *   radius = 模糊半径占贴图边长的比例；各人物可用 CHARACTERS[name].freckles 覆盖 strength（0 = 不处理）
 */
const FRECKLES = { materials: /^char_(Head|Body|Arms|Legs)$/, strength: 0.85, radius: 1 / 250 }

/** 皮肤粗糙度贴图换常数；平均值低于 min 视为错误贴图，取 fallback */
const SKIN = { match: /HD_/i, min: 0.2, fallback: 0.58 }
/** 去掉法线贴图的材质 */
const DROP_NORMAL = /Eyelashes|Eyes_Eye/i

/** 皮肤贴图按材质（改名后的 char_ 名）：脸 / 身体 2048，脚趾甲、口腔 1024 */
const TEXTURE_BY_MATERIAL = [
  { match: /^char_(Head|Body|Arms|Legs)$/i, texture: 2048 },
  { match: /^char_(Toenails|Mouth_Cavity)$/i, texture: 1024 },
]

/** Idle 权重：骨骼名 → 系数（Mixamo 骨骼）。呼吸 = 胸腔起伏；头部 = 绕颈部轻微摆动（头发 / 头饰蒙在头骨上，跟着动） */
const BREATH_JOINTS = { 'mixamorig:Spine': 0.3, 'mixamorig:Spine1': 0.7, 'mixamorig:Spine2': 1 }
const HEAD_JOINTS = { 'mixamorig:Neck': 0.5, 'mixamorig:Head': 1, 'mixamorig:HeadTop_End': 1 }
/** 布料（按 mesh 名）：顶点着色器里做低频波动 */
const CLOTH = /tripo_part|衣服|裙/i

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
function bakeSkin(doc, node, clothMatch) {
  const skin = node.getSkin()
  const joints = skin.listJoints()
  const breathOf = joints.map((j) => BREATH_JOINTS[j.getName()] ?? 0)
  const headOf = joints.map((j) => HEAD_JOINTS[j.getName()] ?? 0)
  const cloth = clothMatch?.test(node.getMesh().getName()) ? 1 : 0
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

/** 去掉 Blender 的重名后缀（.002 之类） */
const baseName = (name) => name.replace(/\.\d{3}$/, '')

/** 从 from 模型里同名材质借底色贴图 + 透明 / 粗糙度参数（替换掉自己的） */
async function borrowTextures(doc, { from, materials }) {
  const donor = await io.read(from)
  const donorMats = new Map(donor.getRoot().listMaterials().map((m) => [baseName(m.getName()).replace(/ /g, '_'), m]))
  const copies = new Map()
  let n = 0
  for (const mat of doc.getRoot().listMaterials()) {
    if (!materials.test(mat.getName())) continue
    const src = donorMats.get(baseName(mat.getName()))
    const tex = src?.getBaseColorTexture()
    if (!tex) continue
    if (!copies.has(tex)) {
      copies.set(tex, doc.createTexture(tex.getName()).setImage(tex.getImage()).setMimeType(tex.getMimeType()))
    }
    mat
      .setBaseColorTexture(copies.get(tex))
      .setBaseColorFactor(src.getBaseColorFactor())
      .setAlphaMode(src.getAlphaMode())
      .setAlphaCutoff(src.getAlphaCutoff())
      .setMetallicFactor(src.getMetallicFactor())
      .setRoughnessFactor(src.getRoughnessFactor())
      .setMetallicRoughnessTexture(null)
      .setNormalTexture(null)
    n++
  }
  console.log(`  借贴图   → ${n} 个材质（${from}）`)
}

/** 皮肤粗糙度贴图 → 常数（G 通道平均值） */
async function flattenSkinRoughness(doc) {
  for (const mat of doc.getRoot().listMaterials()) {
    const tex = mat.getMetallicRoughnessTexture()
    if (!SKIN.match.test(mat.getName()) || !tex) continue
    const { channels } = await sharp(tex.getImage()).stats()
    const mean = (channels[1] ?? channels[0]).mean / 255
    mat.setRoughnessFactor(mat.getRoughnessFactor() * (mean < SKIN.min ? SKIN.fallback : mean)).setMetallicRoughnessTexture(null)
  }
}

async function build(src, name) {
  const doc = await io.read(src)
  const root = doc.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  const character = CHARACTERS[name] ?? {}
  const clothMatch = character.cloth === undefined ? CLOTH : character.cloth

  // 0. 材质名规范化；借贴图（WebP 贴图到第 6 步缩图时再转 PNG：先缩小再转，4K 的 PNG 太占内存）
  for (const mat of root.listMaterials()) mat.setName(mat.getName().replace(/ /g, '_'))
  if (character.borrow) await borrowTextures(doc, character.borrow)
  for (const { to, from } of character.copyTextures ?? []) {
    const mats = root.listMaterials()
    const src = mats.find((m) => from.test(m.getName()))
    const dst = mats.find((m) => to.test(m.getName()))
    if (!src || !dst) throw new Error(`copyTextures：找不到材质 ${from} / ${to}`)
    // 只修真的挂错了的（底色贴图几乎全黑）：后来的导出脸上是带妆的正确贴图，不能被口腔的素颜贴图盖掉
    const base = dst.getBaseColorTexture()
    const mean = base ? (await sharp(base.getImage()).stats()).channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3 / 255 : 0
    if (mean > 0.1) continue
    dst.setBaseColorTexture(src.getBaseColorTexture()).setMetallicRoughnessTexture(src.getMetallicRoughnessTexture())
    console.log(`  换贴图   → ${dst.getName()} ← ${src.getName()}（原底色几乎全黑）`)
  }

  // 姿势（动画第一帧）最先应用：下面无蒙皮 mesh 的世界变换和蒙皮烘焙都要用到摆好姿势的骨架
  const posed = applyPose(root)
  if (posed) console.log(`  姿势     → 动画第一帧（${posed} 个通道与骨骼节点不同）`)

  // 1b. 没蒙皮的 mesh：世界变换烘进顶点（transformMesh 会处理法线和负缩放的绕序），补上 _IDLE（只有布料权重）。
  const skinned = root.listNodes().filter((n) => n.getMesh() && n.getSkin())
  const rigid = root.listNodes().filter((n) => n.getMesh() && !n.getSkin() && n.listParents().some((p) => p.propertyType === 'Node'))
  for (const node of rigid) {
    const mesh = node.getMesh()
    transformMesh(mesh, node.getWorldMatrix())
    const cloth = clothMatch?.test(mesh.getName()) ? 1 : 0
    for (const prim of mesh.listPrimitives()) {
      const n = prim.getAttribute('POSITION').getCount()
      const I = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) I[i * 4 + 2] = cloth
      prim.setAttribute('_IDLE', doc.createAccessor().setType('VEC4').setBuffer(prim.getAttribute('POSITION').getBuffer()).setArray(I))
    }
  }
  if (rigid.length) console.log(`  无蒙皮   → ${rigid.length} 个 mesh 烘入世界变换`)
  for (const node of rigid) {
    for (const parent of node.listParents()) if (parent.propertyType === 'Node') parent.removeChild(node)
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1])
    scene.addChild(node)
  }

  // 1. 烘焙蒙皮：先全部算完（骨骼矩阵要用原始层级），再把 mesh 挪到场景根
  for (const node of skinned) bakeSkin(doc, node, clothMatch)
  const idle = idleRig(root)
  const eyes = bakeBlink(root)
  if (eyes && idle) Object.assign(idle, eyes)
  else if (idle) {
    // 没有单独的眼球（整个人物合成了一个网格）：不眨眼；脸朝向用头骨的朝向
    idle.headForward = headForward(root)
    console.warn('  ⚠ 没找到眼球，不做眨眼（脸朝向取头骨方向）')
  }
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
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()?.getName() ?? ''
      if (DROP_MATERIAL.test(mat) || character.drop?.test(mat)) prim.dispose()
    }
    if (!mesh.listPrimitives().length) node.dispose()
  }

  // 布料（按材质）：只标记这些图元用到的顶点
  if (character.clothMaterials) {
    for (const prim of root.listMeshes().flatMap((m) => m.listPrimitives())) {
      if (!character.clothMaterials.test(prim.getMaterial()?.getName() ?? '')) continue
      const idle = prim.getAttribute('_IDLE')
      const e = []
      for (const i of primVertices(prim)) {
        idle.getElement(i, e)
        e[2] = 1
        idle.setElement(i, e)
      }
    }
  }

  // 3–4. 材质
  await flattenSkinRoughness(doc)
  const desaturated = new Set()
  for (const mat of root.listMaterials()) {
    const old = mat.getName()
    if (DROP_NORMAL.test(old)) mat.setNormalTexture(null)
    for (const t of character.tweaks ?? []) {
      if (!t.match.test(old)) continue
      const base = mat.getBaseColorTexture()
      if (base && t.saturation !== undefined && !desaturated.has(base)) {
        desaturated.add(base)
        await reencode(base, sharp(base.getImage()).modulate({ saturation: t.saturation }))
      }
      const sheen = mat.getExtension('KHR_materials_sheen')
      if (sheen && t.sheenColor !== undefined) sheen.setSheenColorFactor([t.sheenColor, t.sheenColor, t.sheenColor])
      if (sheen && t.sheenRoughness !== undefined) sheen.setSheenRoughnessFactor(t.sheenRoughness)
      const clearcoat = mat.getExtension('KHR_materials_clearcoat')
      if (clearcoat && t.clearcoatRoughness !== undefined) clearcoat.setClearcoatRoughnessFactor(t.clearcoatRoughness)
      if (t.glass) {
        const { ior, thickness, roughness, color = [1, 1, 1], transmission = 1, iridescence = 0, specular = 1, sheen = 0 } = t.glass
        mat
          .setAlphaMode('OPAQUE')
          .setDoubleSided(false)
          .setBaseColorTexture(null)
          .setBaseColorFactor([...color, 1])
          .setMetallicFactor(0)
          .setRoughnessFactor(roughness)
          .setExtension('KHR_materials_transmission', doc.createExtension(KHRMaterialsTransmission).createTransmission().setTransmissionFactor(transmission))
          .setExtension('KHR_materials_ior', doc.createExtension(KHRMaterialsIOR).createIOR().setIOR(ior))
          .setExtension('KHR_materials_clearcoat', doc.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatFactor(1).setClearcoatRoughnessFactor(0))
          .setExtension('KHR_materials_specular', doc.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularFactor(specular))
        // 体积（厚度）只在 thickness > 0 时加：带体积的材质不会被合并网格（厚度按各网格自己的坐标算）
        if (thickness > 0) mat.setExtension('KHR_materials_volume', doc.createExtension(KHRMaterialsVolume).createVolume().setThicknessFactor(thickness))
        if (iridescence > 0) {
          const ir = doc.createExtension(KHRMaterialsIridescence).createIridescence()
          mat.setExtension('KHR_materials_iridescence', ir.setIridescenceFactor(iridescence).setIridescenceIOR(1.3).setIridescenceThicknessMinimum(200).setIridescenceThicknessMaximum(500))
        }
        if (sheen > 0) {
          const sh = doc.createExtension(KHRMaterialsSheen).createSheen()
          mat.setExtension('KHR_materials_sheen', sh.setSheenColorFactor([sheen, sheen, sheen]).setSheenRoughnessFactor(0.25))
        }
      }
    }
    if (mat.getAlphaMode() === 'BLEND' && !character.keepBlend?.test(old)) {
      mat.setAlphaMode('MASK').setAlphaCutoff(CUTOUT.find((c) => c.match.test(old)).cutoff)
    }
    // 去掉 Blender 的重名后缀（.002 之类）：每次重新导出后缀都会变，材质名要稳定，面板里的覆盖才对得上
    const short = baseName(old)
      .replace(/^aprilyshElathlaenHair_\d+_/, 'hair_')
      .replace(/^Victoria_9_HD_/, '')
      .replace(/^Genesis_9_/, '')
    mat.setName(/Pool_Water/i.test(old) ? 'char_droplet' : `char_${short}`)
  }

  if (desaturated.size) console.log(`  饱和度   → ${desaturated.size} 张贴图`)
  await doc.transform(prune(), dedup())

  // 5. 减面（逐 mesh 按部件规则）
  const before = countTriangles(doc)
  const rules = [...(character.parts ?? []), ...PARTS]
  const partOf = (mesh, prim) =>
    rules.find((p) => (p.material ? p.material.test(prim.getMaterial()?.getName() ?? '') : p.match.test(mesh.getName())))
  const eachPrim = (fn) => root.listMeshes().forEach((mesh) => mesh.listPrimitives().forEach((prim) => fn(mesh, prim)))
  const textured = (mat) => !!mat && materialHasTextures(mat)
  eachPrim((mesh, prim) => {
    if (!textured(prim.getMaterial())) for (const sem of prim.listSemantics()) if (sem.startsWith('TEXCOORD')) prim.setAttribute(sem, null)
    if (partOf(mesh, prim).rebuildNormals) prim.setAttribute('NORMAL', null)
  })
  await doc.transform(weld())
  await MeshoptSimplifier.ready
  eachPrim((mesh, prim) => {
    const rule = partOf(mesh, prim)
    if (rule.ratio < 1) simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: rule.ratio, error: rule.error })
  })
  smoothNormals(doc, (mesh, prim) => !!partOf(mesh, prim).rebuildNormals)
  // 同材质的 mesh 合并成一个 draw call（22 颗水珠、9 只蝴蝶原本各自一个；烘焙后都在世界坐标，可以直接合并）
  await doc.transform(prune(), flatten(), joinMeshes({ keepNamed: false }), prune())
  console.log(`  减面     ${Math.round(before)} → ${Math.round(countTriangles(doc))} 三角面`)

  // 轴心 = 包围盒底面中心（此时所有 mesh 都已烘到世界坐标、挂在场景根）
  const { min, max } = getBounds(root.getDefaultScene() ?? root.listScenes()[0])
  const pivot = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2]
  // 克隆文档（贴图数据共享引用）而不是整个序列化一遍：几十 MB 的贴图拼成一个大 buffer 容易分配失败
  const collider = await buildCollider(cloneDocument(doc), name, pivot, character.collider)
  setPivot(doc, pivot, idle)

  // 6. 贴图尺寸：每个材质的上限 = 用到它的部件里最大的；每张贴图的上限 = 用到它的材质里最大的
  const matLimit = new Map()
  eachPrim((mesh, prim) => {
    const mat = prim.getMaterial()
    if (!mat) return
    const byMat = TEXTURE_BY_MATERIAL.find((t) => t.match.test(mat.getName()))
    matLimit.set(mat, Math.max(matLimit.get(mat) ?? 0, byMat?.texture ?? partOf(mesh, prim).texture))
  })
  const limit = new Map()
  for (const tex of root.listTextures()) {
    const mats = [...materialsOf(tex)]
    const sizes = mats.map((m) => matLimit.get(m) ?? 0)
    if (!sizes.length) continue
    const isNormal = mats.some((m) => m.getNormalTexture() === tex)
    limit.set(tex, isNormal && character.normalSize ? Math.min(character.normalSize, Math.max(...sizes)) : Math.max(...sizes))
  }
  // 超出上限的缩小；WebP 顺带转格式（KTX2 压缩不认 WebP）
  for (const tex of root.listTextures()) {
    const size = limit.get(tex) ?? Infinity
    const [w, h] = tex.getSize() ?? [0, 0]
    const webp = tex.getMimeType() === 'image/webp'
    if (Math.max(w, h) <= size && !webp) continue
    const s = Math.min(1, size / Math.max(w, h))
    // 尺寸取 4 的倍数（块压缩要求）
    await reencode(tex, sharp(tex.getImage()).resize(Math.max(4, Math.round((w * s) / 4) * 4), Math.max(4, Math.round((h * s) / 4) * 4)))
  }

  const freckleStrength = character.freckles ?? FRECKLES.strength
  if (freckleStrength > 0) {
    const skinTex = root.listTextures().filter((t) => [...materialsOf(t)].some((m) => FRECKLES.materials.test(m.getName()) && m.getBaseColorTexture() === t))
    for (const tex of skinTex) await reduceFreckles(tex, freckleStrength)
    if (skinTex.length) console.log(`  雀斑     → ${skinTex.length} 张皮肤贴图淡化 ${Math.round(freckleStrength * 100)}%`)
  }

  // 再合并一次：前面按部件 / 规则改过的材质，到这里的去重才合并成一个（例如 19 颗钻石的材质），再把它们的网格并成一个 draw call
  await doc.transform(
    dedup(),
    joinMeshes({ keepNamed: false }),
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

/** 材质有没有用任何贴图（核心槽位或扩展里的） */
function materialHasTextures(mat) {
  return mat.getGraph().listChildren(mat).some((c) => c.propertyType === 'Texture' || mat.getGraph().listChildren(c).some((cc) => cc.propertyType === 'Texture'))
}

async function reduceFreckles(tex, strength) {
  const { data, info } = await sharp(tex.getImage()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const sigma = Math.max(1, width * FRECKLES.radius)
  const blur = await sharp(data, { raw: { width, height, channels: 3 } }).blur(sigma).raw().toBuffer()
  const out = Buffer.from(data)
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const br = blur[i], bg = blur[i + 1], bb = blur[i + 2]
    const L = lum(r, g, b), Lb = lum(br, bg, bb)
    if (L >= Lb || Lb < 1) continue
    // 比周围深多少：雀斑一般 3–30%，鼻孔 / 眼线更深
    const dark = (Lb - L) / Lb
    // 色相（0–1）：肤色和雀斑都在橙红（约 0.0–0.1）
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
    if (d < 1) continue
    let hue = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    hue /= 6
    const hueDist = Math.min(Math.abs(hue - 0.05), 1 - Math.abs(hue - 0.05))
    const w = strength * (1 - smooth(0.06, 0.1, hueDist)) * (1 - smooth(0.35, 0.5, dark))
    if (w <= 0) continue
    out[i] = r + (br - r) * w
    out[i + 1] = g + (bg - g) * w
    out[i + 2] = b + (bb - b) * w
  }
  await reencode(tex, sharp(out, { raw: { width, height, channels: 3 } }))
}

/** 用 sharp 处理后写回贴图：JPEG 保持 JPEG，其余（PNG / WebP）存成 PNG（保留透明通道） */
async function reencode(tex, pipeline) {
  const jpeg = tex.getMimeType() === 'image/jpeg'
  tex.setImage(await pipeline.toFormat(jpeg ? 'jpeg' : 'png', { quality: 95 }).toBuffer()).setMimeType(jpeg ? 'image/jpeg' : 'image/png')
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

/**
 * 脸朝向（没有眼球时的退路）：Mixamo 角色绑定姿势面朝 +Z，用头骨的蒙皮矩阵（世界矩阵 × 逆绑定矩阵）把 +Z 转到当前姿势
 */
function headForward(root) {
  for (const skin of root.listSkins()) {
    const joints = skin.listJoints()
    const i = joints.findIndex((j) => j.getName() === 'mixamorig:Head')
    if (i < 0) continue
    const m = mul(joints[i].getWorldMatrix(), skin.getInverseBindMatrices().getElement(i, []))
    return normalize([m[8], m[9], m[10]])
  }
  return [0, 0, 1]
}

/** 第一个动画第一帧的平移 / 旋转 / 缩放写到目标节点上；返回和节点原值不同的通道数 */
function applyPose(root) {
  const anim = root.listAnimations()[0]
  if (!anim) return 0
  let changed = 0
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode()
    const value = ch.getSampler()?.getOutput()?.getElement(0, [])
    if (!node || !value) continue
    const path = ch.getTargetPath()
    const cur = path === 'translation' ? node.getTranslation() : path === 'rotation' ? node.getRotation() : path === 'scale' ? node.getScale() : null
    if (!cur) continue
    if (value.some((v, i) => Math.abs(v - cur[i]) > 1e-4)) changed++
    if (path === 'translation') node.setTranslation(value)
    else if (path === 'rotation') node.setRotation(value)
    else node.setScale(value)
  }
  return changed
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
    return { c, r }
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
  return { eyeLeft: L.c, eyeRight: R.c, blinkAxis: axis, headForward: forward }
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
      }),
      ...(idle.headForward && { idleHeadForward: idle.headForward }),
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

async function buildCollider(doc, name, pivot, include = COLLIDER) {
  const root = doc.getRoot()
  for (const node of root.listNodes()) if (node.getMesh() && !include.test(node.getMesh().getName())) node.dispose()
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
