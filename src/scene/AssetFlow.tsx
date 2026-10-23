import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { MathUtils, Vector3, type PerspectiveCamera } from 'three'
import { AudioBus } from '../audio/AudioBus'
import { triggerConfirmGust } from '../materials/uniforms'
import type { SceneId } from '../config/schema'
import { assetsForScene } from '../data/assets'
import { assetTransform } from '../state/assetPlacement'
import { getSceneCfg } from '../state/useConfigStore'
import { nowSec, useFlowStore } from '../state/useFlowStore'
import { useRunStore } from '../state/useRunStore'
import { useTransition } from '../ui/Transition'
import { CollectableAsset } from './CollectableAsset'
import { rig } from './rig'

function leave() {
  useFlowStore.getState().exit()
  useTransition.getState().go(useRunStore.getState().nextRoute())
}

const dist2D = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz)
const DEG = Math.PI / 180
/** 已在看的资产放宽一点再丢掉，避免在边界上来回闪 */
const HOLD = 1.4
const forward = new Vector3()

/** 调试：标记全部已发现，采集本场景第一个资产并走完正常的确认 → 跳转流程（K 键 / look dev「跳过场景」） */
export function debugSkipScene(sceneId: SceneId) {
  const flow = useFlowStore.getState()
  if (flow.phase === 'CONFIRMED' || flow.phase === 'RESOLVED' || flow.phase === 'EXIT') return
  const ids = assetsForScene(sceneId).map((a) => a.id)
  useFlowStore.setState({ phase: 'INSPECTING', assetId: ids[0], discovered: ids, total: ids.length })
  useFlowStore.getState().confirm(ids[0])
}

// §6.3 四选一流程：逐帧做看向判定；四个都看过才能收集；CONFIRMED 后写 store 并跳转。
// 看向判定：资产在画面中间附近（水平夹角 ≤ inspectAngleDeg），且在画面上够大——最长边占竖直视野的 discoverScreenSize 以上
// （按资产实际尺寸和视野角换算成距离，大资产远一点就算、小资产要近一点，判定时在画面里的大小差不多；inspectDistance 是上限）。
// 贴身（proximity 内）时不管朝向。第一次发现某个资产时，相机平滑转向它（rig.focus，见 FollowCamera）。
export function AssetFlow({ sceneId }: { sceneId: SceneId }) {
  const assets = useMemo(() => assetsForScene(sceneId), [sceneId])

  useEffect(() => {
    useFlowStore.getState().reset(assetsForScene(sceneId).length)
    rig.focus = { id: null, start: 0 }
  }, [sceneId])

  // 进入 CONFIRMED：写入选择，按时序推进到 RESOLVED → 跳下一页
  useEffect(() => {
    const timers: number[] = []
    const unsub = useFlowStore.subscribe((s, prev) => {
      if (s.phase === prev.phase) return
      if (s.phase === 'INSPECTING' && s.assetId !== prev.assetId) AudioBus.playSfx('assetNear')
      if (s.phase === 'CONFIRMED' && s.assetId) {
        AudioBus.playSfx('collect')
        // 采集确认时刮一阵风（spec §5.2A）
        triggerConfirmGust()
        useRunStore.getState().select(sceneId, s.assetId)
        const f = getSceneCfg().flow
        const total = f.selectGlowDuration + f.fadeDuration + f.resolveDelay
        timers.push(window.setTimeout(() => useFlowStore.getState().resolve(), total * 1000))
      }
      if (s.phase === 'RESOLVED') leave()
    })
    const unsubFound = useFlowStore.subscribe((s, prev) => {
      // 新发现一个资产：相机平滑转向它
      if (s.discovered.length > prev.discovered.length) rig.focus = { id: s.discovered[s.discovered.length - 1], start: nowSec() }
      // 四个都看过：提示可以选择了
      if (s.total > 0 && s.discovered.length === s.total && prev.discovered.length < s.total) AudioBus.playSfx('zoneEnter')
    })
    return () => {
      unsub()
      unsubFound()
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

  useFrame(({ camera }) => {
    const flow = useFlowStore.getState()
    const f = getSceneCfg().flow
    const p = rig.position

    if (flow.phase !== 'EXPLORING' && flow.phase !== 'INSPECTING') return

    camera.getWorldDirection(forward)
    const yaw = Math.atan2(forward.x, forward.z)
    // 最长边为 1 米的资产，占竖直视野 discoverScreenSize 时离相机多远
    const unitDist = 0.5 / Math.tan(((camera as PerspectiveCamera).fov * DEG * f.discoverScreenSize) / 2)
    let picked: string | null = null
    let best = Infinity
    for (const a of assets) {
      const t = assetTransform(a)
      const [ax, , az] = t.position
      const d = dist2D(p.x, p.z, ax, az)
      const dCam = dist2D(camera.position.x, camera.position.z, ax, az)
      const size = a.size * t.scale * f.assetSize
      // 夹角从相机算（第三人称时相机在角色身后，画面中心对的是相机视线）
      const angle = Math.abs(
        MathUtils.euclideanModulo(Math.atan2(ax - camera.position.x, az - camera.position.z) - yaw + Math.PI, Math.PI * 2) - Math.PI,
      )
      // 模型特别大的资产（游动时鱼鳍展开的斗鱼）远处就显得很近，按 reach 放宽距离和角度
      const held = (flow.phase === 'INSPECTING' && flow.assetId === a.id ? HOLD : 1) * (a.reach ?? 1)
      const inView = dCam <= Math.min(f.inspectDistance, size * unitDist) * held && angle <= f.inspectAngleDeg * DEG * held
      if (!inView && d > f.proximity) continue
      // 越居中越优先；贴身的直接优先
      const score = d <= f.proximity ? -1 / (d + 0.01) : angle
      if (score < best) {
        best = score
        picked = a.id
      }
    }
    if (picked) flow.inspect(picked)
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
