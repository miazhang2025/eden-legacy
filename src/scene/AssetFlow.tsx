import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { AudioBus } from '../audio/AudioBus'
import type { SceneId } from '../config/schema'
import { assetsForScene } from '../data/assets'
import { assetTransform } from '../state/useAssetOverrides'
import { getSceneCfg } from '../state/useConfigStore'
import { useFlowStore } from '../state/useFlowStore'
import { useRunStore } from '../state/useRunStore'
import { useTransition } from '../ui/Transition'
import { CollectableAsset } from './CollectableAsset'
import { rig } from './rig'

const dist2D = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz)

/** 调试：直接采集本场景第一个资产并走完正常的确认 → 跳转流程（K 键 / look dev「跳过场景」） */
export function debugSkipScene(sceneId: SceneId) {
  const flow = useFlowStore.getState()
  if (flow.phase === 'CONFIRMED' || flow.phase === 'RESOLVED' || flow.phase === 'EXIT') return
  const id = assetsForScene(sceneId)[0].id
  useFlowStore.setState({ phase: 'INSPECTING', assetId: id })
  useFlowStore.getState().confirm(id)
}

// §6.3 四选一流程：逐帧做采集区 / proximity 判定，CONFIRMED 后写 store 并跳转。
export function AssetFlow({ sceneId }: { sceneId: SceneId }) {
  const assets = useMemo(() => assetsForScene(sceneId), [sceneId])

  useEffect(() => {
    useFlowStore.getState().reset()
  }, [sceneId])

  // 进入 CONFIRMED：写入选择，按时序推进到 RESOLVED → 跳下一页
  useEffect(() => {
    const timers: number[] = []
    const unsub = useFlowStore.subscribe((s, prev) => {
      if (s.phase === prev.phase) return
      if (s.phase === 'PROMPTED' && prev.phase === 'IDLE') AudioBus.playSfx('zoneEnter')
      if (s.phase === 'INSPECTING' && s.assetId !== prev.assetId) AudioBus.playSfx('assetNear')
      if (s.phase === 'CONFIRMED' && s.assetId) {
        AudioBus.playSfx('collect')
        useRunStore.getState().select(sceneId, s.assetId)
        const f = getSceneCfg().flow
        const total = f.selectGlowDuration + f.fadeDuration + f.resolveDelay
        timers.push(window.setTimeout(() => useFlowStore.getState().resolve(), total * 1000))
      }
      if (s.phase === 'RESOLVED') {
        useFlowStore.getState().exit()
        useTransition.getState().go(useRunStore.getState().nextRoute())
      }
    })
    return () => {
      unsub()
      timers.forEach(clearTimeout)
    }
  }, [sceneId])

  // DEV：按 K 直接采集第一个资产（跳过行走），用于快速跑通流程
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyK' && !(e.target instanceof HTMLInputElement)) debugSkipScene(sceneId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sceneId])

  useFrame(() => {
    const flow = useFlowStore.getState()
    const f = getSceneCfg().flow
    const p = rig.position

    if (flow.phase === 'IDLE') {
      if (dist2D(p.x, p.z, f.zoneCenter[0], f.zoneCenter[2]) <= f.zoneRadius) flow.enterZone()
      return
    }
    if (flow.phase !== 'PROMPTED' && flow.phase !== 'INSPECTING') return

    let nearest: string | null = null
    let best = f.proximity
    for (const a of assets) {
      const [ax, , az] = assetTransform(a).position
      const d = dist2D(p.x, p.z, ax, az)
      if (d <= best) {
        best = d
        nearest = a.id
      }
    }
    if (nearest) flow.inspect(nearest)
    else flow.uninspect()
  })

  return (
    <>
      {assets.map((a) => (
        <CollectableAsset key={a.id} def={a} />
      ))}
    </>
  )
}
