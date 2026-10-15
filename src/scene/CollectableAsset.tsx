import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Color, DoubleSide, MathUtils, MeshStandardMaterial, type Group, type Material } from 'three'
import type { CollectableAssetDef } from '../data/assets'
import { assetTransform, useAssetTransform } from '../state/assetPlacement'
import { getSceneCfg, useSceneCfg } from '../state/useConfigStore'
import { nowSec, useFlowStore } from '../state/useFlowStore'
import { groundHeightFromSky } from './collision'
import { AssetModel } from './AssetModel'
import { PlaceholderModel } from './PlaceholderModel'
import { dampFactor } from './rig'

/**
 * 真实模型的自发光：emissive 设成白色，着色器里再乘上（调色后的）底色 = 按自己的颜色发光（见 materials/specimenLook.ts）。
 * 只改 AssetModel 给的每实例材质副本，不影响结尾标本盒里同一个模型。
 */
function applyBaseColorGlow(m: Material) {
  const std = m as MeshStandardMaterial
  if (std.emissive) std.emissive.set('#ffffff')
}

export function CollectableAsset({ def }: { def: CollectableAssetDef }) {
  const group = useRef<Group>(null)
  const emissive = useRef(0)
  /** 资产贴地：config assets[].position 的 x/z 为世界坐标，y 为相对地面的偏移；x/z 变化时重新求地面高度 */
  const ground = useRef<{ x: number; z: number; y: number } | null>(null)
  const roughness = useSceneCfg((c) => c.placeholder.assetRoughness)
  const metalness = useSceneCfg((c) => c.placeholder.assetMetalness)
  /** 本场景资产整体大小（× 各自摆位里的 scale） */
  const assetSize = useSceneCfg((c) => c.flow.assetSize)
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

  // 逐帧控制淡出与发光的材质：占位几何体就是上面那一个，真实模型由 AssetModel 交过来（每实例一份副本）。
  // 真实模型用自己的 base 贴图做自发光（常驻一点 + 靠近 / 选中时增强），不再用背后的光晕精灵（会被模型穿插切开）
  const placeholder = def.model === 'placeholder'
  const mats = useRef<Material[]>([])
  useEffect(() => {
    if (placeholder) mats.current = [material]
  }, [placeholder, material])
  const onMaterials = useCallback((m: Material[]) => {
    m.forEach(applyBaseColorGlow)
    mats.current = m
  }, [])

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
      case 'EXPLORING':
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
    const glow = placeholder ? emissive.current : f.assetSelfGlow + (def.selfGlow ?? 0) + emissive.current * f.assetGlowGain
    for (const m of mats.current) {
      if ('emissiveIntensity' in m) (m as MeshStandardMaterial).emissiveIntensity = glow
      m.opacity = opacity
      // 真实模型平时不透明（免得排序出错），淡出时才切透明
      m.transparent = placeholder || opacity < 0.999
      m.depthWrite = opacity > 0.99
    }
    g.visible = opacity > 0.001

    const lift = floating ? Math.sin(t * f.floatSpeed + phaseOffset) * f.floatAmplitude : 0
    g.position.y = ground.current.y + offsetY + f.assetLift + lift
    if (floating) g.rotation.y += dt * f.spinSpeed
  })

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    // 拖拽转视角时不算点击
    if (e.delta > getSceneCfg().flow.clickDragThreshold) return
    e.stopPropagation()
    // 只有 proximity 内（正在 INSPECTING 这个资产）且四个都看过才生效，由 store 判定
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
      scale={transform.scale * assetSize}
      onClick={onClick}
      onPointerOver={onOver}
      onPointerOut={onOut}
    >
      {placeholder ? (
        <PlaceholderModel category={def.category} material={material} />
      ) : (
        <Suspense fallback={null}>
          <AssetModel def={def} onMaterials={onMaterials} />
        </Suspense>
      )}
    </group>
  )
}
