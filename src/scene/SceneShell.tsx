import { Suspense, useEffect } from 'react'
import { TheatreSaveButton, TheatreSceneEditor } from '../lookdev/theatre'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { AudioBus } from '../audio/AudioBus'
import type { SceneId } from '../config/schema'
import { TouchControls } from '../input/TouchControls'
import { isTouchMode, useInputListeners } from '../input/useInput'
import { useConfigStore, useSceneCfg } from '../state/useConfigStore'
import { useDebugStore } from '../state/useDebugStore'
import { RegisterCanvas } from './activeCanvas'
import { AssetInfoCard } from '../ui/AssetInfoCard'
import { CollectPrompt } from '../ui/CollectPrompt'
import { useTransition } from '../ui/Transition'
import { AssetFlow } from './AssetFlow'
import { CharacterController } from './CharacterController'
import { CollectZone } from './CollectZone'
import { ColliderModel, EnvModel } from './EnvModel'
import { FollowCamera } from './FollowCamera'

/** Suspense 内的内容全部就绪后才挂载，此时 fade in */
function RevealWhenReady() {
  useEffect(() => {
    const id = requestAnimationFrame(() => useTransition.getState().reveal())
    return () => cancelAnimationFrame(id)
  }, [])
  return null
}

function Atmosphere() {
  const background = useSceneCfg((c) => c.background)
  const fog = useSceneCfg((c) => c.fog)
  const lights = useSceneCfg((c) => c.lights)
  const exposure = useSceneCfg((c) => c.render.exposure)
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    gl.toneMappingExposure = exposure
  }, [gl, exposure])

  return (
    <>
      <color attach="background" args={[background]} />
      {fog.type === 'exp2' && <fogExp2 key="exp2" attach="fog" args={[fog.color, fog.density]} />}
      {fog.type === 'linear' && <fog key="linear" attach="fog" args={[fog.color, fog.near, fog.far]} />}
      <ambientLight color={lights.ambient.color} intensity={lights.ambient.intensity} />
      <directionalLight
        color={lights.directional.color}
        intensity={lights.directional.intensity}
        position={lights.directional.position}
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

/** 环境模型 + 碰撞体；env.model 为空时回落到色块地面 */
function Terrain() {
  const env = useSceneCfg((c) => c.env)
  if (!env.model) return <PlaceholderGround />
  return (
    <>
      <EnvModel path={env.model} />
      {env.collider && <ColliderModel path={env.collider} />}
    </>
  )
}

function PlaceholderGround() {
  const { groundColor, groundSize } = useSceneCfg((c) => c.placeholder)
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[groundSize, groundSize]} />
      <meshStandardMaterial color={groundColor} roughness={0.95} />
    </mesh>
  )
}

function InputBinder() {
  const gl = useThree((s) => s.gl)
  useInputListeners(gl.domElement)
  return null
}

export function SceneShell({ sceneId }: { sceneId: SceneId }) {
  const current = useConfigStore((s) => s.scene)

  useEffect(() => {
    useConfigStore.getState().setScene(sceneId)
    AudioBus.playAmbience(sceneId)
    return () => AudioBus.stopAmbience()
  }, [sceneId])

  const fov = useConfigStore((s) => s.configs[sceneId].camera.fov)
  const touch = isTouchMode()
  const freeFly = useDebugStore((s) => s.freeFly)
  // 移动端 pixelRatio 上限单独控制（完整质量档位见 M5 / spec §12）
  const pixelRatioMax = useConfigStore((s) =>
    touch ? s.configs[sceneId].mobile.pixelRatioMax : s.configs[sceneId].render.pixelRatioMax,
  )

  // 等 store 切到本场景后再挂载子组件（子组件通过 useSceneCfg 读当前场景）
  if (current !== sceneId) return null

  return (
    <div className="scene-root">
      <Canvas dpr={[1, pixelRatioMax]} camera={{ fov }} gl={{ antialias: true }}>
        <Suspense fallback={null}>
          {/* 渲染顺序：环境 → 地形 → 水面 → 粒子 → 角色 → 采集资产 → 后处理 */}
          <Atmosphere />
          <Terrain />
          <CollectZone />
          <CharacterController />
          {/* DEV 调试：自由飞行相机替代跟随相机 */}
          {freeFly ? <OrbitControls makeDefault /> : <FollowCamera />}
          <AssetFlow sceneId={sceneId} />
          <InputBinder />
          <RegisterCanvas />
          <RevealWhenReady />
        </Suspense>
        {TheatreSceneEditor && (
          <Suspense fallback={null}>
            <TheatreSceneEditor sceneId={sceneId} />
          </Suspense>
        )}
      </Canvas>
      <CollectPrompt sceneId={sceneId} />
      <AssetInfoCard />
      {touch && <TouchControls />}
      {TheatreSaveButton && (
        <Suspense fallback={null}>
          <TheatreSaveButton id={sceneId} />
        </Suspense>
      )}
    </div>
  )
}
