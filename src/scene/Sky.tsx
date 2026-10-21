import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Mesh } from 'three'
import { createSkyMaterial, updateSkyMaterial } from '../materials/SkyMaterial'
import { getSceneCfg, useSceneCfg } from '../state/useConfigStore'

/** 天球半径：落在相机 far 以内 */
const RADIUS_FACTOR = 0.9

/** 背景天空盒：跟随相机，最先绘制、不写深度、不受雾影响 */
export function Sky() {
  const enabled = useSceneCfg((c) => c.sky.enabled)
  const hdriBackground = useSceneCfg((c) => c.environment.mode === 'hdri' && c.environment.background && (c.environment.hdri !== '' || c.environment.hdriBackground !== ''))
  const far = useSceneCfg((c) => c.camera.far)
  const material = useMemo(createSkyMaterial, [])
  const mesh = useRef<Mesh>(null)
  useEffect(() => () => material.dispose(), [material])

  useFrame(({ camera }) => {
    updateSkyMaterial(material, getSceneCfg())
    mesh.current?.position.copy(camera.position)
  })

  if (!enabled || hdriBackground) return null
  return (
    <mesh ref={mesh} material={material} scale={far * RADIUS_FACTOR} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[1, 48, 24]} />
    </mesh>
  )
}

/** 环境光用的天球：只在 <Environment frames={1}> 里渲染一次 */
export function EnvironmentSky() {
  const cfg = useSceneCfg((c) => c)
  const material = useMemo(createSkyMaterial, [])
  useEffect(() => () => material.dispose(), [material])
  updateSkyMaterial(material, cfg, true)
  return (
    <mesh material={material} scale={100}>
      <sphereGeometry args={[1, 32, 16]} />
    </mesh>
  )
}
