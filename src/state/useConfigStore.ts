import { create } from 'zustand'
import { deepMerge } from '../config/merge'
import type { ConfigId, DeepPartial, EndingConfig, GlobalConfig, SceneConfig, SceneId, StoreId } from '../config/schema'
import caveJson from '../config/scenes/cave.json'
import oceanJson from '../config/scenes/ocean.json'
import gardenJson from '../config/scenes/garden.json'
import endingJson from '../config/scenes/ending.json'
import globalJson from '../config/global.json'

// 文件原值。组件永远不直接读这些，只读 store（look dev 面板改动才能实时生效）。
// JSON 推断出的是 number[] 而非元组，这里按 schema 断言。
export const FILE_DEFAULTS = {
  cave: caveJson as unknown as SceneConfig,
  ocean: oceanJson as unknown as SceneConfig,
  garden: gardenJson as unknown as SceneConfig,
  ending: endingJson as unknown as EndingConfig,
  global: globalJson as unknown as GlobalConfig,
}

export type Configs = {
  cave: SceneConfig
  ocean: SceneConfig
  garden: SceneConfig
  ending: EndingConfig
  global: GlobalConfig
}

interface ConfigState {
  /** 本次会话的运行时 config，按场景分别保存（不 persist，刷新回到文件原值） */
  configs: Configs
  /** 当前（或最近一次）的探索场景，场景内组件从这里读 config */
  scene: SceneId
  /** look dev 面板当前编辑的 config */
  active: ConfigId
  /** 标本盒组合带来的 ending 补丁（spec §8.2 configPatch） */
  endingPatch: DeepPartial<EndingConfig> | null
  /** configs.ending 深合并 endingPatch 后的结果；ending 页面只读这个 */
  endingEffective: EndingConfig
  setScene(id: SceneId): void
  setActive(id: ConfigId): void
  setEndingPatch(patch: DeepPartial<EndingConfig> | null): void
  resetToFile(id: StoreId): void
  /** 整体替换某个 config（导入 JSON） */
  replace<K extends StoreId>(id: K, config: Configs[K]): void
  /** 修改某个 config：recipe 直接改传入的副本（immer 风格），调用方不用关心不可变更新 */
  update<K extends StoreId>(id: K, recipe: (draft: Configs[K]) => void): void
}

const clone = <T,>(v: T): T => structuredClone(v)

/** 写入新的 configs / patch 时同步重算 endingEffective（保持引用稳定，避免选择器每次返回新对象） */
function withEffective(
  configs: Configs,
  patch: DeepPartial<EndingConfig> | null,
): Pick<ConfigState, 'configs' | 'endingPatch' | 'endingEffective'> {
  return { configs, endingPatch: patch, endingEffective: deepMerge(configs.ending, patch) }
}

export const useConfigStore = create<ConfigState>()((set) => ({
  ...withEffective(clone(FILE_DEFAULTS), null),
  scene: 'cave',
  active: 'cave',
  setScene: (scene) => set({ scene, active: scene }),
  setActive: (active) => set({ active }),
  setEndingPatch: (patch) => set((s) => withEffective(s.configs, patch)),
  resetToFile: (id) => set((s) => withEffective({ ...s.configs, [id]: clone(FILE_DEFAULTS[id]) }, s.endingPatch)),
  replace: (id, config) => set((s) => withEffective({ ...s.configs, [id]: clone(config) }, s.endingPatch)),
  update: (id, recipe) =>
    set((s) => {
      const draft = clone(s.configs[id])
      recipe(draft)
      return withEffective({ ...s.configs, [id]: draft }, s.endingPatch)
    }),
}))

/** 读当前场景 config 的某个字段（仅在 3 个探索场景内使用） */
export function useSceneCfg<T>(selector: (c: SceneConfig) => T): T {
  return useConfigStore((s) => selector(s.configs[s.scene]))
}

/** 非 React 场景下读取（useFrame 内部等） */
export function getSceneCfg(): SceneConfig {
  const s = useConfigStore.getState()
  return s.configs[s.scene]
}

/** 读全局 config */
export function useGlobalCfg<T>(selector: (c: GlobalConfig) => T): T {
  return useConfigStore((s) => selector(s.configs.global))
}
export const getGlobalCfg = () => useConfigStore.getState().configs.global

/** 读 ending config（已合并组合补丁） */
export function useEndingCfg<T>(selector: (c: EndingConfig) => T): T {
  return useConfigStore((s) => selector(s.endingEffective))
}

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__configStore = useConfigStore
