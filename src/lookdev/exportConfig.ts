// 导出 / 导入 config（spec §9.2）。
// 导出的是 base config：不含质量档位降级、移动端叠加、ending 组合补丁（spec §14-14）。
// 导出文件结构与 src/config/scenes/<id>.json 完全一致，可直接覆盖。

import type { MaterialOverride, SceneConfig, StoreId } from '../config/schema'
import { useMaterialRegistry } from '../scene/materialOverrides'
import { useConfigStore, type Configs } from '../state/useConfigStore'

const IDS: StoreId[] = ['cave', 'ocean', 'garden', 'ending', 'global']

/** materials 只保留与模型原值不同的字段（需要该场景的材质表已加载，否则原样导出） */
function diffMaterials(id: StoreId, materials: SceneConfig['materials']): SceneConfig['materials'] {
  const reg = useMaterialRegistry.getState()
  if (reg.scene !== id) return materials
  const out: SceneConfig['materials'] = {}
  for (const [name, o] of Object.entries(materials)) {
    const original = reg.entries[name]?.original
    const kept: MaterialOverride = {}
    for (const [k, v] of Object.entries(o) as [keyof MaterialOverride, unknown][]) {
      if (!original || JSON.stringify(original[k]) !== JSON.stringify(v)) (kept as Record<string, unknown>)[k] = v
    }
    if (Object.keys(kept).length) out[name] = kept
  }
  return out
}

export function configForExport<K extends StoreId>(id: K): Configs[K] {
  const cfg = structuredClone(useConfigStore.getState().configs[id])
  if ('materials' in cfg) (cfg as SceneConfig).materials = diffMaterials(id, (cfg as SceneConfig).materials)
  return cfg
}

export const toJson = (v: unknown) => JSON.stringify(v, null, 2) + '\n'

export function download(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadDataUrl(filename: string, dataUrl: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.click()
}

export const exportOne = (id: StoreId) => download(`${id}.json`, toJson(configForExport(id)))

/** Export All：单个合并 JSON { cave, ocean, garden, ending, global }（spec §9.2 二选一，选合并 json） */
export const exportAll = () =>
  download('lookdev-all.json', toJson(Object.fromEntries(IDS.map((id) => [id, configForExport(id)]))))

/** 导入：单个场景 json（按其 scene 字段）或 Export All 的合并 json。返回导入了哪些。 */
export function importJson(text: string): StoreId[] {
  const data = JSON.parse(text)
  const store = useConfigStore.getState()
  const valid = (c: unknown, id: StoreId) =>
    typeof c === 'object' && c !== null && (c as { version?: number }).version === 1 && (c as { scene?: string }).scene === id

  if (typeof data?.scene === 'string') {
    const id = data.scene as StoreId
    if (!IDS.includes(id) || !valid(data, id)) throw new Error(`不是有效的 config：scene=${data.scene}`)
    store.replace(id, data)
    return [id]
  }
  const done: StoreId[] = []
  for (const id of IDS) {
    if (data?.[id] === undefined) continue
    if (!valid(data[id], id)) throw new Error(`合并文件里的 ${id} 不是有效的 config`)
    store.replace(id, data[id])
    done.push(id)
  }
  if (!done.length) throw new Error('文件里没有可识别的 config')
  return done
}
