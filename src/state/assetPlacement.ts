import type { AssetPlacement } from '../config/schema'
import type { CollectableAssetDef } from '../data/assets'
import { useConfigStore } from './useConfigStore'

// 资产摆位的唯一来源：config/scenes/<scene>.json 的 assets 段（look dev 面板可调、随 JSON 导出）。

const MISSING: AssetPlacement = { id: '', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }

const find = (list: AssetPlacement[] | undefined, id: string) => list?.find((a) => a.id === id) ?? MISSING

/** 资产当前摆位（非响应式，供 useFrame 使用） */
export function assetTransform(def: CollectableAssetDef): AssetPlacement {
  return find(useConfigStore.getState().configs[def.scene].assets, def.id)
}

/** 资产当前摆位（响应式） */
export function useAssetTransform(def: CollectableAssetDef): AssetPlacement {
  return useConfigStore((s) => find(s.configs[def.scene].assets, def.id))
}
