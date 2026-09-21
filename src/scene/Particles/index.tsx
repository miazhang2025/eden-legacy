import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { InstancedBufferAttribute, InstancedBufferGeometry, MathUtils, PlaneGeometry, type Mesh } from 'three'
import type { ParticlePool as PoolConfig, SceneConfig, Vec3 } from '../../config/schema'
import { assetsForScene } from '../../data/assets'
import { assetTransform } from '../../state/useAssetOverrides'
import { getSceneCfg, useConfigStore, useSceneCfg } from '../../state/useConfigStore'
import { useFlowStore } from '../../state/useFlowStore'
import { useTier } from '../../state/useQualityStore'
import { groundHeightFromSky } from '../collision'
import { LAYER_PARTICLES, useModelEmitters } from '../envMaterials'
import { dampFactor, rig } from '../rig'
import { bakeCurves } from './curves'
import {
  APPEARANCES,
  EASINGS,
  MAX_EMITTERS,
  SHAPES,
  createParticleMaterial,
  createParticleUniforms,
  type ParticleUniforms,
} from './particleMaterial'

// 粒子系统入口（spec §5.3）：config.particles 里每个池 = 一个 draw call，多个发射点共享同一套 geometry / material。

interface Emitter {
  position: Vec3
  /** 分到的粒子比例权重 */
  weight: number
  delay: number
}

const ground = (x: number, z: number) => groundHeightFromSky(x, z) ?? 0

/** 按池的 role 求当前发射点（world 坐标） */
function resolveEmitters(pool: PoolConfig, cfg: SceneConfig, modelEmitters: Vec3[]): Emitter[] {
  const lift = cfg.flow.assetLift
  switch (pool.role) {
    case 'ambient':
      return pool.emitters.length
        ? pool.emitters.map((e) => ({ position: e.position, weight: Math.max(e.emitCount, 0), delay: e.delay }))
        : [{ position: [0, 0, 0], weight: 1, delay: 0 }]
    case 'beaconZone': {
      const [x, , z] = cfg.flow.zoneCenter
      return [{ position: [x, ground(x, z) + lift, z], weight: 1, delay: 0 }]
    }
    case 'beaconAsset':
    case 'burst':
      return assetsForScene(cfg.scene).map((a) => {
        const [x, dy, z] = assetTransform(a).position
        return { position: [x, ground(x, z) + dy + lift, z] as Vec3, weight: 1, delay: 0 }
      })
    case 'modelEmitters':
      return modelEmitters.map((position) => ({ position, weight: 1, delay: 0 }))
  }
}

/** 把粒子按权重随机分给各发射点（交错分配，截断 instanceCount 时各发射点按比例减少） */
function buildGeometry(max: number, weights: number[]) {
  const base = new PlaneGeometry(1, 1)
  const geo = new InstancedBufferGeometry()
  geo.index = base.index
  geo.setAttribute('position', base.getAttribute('position'))
  const seed = new Float32Array(max * 4)
  const emitter = new Float32Array(max)
  const phase = new Float32Array(max)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let acc = 0
  const cdf = weights.map((w) => (acc += w / total))
  for (let i = 0; i < max; i++) {
    seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4)
    const r = (i + Math.random()) / max
    emitter[i] = Math.max(0, cdf.findIndex((c) => r <= c + 1e-9))
    phase[i] = Math.random()
  }
  geo.setAttribute('aSeed', new InstancedBufferAttribute(seed, 4))
  geo.setAttribute('aEmitter', new InstancedBufferAttribute(emitter, 1))
  geo.setAttribute('aPhase', new InstancedBufferAttribute(phase, 1))
  geo.instanceCount = max
  return geo
}

function pushParams(u: ParticleUniforms, p: PoolConfig) {
  u.uLifetime.value.set(...p.lifetime)
  u.uSpeed.value.set(...p.speed)
  u.uDir.value.set(...p.emitterDirection)
  u.uSpread.value = p.directionSpread
  u.uGravity.value.set(...p.gravity)
  u.uFriction.value = p.friction.intensity
  u.uFrictionEase.value = EASINGS[p.friction.easing]
  u.uTurb.value.set(p.turbulence.intensity, p.turbulence.frequency, p.turbulence.speed)
  u.uSize.value.set(...p.size)
  u.uColorStart.value.set(p.colorStart)
  u.uColorEnd.value.set(p.colorEnd)
  u.uIntensity.value = p.intensity
  u.uShape.value = SHAPES[p.emitterShape]
  u.uRadius.value = p.emitterRadius
  u.uBoxSize.value.set(...p.emitterSize)
  u.uAngle.value = p.emitterAngle
  u.uHeight.value = p.emitterHeight
  u.uSurfaceOnly.value = p.emitterSurfaceOnly ? 1 : 0
  u.uStartPosAsDir.value = p.startPositionAsDirection ? 1 : 0
  u.uRotation.value.set(...p.rotation)
  u.uRotSpeed.value.set(...p.rotationSpeed)
  u.uSoftDistance.value = p.softDistance
  u.uGroundFade.value = p.groundFade
  u.uFollowCamera.value = p.followCamera ? 1 : 0
  u.uAppearance.value = APPEARANCES[p.appearance]
  u.uBurst.value = p.role === 'burst' ? 1 : 0
}

/** 引导发光粒子的目标强度（spec §5.1）：远处亮、走近变弱；进入采集区后区域光团减弱、资产光团点亮 */
function beaconTarget(pool: PoolConfig, cfg: SceneConfig, pos: Vec3): number {
  const b = cfg.beacon
  const phase = useFlowStore.getState().phase
  const d = Math.hypot(pos[0] - rig.position.x, pos[2] - rig.position.z)
  const k = MathUtils.smoothstep(d, b.falloffNear, b.falloffFar)
  if (pool.role === 'beaconZone') {
    if (phase === 'IDLE') return MathUtils.lerp(b.zoneNearIntensity, b.zoneFarIntensity, k)
    if (phase === 'PROMPTED' || phase === 'INSPECTING') return b.zoneInsideIntensity
    return 0
  }
  // beaconAsset：进入采集区后才点亮，确认后熄灭（burst 接手）
  if (phase !== 'PROMPTED' && phase !== 'INSPECTING') return 0
  return MathUtils.lerp(b.assetNearIntensity, b.assetFarIntensity, k)
}

function Pool({ index }: { index: number }) {
  const pool = useSceneCfg((c) => c.particles[index])
  const modelEmitters = useModelEmitters((s) => s.positions)
  const tier = useTier()
  const mesh = useRef<Mesh | null>(null)
  const current = useRef<number[]>(new Array(MAX_EMITTERS).fill(0))
  const lastBurst = useRef(0)

  const cfg = useConfigStore.getState().configs[useConfigStore.getState().scene]
  const emitters = resolveEmitters(pool, cfg, modelEmitters).slice(0, MAX_EMITTERS)
  const weightsKey = emitters.map((e) => e.weight).join(',')

  const uniforms = useMemo(createParticleUniforms, [])
  const geometry = useMemo(
    () => buildGeometry(pool.maxParticles, weightsKey.split(',').map(Number)),
    [pool.maxParticles, weightsKey],
  )
  const material = useMemo(
    () => createParticleMaterial(uniforms, pool.blending === 'additive', pool.depthTest),
    [uniforms, pool.blending, pool.depthTest],
  )
  const curves = useMemo(
    () => bakeCurves(pool.fadeSizeCurve, pool.fadeOpacityCurve, pool.velocityCurve),
    // 曲线按值比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool.fadeSizeCurve.join(), pool.fadeOpacityCurve.join(), pool.velocityCurve.join()],
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => curves.dispose(), [curves])

  useFrame((_, dt) => {
    const c = getSceneCfg()
    const p = c.particles[index]
    if (!p) return
    const u = uniforms
    pushParams(u, p)
    u.uCurves.value = curves
    geometry.instanceCount = Math.floor(p.maxParticles * tier.particles)

    const list = resolveEmitters(p, c, useModelEmitters.getState().positions).slice(0, MAX_EMITTERS)
    const flow = useFlowStore.getState()
    list.forEach((e, i) => {
      u.uEmitterPos.value[i].set(...e.position)
      u.uEmitterDelay.value[i] = e.delay
      u.uEmitterGround.value[i] = p.followCamera ? -1e4 : ground(e.position[0], e.position[2])
      let target = 1
      if (p.role === 'beaconZone' || p.role === 'beaconAsset') target = beaconTarget(p, c, e.position)
      if (p.role === 'burst') {
        // 只在被确认的那个资产位置爆发
        const confirmed = assetsForScene(c.scene).findIndex((a) => a.id === flow.assetId)
        target = flow.phase !== 'IDLE' && i === confirmed ? 1 : 0
      }
      current.current[i] = MathUtils.lerp(current.current[i], target, dampFactor(0.4, dt))
      if (p.role === 'burst') current.current[i] = target
      u.uEmitterIntensity.value[i] = current.current[i]
    })
    for (let i = list.length; i < MAX_EMITTERS; i++) u.uEmitterIntensity.value[i] = 0

    // 采集确认：记录爆发起点（spec §5.3B）
    if (p.role === 'burst' && flow.phase === 'CONFIRMED' && flow.confirmedAt !== lastBurst.current) {
      lastBurst.current = flow.confirmedAt
      u.uBurstStart.value = u.uTime.value
    }
    if (mesh.current) mesh.current.renderOrder = p.renderOrder
  })

  if (!pool.enabled || emitters.length === 0) return null
  return (
    <mesh
      ref={(m) => {
        mesh.current = m
        // 粒子放在单独图层：主相机可见，实时反射不渲染
        m?.layers.set(LAYER_PARTICLES)
      }}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={pool.renderOrder}
    />
  )
}

export function Particles() {
  const count = useSceneCfg((c) => c.particles.length)
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Pool key={i} index={i} />
      ))}
    </>
  )
}
