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

const SRC = 'art/interactive'
const TEX_SRC = 'art/textures/interactive'
const OUT = 'public/models/assets'
const MAX_TRIS = 40000
const MAX_TEX = 2048

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
})

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

  // 贴图：只缩超过 MAX_TEX 的，保持原比例与原格式
  for (const tex of root.listTextures()) {
    const [w, h] = tex.getSize() ?? [0, 0]
    if (Math.max(w, h) <= MAX_TEX) continue
    const png = tex.getMimeType() === 'image/png'
    const img = sharp(tex.getImage()).resize(MAX_TEX, MAX_TEX, { fit: 'inside' })
    tex.setImage(new Uint8Array(await (png ? img.png() : img.jpeg({ quality: 95 })).toBuffer()))
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
