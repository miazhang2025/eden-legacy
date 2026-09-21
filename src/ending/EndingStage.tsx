import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { BackSide, Color, PCFShadowMap, PCFSoftShadowMap, ShaderMaterial, type Material, type Mesh } from 'three'
import { useEndingCfg } from '../state/useConfigStore'
import { useTier } from '../state/useQualityStore'

// Ending 的灯光舞台：影棚式渐变环境 + 主光（投影）+ 环境光。
// 环境贴图只渲染一次（frames=1），颜色变化时重渲。

function StudioGradient({ top, bottom }: { top: string; bottom: string }) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        uniforms: { uTop: { value: new Color() }, uBottom: { value: new Color() } },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop;
          uniform vec3 uBottom;
          varying vec3 vDir;
          void main() {
            gl_FragColor = vec4(mix(uBottom, uTop, smoothstep(-0.4, 0.6, vDir.y)), 1.0);
          }
        `,
      }),
    [],
  )
  material.uniforms.uTop.value.set(top)
  material.uniforms.uBottom.value.set(bottom)
  useEffect(() => () => material.dispose(), [material])
  return (
    <mesh material={material} scale={60}>
      <sphereGeometry args={[1, 32, 16]} />
    </mesh>
  )
}

export function EndingStage() {
  const env = useEndingCfg((c) => c.environment)
  const lights = useEndingCfg((c) => c.lights)
  const shadows = useEndingCfg((c) => c.shadows)
  const tier = useTier()
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  const enabled = shadows.enabled && tier.shadows !== 'off'
  const type = tier.shadows === 'soft' ? PCFSoftShadowMap : PCFShadowMap
  useEffect(() => {
    if (gl.shadowMap.enabled === enabled && gl.shadowMap.type === type) return
    gl.shadowMap.enabled = enabled
    gl.shadowMap.type = type
    scene.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined
      if (!m) return
      for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true
    })
  }, [gl, scene, enabled, type])

  const sun = lights.directional
  const len = Math.hypot(...sun.position) || 1
  const key = sun.position.map((v) => (v / len) * 12) as [number, number, number]
  const half = shadows.cameraSize

  return (
    <>
      <Environment
        key={[env.topColor, env.bottomColor, env.keyIntensity, env.keySize, sun.color, ...key].join('|')}
        frames={1}
        resolution={256}
        environmentIntensity={env.intensity}
        environmentRotation={[0, env.rotationY, 0]}
      >
        <StudioGradient top={env.topColor} bottom={env.bottomColor} />
        <Lightformer form="rect" color={sun.color} intensity={env.keyIntensity} position={key} scale={env.keySize} target={[0, 0, 0]} />
      </Environment>
      <ambientLight color={lights.ambient.color} intensity={lights.ambient.intensity} />
      <directionalLight
        key={`${enabled}-${tier.shadowMapSize}`}
        color={sun.color}
        intensity={sun.intensity}
        position={sun.position}
        castShadow={enabled}
        shadow-mapSize={[tier.shadowMapSize, tier.shadowMapSize]}
        shadow-bias={shadows.bias}
        shadow-normalBias={shadows.normalBias}
        shadow-radius={tier.shadows === 'soft' ? shadows.radius : 1}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-camera-near={0.1}
        shadow-camera-far={shadows.cameraFar}
      />
    </>
  )
}
