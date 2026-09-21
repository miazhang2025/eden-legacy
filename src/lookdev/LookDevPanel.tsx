// Tech Art Look Dev 面板（spec §9）。仅 DEV：由 lookdev/lookdev.ts lazy 加载，生产构建不含。
// 打开方式：按 ` 键，或 URL 带 ?lookdev=1。打开状态与折叠状态存 localStorage。

import { useEffect, useRef, useState } from 'react'
import { Pane, type FolderApi } from 'tweakpane'
import * as EssentialsPlugin from '@tweakpane/plugin-essentials'
import { ENDING_SCHEMA, GLOBAL_SCHEMA, SCENE_SCHEMA, type QualityTier, type SceneId, type StoreId } from '../config/schema'
import { ALL_COMBOS } from '../data/specimenBoxes'
import { captureActiveCanvas, getActiveCanvas } from '../scene/activeCanvas'
import { debugSkipScene } from '../scene/AssetFlow'
import { useMaterialRegistry } from '../scene/materialOverrides'
import { useConfigStore } from '../state/useConfigStore'
import { useDebugStore } from '../state/useDebugStore'
import { useQualityStore } from '../state/useQualityStore'
import { addFolder, buildNode, syncPanel, type BuildContext } from './buildPanel'
import { downloadDataUrl, exportAll, exportOne, importJson, configForExport, toJson } from './exportConfig'
import { measureToggle } from './measure'

const OPEN_KEY = 'lookdev.open'
const readOpen = () => {
  const q = new URLSearchParams(location.search).get('lookdev') ?? new URLSearchParams(location.hash.split('?')[1] ?? '').get('lookdev')
  if (q === '1') return true
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

const isScene = (id: StoreId): id is SceneId => id !== 'ending' && id !== 'global'

/** 顶部工具区：文件操作、性能、调试 */
function buildTools(pane: Pane, ctx: BuildContext, stopFns: Array<() => void>) {
  const id = ctx.id
  const status = { msg: '' }
  const say = (msg: string) => {
    status.msg = msg
    console.info(`[lookdev] ${msg}`)
  }

  // ---------- 文件 ----------
  const file = addFolder(pane, '文件', `lookdev.fold:${id}:__file`, true)
  file.addButton({ title: `Export JSON（${id}.json）` }).on('click', () => {
    exportOne(id)
    say(`已导出 ${id}.json，覆盖 src/config/scenes/${id}.json 即可生效`)
  })
  file.addButton({ title: 'Export All（合并 json）' }).on('click', () => {
    exportAll()
    say('已导出 lookdev-all.json（cave / ocean / garden / ending）')
  })
  file.addButton({ title: 'Import JSON' }).on('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      try {
        say(`已导入：${importJson(await f.text()).join(', ')}`)
      } catch (e) {
        say(`导入失败：${(e as Error).message}`)
      }
    }
    input.click()
  })
  file.addButton({ title: 'Copy to clipboard' }).on('click', async () => {
    try {
      await navigator.clipboard.writeText(toJson(configForExport(id)))
      say('已复制到剪贴板')
    } catch {
      say('复制失败（浏览器未授权剪贴板）')
    }
  })
  file.addButton({ title: 'Reset to file defaults' }).on('click', () => {
    useConfigStore.getState().resetToFile(id)
    say(`已恢复 ${id}.json 文件原值`)
  })
  file.addButton({ title: 'Screenshot' }).on('click', () => {
    const url = captureActiveCanvas()
    if (!url) return say('当前页面没有 3D 画布')
    downloadDataUrl(`lookdev-${id}-${Date.now()}.png`, url)
    say('已导出当前视角截图')
  })
  file.addBinding(status, 'msg', { readonly: true, label: '状态', multiline: true, rows: 2 })

  // ---------- 性能 ----------
  const perf = addFolder(pane, '性能', `lookdev.fold:${id}:__perf`, true)
  const fps = perf.addBlade({ view: 'fpsgraph', label: 'fps', rows: 2 }) as unknown as { begin(): void; end(): void }
  const stats = { frameMs: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0 }
  perf.addBinding(stats, 'frameMs', { readonly: true, label: 'frame ms', format: (v: number) => v.toFixed(2) })
  perf.addBinding(stats, 'drawCalls', { readonly: true, label: 'draw calls', format: (v: number) => v.toFixed(0) })
  perf.addBinding(stats, 'triangles', { readonly: true, format: (v: number) => v.toFixed(0) })
  perf.addBinding(stats, 'geometries', { readonly: true, format: (v: number) => v.toFixed(0) })
  perf.addBinding(stats, 'textures', { readonly: true, format: (v: number) => v.toFixed(0) })
  let raf = 0
  let last = performance.now()
  const loop = (t: number) => {
    fps.end()
    fps.begin()
    stats.frameMs += (t - last - stats.frameMs) * 0.1
    last = t
    const gl = getActiveCanvas()?.gl
    if (gl) {
      stats.drawCalls = gl.info.render.calls
      stats.triangles = gl.info.render.triangles
      stats.geometries = gl.info.memory.geometries
      stats.textures = gl.info.memory.textures
    }
    raf = requestAnimationFrame(loop)
  }
  fps.begin()
  raf = requestAnimationFrame(loop)
  stopFns.push(() => cancelAnimationFrame(raf))

  // 测开销：选一个开关，自动 A/B 切换并比较平均帧时间（spec §1.1 / §12.3）
  const cost = addFolder(perf, '测开销（开关 A/B）', `lookdev.fold:${id}:__cost`)
  const pick = { toggle: ctx.toggles[0]?.name ?? '' }
  const result = { text: '选择一个开关后点「测量」。结果同时打印到控制台，可抄进 docs/perf.md。' }
  if (ctx.toggles.length) {
    cost.addBinding(pick, 'toggle', {
      label: '开关',
      options: Object.fromEntries(ctx.toggles.map((t) => [t.name, t.name])),
    })
    cost.addButton({ title: '测量（约 5 秒）' }).on('click', async () => {
      const t = ctx.toggles.find((x) => x.name === pick.toggle)
      if (!t) return
      result.text = `测量中：${t.name} …`
      const r = await measureToggle(ctx, t.acc)
      result.text = `${t.name}\n开 ${r.on.toFixed(2)}ms / 关 ${r.off.toFixed(2)}ms / Δ ${(r.on - r.off >= 0 ? '+' : '') + (r.on - r.off).toFixed(2)}ms`
      console.info(`[lookdev][perf] ${id} ${result.text.replace('\n', ' ')}`)
    })
  }
  cost.addBinding(result, 'text', { readonly: true, label: '结果', multiline: true, rows: 3 })

  // ---------- 调试（不属于 config，不导出） ----------
  const debug = addFolder(pane, '调试', `lookdev.fold:${id}:__debug`)
  // 质量档位：look dev 时可锁定在 high（关闭自动降档）
  const q = useQualityStore.getState()
  const qualityInfo = (s: typeof q) => [`来源：${s.source}`, ...s.log.slice(-3)].join('\n')
  const quality = { tier: q.tier, auto: q.autoDowngrade, info: qualityInfo(q) }
  debug
    .addBinding(quality, 'tier', { label: '质量档位', options: { low: 'low', mid: 'mid', high: 'high' } })
    .on('change', (ev) => useQualityStore.getState().setTier(ev.value as QualityTier, 'panel'))
  debug
    .addBinding(quality, 'auto', { label: '自动降档' })
    .on('change', (ev) => useQualityStore.getState().setAutoDowngrade(ev.value))
  debug.addBinding(quality, 'info', { readonly: true, label: '档位日志', multiline: true, rows: 3 })
  stopFns.push(
    useQualityStore.subscribe((s) => {
      quality.tier = s.tier
      quality.auto = s.autoDowngrade
      quality.info = qualityInfo(s)
      pane.refresh()
    }),
  )
  if (isScene(id)) {
    const d = { freeFly: useDebugStore.getState().freeFly }
    debug
      .addBinding(d, 'freeFly', { label: 'free-fly 相机' })
      .on('change', (ev) => useDebugStore.setState({ freeFly: ev.value }))
    debug.addButton({ title: '跳过场景（采集第一个资产）' }).on('click', () => debugSkipScene(id))
  } else {
    const d = { combo: useDebugStore.getState().simulateCombo ?? '' }
    debug
      .addBinding(d, 'combo', {
        label: '模拟组合',
        options: { '（真实选择）': '', ...Object.fromEntries(ALL_COMBOS.map((c) => [c, c])) },
      })
      .on('change', (ev) => useDebugStore.setState({ simulateCombo: ev.value || null }))
  }
}

export default function LookDevPanel() {
  const [open, setOpen] = useState(readOpen)
  const id = useConfigStore((s) => s.active)
  // 材质表变化（换场景 / 模型加载完成）时重建
  const materialEntries = useMaterialRegistry((s) => s.entries)
  const [nonce, setNonce] = useState(0)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Backquote') return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      setOpen((o) => {
        try {
          localStorage.setItem(OPEN_KEY, o ? '0' : '1')
        } catch {
          /* ignore */
        }
        return !o
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open || !container.current) return
    const pane = new Pane({ container: container.current, title: `Look Dev · ${id}` })
    pane.registerPlugin(EssentialsPlugin)
    const store = useConfigStore.getState
    const ctx: BuildContext = {
      id,
      getConfig: () => store().configs[id],
      update: (recipe) => store().update(id, recipe),
      // 延后到当前事件处理结束后再重建，避免在 Tweakpane 自己的回调里 dispose
      rebuild: () => setTimeout(() => setNonce((n) => n + 1)),
      syncs: [],
      structure: [],
      toggles: [],
      materialFolders: new Map<string, FolderApi>(),
      syncing: false,
    }
    const stops: Array<() => void> = []
    // 先构建参数树（收集开关列表供「测开销」用），再把工具区插到最上面
    buildNode(pane, isScene(id) ? SCENE_SCHEMA : ENDING_SCHEMA, [], ctx)
    // 全局 config（页面过场 + 质量档位表 + 帧率守门）
    const globalPane = new Pane({ container: container.current, title: 'Global（global.json）', expanded: false })
    const gctx: BuildContext = {
      ...ctx,
      id: 'global',
      getConfig: () => store().configs.global,
      update: (recipe) => store().update('global', recipe),
      syncs: [],
      structure: [],
      toggles: [],
      materialFolders: new Map<string, FolderApi>(),
    }
    globalPane.addButton({ title: 'Export global.json' }).on('click', () => exportOne('global'))
    buildNode(globalPane, GLOBAL_SCHEMA, [], gctx)
    const toolsHost = new Pane({ container: container.current, title: '工具' })
    toolsHost.registerPlugin(EssentialsPlugin)
    buildTools(toolsHost, ctx, stops)
    container.current.insertBefore(toolsHost.element, pane.element)

    const unsub = useConfigStore.subscribe((s, prev) => {
      if (s.configs[id] !== prev.configs[id]) syncPanel(pane, ctx, s.configs[id])
      if (s.configs.global !== prev.configs.global) syncPanel(globalPane, gctx, s.configs.global)
    })
    return () => {
      unsub()
      stops.forEach((f) => f())
      toolsHost.dispose()
      pane.dispose()
      globalPane.dispose()
    }
  }, [open, id, materialEntries, nonce])

  return <div ref={container} className="lookdev-panel" style={{ display: open ? 'block' : 'none' }} />
}
