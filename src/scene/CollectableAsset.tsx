import { useEffect, useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Color, DoubleSide, MathUtils, MeshStandardMaterial, type Group } from 'three'
import type { CollectableAssetDef } from '../data/assets'
import { assetTransform, useAssetTransform } from '../state/useAssetOverrides'
import { getSceneCfg, useSceneCfg } from '../state/useConfigStore'
import { nowSec, useFlowStore } from '../state/useFlowStore'
import { groundHeightFromSky } from './collision'
import { PlaceholderModel } from './PlaceholderModel'
import { dampFactor } from './rig'

export function CollectableAsset({ def }: { def: CollectableAssetDef }) {
  const group = useRef<Group>(null)
  const emissive = useRef(0)
  /** 资产贴地：worldPosition 的 x/z 为世界坐标，y 为相对地面的偏移；x/z 变化时重新求地面高度 */
  const ground = useRef<{ x: number; z: number; y: number } | null>(null)
  const roughness = useSceneCfg((c) => c.placeholder.assetRoughness)
  const metalness = useSceneCfg((c) => c.placeholder.assetMetalness)
  const transform = useAssetTransform(def)
  const phaseOffset = useMemo(() => Math.random() * Math.PI * 2, [])

  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new Color(def.placeholderColor),
        emissive: new Color(def.glowColor),
        emissiveIntensity: 0,
        roughness,
        metalness,
        side: DoubleSide,
        transparent: true,
      }),
    [def.placeholderColor, def.glowColor, roughness, metalness],
  )
  useEffect(() => () => material.dispose(), [material])

  useFrame((state, rawDt) => {
    const g = group.current
    if (!g) return
    const dt = Math.min(rawDt, 0.1)
    const f = getSceneCfg().flow
    const [x, offsetY, z] = assetTransform(def).position
    if (!ground.current || ground.current.x !== x || ground.current.z !== z) {
      ground.current = { x, z, y: groundHeightFromSky(x, z) ?? 0 }
    }
    g.position.x = x
    g.position.z = z
    const { phase, assetId, confirmedAt } = useFlowStore.getState()
    const t = state.clock.elapsedTime
    const isMe = assetId === def.id

    let targetEmissive = f.idleEmissive
    let opacity = 1
    let floating = false

    switch (phase) {
      case 'IDLE':
        break
      case 'PROMPTED':
      case 'INSPECTING': {
        floating = true
        const breathe = 1 - f.breatheDepth * (0.5 + 0.5 * Math.sin(t * f.breatheSpeed + phaseOffset))
        targetEmissive = (isMe ? f.inspectEmissive : f.activeEmissive) * breathe
        break
      }
      case 'CONFIRMED':
      case 'RESOLVED':
      case 'EXIT': {
        floating = true
        const elapsed = nowSec() - confirmedAt
        const fadeT = MathUtils.clamp((elapsed - f.selectGlowDuration) / f.fadeDuration, 0, 1)
        if (isMe) {
          targetEmissive = MathUtils.lerp(f.inspectEmissive, f.selectedEmissive, Math.min(1, elapsed / f.selectGlowDuration))
          opacity = 1 - fadeT
          // TODO(M5): 采集确认 burst 粒子（§5.3B）
        } else if (f.othersFadeOut) {
          targetEmissive = f.activeEmissive
          opacity = 1 - fadeT
        } else {
          targetEmissive = f.activeEmissive
        }
        break
      }
    }

    emissive.current = MathUtils.lerp(emissive.current, targetEmissive, dampFactor(f.emissiveDamping, dt))
    material.emissiveIntensity = emissive.current
    material.opacity = opacity
    material.depthWrite = opacity > 0.99
    g.visible = opacity > 0.001

    const lift = floating ? Math.sin(t * f.floatSpeed + phaseOffset) * f.floatAmplitude : 0
    g.position.y = ground.current.y + offsetY + f.assetLift + lift
    if (floating) g.rotation.y += dt * f.spinSpeed
  })

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    // 拖拽转视角时不算点击
    if (e.delta > getSceneCfg().flow.clickDragThreshold) return
    e.stopPropagation()
    // 只有 proximity 内（正在 INSPECTING 这个资产）才生效，由 store 判定
    useFlowStore.getState().confirm(def.id)
  }

  const onOver = () => {
    const { phase, assetId } = useFlowStore.getState()
    if (phase === 'INSPECTING' && assetId === def.id) document.body.style.cursor = 'pointer'
  }
  const onOut = () => {
    document.body.style.cursor = ''
  }
  useEffect(() => onOut, [])

  return (
    <group
      ref={group}
      // position 逐帧在 useFrame 里设置（贴地 + 浮动）
      rotation={transform.rotation}
      scale={transform.scale}
      onClick={onClick}
      onPointerOver={onOver}
      onPointerOut={onOut}
    >
      <PlaceholderModel category={def.category} material={material} />
    </group>
  )
}
