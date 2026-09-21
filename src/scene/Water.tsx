import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PlaneGeometry, type Matrix4, type Mesh } from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { isTouchMode } from '../input/useInput'
import { MAX_DEPTH, bakeDepthMap, createWaterMaterial, createWaterUniforms } from '../materials/WaterMaterial'
import { getSceneCfg, useSceneCfg } from '../state/useConfigStore'
import { capQuality, useTier } from '../state/useQualityStore'
import { hasCollider, setWalkPlane } from './collision'
import { LAYER_VEGETATION } from './envMaterials'

const DEG = Math.PI / 180

// 水面平面（spec §5.2C）。三个场景都可以有，由各自 config 的 water.enabled 控制。
export function Water() {
  const enabled = useSceneCfg((c) => c.water.enabled)
  const walkable = useSceneCfg((c) => c.water.walkable)
  const level = useSceneCfg((c) => c.water.level)
  // 走水：水面作为可站立的地面（spec §15-B 决定：ocean 浮岛之间可以走水）
  useEffect(() => {
    setWalkPlane(enabled && walkable ? level : null)
    return () => setWalkPlane(null)
  }, [enabled, walkable, level])
  if (!enabled) return null
  return <WaterSurface />
}

function WaterSurface() {
  const w = useSceneCfg((c) => c.water)
  const tier = useTier()
  const quality = capQuality(w.quality, tier.water)
  const scene = useThree((s) => s.scene)
  const mesh = useRef<Mesh>(null)

  const uniforms = useMemo(createWaterUniforms, [])
  const material = useMemo(() => createWaterMaterial(uniforms), [uniforms])
  const geometry = useMemo(() => new PlaneGeometry(1, 1), [])
  useEffect(
    () => () => {
      material.dispose()
      geometry.dispose()
    },
    [material, geometry],
  )

  // 水深图：碰撞体就绪后按水面范围烘一次；范围 / 高度变化时重烘
  const [colliderReady, setColliderReady] = useState(hasCollider)
  const [cx, , cz] = w.center
  const depthMap = useMemo(
    () => (colliderReady ? bakeDepthMap(w.level, cx, cz, w.size) : null),
    [colliderReady, w.level, cx, cz, w.size],
  )
  useEffect(() => () => depthMap?.dispose(), [depthMap])

  // 实时反射（mid 及以上）：分辨率是最大的性能旋钮，移动端减半
  const resolution = Math.round(w.reflectionResolution * (isTouchMode() ? 0.5 : 1))
  const reflector = useMemo(() => {
    if (quality === 'low') return null
    const r = new Reflector(new PlaneGeometry(1, 1), {
      textureWidth: resolution,
      textureHeight: resolution,
      clipBias: 0.003,
      multisample: 0,
    })
    r.visible = false
    return r
  }, [quality, resolution])
  useEffect(
    () => () => {
      reflector?.getRenderTarget().dispose()
      reflector?.dispose()
    },
    [reflector],
  )

  // 反射图层：默认只有地形（0 层），可选加入植被（1 层）；粒子（2 层）永远不进反射
  useEffect(() => {
    if (!reflector) return
    reflector.camera.layers.set(0)
    if (w.reflectionLayers === 'terrain+vegetation') reflector.camera.layers.enable(LAYER_VEGETATION)
  }, [reflector, w.reflectionLayers])

  // 档位相关的材质开关（切换 transmission 需要重编译）
  useEffect(() => {
    const refract = quality === 'high' && w.refractionStrength > 0
    material.transparent = !refract
    ;(material as unknown as { transmission: number }).transmission = refract ? w.refractionStrength : 0
    ;(material as unknown as { thickness: number }).thickness = refract ? 1 : 0
    ;(material as unknown as { ior: number }).ior = 1.333
    material.depthWrite = refract
    material.needsUpdate = true
  }, [material, quality, w.refractionStrength])

  useFrame((state) => {
    if (!colliderReady && hasCollider()) setColliderReady(true)
    const c = getSceneCfg().water
    const u = uniforms
    u.uShallowColor.value.set(c.shallowColor)
    u.uDeepColor.value.set(c.deepColor)
    u.uDepthFalloff.value = c.depthFalloff
    u.uNormalScale.value = c.normalScale
    u.uNormalStrength.value = c.normalStrength
    u.uFlowSpeed.value = c.flowSpeed
    u.uFlowDir.value.set(Math.cos(c.flowDirectionDeg * DEG), Math.sin(c.flowDirectionDeg * DEG))
    u.uFresnelPower.value = c.fresnelPower
    u.uReflectionIntensity.value = c.reflectionIntensity
    u.uFoamWidth.value = c.foamWidth
    u.uFoamColor.value.set(c.foamColor)
    u.uOpacity.value = c.opacity
    u.uUseDepthColor.value = quality !== 'low' && depthMap ? 1 : 0
    u.uUseFoam.value = quality === 'high' && depthMap ? 1 : 0
    u.uDepthMap.value = depthMap
    u.uDepthBounds.value.set(cx - c.size / 2, cz - c.size / 2, c.size, c.size)
    u.uMaxDepth.value = MAX_DEPTH
    material.roughness = c.roughness
    // 环境反射也随 reflectionIntensity 缩放（没有海底的开放水面，全强度反射会把远处水面冲成天空色）
    material.envMapIntensity = c.reflectionIntensity

    const m = mesh.current
    if (reflector && m) {
      // Reflector 与水面共用同一变换；渲染反射时把水面自己藏起来
      reflector.position.copy(m.position)
      reflector.rotation.copy(m.rotation)
      reflector.scale.copy(m.scale)
      reflector.updateMatrixWorld()
      m.visible = false
      reflector.onBeforeRender(state.gl, scene, state.camera, undefined as never, undefined as never, undefined as never)
      reflector.visible = false
      m.visible = true
      u.uReflectionMap.value = reflector.getRenderTarget().texture
      const reflUniforms = (reflector.material as unknown as { uniforms: { textureMatrix: { value: Matrix4 } } }).uniforms
      u.uReflectionMatrix.value = reflUniforms.textureMatrix.value
      u.uUseReflection.value = 1
    } else {
      u.uUseReflection.value = 0
    }
  })

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      position={[cx, w.level, cz]}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[w.size, w.size, 1]}
      receiveShadow
      renderOrder={1}
    />
  )
}
