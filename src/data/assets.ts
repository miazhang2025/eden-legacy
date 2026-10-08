import type { SceneId } from '../config/schema'
import { copy } from './copy'

export type Category = 'ore' | 'mushroom' | 'shell' | 'fish' | 'flower' | 'butterfly'

export const SCENE_CATEGORIES: Record<SceneId, [Category, Category]> = {
  cave: ['ore', 'mushroom'],
  ocean: ['shell', 'fish'],
  garden: ['flower', 'butterfly'],
}

export interface CollectableAssetDef {
  id: string
  scene: SceneId
  category: Category
  /** 文案 key：通过 copy(`${copyKey}.name`) / copy(`${copyKey}.desc`) 取 */
  copyKey: string
  /** '/models/assets/xxx.glb'；美术资产未到位时为 'placeholder' */
  model: string
  specimenScale?: number
  glowColor: string
  /** 占位几何体的底色，接入真实模型后不再使用 */
  placeholderColor: string
}

type Seed = Omit<CollectableAssetDef, 'copyKey' | 'model'> & { model?: string }

// 资产的静态定义（类别、颜色、文案）。摆位（位置 / 旋转 / 缩放）在 config/scenes/<scene>.json 的 assets 段，
// look dev 面板里调、随 JSON 导出；探索时按 1–4 可把对应资产放到角色前方。
const SEEDS: Seed[] = [
  { id: 'cave_ore_01', scene: 'cave', category: 'ore', glowColor: '#7ef9ff', placeholderColor: '#6a7fa8', specimenScale: 1 },
  { id: 'cave_ore_02', scene: 'cave', category: 'ore', glowColor: '#c78bff', placeholderColor: '#8a6aa8', specimenScale: 1 },
  { id: 'cave_mushroom_01', scene: 'cave', category: 'mushroom', glowColor: '#9dff8a', placeholderColor: '#b89a7a', specimenScale: 1 },
  { id: 'cave_mushroom_02', scene: 'cave', category: 'mushroom', glowColor: '#ffb86b', placeholderColor: '#a87a6a', specimenScale: 1 },

  { id: 'ocean_shell_01', scene: 'ocean', category: 'shell', glowColor: '#ffd1e8', placeholderColor: '#e8d6c8', specimenScale: 1 },
  { id: 'ocean_shell_02', scene: 'ocean', category: 'shell', glowColor: '#b3f0ff', placeholderColor: '#c8d6e8', specimenScale: 1 },
  { id: 'ocean_fish_01', scene: 'ocean', category: 'fish', glowColor: '#6bd8ff', placeholderColor: '#4a8ab8', specimenScale: 1 },
  { id: 'ocean_fish_02', scene: 'ocean', category: 'fish', glowColor: '#ffa36b', placeholderColor: '#d88a4a', specimenScale: 1 },

  { id: 'garden_flower_01', scene: 'garden', category: 'flower', glowColor: '#ff8ac8', placeholderColor: '#e86aa8', specimenScale: 1 },
  { id: 'garden_flower_02', scene: 'garden', category: 'flower', glowColor: '#fff08a', placeholderColor: '#e8d84a', specimenScale: 1 },
  { id: 'garden_butterfly_01', scene: 'garden', category: 'butterfly', glowColor: '#8ab8ff', placeholderColor: '#4a6ae8', specimenScale: 1 },
  { id: 'garden_butterfly_02', scene: 'garden', category: 'butterfly', glowColor: '#ffc78a', placeholderColor: '#e8984a', specimenScale: 1 },
]

export const ASSETS: CollectableAssetDef[] = SEEDS.map((s) => ({
  model: 'placeholder',
  ...s,
  copyKey: `asset.${s.id}`,
}))

const BY_ID = new Map(ASSETS.map((a) => [a.id, a]))

export function getAsset(id: string | null | undefined): CollectableAssetDef | undefined {
  return id ? BY_ID.get(id) : undefined
}

export function assetsForScene(scene: SceneId): CollectableAssetDef[] {
  return ASSETS.filter((a) => a.scene === scene)
}

export const assetName = (a: CollectableAssetDef) => copy(`${a.copyKey}.name`)
/** 名字下方的小字（中文版显示英文名）；英文版为空串 */
export const assetSubname = (a: CollectableAssetDef) => copy(`${a.copyKey}.subname`)
export const assetDesc = (a: CollectableAssetDef) => copy(`${a.copyKey}.desc`)
