import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { PCFShadowMap, PCFSoftShadowMap, type Material, type Mesh } from 'three'
import { useSceneCfg } from '../state/useConfigStore'
import { useTier } from '../state/useQualityStore'
import { EnvironmentSky } from './Sky'

// 环境光 + 主光 + 点光 + 阴影（spec §9.3 Lights / Environment）

const url = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

function SceneEnvironment() {
  const env = useSceneCfg((c) => c.environment)
  const sky = useSceneCfg((c) => c.sky)
  const sunPos = useSceneCfg((c) => c.lights.directional.position)
  const sunColor = useSceneCfg((c) => c.lights.directional.color)
  const rotation: [number, number, number] = [0, env.rotationY, 0]

  if (env.mode === 'hdri' && (env.hdri || env.hdriBackground)) {
    // 背景与打光可以是两张不同的 HDRI（美术给的 pinksky 是纯背景、bluesky 是打光）：
    // 第二个 Environment 用 background="only"，只换天空不动 scene.environment。
    const bg = env.background ? env.hdriBackground || env.hdri : ''
    return (
      <>
        {env.hdri && (
          <Environment
            files={url(env.hdri)}
            background={env.background && !env.hdriBackground}
            environmentIntensity={env.intensity}
            environmentRotation={rotation}
            backgroundRotation={rotation}
            backgroundIntensity={env.backgroundIntensity}
          />
        )}
        {bg && bg !== env.hdri && (
          <Environment
            files={url(bg)}
            background="only"
            backgroundRotation={rotation}
            backgroundIntensity={env.backgroundIntensity}
          />
        )}
      </>
    )
  }
  // 程序化：用天空盒渲染一次环境贴图；天空 / 主光变化时重新渲染（frames=1，平时零开销）
  const key = JSON.stringify([sky, env.sunIntensity, sunColor, sunPos])
  const len = Math.hypot(...sunPos) || 1
  const dir = sunPos.map((v) => (v / len) * 50) as [number, number, number]
  return (
    <Environment key={key} frames={1} resolution={256} environmentIntensity={env.intensity} environmentRotation={rotation}>
      <EnvironmentSky />
      <Lightformer form="circle" color={sunColor} intensity={env.sunIntensity} position={dir} scale={12} target={[0, 0, 0]} />
    </Environment>
  )
}

/** 主光阴影：档位决定开关 / 分辨率 / 软硬（spec §12.1），config 决定 bias 与范围 */
function useShadowSettings() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const shadows = useSceneCfg((c) => c.shadows)
  const tier = useTier()
  const enabled = shadows.enabled && tier.shadows !== 'off'
  const type = tier.shadows === 'soft' ? PCFSoftShadowMap : PCFShadowMap

  useEffect(() => {
    if (gl.shadowMap.enabled === enabled && gl.shadowMap.type === type) return
    gl.shadowMap.enabled = enabled
    gl.shadowMap.type = type
    // 阴影开关 / 类型变化需要所有材质重新编译
    scene.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined
      if (!m) return
      for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true
    })
  }, [gl, scene, enabled, type])

  return { ...shadows, enabled, mapSize: tier.shadowMapSize, soft: tier.shadows === 'soft' }
}

export function Lighting() {
  const lights = useSceneCfg((c) => c.lights)
  const s = useShadowSettings()
  const half = s.cameraSize

  return (
    <>
      <SceneEnvironment />
      <ambientLight color={lights.ambient.color} intensity={lights.ambient.intensity} />
      <directionalLight
        // mapSize 变化需要重建 shadow map，用 key 强制重建灯
        key={`${s.enabled}-${s.mapSize}`}
        color={lights.directional.color}
        intensity={lights.directional.intensity}
        position={lights.directional.position}
        castShadow={s.enabled}
        shadow-mapSize={[s.mapSize, s.mapSize]}
        shadow-bias={s.bias}
        shadow-normalBias={s.normalBias}
        shadow-radius={s.soft ? s.radius : 1}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-camera-near={0.5}
        shadow-camera-far={s.cameraFar}
      />
      {lights.points.map((l) => (
        <pointLight
          key={l.name}
          color={l.color}
          intensity={l.intensity}
          distance={l.distance}
          decay={l.decay}
          position={l.position}
        />
      ))}
    </>
  )
}
