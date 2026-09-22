// 按名字给几何体接贴图（美术给的新场景 glb 只有几何，贴图单独放在 public/textures/<scene>/）
//   贴图文件名规则：SC<编号>[-<编号>]_<用途>.jpg|png，例如 SC08_land.jpg、SC30-41_archangel.jpg
//   网格名就是编号（还有 stem / 水 这类特例）
//   材质名 = 贴图文件名（不含扩展名），这样运行时能按名字里的用途自动判断材质角色（land/rock → 静态，coral/tree → 植被…）

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

/** 没有同号贴图的网格：手动指定用哪张（编号 → 贴图文件名里的编号） */
const OVERRIDES = {
  garden: { 13: 14, 48: 47, 49: 46, 50: 45, 12: 14 },
  ocean: {},
}

/** 同一个编号有多张贴图时，按网格名指定用哪一张（否则取第一张并告警） */
const PICK = {
  garden: { 12: 'bigpoppy', 13: 'bigpoppy', 14: 'daisy' },
  ocean: {},
}

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
  if (name === '水') return null
  if (/^stem/i.test(name)) return 1
  const m = name.match(/^(\d+)/)
  return m ? Number(m[1]) : null
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

  const texCache = new Map()
  const matCache = new Map()
  const missing = []
  let assigned = 0

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const meshName = mesh.getName() || node.getName()
    const num = meshNumber(meshName)
    const lookup = overrides[num] ?? num
    let candidates = lookup === null ? [] : files.filter((f) => lookup >= f.from && lookup <= f.to)
    if (candidates.length > 1) {
      const want = pick[num]
      const chosen = want ? candidates.filter((f) => f.label.toLowerCase().includes(want.toLowerCase())) : []
      if (!chosen.length) console.warn(`  ${meshName}：编号 ${lookup} 有多张贴图（${candidates.map((f) => f.file).join(', ')}），用第一张`)
      candidates = chosen.length ? chosen : candidates
    }
    const tex = candidates[0]
    if (!tex) {
      if (meshName !== '水') missing.push(meshName)
      // 没有贴图也建一个材质，名字带 mesh 名，方便在面板里认出来
      // 「水」是从花上滴落的水珠（见参考图），按玻璃质感处理，不是水面
      const name = meshName === '水' ? 'droplet_crystal' : `untextured_${meshName}`
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
      let texture = texCache.get(tex.file)
      if (!texture) {
        const size = LARGE.test(tex.label) ? SIZE_LARGE : SIZE_DEFAULT
        const buf = await sharp(readFileSync(tex.path)).resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer()
        texture = doc.createTexture(tex.stem).setMimeType('image/jpeg').setImage(buf)
        texCache.set(tex.file, texture)
      }
      mat = doc.createMaterial(tex.stem).setBaseColorTexture(texture).setRoughnessFactor(0.9).setMetallicFactor(0)
      matCache.set(tex.stem, mat)
    }
    for (const prim of mesh.listPrimitives()) prim.setMaterial(mat)
    assigned++
  }
  return { assigned, missing, materials: matCache.size, textures: texCache.size }
}
