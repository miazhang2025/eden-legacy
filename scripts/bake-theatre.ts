// Theatre state → config（单向，spec §9.5）
//   theatre/<id>.theatre-project-state.json  ──►  src/config/scenes/<id>.json（出生点 / 灯光 / ending slot）
// 资产摆位不走 Theatre：在 look dev 面板调（config assets 段），随 Export JSON 导出。
// 只烘 Theatre 里被拖动过（有 override）的对象与分量，其它保持 config 原值。
//
// 用法：npm run bake:theatre            烘全部有 state 文件的场景
//       npm run bake:theatre -- garden  只烘指定场景

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

type Vec3 = [number, number, number]
type XYZ = { x?: number; y?: number; z?: number }
type Override = { position?: XYZ; rotation?: XYZ; scale?: XYZ }

const SHEET = 'layout' // 与 src/lookdev/TheatreEditor.tsx 一致
const IDS = ['cave', 'ocean', 'garden', 'ending'] as const

const round = (n: number, d = 3) => +n.toFixed(d)
const merge = (base: Vec3, o: XYZ | undefined, d = 3): Vec3 =>
  [round(o?.x ?? base[0], d), round(o?.y ?? base[1], d), round(o?.z ?? base[2], d)]

function readOverrides(id: string): Record<string, Override> | null {
  const file = `theatre/${id}.theatre-project-state.json`
  if (!existsSync(file)) return null
  const state = JSON.parse(readFileSync(file, 'utf8'))
  return state.sheetsById?.[SHEET]?.staticOverrides?.byObject ?? {}
}

const only = process.argv[2]
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
      const role = key.match(/^role:(heroRole|accentNear|accentFar)$/)?.[1]
      if (!role) continue
      // Theatre 里存的是标本盒局部坐标，config 里的 anchor 按画框尺寸归一
      const r = cfg.composition[role]
      const size: Vec3 = cfg.frame.size
      const pos = merge(
        r.anchor.map((v: number, i: number) => v * size[i]) as Vec3,
        o.position,
        6,
      )
      r.anchor = pos.map((v, i) => round(v / size[i], 4))
      r.rotation = merge(r.rotation, o.rotation, 4)
      if (o.scale?.x !== undefined) r.scale = round(o.scale.x)
      log.push(key)
    }
  } else {
    for (const [key, o] of Object.entries(overrides)) {
      if (key === 'zone') {
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

console.log(touched ? `\n完成：共写回 ${touched} 个对象。` : '\n没有需要写回的内容。')
