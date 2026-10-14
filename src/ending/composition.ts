import type { CompositionRole, EndingConfig, SceneId, Vec3 } from '../config/schema'
import { getAsset, type Category, type CollectableAssetDef } from '../data/assets'

// 标本盒构图：三件标本里挑一件做主体，另两件做点缀，按画框尺寸算出每件的落位点 / 可占区域 / 旋转。
// 具体「装进区域」的缩放在 SpecimenSlot 里按模型包围盒完成。

export type RoleName = 'heroRole' | 'accentNear' | 'accentFar'

/** hero = auto 时的主体优先级：越靠前越适合做视觉中心 */
export const HERO_RANK: Category[] = ['butterfly', 'shell', 'flower', 'plant', 'fish', 'mineral']

const SCENES: SceneId[] = ['cave', 'ocean', 'garden']
const DEG = Math.PI / 180

export interface Placement {
  scene: SceneId
  role: RoleName
  asset: CollectableAssetDef | undefined
  /** 落位点（标本盒局部坐标） */
  position: Vec3
  rotation: Vec3
  /** 可占据的包围盒尺寸（标本盒局部单位） */
  region: Vec3
  scale: number
}

/** 字符串 → 0–1 的稳定伪随机数（同一组合每次结果相同） */
export function hash01(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h = Math.imul(h ^ (h >>> 15), 2246822507)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** 左右镜像：auto = 按组合 id 决定（装饰花草跟着标本一起镜像） */
export const isMirrored = (comp: EndingConfig['composition'], seed: string) =>
  comp.mirror === 'on' || (comp.mirror === 'auto' && hash01(seed, 0) < 0.5)

function pickHero(selections: Record<SceneId, string | null>, choice: EndingConfig['composition']['hero']): SceneId {
  if (choice !== 'auto' && selections[choice]) return choice
  let best: SceneId = 'garden'
  let bestRank = Infinity
  for (const scene of SCENES) {
    const cat = getAsset(selections[scene])?.category
    const rank = cat ? HERO_RANK.indexOf(cat) : -1
    if (rank >= 0 && rank < bestRank) {
      best = scene
      bestRank = rank
    }
  }
  return best
}

export function composeSpecimens(
  selections: Record<SceneId, string | null>,
  comp: EndingConfig['composition'],
  frameSize: Vec3,
  seed: string,
): Placement[] {
  const hero = pickHero(selections, comp.hero)
  const accents = SCENES.filter((s) => s !== hero)
  const mirror = isMirrored(comp, seed)
  const [w, h, d] = frameSize

  const place = (scene: SceneId, role: RoleName, salt: number): Placement => {
    const r: CompositionRole = comp[role]
    const j = (k: number) => (hash01(seed, salt * 7 + k) * 2 - 1) * comp.jitterDeg * DEG
    // 镜像时 x 取反，旋转的 y / z 分量也要取反才能保持对称
    const sx = mirror ? -1 : 1
    return {
      scene,
      role,
      asset: getAsset(selections[scene]),
      position: [sx * r.anchor[0] * w, r.anchor[1] * h, r.anchor[2] * d],
      // 标本已摊平正对背板（flatten.ts），扰动只加在平面内（绕 Z），不让它前后倾斜
      rotation: [r.rotation[0], sx * r.rotation[1], sx * (r.rotation[2] + j(2))],
      region: [r.region[0] * w, r.region[1] * h, r.region[2] * d],
      scale: r.scale,
    }
  }

  return [place(hero, 'heroRole', 1), place(accents[0], 'accentNear', 2), place(accents[1], 'accentFar', 3)]
}
