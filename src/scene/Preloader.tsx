import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Canvas, useLoader } from '@react-three/fiber'
import { useEnvironment, useGLTF } from '@react-three/drei'
import { TextureLoader } from 'three'
import { waterOn, type SceneConfig, type SceneId } from '../config/schema'
import { ASSETS } from '../data/assets'
import { isTouchMode } from '../input/useInput'
import { useConfigStore } from '../state/useConfigStore'
import { SCENE_ORDER } from '../state/useRunStore'
import { DRACO_PATH, SharedKTX2Loader, url, useKTX2Extension } from './EnvModel'

// 开始页预加载（spec：加载时间放在开始页，场景之间不再长时间黑屏；手机只预加载第一个场景）：
// 在一个隐藏的小 Canvas 里，用和场景里完全相同的 hook / 参数把所有模型、贴图、HDRI 加载并解码一遍，
// 结果进 R3F 的加载缓存（按 loader + url 为 key），场景挂载时直接命中，不用再下载、解 Draco、转 KTX2。
// 每一项各自一个 Suspense + 出错兜底，加载完（或失败）就计数，进度交给开始页显示。

type Item = { key: string; load: () => void }

/** 场景顺序与 useRunStore 的 SCENE_ORDER 一致，第一个是 cave */
const SCENES: SceneId[] = SCENE_ORDER

function gltf(paths: string[], ktx2: boolean): Item {
  return {
    key: `gltf:${paths.join(',')}`,
    // 参数与场景里的调用一致：数组 / 单个 url 决定缓存 key
    load: function useItem() {
      const ext = useKTX2Extension()
      const input = paths.length === 1 ? url(paths[0]) : paths.map(url)
      useGLTF(input as string, DRACO_PATH, undefined, ktx2 ? ext : undefined)
    },
  }
}

/** 一个场景要加载的东西（与 SceneShell / EnvModel / GeneratedTerrain / Water / Grass / Lighting 对应） */
function sceneItems(c: SceneConfig): Item[] {
  const items: Item[] = []
  const generated = c.terrain.enabled && c.terrain.model !== ''
  if (c.env.model) {
    const extras = (c.env.extras ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    items.push(gltf([c.env.model, ...extras], true))
    const collider = generated ? c.terrain.collider : c.env.collider
    const extraColliders = (c.env.extraColliders ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    // 碰撞体在场景里各自单独加载（ColliderModel），这里也逐个预加载，缓存 key 才对得上
    for (const p of [collider, ...extraColliders]) if (p) items.push(gltf([p], false))
  }
  if (generated) {
    items.push(gltf([c.terrain.model], true))
    if (c.terrain.scatter.enabled && c.terrain.scatter.model) items.push(gltf([c.terrain.scatter.model], true))
    const t = c.terrain
    const textures = [t.near.albedo, t.near.normal, t.near.orm, t.far.albedo, t.far.normal, t.far.orm]
    if (textures.every(Boolean)) {
      items.push({
        key: `ktx2:${textures.join(',')}`,
        load: function useItem() {
          useKTX2Extension()
          useLoader(SharedKTX2Loader, textures.map(url))
        },
      })
    }
  }
  if (waterOn(c) && c.water.mesh) items.push(gltf([c.water.mesh], false))
  if (c.grass.enabled && c.grass.mask) {
    const mask = c.grass.mask
    items.push({
      key: `tex:${mask}`,
      load: function useItem() {
        useLoader(TextureLoader, url(mask))
      },
    })
  }
  if (c.environment.mode === 'hdri') {
    const env = c.environment
    const bg = env.background ? env.hdriBackground || env.hdri : ''
    for (const file of new Set([env.hdri, bg].filter(Boolean))) {
      items.push({
        key: `hdri:${file}`,
        load: function useItem() {
          useEnvironment({ files: url(file) })
        },
      })
    }
  }
  return items
}

/**
 * 要预加载的东西。手机内存紧，只预加载第一个场景（含它的 4 件资产），其余场景进去时再加载；
 * 电脑预加载全部三个场景 + 结尾。
 */
export function preloadItems(): Item[] {
  const { configs } = useConfigStore.getState()
  const scenes = isTouchMode() ? SCENES.slice(0, 1) : SCENES
  const items: Item[] = []
  for (const s of scenes) items.push(...sceneItems(configs[s]))
  for (const a of ASSETS) if (a.model !== 'placeholder' && scenes.includes(a.scene)) items.push(gltf([a.model], true))
  if (!isTouchMode()) {
    const ending = configs.ending
    for (const f of ending.frame.models) if (f.model) items.push(gltf([f.model], true))
    if (ending.decor.enabled && ending.decor.model) items.push(gltf([ending.decor.model], true))
  }
  // 去重（不同场景可能共用同一份文件）
  const seen = new Set<string>()
  return items.filter((i) => !seen.has(i.key) && seen.add(i.key))
}

/** 出错时也算加载完（场景里会再加载一次并按原逻辑处理），不让一个文件卡住整个开始页 */
class Guard extends Component<{ onDone: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    console.warn('[preload] 预加载失败，进场景时再加载', e)
    this.props.onDone()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function Done({ onDone }: { onDone: () => void }) {
  useEffect(onDone, [onDone])
  return null
}

function Loader({ item, onDone }: { item: Item; onDone: () => void }) {
  item.load()
  return <Done onDone={onDone} />
}

/**
 * 隐藏的预加载画布：不渲染任何东西（frameloop="never"），只借它的渲染器初始化 KTX2 解码器。
 * onProgress(已完成, 总数)
 */
export function ScenePreloader({ onProgress }: { onProgress: (done: number, total: number) => void }) {
  const items = useMemo(preloadItems, [])
  const done = useRef(new Set<string>())
  const report = useRef(onProgress)
  report.current = onProgress
  useEffect(() => report.current(0, items.length), [items])
  const finish = (key: string) => () => {
    if (done.current.has(key)) return
    done.current.add(key)
    report.current(done.current.size, items.length)
  }

  return (
    <div className="preloader" aria-hidden="true">
      <Canvas frameloop="never" dpr={1} gl={{ antialias: false, powerPreference: 'high-performance' }}>
        {items.map((item) => (
          <Guard key={item.key} onDone={finish(item.key)}>
            <Suspense fallback={null}>
              <Loader item={item} onDone={finish(item.key)} />
            </Suspense>
          </Guard>
        ))}
      </Canvas>
    </div>
  )
}
