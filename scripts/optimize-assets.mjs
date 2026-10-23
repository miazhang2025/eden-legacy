// 交互资产（可采集的 12 件）处理流水线
//   art/interactive/<scene>/<file>  ──►  public/models/assets/<资产 id>.glb
//   - 面数超过 MAX_TRIS 的先焊接再减面（砗磲原模型 200 万面）；带骨骼的不减
//   - 材质与贴图沿用资产自带的：不压 KTX2、不改格式，只把长边超过 MAX_TEX 的贴图按原比例缩小（8K 贴图在浏览器里显存吃不消）
//   - 动画重采样去掉冗余关键帧，Draco 压几何
//   资产 id 与 src/data/assets.ts 对应；运行时（AssetModel）负责居中、统一尺寸、播放动画，不改材质。
//
// 用法：npm run assets            处理全部
//       npm run assets -- cave    只处理某个场景（或某个资产 id）

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, draco, prune, resample, simplify, unpartition, weld } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { smoothNormals } from './smooth-normals.mjs'
import { addRelief } from './surface-relief.mjs'

/** 资产 id → 原文件（art/interactive 下） */
const ASSETS = {
  cave_ore_01: 'cave/moroccanbarite.glb', // 沉蓝晶脉
  cave_ore_02: 'cave/crystalorchid.glb', // 幽辉隐花（水晶兰）
  cave_mushroom_01: 'cave/oxygen.glb', // 深隙异兰（Oxygyne）
  cave_mushroom_02: 'cave/mycena.glb', // 绯雾菌群（Mycena roseoflava 小菇）
  ocean_shell_01: 'ocean/chequ.glb', // 潮光巨贝（砗磲）
  ocean_shell_02: 'ocean/liluo.glb', // 附岩笠灵（笠螺）
  ocean_fish_01: 'ocean/seaangel.glb', // 浮翼海蝶（裸海蝶）
  ocean_fish_02: 'ocean/betta.glb', // 镜鳍游斗（斗鱼）
  garden_flower_01: 'garden/bianfuhua.glb', // 夜蝠幽花（黑蝙蝠花）
  garden_flower_02: 'garden/feicuige.glb', // 碧垂藤华（翡翠葛）
  garden_butterfly_01: 'garden/lunarmoth.glb', // 月辉夜蛾
  garden_butterfly_02: 'garden/butterfly.gltf', // 琥纹矩蝶（杜伯矩蛱蝶）
}

/** 平滑着色（重算法线，抹掉美术导出的硬边）的资产 */
const SMOOTH = new Set(['ocean_fish_01'])

/**
 * 美术后来单独给的新贴图（art/textures/interactive 下）：资产 id → { 材质名: 贴图文件 }，替换该材质的底色贴图（UV 不变）。
 * 砗磲与笠螺的贝壳底座用的是同一张贴图，一起换
 */
const TEXTURE_REPLACE = {
  ocean_fish_02: { 材质: 'fish.jpg' },
  ocean_shell_01: { pbr_material: 'shell.jpg' },
  ocean_shell_02: { '材质.1': 'shell.jpg' },
}

/**
 * 底色贴图暗部提亮：资产 id → { lift 强度 0–1, threshold 明度阈值 0–1 }。
 * 按 HSL 明度抬起低于阈值的部分（色相、饱和度不变，亮部不动）。例：{ cave_ore_01: { lift: 1, threshold: 0.8 } }
 */
const TEXTURE_LIFT = {}

/**
 * 表面起伏（surface-relief.mjs）：资产 id → { mesh 名, 细分次数, 位移幅度（模型局部单位，亮度 0→1） }。
 * 笠螺的贝壳原模型只有 550 面、表面平整，按贴图的放射纹做出凹凸
 */
const RELIEF = {
  ocean_shell_02: { mesh: '笠螺-材质', levels: 1, amplitude: 0.01, blur: 30, detail: 0.015, detailSigma: 24 },
}

/**
 * 拆材质：资产 id → { mesh 名: 新材质名 }，给这些 mesh 复制一份独立的材质（贴图共用），
 * 运行时可以按材质名单独调色（data/assets.ts 的 materialGrades）。海蝶：只给最外层皮上色
 */
const SPLIT_MATERIAL = {
  ocean_fish_01: { seaa_skinout_Seaangel_out_0: 'seaangel_outer' },
}

const SRC = 'art/interactive'
const TEX_SRC = 'art/textures/interactive'
const OUT = 'public/models/assets'
const MAX_TRIS = 40000
const MAX_TEX = 2048

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
})

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function hueToRgb(p, q, t) {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)]
}

/**
 * 暗部提亮（改贴图本身）：HSL 明度低于阈值的部分沿二次曲线抬起，阈值处平滑衔接；k <= 0.5 保证单调。
 * 按明度而不是按亮度 / 最亮通道算：深海军蓝这类饱和暗色也能抬起来，又不会把蓝色通道放大成荧光色
 */
async function liftTexture(tex, { lift, threshold }) {
  const { data, info } = await sharp(tex.getImage()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const k = 0.5 * lift
  for (let i = 0; i < data.length; i += 3) {
    const [h, s, l] = rgbToHsl(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255)
    const x = Math.max(threshold - l, 0)
    const [r, g, b] = hslToRgb(h, s, l + (k * x * x) / threshold)
    data[i] = Math.round(r * 255)
    data[i + 1] = Math.round(g * 255)
    data[i + 2] = Math.round(b * 255)
  }
  const png = tex.getMimeType() === 'image/png'
  const img = sharp(data, { raw: info })
  tex.setImage(new Uint8Array(await (png ? img.png() : img.jpeg({ quality: 95 })).toBuffer()))
}

const triCount = (doc) =>
  doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0)
const mb = (n) => `${(n / 1e6).toFixed(1)}MB`

const only = process.argv[2]
for (const [id, file] of Object.entries(ASSETS)) {
  if (only && !id.startsWith(only) && id !== only) continue
  const src = join(SRC, file)
  const doc = await io.read(src)
  const root = doc.getRoot()
  const before = triCount(doc)
  await doc.transform(dedup(), prune())
  if (SMOOTH.has(id)) smoothNormals(doc, () => true)

  // 减面：只动没有骨骼的大模型
  if (before > MAX_TRIS && root.listSkins().length === 0) {
    await doc.transform(weld({ tolerance: 0.0001 }))
    const welded = triCount(doc)
    if (welded > MAX_TRIS) {
      await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: MAX_TRIS / welded, error: 0.005 }))
    }
  }

  for (const [name, file] of Object.entries(TEXTURE_REPLACE[id] ?? {})) {
    const mat = root.listMaterials().find((m) => m.getName() === name)
    if (!mat) throw new Error(`${id}：没有材质 ${name}，换不了贴图 ${file}`)
    const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg'
    mat.setBaseColorTexture(doc.createTexture(file).setImage(readFileSync(join(TEX_SRC, file))).setMimeType(mime))
  }

  for (const [meshName, matName] of Object.entries(SPLIT_MATERIAL[id] ?? {})) {
    const mesh = root.listMeshes().find((m) => m.getName() === meshName)
    if (!mesh) throw new Error(`${id}：没有 mesh ${meshName}，拆不了材质`)
    for (const prim of mesh.listPrimitives()) prim.setMaterial(prim.getMaterial().clone().setName(matName))
  }

  const relief = RELIEF[id]
  if (relief) {
    const mesh = root.listMeshes().find((m) => m.getName() === relief.mesh)
    if (!mesh) throw new Error(`${id}：没有 mesh ${relief.mesh}，做不了表面起伏`)
    for (const prim of mesh.listPrimitives()) {
      const r = await addRelief(doc, prim, relief)
      console.log(`  表面起伏 ${relief.mesh}：${r.before} → ${r.after} 三角面`)
    }
  }

  // 贴图：只缩超过 MAX_TEX 的，保持原比例与原格式
  for (const tex of root.listTextures()) {
    const [w, h] = tex.getSize() ?? [0, 0]
    if (Math.max(w, h) <= MAX_TEX) continue
    const png = tex.getMimeType() === 'image/png'
    const img = sharp(tex.getImage()).resize(MAX_TEX, MAX_TEX, { fit: 'inside' })
    tex.setImage(new Uint8Array(await (png ? img.png() : img.jpeg({ quality: 95 })).toBuffer()))
  }

  const lift = TEXTURE_LIFT[id]
  if (lift) {
    const done = new Set()
    for (const mat of root.listMaterials()) {
      const tex = mat.getBaseColorTexture()
      if (!tex || done.has(tex)) continue
      done.add(tex)
      await liftTexture(tex, lift)
      console.log(`  暗部提亮 ${mat.getName()}：lift ${lift.lift} / threshold ${lift.threshold}`)
    }
  }

  await doc.transform(
    resample(),
    prune(),
    // .gltf 可能分了多个 buffer，GLB 只能有一个
    unpartition(),
    draco(),
  )
  const out = join(OUT, `${id}.glb`)
  await io.write(out, doc)
  const anims = root.listAnimations().length
  console.log(
    `${id.padEnd(20)} ${file.padEnd(26)} ${mb(statSync(src).size).padStart(7)} → ${mb(statSync(out).size).padStart(6)}  ` +
      `${Math.round(before)} → ${Math.round(triCount(doc))} 三角面${root.listSkins().length ? '  骨骼' : ''}${anims ? `  动画 ${anims}` : ''}`,
  )
}
