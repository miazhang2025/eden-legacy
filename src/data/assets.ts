import type { SceneId, Vec3 } from '../config/schema'
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
  worldPosition: Vec3
  worldRotation?: Vec3
  scale?: number
  specimenScale?: number
  glowColor: string
  /** 占位几何体的底色，接入真实模型后不再使用 */
  placeholderColor: string
}

type Seed = Omit<CollectableAssetDef, 'copyKey' | 'model'> & { model?: string }

// 四个资产围绕采集区中心（见各场景 json 的 flow.zoneCenter）摆放。M3 用 Theatre 重新摆位后烘回此处。
// worldPosition 只用 x/z，y 为相对地面的偏移（运行时用射线贴地）。
const SEEDS: Seed[] = [
  { id: 'cave_ore_01', scene: 'cave', category: 'ore', worldPosition: [-18, 0, 2], glowColor: '#7ef9ff', placeholderColor: '#6a7fa8', specimenScale: 1 },
  { id: 'cave_ore_02', scene: 'cave', category: 'ore', worldPosition: [-10, 0, 2], glowColor: '#c78bff', placeholderColor: '#8a6aa8', specimenScale: 1 },
  { id: 'cave_mushroom_01', scene: 'cave', category: 'mushroom', worldPosition: [-17, 0, 8], glowColor: '#9dff8a', placeholderColor: '#b89a7a', specimenScale: 1 },
  { id: 'cave_mushroom_02', scene: 'cave', category: 'mushroom', worldPosition: [-11, 0, 8], glowColor: '#ffb86b', placeholderColor: '#a87a6a', specimenScale: 1 },

  { id: 'ocean_shell_01', scene: 'ocean', category: 'shell', worldPosition: [6, 0, -15], glowColor: '#ffd1e8', placeholderColor: '#e8d6c8', specimenScale: 1 },
  { id: 'ocean_shell_02', scene: 'ocean', category: 'shell', worldPosition: [12, 0, -16], glowColor: '#b3f0ff', placeholderColor: '#c8d6e8', specimenScale: 1 },
  { id: 'ocean_fish_01', scene: 'ocean', category: 'fish', worldPosition: [8, 0, -10], glowColor: '#6bd8ff', placeholderColor: '#4a8ab8', specimenScale: 1 },
  { id: 'ocean_fish_02', scene: 'ocean', category: 'fish', worldPosition: [12, 0, -8], glowColor: '#ffa36b', placeholderColor: '#d88a4a', specimenScale: 1 },

  { id: 'garden_flower_01', scene: 'garden', category: 'flower', worldPosition: [-18, 0, 2], glowColor: '#ff8ac8', placeholderColor: '#e86aa8', specimenScale: 1 },
  { id: 'garden_flower_02', scene: 'garden', category: 'flower', worldPosition: [-10, 0, 2], glowColor: '#fff08a', placeholderColor: '#e8d84a', specimenScale: 1 },
  { id: 'garden_butterfly_01', scene: 'garden', category: 'butterfly', worldPosition: [-17, 0, 8], glowColor: '#8ab8ff', placeholderColor: '#4a6ae8', specimenScale: 1 },
  { id: 'garden_butterfly_02', scene: 'garden', category: 'butterfly', worldPosition: [-11, 0, 8], glowColor: '#ffc78a', placeholderColor: '#e8984a', specimenScale: 1 },
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
export const assetDesc = (a: CollectableAssetDef) => copy(`${a.copyKey}.desc`)
