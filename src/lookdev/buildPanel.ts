// schema → Tweakpane 自动构建（spec §9.2）。
// 新增参数只需改 config/schema.ts，本文件不用动。
//
// 每个叶子绑定到一个独立的 holder 对象（不直接绑 config，config 是不可变更新的）：
//   面板改动 → holder change → ctx.update() 写回 useConfigStore
//   config 被外部改动（导入 / 重置 / Theatre 拖动）→ sync() 把新值写回 holder 并刷新面板

import type { FolderApi, Pane } from 'tweakpane'
import {
  MATERIAL_FIELDS,
  isLeaf,
  type ArrayLeaf,
  type ConfigId,
  type Leaf,
  type MaterialOverride,
} from '../config/schema'
import { useMaterialRegistry, type MaterialEntry } from '../scene/materialOverrides'

type Container = Pane | FolderApi
type Path = (string | number)[]
// config 在这里按「任意 JSON」处理，类型安全由 schema.ts 的 SchemaFor 保证
type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface SyncEntry {
  read(cfg: Json): unknown
  /** 返回 true 表示 holder 值有变化 */
  apply(value: unknown): boolean
}

export interface BuildContext {
  id: ConfigId
  getConfig(): Json
  update(recipe: (draft: Json) => void): void
  /** 结构变化（增删数组项、材质表变化）时整体重建面板 */
  rebuild(): void
  syncs: SyncEntry[]
  /** 结构快照：值变化即重建（例如数组长度） */
  structure: Array<{ read(cfg: Json): unknown; value: unknown }>
  /** 所有 bool 参数（路径 + 读写），供「测开销」A/B 切换 */
  toggles: Array<{ name: string; acc: Accessor }>
  materialFolders: Map<string, FolderApi>
  /** 同步期间忽略 change 事件，避免回写 */
  syncing: boolean
}

export const getAt = (obj: Json, path: Path): Json => path.reduce((o, k) => o?.[k], obj)
export function setAt(obj: Json, path: Path, value: unknown) {
  const parent = getAt(obj, path.slice(0, -1))
  parent[path[path.length - 1]] = value
}

// ---------------------------------------------------------------------------
// 折叠状态持久化（localStorage，失败时静默）
const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* 隐私模式等 */
    }
  },
}

export function addFolder(parent: Container, title: string, foldKey: string, defaultExpanded = false): FolderApi {
  const stored = storage.get(foldKey)
  const f = parent.addFolder({ title, expanded: stored === null ? defaultExpanded : stored === '1' })
  f.on('fold', (ev) => storage.set(foldKey, ev.expanded ? '1' : '0'))
  return f
}

const foldKeyOf = (ctx: BuildContext, path: Path) => `lookdev.fold:${ctx.id}:${path.join('.')}`

// ---------------------------------------------------------------------------
// 叶子绑定

export interface Accessor {
  read(cfg: Json): unknown
  write(draft: Json, value: unknown): void
}

const AXES = ['x', 'y', 'z', 'w'] as const
/** vec2 / vec3 / vec4 在 Tweakpane 里用 {x,y(,z,w)} 对象绑定 */
const vecDims: Partial<Record<Leaf['t'], number>> = { vec2: 2, vec3: 3, vec4: 4 }
const toObj = (v: Json, n: number) => Object.fromEntries(AXES.slice(0, n).map((a, i) => [a, v[i]]))
const toArr = (o: Json, n: number) => AXES.slice(0, n).map((a) => o[a])

function bindLeaf(parent: Container, leaf: Leaf, label: string, name: string, acc: Accessor, ctx: BuildContext) {
  if (leaf.t === 'hidden' || leaf.t === 'array' || leaf.t === 'materials') return
  const initial = acc.read(ctx.getConfig())
  const dims = vecDims[leaf.t] ?? 0
  const holder: { v: Json } = { v: dims ? toObj(initial, dims) : initial }

  let params: Record<string, unknown> = { label: leaf.label ?? label }
  switch (leaf.t) {
    case 'number':
      params = { ...params, min: leaf.min, max: leaf.max, step: leaf.step }
      break
    case 'color':
      params = { ...params, view: 'color' }
      break
    case 'select':
      params = { ...params, options: Object.fromEntries(leaf.options.map((o) => [o, o])) }
      break
    case 'vec2':
    case 'vec3':
    case 'vec4': {
      const axis = { step: leaf.step, min: leaf.min, max: leaf.max }
      params = { ...params, ...Object.fromEntries(AXES.slice(0, dims).map((a) => [a, axis])) }
      break
    }
  }
  const binding = parent.addBinding(holder, 'v', params)
  if ('hint' in leaf && leaf.hint) binding.element.title = leaf.hint
  // 材质的 transparent / wireframe 不是「效果开关」，不进测开销列表
  if (leaf.t === 'bool' && !name.startsWith('materials.')) ctx.toggles.push({ name, acc })

  binding.on('change', (ev) => {
    if (ctx.syncing) return
    const value = dims ? toArr(ev.value, dims) : ev.value
    ctx.update((d) => acc.write(d, value))
  })

  ctx.syncs.push({
    read: acc.read,
    apply(value) {
      const next = dims ? toObj(value, dims) : value
      if (JSON.stringify(next) === JSON.stringify(holder.v)) return false
      holder.v = next
      return true
    },
  })
}

// ---------------------------------------------------------------------------
// 递归构建

function buildArray(parent: Container, leaf: ArrayLeaf, key: string, path: Path, ctx: BuildContext) {
  const items: Json[] = getAt(ctx.getConfig(), path) ?? []
  const f = addFolder(parent, `${leaf.label ?? key} (${items.length})`, foldKeyOf(ctx, path))
  ctx.structure.push({ read: (cfg) => getAt(cfg, path)?.length ?? 0, value: items.length })
  items.forEach((item, i) => {
    const itemPath = [...path, i]
    const sub = addFolder(f, leaf.itemLabel(item, i), foldKeyOf(ctx, itemPath), true)
    buildNode(sub, leaf.item, itemPath, ctx)
    sub.addButton({ title: '删除' }).on('click', () => {
      ctx.update((d) => getAt(d, path).splice(i, 1))
      ctx.rebuild()
    })
  })
  f.addButton({ title: '+ 添加' }).on('click', () => {
    ctx.update((d) => {
      const arr = getAt(d, path)
      arr.push(leaf.create(arr))
    })
    ctx.rebuild()
  })
}

function buildMaterials(parent: Container, path: Path, ctx: BuildContext) {
  const reg = useMaterialRegistry.getState()
  const entries: MaterialEntry[] = reg.scene === ctx.id ? Object.values(reg.entries) : []
  const f = addFolder(parent, `材质 Materials (${entries.length})`, foldKeyOf(ctx, path))
  if (!entries.length) {
    f.addBlade({ view: 'text', label: '状态', parse: (v: string) => v, value: '模型未加载', disabled: true })
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  // 按 mesh 定位：选择 mesh → 展开它用的材质
  const meshToMaterial: Record<string, string> = { '—': '' }
  for (const e of entries) for (const m of e.meshNames) meshToMaterial[`${m}  →  ${e.name}`] = e.name
  const lookup = { v: '' }
  f.addBinding(lookup, 'v', { label: '按 mesh 定位', options: meshToMaterial }).on('change', (ev) => {
    if (!ev.value) return
    for (const [name, folder] of ctx.materialFolders) folder.expanded = name === ev.value
    ctx.materialFolders.get(ev.value)?.element.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })

  for (const e of entries) {
    const sub = addFolder(f, `${e.name} · ${e.role} · ${e.meshes.length} mesh`, foldKeyOf(ctx, [...path, e.name]))
    ctx.materialFolders.set(e.name, sub)
    for (const field of MATERIAL_FIELDS) {
      if (field.physical && !e.physical) continue
      const key = field.key
      bindLeaf(
        sub,
        field.leaf,
        key,
        `materials.${e.name}.${key}`,
        {
          read: (cfg) => cfg.materials?.[e.name]?.[key] ?? e.original[key],
          write: (d, v) => {
            const m: MaterialOverride = (d.materials[e.name] ??= {})
            ;(m as Json)[key] = v
          },
        },
        ctx,
      )
    }
    sub.addButton({ title: '恢复模型原值' }).on('click', () => ctx.update((d) => void delete d.materials[e.name]))
  }
}

export function buildNode(parent: Container, node: Json, path: Path, ctx: BuildContext) {
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('_')) continue
    const childPath = [...path, key]
    if (isLeaf(child)) {
      if (child.t === 'array') buildArray(parent, child, key, childPath, ctx)
      else if (child.t === 'materials') buildMaterials(parent, childPath, ctx)
      else
        bindLeaf(
          parent,
          child,
          key,
          childPath.join('.'),
          { read: (cfg) => getAt(cfg, childPath), write: (d, v) => setAt(d, childPath, v) },
          ctx,
        )
    } else {
      const f = addFolder(parent, (child as { _label?: string })._label ?? key, foldKeyOf(ctx, childPath))
      buildNode(f, child, childPath, ctx)
    }
  }
}

/** config 被外部改动后调用：结构变了就重建，否则只刷新数值 */
export function syncPanel(pane: Pane, ctx: BuildContext, cfg: Json) {
  if (ctx.structure.some((s) => s.read(cfg) !== s.value)) {
    ctx.rebuild()
    return
  }
  let changed = false
  for (const s of ctx.syncs) changed = s.apply(s.read(cfg)) || changed
  if (!changed) return
  ctx.syncing = true
  try {
    pane.refresh()
  } finally {
    ctx.syncing = false
  }
}
