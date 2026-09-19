// 环境模型处理流水线（spec §4.3）
//   art/env/<name>.glb  ──►  public/models/env/<name>.glb        渲染用：Draco + WebP（KTX2 待装 toktx 后替换）
//                       └─►  public/models/colliders/<name>.glb  碰撞用：只留地形类大物体，减面 ≥90%，无材质贴图
//
// 用法：npm run models            处理 art/env 下全部模型
//       npm run models -- garden  只处理指定模型

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { NodeIO, getBounds } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  dedup, draco, instance, prune, weld, simplify, textureCompress, flatten, join as joinMeshes,
} from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

const SRC = 'art/env'
const OUT_RENDER = 'public/models/env'
const OUT_COLLIDER = 'public/models/colliders'

/**
 * 每个模型的碰撞体规则：
 * - exclude：按 mesh 名排除（水面不能站人）
 * - minExtent：mesh 水平包围盒最长边 / 场景最长边 小于该比例的视为花草等小物件，不进碰撞体
 * - maxTriangles：碰撞体三角面上限，超出才减面（地形本身面数不高时保持原精度，贴地更准）
 *
 * 高模主要是花草等小物件，被 minExtent 整体剔除，因此总体减面远超 90%。
 */
const COLLIDER_RULES = {
  garden: { exclude: ['水'], minExtent: 0.12, maxTriangles: 20000 },
  ocean: { exclude: [], minExtent: 0.08, maxTriangles: 20000 },
  default: { exclude: [], minExtent: 0.1, maxTriangles: 20000 },
}

const countTriangles = (doc) =>
  doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
    .reduce((sum, p) => sum + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0)

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  })

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`

async function buildRender(src, name) {
  const doc = await io.read(src)
  await doc.transform(
    dedup(),
    instance({ min: 2 }),
    weld(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 85 }),
    draco(),
  )
  const out = join(OUT_RENDER, `${name}.glb`)
  await io.write(out, doc)
  return out
}

/** 节点在世界空间的水平包围盒最长边 */
function horizontalExtent(node) {
  const { min, max } = getBounds(node)
  return Math.max(max[0] - min[0], max[2] - min[2])
}

async function buildCollider(src, name) {
  const rules = COLLIDER_RULES[name] ?? COLLIDER_RULES.default
  const doc = await io.read(src)
  const root = doc.getRoot()

  const nodes = root.listNodes().filter((n) => n.getMesh())
  const extents = nodes.map((n) => horizontalExtent(n))
  const sceneExtent = Math.max(...extents)

  const kept = []
  const dropped = []
  nodes.forEach((n, i) => {
    const meshName = n.getMesh().getName() || n.getName()
    const excluded = rules.exclude.includes(meshName) || rules.exclude.includes(n.getName())
    if (excluded || extents[i] / sceneExtent < rules.minExtent) {
      dropped.push(meshName)
      n.setMesh(null)
    } else {
      kept.push(meshName)
    }
  })

  // 碰撞体不需要材质、贴图、UV、法线
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      prim.setMaterial(null)
      for (const sem of prim.listSemantics()) if (sem !== 'POSITION') prim.setAttribute(sem, null)
    }
  }

  await doc.transform(prune(), flatten(), joinMeshes({ keepNamed: false }), weld({ tolerance: 0.0001 }))
  const before = countTriangles(doc)
  if (before > rules.maxTriangles) {
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: rules.maxTriangles / before, error: 0.01 }))
  }
  await doc.transform(prune(), draco())
  const out = join(OUT_COLLIDER, `${name}.glb`)
  await io.write(out, doc)
  return { out, kept, dropped, triangles: countTriangles(doc) }
}

const only = process.argv[2]
const files = readdirSync(SRC).filter((f) => f.endsWith('.glb') && (!only || basename(f, '.glb') === only))
if (!files.length) {
  console.error(`没有找到模型：${only ?? SRC}`)
  process.exit(1)
}

await MeshoptSimplifier.ready
for (const f of files) {
  const name = basename(f, '.glb')
  const src = join(SRC, f)
  console.log(`\n▸ ${name}  (${mb(statSync(src).size)})`)
  const render = await buildRender(src, name)
  console.log(`  render   → ${render}  ${mb(statSync(render).size)}`)
  const col = await buildCollider(src, name)
  console.log(`  collider → ${col.out}  ${mb(statSync(col.out).size)}  ${Math.round(col.triangles)} 三角面`)
  console.log(`    保留 ${col.kept.length} 个 mesh：${col.kept.join(', ')}`)
  console.log(`    排除 ${col.dropped.length} 个（小物件/水面）`)
}

