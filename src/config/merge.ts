import type { DeepPartial } from './schema'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 深合并：patch 里的对象递归合并，数组与标量整体替换。返回新对象，不改输入。 */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | null | undefined): T {
  if (!patch) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = out[k]
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v as DeepPartial<typeof cur>) : v
  }
  return out as T
}
