// 按名字给几何体接贴图（美术给的新场景 glb 只有几何，贴图单独放在 art/textures/<scene>/；glb 自带烘焙贴图时直接用自带的）
//   贴图文件名规则：SC<编号>[-<编号>]_<用途>.jpg|png，例如 SC08_land.jpg、SC30-41_archangel.jpg
//   网格名就是编号（还有 stem / 水 这类特例）
//   材质名 = 贴图文件名（不含扩展名），这样运行时能按名字里的用途自动判断材质角色（land/rock → 静态，coral/tree → 植被…）
//   美术更新了某张贴图：放进同一目录，在 REPLACE 里登记新文件名；透明遮罩命名为 SC<编号>_<用途>_trans.jpg

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

/** 没有同号贴图的网格：手动指定用哪张（编号 → 贴图文件名里的编号） */
const OVERRIDES = {
  garden: { 13: 14, 48: 47, 49: 46, 50: 45, 12: 14 },
  ocean: {},
  cave: { 33: 32 },
}

/**
 * 水面 mesh（没有贴图）：材质单独命名 water_<scene>，运行时角色为 water，开了水面（Water.tsx）就隐藏。
 * 不单独命名的话会和同样没贴图的水珠被 dedup 合成一个 droplet_crystal 材质，水面被当成水晶渲染。
 */
const WATER_MESHES = {
  cave: ['59'],
}

/** 同一个编号有多张贴图时，按网格名指定用哪一张（否则取第一张并告警） */
const PICK = {
  garden: { 12: 'bigpoppy', 13: 'bigpoppy', 14: 'daisy' },
  ocean: {},
}

/**
 * 美术后来更新的贴图：网格编号 → 新贴图文件名（贴图文件名里的编号不一定对，以网格为准）。优先于同号的旧贴图，也优先于模型自带的烘焙贴图
 * （洞穴模型自带烘焙贴图，贴图目录里改了图不登记在这里是不会生效的）。
 * 材质名 = 新贴图文件名：config 里按材质名的设置（pond.material、terrain.replaces、materials 覆盖）要用这个名字。
 */
const REPLACE = {
  // SC29_plants.jpg 虽然编号是 29，画的其实是 33 号（粉色海胆花）的 UV（33 号自带的烘焙图就是它的旧版）；29 号葫芦用自带的紫色烘焙图
  cave: { 1: 'SC01_land.jpg', 33: 'SC29_plants.jpg', 34: 'SC34_PLANTS.jpg', 36: 'SC36_PLANTS.jpg' },
  garden: { 8: 'SC08_land.jpg' },
  ocean: { 8: 'SC08_land.jpg' },
}

/** 用途以 trans 结尾的是透明遮罩（白 = 留、黑 = 镂空），不当颜色贴图，合进同号材质的 alpha，例如 SC49-54_fern_trans.jpg */
const MASK = /(^|_)trans$/i

/** 地形类贴图放大一点，其它统一 1024 */
const SIZE_LARGE = 2048
const SIZE_DEFAULT = 1024
const LARGE = /land|landscape/i

function parseTextureDir(dir) {
  const out = []
  for (const file of readdirSync(dir)) {
    const m = file.match(/^SC(\d+)(?:-(\d+))?_(.+)\.(jpg|jpeg|png)$/i)
    if (!m) continue
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    out.push({ file, path: join(dir, file), from, to, label: m[3], stem: file.replace(/\.[^.]+$/, '') })
  }
  return out
}

/** 网格名 → 编号（'8' → 8，'36.' → 36，'stem' → 1，'水' → null） */
function meshNumber(name) {
  if (name === '水' || name === 'waterdrop') return null
  if (/^stem/i.test(name)) return 1
  const m = name.match(/^(\d+)/)
  return m ? Number(m[1]) : null
}

const shrunk = new WeakSet()
/** 模型自带的贴图超过上限时缩小（烘焙贴图可能是 8K） */
async function shrinkTexture(texture, size) {
  if (shrunk.has(texture)) return
  shrunk.add(texture)
  const [w, h] = texture.getSize() ?? [0, 0]
  if (Math.max(w, h) <= size) return
  const img = sharp(texture.getImage()).resize(size, size, { fit: 'inside' })
  const png = texture.getMimeType() === 'image/png'
  texture.setImage(new Uint8Array(await (png ? img.png() : img.jpeg({ quality: 92 })).toBuffer()))
  console.log(`  ${texture.getName() || '(贴图)'} ${w}×${h} → ${size}`)
}

/** 颜色贴图里比这更暗的（RGB 最大分量，0–255）也算透明：遮罩是几张贴图共用的并集，有的贴图在遮罩范围里画的是纯黑的叶子 / 茎 */
const MASK_DARK = 24
/** 透明区域用附近不透明像素的颜色填充（模糊半径，像素）：远处 mipmap / 双线性过滤不会把黑底混进叶子边缘 */
const BLEED_SIGMA = [3, 12, 40]

const masked = new WeakSet()
/**
 * 把遮罩合进材质颜色贴图的 alpha（另建一张 PNG，不动可能共用的原贴图），材质改为 alpha 裁切。
 * alpha = 遮罩 × 不是纯黑；透明处的颜色由近到远用周围叶子的颜色填满，去掉黑边。
 */
async function applyMask(doc, material, mask) {
  if (masked.has(material)) return
  masked.add(material)
  const src = material.getBaseColorTexture()
  if (!src) return
  const [w, h] = src.getSize()
  const raw = { raw: { width: w, height: h, channels: 3 } }
  const rgb = await sharp(src.getImage()).removeAlpha().raw().toBuffer()
  const m = await sharp(readFileSync(mask.path)).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer()

  const alpha = Buffer.alloc(w * h)
  const premul = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    const dark = Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) <= MASK_DARK
    alpha[i] = dark ? 0 : m[i]
    const a = alpha[i] >= 128 ? 1 : 0
    for (let c = 0; c < 3; c++) premul[i * 3 + c] = rgb[i * 3 + c] * a
  }

  // 边缘外扩：对「颜色 × 不透明」和「不透明」分别模糊，相除得到周围叶子的平均色；先用小半径，填不到的再用大半径
  // 不透明度也存成三通道（sharp 模糊单通道 raw 时输出会变成三通道），读第一个通道
  const solid = Buffer.alloc(w * h * 3)
  const filled = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    filled[i] = alpha[i] >= 128 ? 1 : 0
    solid.fill(filled[i] * 255, i * 3, i * 3 + 3)
  }
  const out = Buffer.from(rgb)
  for (const sigma of BLEED_SIGMA) {
    const c = await sharp(premul, raw).blur(sigma).raw().toBuffer()
    const a = await sharp(solid, raw).blur(sigma).raw().toBuffer()
    for (let i = 0; i < w * h; i++) {
      const cover = a[i * 3]
      if (filled[i] || cover < 2) continue
      for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.min(255, Math.round((c[i * 3 + k] * 255) / cover))
      filled[i] = 1
    }
  }

  const png = await sharp(out, raw)
    .joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer()
  const texture = doc.createTexture(`${material.getName()}_${mask.label}`).setMimeType('image/png').setImage(new Uint8Array(png))
  material.setBaseColorTexture(texture).setAlphaMode('MASK').setAlphaCutoff(0.5)
}

/** 读贴图目录里的文件，按用途缩到上限，转 JPEG */
async function loadTexture(doc, tex) {
  const size = LARGE.test(tex.label) ? SIZE_LARGE : SIZE_DEFAULT
  const buf = await sharp(readFileSync(tex.path)).resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer()
  return doc.createTexture(tex.stem).setMimeType('image/jpeg').setImage(buf)
}

export async function assignTextures(doc, scene, texturesRoot) {
  const dir = join(texturesRoot, scene)
  let files
  try {
    files = parseTextureDir(dir)
  } catch {
    console.warn(`  贴图目录不存在，跳过接贴图：${dir}`)
    return { assigned: 0, missing: [] }
  }
  const overrides = OVERRIDES[scene] ?? {}
  const pick = PICK[scene] ?? {}
  const replace = REPLACE[scene] ?? {}
  const masks = files.filter((f) => MASK.test(f.label))
  const colors = files.filter((f) => !MASK.test(f.label))
  const waterMeshes = WATER_MESHES[scene] ?? []

  const texCache = new Map()
  const matCache = new Map()
  const missing = []
  let assigned = 0
  /** 同名 mesh 共用烘焙材质（美术文件里有重复导出、没带材质的同名 mesh） */
  const bakedByMesh = new Map()

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const meshName = mesh.getName() || node.getName()
    if (waterMeshes.includes(meshName)) {
      const name = `water_${scene}`
      let mat = matCache.get(name)
      if (!mat) {
        mat = doc.createMaterial(name).setRoughnessFactor(0.1).setMetallicFactor(0)
        matCache.set(name, mat)
      }
      for (const prim of mesh.listPrimitives()) prim.setMaterial(mat)
      continue
    }
    const num = meshNumber(meshName)
    const lookup = overrides[num] ?? num
    const inRange = (f) => lookup !== null && lookup >= f.from && lookup <= f.to
    const mask = masks.find(inRange)
    // 先按网格自己的编号找（OVERRIDES 只借名字，比如 33 → 32），再按借来的编号找
    const replacement = colors.find((f) => f.file === (replace[num] ?? replace[lookup]))
    let candidates = colors.filter((f) => inRange(f) && f !== replacement)
    if (candidates.length > 1) {
      const want = pick[num]
      const chosen = want ? candidates.filter((f) => f.label.toLowerCase().includes(want.toLowerCase())) : []
      if (!chosen.length) console.warn(`  ${meshName}：编号 ${lookup} 有多张贴图（${candidates.map((f) => f.file).join(', ')}），用第一张`)
      candidates = chosen.length ? chosen : candidates
    }
    // 材质名：有新贴图按新贴图起
    const tex = replacement ?? candidates[0]
    /** 贴图目录里的颜色贴图（同一张文件只读一次） */
    const fileTexture = async (f) => {
      if (!texCache.has(f.file)) texCache.set(f.file, await loadTexture(doc, f))
      return texCache.get(f.file)
    }

    // 模型自带烘焙贴图（美术直接导出带贴图的 glb）：贴图用模型里的（有新贴图则换成新的），材质名仍按贴图目录的规则起
    // （运行时按名字判断材质角色，config.materials 的覆盖也按名字认）
    const baked =
      mesh.listPrimitives().map((p) => p.getMaterial()).find((m) => m?.getBaseColorTexture()) ?? bakedByMesh.get(meshName)
    if (baked) {
      bakedByMesh.set(meshName, baked)
      const name = tex ? `SC${String(num).padStart(2, '0')}_${tex.label}` : baked.getName() || `baked_${meshName}`
      baked.setName(name).setRoughnessFactor(0.9).setMetallicFactor(0)
      if (replacement) baked.setBaseColorTexture(await fileTexture(replacement))
      else await shrinkTexture(baked.getBaseColorTexture(), LARGE.test(name) ? SIZE_LARGE : SIZE_DEFAULT)
      if (mask) await applyMask(doc, baked, mask)
      for (const prim of mesh.listPrimitives()) prim.setMaterial(baked)
      assigned++
      continue
    }

    if (!tex) {
      if (meshName !== '水' && meshName !== 'waterdrop') missing.push(meshName)
      // 没有贴图也建一个材质，名字带 mesh 名，方便在面板里认出来
      // 「水」是从花上滴落的水珠（见参考图），按玻璃质感处理，不是水面
      const name = meshName === '水' || meshName === 'waterdrop' ? 'droplet_crystal' : `untextured_${meshName}`
      let mat = matCache.get(name)
      if (!mat) {
        mat = doc.createMaterial(name).setRoughnessFactor(0.9).setMetallicFactor(0)
        matCache.set(name, mat)
      }
      for (const prim of mesh.listPrimitives()) prim.setMaterial(mat)
      continue
    }

    let mat = matCache.get(tex.stem)
    if (!mat) {
      const texture = await fileTexture(tex)
      mat = doc.createMaterial(tex.stem).setBaseColorTexture(texture).setRoughnessFactor(0.9).setMetallicFactor(0)
      matCache.set(tex.stem, mat)
    }
    if (mask) await applyMask(doc, mat, mask)
    for (const prim of mesh.listPrimitives()) prim.setMaterial(mat)
    assigned++
  }
  return { assigned, missing, materials: matCache.size, textures: texCache.size }
}
