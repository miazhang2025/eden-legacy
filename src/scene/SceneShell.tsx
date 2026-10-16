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
import { SharedUniformDriver } from '../materials/uniforms'
import { FrameGuard, useTier } from '../state/useQualityStore'
import { LAYER_PARTICLES, LAYER_VEGETATION } from './envMaterials'
import { Lighting } from './Lighting'
import { Grass } from './Grass'
import { Particles } from './Particles'
import { Sky } from './Sky'
import { PostFX } from './PostFX'
import { Water } from './Water'
import { AssetInfoCard } from '../ui/AssetInfoCard'
import { CollectPrompt } from '../ui/CollectPrompt'
import { useTransition } from '../ui/Transition'
import { AssetFlow } from './AssetFlow'
import { CharacterController } from './CharacterController'
import { ColliderModel, EnvModel } from './EnvModel'
import { FollowCamera } from './FollowCamera'
import { BoundaryField, GeneratedTerrain, Scatter } from './GeneratedTerrain'

/** 等几帧（R3F 每帧渲染一次） */
const nextFrames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step))
    requestAnimationFrame(step)
  })

/**
 * Suspense 内的内容全部就绪后才挂载。揭开前还在遮罩下面做两件事，免得渐入时卡顿（看起来像黑屏直接切进来）：
 *   1. 异步编译所有着色器（KHR_parallel_shader_compile，不阻塞主线程）
 *   2. 再渲染几帧：贴图上传、阴影图、实时反射、水深烘焙等第一次的开销都在这里付掉
 */
function RevealWhenReady() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        await gl.compileAsync(scene, camera)
      } catch {
        /* 不支持异步编译时直接在首帧编译 */
      }
      await nextFrames(REVEAL_WARMUP_FRAMES)
      if (alive) useTransition.getState().reveal()
    })()
    return () => {
      alive = false
    }
    // 只在挂载时做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

/** 揭开前预热渲染的帧数 */
const REVEAL_WARMUP_FRAMES = 4

/** 背景 / 雾 / 曝光（灯光与环境光见 Lighting.tsx） */
function Atmosphere() {
  const background = useSceneCfg((c) => c.background)
  const fog = useSceneCfg((c) => c.fog)
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
    </>
  )
}

/**
 * 环境模型 + 碰撞体；env.model 为空时回落到色块地面。
 * 生成地形开启时：原模型照常加载（被替换的地形材质隐藏），碰撞体换成生成地形的，并加载可玩区软边界。
 */
function Terrain() {
  const env = useSceneCfg((c) => c.env)
  const terrain = useSceneCfg((c) => c.terrain)
  if (!env.model) return <PlaceholderGround />
  const extras = (env.extras ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const extraColliders = (env.extraColliders ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const generated = terrain.enabled && terrain.model !== ''
  const collider = generated ? terrain.collider : env.collider
  return (
    <>
      {/* key：叠加模型变了就重新挂载（材质要重新收集） */}
      <EnvModel key={extras.join(',')} path={env.model} extras={extras} />
      {generated && <GeneratedTerrain path={terrain.model} />}
      {generated && terrain.scatter.enabled && terrain.scatter.model && <Scatter path={terrain.scatter.model} />}
      {generated && terrain.boundary.enabled && terrain.boundary.map && <BoundaryField map={terrain.boundary.map} />}
      {/* key：切换碰撞体时重新挂载，旧碰撞体先注销 */}
      {collider && <ColliderModel key={collider} path={collider} />}
      {extraColliders.map((p) => (
        <ColliderModel key={p} path={p} extra />
      ))}
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
  // 遮罩揭开时画面从轻微模糊、放大、偏亮慢慢清晰（styles.css 的 scene-in），不是从黑屏硬切进来
  const revealed = useTransition((s) => !s.covered)

  useEffect(() => {
    useConfigStore.getState().setScene(sceneId)
    AudioBus.playAmbience(sceneId)
    return () => AudioBus.stopAmbience()
  }, [sceneId])

  const fov = useConfigStore((s) => s.configs[sceneId].camera.fov)
  const touch = isTouchMode()
  const freeFly = useDebugStore((s) => s.freeFly)
  const tier = useTier()
  // pixelRatio 上限：取质量档位与场景 config（桌面 render / 移动端 mobile）中较小的（spec §12.1）
  const configMax = useConfigStore((s) =>
    touch ? s.configs[sceneId].mobile.pixelRatioMax : s.configs[sceneId].render.pixelRatioMax,
  )
  const pixelRatioMax = Math.min(configMax, tier.pixelRatioMax)

  // 等 store 切到本场景后再挂载子组件（子组件通过 useSceneCfg 读当前场景）
  if (current !== sceneId) return null

  return (
    <div className={`scene-root ${revealed ? 'is-revealed' : ''}`}>
      <Canvas
        dpr={[1, pixelRatioMax]}
        camera={{ fov }}
        // 场景都开后处理，抗锯齿在 EffectComposer 的离屏 RT 上做（PostFX 按档位设 MSAA），canvas 自带的多重采样白占显存
        gl={{ antialias: false }}
        shadows
        onCreated={({ camera }) => {
          // 主相机看得到植被层与粒子层（实时反射相机默认只看地形层）
          camera.layers.enable(LAYER_VEGETATION)
          camera.layers.enable(LAYER_PARTICLES)
        }}
      >
        <Suspense fallback={null}>
          {/* 渲染顺序：环境 → 地形 → 水面 → 粒子 → 角色 → 采集资产 → 后处理 */}
          <SharedUniformDriver />
          <Atmosphere />
          <Sky />
          <Lighting />
          <Terrain />
          <Grass />
          <Water />
          <Particles />
          <CharacterController />
          {/* DEV 调试：自由飞行相机替代跟随相机 */}
          {freeFly ? <OrbitControls makeDefault /> : <FollowCamera />}
          <AssetFlow sceneId={sceneId} />
          <InputBinder />
          <RegisterCanvas />
          <FrameGuard />
          <PostFX />
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
