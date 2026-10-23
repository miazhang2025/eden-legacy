import type { SceneId } from '../config/schema'
import type { SpecimenGrade } from '../materials/specimenLook'
import { copy } from './copy'

/** 结尾标本盒的文案按「洞穴类别 × 海洋类别 × 花园类别」查（8 种组合，见 data/specimenBoxes.ts） */
export type Category = 'mineral' | 'plant' | 'shell' | 'fish' | 'flower' | 'butterfly'

export const SCENE_CATEGORIES: Record<SceneId, [Category, Category]> = {
  cave: ['mineral', 'plant'],
  ocean: ['shell', 'fish'],
  garden: ['flower', 'butterfly'],
}

export interface CollectableAssetDef {
  id: string
  scene: SceneId
  category: Category
  /** 文案 key：通过 copy(`${copyKey}.name`) / copy(`${copyKey}.desc`) 取 */
  copyKey: string
  /** '/models/assets/<id>.glb'（npm run assets）；美术资产未到位时为 'placeholder' */
  model: string
  /** 真实模型最长边缩放到多少米（占位几何体约 1 米） */
  size: number
  specimenScale?: number
  /**
   * 结尾标本盒里做主体（最大那件）的优先级：三件里取最高的。按单个资产定，不按类别——
   * 同是贝壳，笠贝摊平好看，巨贝放大了很丑（0 = 永远不做主体）
   */
  heroWeight: number
  /** 标本盒里的姿态：flatten（默认）= 转到投影面积最大的一面正对背板；upright = 保持直立的侧面（蘑菇摊平只剩一个圆顶） */
  specimenPose?: 'flatten' | 'upright'
  /** upright 时额外的旋转（度，XYZ）：把资产的「正面」（花口、眼睛）转到正对镜头 */
  specimenRotation?: [number, number, number]
  /** 调色（色相 / 饱和度 / 亮度）对齐美术效果图，场景里和标本盒里都生效 */
  specimenGrade?: SpecimenGrade
  /** 按材质名单独调色（覆盖 specimenGrade），如海蝶只给最外层皮（optimize-assets 拆出的 seaangel_outer）上色 */
  materialGrades?: Record<string, SpecimenGrade>
  /** 场景里额外的常驻自发光（叠加在 flow.assetSelfGlow 上）：贴图偏暗的资产单独提亮 */
  selfGlow?: number
  /** 自发光总倍数（常驻 + 靠近 / 发现时的发光，场景和标本盒都乘）：0 = 完全不发光；默认 1 */
  glowScale?: number
  /** 常驻不透明度（场景里和标本盒里都生效）：< 1 = 半透明（如海蝶，能透出里层和心脏）；默认 1 */
  opacity?: number
  /**
   * 只在结尾标本盒里生效的修正，让颜色贴近场景里看到的：grade 逐项覆盖 specimenGrade，opacity 覆盖 opacity。
   * 标本盒背后是深色绒布，半透明的会透出黑底显得更深更饱和；场景里的亮背景、泛光也会让颜色显得更浅
   */
  box?: { grade?: SpecimenGrade; opacity?: number }
  /** 看向判定范围的倍数（inspectDistance、inspectAngleDeg 一起放大）：模型特别大、远处就显得很近的资产放宽，默认 1 */
  reach?: number
  /** 资产的代表色：色相按游戏里实际渲染出的主色取，饱和度 / 明度 12 件统一（HSL 0.85 / 0.75，不用深色）。发现后的光晕 / 光点、占位几何体的自发光都用它 */
  glowColor: string
  /** 占位几何体的底色，接入真实模型后不再使用 */
  placeholderColor: string
}

type Seed = Omit<CollectableAssetDef, 'copyKey' | 'model' | 'size'> & { model?: string; size?: number }

// 资产的静态定义（类别、颜色、文案）。摆位（位置 / 旋转 / 缩放）在 config/scenes/<scene>.json 的 assets 段，
// look dev 面板里调、随 JSON 导出；探索时按 1–4 可把对应资产放到角色前方。
const SEEDS: Seed[] = [
  // 资产 id 沿用最早的占位命名（也是模型文件名），类别以 category 为准
  // heroWeight：蝴蝶 > 花 > 斗鱼 > 洞穴植物 / 矿 > 海蝶 / 菌群 > 笠贝 > 巨贝（花园总有一件蝴蝶或花，实际上主体总是花园那件）
  // 浅蓝晶体一发光就过曝成白团：不发光（glowScale 0）。它下面的深色岩块是洞穴模型的 SC20_LAND，在 cave.json 里提亮
  { id: 'cave_ore_01', scene: 'cave', category: 'mineral', glowColor: '#89d2f5', placeholderColor: '#6a7fa8', specimenScale: 1, heroWeight: 5, glowScale: 0 },
  { id: 'cave_ore_02', scene: 'cave', category: 'plant', glowColor: '#89aef5', placeholderColor: '#8a6aa8', specimenScale: 1, heroWeight: 6, specimenPose: 'upright', specimenRotation: [0, -90, 0], specimenGrade: { saturation: 0.6 } },
  { id: 'cave_mushroom_01', scene: 'cave', category: 'plant', glowColor: '#89b6f5', placeholderColor: '#b89a7a', specimenScale: 1, heroWeight: 6, specimenPose: 'upright', specimenRotation: [0, 180, 0] },
  { id: 'cave_mushroom_02', scene: 'cave', category: 'plant', glowColor: '#f589bc', placeholderColor: '#a87a6a', specimenScale: 1, heroWeight: 4, specimenPose: 'upright', specimenGrade: { hue: 75, saturation: 0.5, brightness: 1.55, tint: '#ffd2e6' }, selfGlow: 0.2, box: { grade: { saturation: 0.2, tint: '#ffeaf2' } } },

  { id: 'ocean_shell_01', scene: 'ocean', category: 'shell', glowColor: '#89d2f5', placeholderColor: '#e8d6c8', specimenScale: 1, heroWeight: 0 },
  { id: 'ocean_shell_02', scene: 'ocean', category: 'shell', glowColor: '#f5e389', placeholderColor: '#c8d6e8', specimenScale: 1, heroWeight: 3 },
  { id: 'ocean_fish_01', scene: 'ocean', category: 'fish', glowColor: '#89a5f5', placeholderColor: '#4a8ab8', specimenScale: 1, heroWeight: 4, specimenGrade: { saturation: 0.35, brightness: 1.15 }, materialGrades: { seaangel_outer: { saturation: 1.1, brightness: 1.05, tint: '#9fb6ff' } } },
  { id: 'ocean_fish_02', scene: 'ocean', category: 'fish', glowColor: '#89f5f3', placeholderColor: '#d88a4a', specimenScale: 1, heroWeight: 7, specimenGrade: { saturation: 1.5, brightness: 0.95, hueCenter: 55, hueWidth: 35, hueSaturation: 0.42 }, reach: 1.6 },

  { id: 'garden_flower_01', scene: 'garden', category: 'flower', glowColor: '#b389f5', placeholderColor: '#e86aa8', specimenScale: 1, heroWeight: 8, specimenGrade: { saturation: 0.85, brightness: 4, hueCenter: 60, hueWidth: 40, hueBrightness: 0.25 }, box: { grade: { hueCenter: 60, hueWidth: 40, hueSaturation: 0.3 } } },
  { id: 'garden_flower_02', scene: 'garden', category: 'flower', glowColor: '#89f5e2', placeholderColor: '#e8d84a', specimenScale: 1, heroWeight: 9, specimenGrade: { hue: 165, saturation: 0.6, brightness: 1.15 } },
  // 浅绿翅膀贴图本身很亮，停在白花上会和背景糊成一片：压暗、提饱和，常驻自发光也减一点
  { id: 'garden_butterfly_01', scene: 'garden', category: 'butterfly', glowColor: '#90f589', placeholderColor: '#4a6ae8', specimenScale: 1, heroWeight: 10, specimenGrade: { saturation: 1.6, brightness: 0.72 }, selfGlow: -0.2 },
  { id: 'garden_butterfly_02', scene: 'garden', category: 'butterfly', glowColor: '#b289f5', placeholderColor: '#e8984a', specimenScale: 1, heroWeight: 10 },
]

export const ASSETS: CollectableAssetDef[] = SEEDS.map((s) => ({
  model: `/models/assets/${s.id}.glb`,
  size: 1,
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
