import { create } from 'zustand'
import type { Vec3 } from '../config/schema'
import type { CollectableAssetDef } from '../data/assets'

// 资产摆位的运行时覆盖：仅在 DEV 的 Theatre 编辑时写入，让场景实时跟随 gizmo。
// 生产环境永远为空，资产位置只来自 data/assets.ts。

export interface AssetTransform {
  /** x/z 为世界坐标，y 为相对地面的偏移（与 assets.ts 的 worldPosition 语义一致） */
  position: Vec3
  rotation: Vec3
  scale: number
}

interface OverrideState {
  overrides: Record<string, AssetTransform>
  set(id: string, t: AssetTransform): void
  clear(): void
}

export const useAssetOverrides = create<OverrideState>()((set) => ({
  overrides: {},
  set: (id, t) => set((s) => ({ overrides: { ...s.overrides, [id]: t } })),
  clear: () => set({ overrides: {} }),
}))

const fromDef = (def: CollectableAssetDef): AssetTransform => ({
  position: def.worldPosition,
  rotation: def.worldRotation ?? [0, 0, 0],
  scale: def.scale ?? 1,
})

/** 资产当前生效的变换（非响应式，供 useFrame 使用） */
export function assetTransform(def: CollectableAssetDef): AssetTransform {
  return useAssetOverrides.getState().overrides[def.id] ?? fromDef(def)
}

/** 资产当前生效的变换（响应式） */
export function useAssetTransform(def: CollectableAssetDef): AssetTransform {
  const o = useAssetOverrides((s) => s.overrides[def.id])
  return o ?? fromDef(def)
}

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__assetOverrides = useAssetOverrides
