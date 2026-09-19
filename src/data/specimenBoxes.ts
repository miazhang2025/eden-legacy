import type { DeepPartial, EndingConfig, SceneId } from '../config/schema'
import { ASSETS, SCENE_CATEGORIES, getAsset, type Category } from './assets'
import { copy } from './copy'

export interface BoxResult {
  id: string
  name: string
  description: string
  configPatch?: DeepPartial<EndingConfig>
}

interface BoxRecord {
  /** 对 ending.json 的深合并补丁；当前全部留空，做差异化时只填这里 */
  configPatch: DeepPartial<EndingConfig>
}

const comboId = (a: Category, b: Category, c: Category) => `${a}_${b}_${c}`

// 2×2×2 = 8 种组合，每种一条记录
const TABLE: Record<string, BoxRecord> = {}
for (const a of SCENE_CATEGORIES.cave)
  for (const b of SCENE_CATEGORIES.ocean)
    for (const c of SCENE_CATEGORIES.garden) TABLE[comboId(a, b, c)] = { configPatch: {} }

export const ALL_COMBOS: string[] = Object.keys(TABLE)

/** 组合 id → 每个场景取该类别的第一个资产（look dev「模拟组合」用） */
export function selectionsForCombo(combo: string): Record<SceneId, string | null> {
  const [a, b, c] = combo.split('_') as Category[]
  const pick = (scene: SceneId, cat: Category) => ASSETS.find((x) => x.scene === scene && x.category === cat)?.id ?? null
  return { cave: pick('cave', a), ocean: pick('ocean', b), garden: pick('garden', c) }
}

export function resolveBox(selections: Record<SceneId, string | null>): BoxResult {
  const cats = (['cave', 'ocean', 'garden'] as const).map((s) => getAsset(selections[s])?.category)
  const id = cats.every(Boolean) ? comboId(cats[0]!, cats[1]!, cats[2]!) : 'unknown'
  const record = TABLE[id]
  if (record) {
    return { id, name: copy(`box.${id}.name`), description: copy(`box.${id}.desc`), configPatch: record.configPatch }
  }
  // 查不到时回落到模板串联：三个资产名拼接
  const names = (['cave', 'ocean', 'garden'] as const)
    .map((s) => getAsset(selections[s]))
    .map((a) => (a ? copy(`${a.copyKey}.name`) : ''))
  return { id, name: names.join('·'), description: copy('box.fallback.desc') }
}
