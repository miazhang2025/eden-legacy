import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { BackSide, Color, PCFShadowMap, PCFSoftShadowMap, ShaderMaterial, type Material, type Mesh } from 'three'
import { useSceneCfg } from '../state/useConfigStore'
import { useTier } from '../state/useQualityStore'

// 环境光 + 主光 + 点光 + 阴影（spec §9.3 Lights / Environment）

const url = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

/** 渐变天空球：只在程序化环境贴图里渲染一次 */
function SkyGradient({ sky, horizon, ground }: { sky: string; horizon: string; ground: string }) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        uniforms: { uSky: { value: new Color() }, uHorizon: { value: new Color() }, uGround: { value: new Color() } },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uSky;
          uniform vec3 uHorizon;
          uniform vec3 uGround;
          varying vec3 vDir;
          void main() {
            float y = vDir.y;
            vec3 c = y > 0.0 ? mix(uHorizon, uSky, pow(y, 0.6)) : mix(uHorizon, uGround, pow(-y, 0.4));
            gl_FragColor = vec4(c, 1.0);
          }
        `,
      }),
    [],
  )
  material.uniforms.uSky.value.set(sky)
  material.uniforms.uHorizon.value.set(horizon)
  material.uniforms.uGround.value.set(ground)
  useEffect(() => () => material.dispose(), [material])
  return (
    <mesh material={material} scale={100}>
      <sphereGeometry args={[1, 32, 16]} />
    </mesh>
  )
}

function SceneEnvironment() {
  const env = useSceneCfg((c) => c.environment)
  const sunPos = useSceneCfg((c) => c.lights.directional.position)
  const sunColor = useSceneCfg((c) => c.lights.directional.color)
  const rotation: [number, number, number] = [0, env.rotationY, 0]

  if (env.mode === 'hdri' && env.hdri) {
    return (
      <Environment
        files={url(env.hdri)}
        background={env.background}
        environmentIntensity={env.intensity}
        environmentRotation={rotation}
        backgroundRotation={rotation}
      />
    )
  }
  // 程序化：颜色 / 主光位置变化时重新渲染一次（frames=1，平时零开销）
  const key = [env.skyColor, env.horizonColor, env.groundColor, env.sunIntensity, sunColor, ...sunPos].join('|')
  const len = Math.hypot(...sunPos) || 1
  const dir = sunPos.map((v) => (v / len) * 50) as [number, number, number]
  return (
    <Environment key={key} frames={1} resolution={256} environmentIntensity={env.intensity} environmentRotation={rotation}>
      <SkyGradient sky={env.skyColor} horizon={env.horizonColor} ground={env.groundColor} />
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

  return { enabled, mapSize: tier.shadowMapSize, soft: tier.shadows === 'soft', ...shadows }
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
