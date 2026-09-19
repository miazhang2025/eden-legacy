// Theatre state → config（单向，spec §9.5）
//   theatre/<id>.theatre-project-state.json  ──►  src/data/assets.ts（资产摆位）
//                                            └─►  src/config/scenes/<id>.json（采集区 / 出生点 / 灯光 / ending slot）
// 只烘 Theatre 里被拖动过（有 override）的对象与分量，其它保持 config 原值。
//
// 用法：npm run bake:theatre            烘全部有 state 文件的场景
//       npm run bake:theatre -- garden  只烘指定场景

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import draco3d from 'draco3dgltf'
import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, Raycaster, Vector3 } from 'three'
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh'

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
Mesh.prototype.raycast = acceleratedRaycast

type Vec3 = [number, number, number]
type XYZ = { x?: number; y?: number; z?: number }
type Override = { position?: XYZ; rotation?: XYZ; scale?: XYZ }

const SHEET = 'layout' // 与 src/lookdev/TheatreEditor.tsx 一致
const IDS = ['cave', 'ocean', 'garden', 'ending'] as const
const ASSETS_FILE = 'src/data/assets.ts'

const round = (n: number, d = 3) => +n.toFixed(d)
const merge = (base: Vec3, o: XYZ | undefined, d = 3): Vec3 =>
  [round(o?.x ?? base[0], d), round(o?.y ?? base[1], d), round(o?.z ?? base[2], d)]

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
})

/** 载入碰撞体并套上 env 变换，返回地面高度查询函数（与运行时 collision.ts 同一套射线规则） */
async function loadGround(env: { collider: string; scale: number; position: Vec3; rotationY: number }) {
  if (!env.collider) return () => 0
  const doc = await io.read(`public${env.collider}`)
  const root = new Group()
  root.scale.setScalar(env.scale)
  root.position.set(...env.position)
  root.rotation.y = env.rotationY
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    for (const prim of mesh.listPrimitives()) {
      const geo = new BufferGeometry()
      geo.setAttribute('position', new BufferAttribute(prim.getAttribute('POSITION')!.getArray()!.slice(), 3))
      const idx = prim.getIndices()?.getArray()
      if (idx) geo.setIndex(new BufferAttribute(idx.slice(), 1))
      geo.applyMatrix4(new Matrix4().fromArray(node.getWorldMatrix()))
      geo.computeBoundsTree()
      root.add(new Mesh(geo))
    }
  }
  root.updateMatrixWorld(true)
  const ray = new Raycaster()
  ray.firstHitOnly = true
  return (x: number, z: number) => {
    ray.set(new Vector3(x, 1e4, z), new Vector3(0, -1, 0))
    return ray.intersectObject(root, true)[0]?.point.y ?? 0
  }
}

function readOverrides(id: string): Record<string, Override> | null {
  const file = `theatre/${id}.theatre-project-state.json`
  if (!existsSync(file)) return null
  const state = JSON.parse(readFileSync(file, 'utf8'))
  return state.sheetsById?.[SHEET]?.staticOverrides?.byObject ?? {}
}

/** 改写 assets.ts 里某个资产那一行的 worldPosition / worldRotation / scale */
function patchAssetLine(src: string, id: string, pos: Vec3, rot: Vec3, scale: number): string {
  const re = new RegExp(`^(\\s*\\{ id: '${id}',.*)$`, 'm')
  const m = src.match(re)
  if (!m) throw new Error(`assets.ts 里找不到资产 ${id}`)
  let line = m[1]
    .replace(/,\s*worldRotation: \[[^\]]*\]/, '')
    .replace(/,\s*scale: [\d.]+/, '')
    .replace(/worldPosition: \[[^\]]*\]/, `worldPosition: [${pos.join(', ')}]`)
  const extras: string[] = []
  if (rot.some((v) => v !== 0)) extras.push(`worldRotation: [${rot.join(', ')}]`)
  if (scale !== 1) extras.push(`scale: ${scale}`)
  if (extras.length) line = line.replace(/(worldPosition: \[[^\]]*\])/, `$1, ${extras.join(', ')}`)
  return src.replace(m[1], line)
}

function currentAsset(src: string, id: string) {
  const line = src.match(new RegExp(`\\{ id: '${id}',.*`))?.[0] ?? ''
  const arr = (key: string): Vec3 | null => {
    const m = line.match(new RegExp(`${key}: \\[([^\\]]*)\\]`))
    return m ? (m[1].split(',').map(Number) as Vec3) : null
  }
  return {
    position: arr('worldPosition') ?? [0, 0, 0],
    rotation: arr('worldRotation') ?? [0, 0, 0],
    scale: Number(line.match(/scale: ([\d.]+)/)?.[1] ?? 1),
  }
}

const only = process.argv[2]
let assetsSrc = readFileSync(ASSETS_FILE, 'utf8')
let touched = 0

for (const id of IDS) {
  if (only && only !== id) continue
  const overrides = readOverrides(id)
  if (!overrides) continue
  const cfgFile = `src/config/scenes/${id}.json`
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
  const log: string[] = []

  if (id === 'ending') {
    for (const [key, o] of Object.entries(overrides)) {
      const slot = key.match(/^slot:(slot[ABC])$/)?.[1]
      if (!slot) continue
      const s = cfg.slots[slot]
      s.position = merge(s.position, o.position)
      s.rotation = merge(s.rotation, o.rotation, 4)
      if (o.scale?.x !== undefined) s.scale = round(o.scale.x)
      log.push(key)
    }
  } else {
    const ground = await loadGround(cfg.env)
    for (const [key, o] of Object.entries(overrides)) {
      const assetId = key.match(/^asset:(.+)$/)?.[1]
      if (assetId) {
        // Theatre 里存的是绝对高度，assets.ts 存相对地面的偏移
        const cur = currentAsset(assetsSrc, assetId)
        const x = o.position?.x ?? cur.position[0]
        const z = o.position?.z ?? cur.position[2]
        const g = ground(x, z)
        const offsetY = o.position?.y !== undefined ? o.position.y - g : cur.position[1]
        const pos: Vec3 = [round(x), round(offsetY), round(z)]
        const rot = merge(cur.rotation, o.rotation, 4)
        const scale = o.scale?.x !== undefined ? round(o.scale.x) : cur.scale
        assetsSrc = patchAssetLine(assetsSrc, assetId, pos, rot, scale)
        log.push(key)
      } else if (key === 'zone') {
        const c = cfg.flow.zoneCenter
        cfg.flow.zoneCenter = [round(o.position?.x ?? c[0]), 0, round(o.position?.z ?? c[2])]
        if (o.scale?.x !== undefined) cfg.flow.zoneRadius = round(o.scale.x)
        log.push(key)
      } else if (key === 'spawn') {
        const s = cfg.character.spawn
        cfg.character.spawn = [round(o.position?.x ?? s[0]), 0, round(o.position?.z ?? s[2])]
        if (o.rotation?.y !== undefined) cfg.character.spawnYaw = round(o.rotation.y, 4)
        log.push(key)
      } else if (key === 'light:directional') {
        cfg.lights.directional.position = merge(cfg.lights.directional.position, o.position)
        log.push(key)
      } else if (key.startsWith('light:point:')) {
        const light = cfg.lights.points.find((l: { name: string }) => `light:point:${l.name}` === key)
        if (!light) continue
        light.position = merge(light.position, o.position)
        log.push(key)
      }
    }
  }

  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
  touched += log.length
  console.log(`▸ ${id}: ${log.length ? log.join(', ') : '（没有被拖动过的对象）'}`)
}

writeFileSync(ASSETS_FILE, assetsSrc)
console.log(touched ? `\n完成：共写回 ${touched} 个对象。` : '\n没有需要写回的内容。')
