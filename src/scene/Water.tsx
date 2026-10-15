import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { Matrix4, Mesh, PlaneGeometry, Vector3, type BufferGeometry } from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { waterOn } from '../config/schema'
import { isTouchMode } from '../input/useInput'
import { MAX_DEPTH, bakeDepthMap, createWaterMaterial, createWaterUniforms } from '../materials/WaterMaterial'
import { getSceneCfg, useSceneCfg } from '../state/useConfigStore'
import { capQuality, useTier } from '../state/useQualityStore'
import { getWaterBedVersion, hasCollider, setWalkPlane } from './collision'
import { url, useEnvTransform } from './EnvModel'
import { LAYER_VEGETATION } from './envMaterials'

const DEG = Math.PI / 180
/** 水深图在场景边界外多烘几米（边界外远处的水看不清，按深水处理） */
const DEPTH_PAD = 4
const reflMatrix = new Matrix4()
const inverse = new Matrix4()
const local = new Vector3()

// 水面（spec §5.2C）。三个场景都可以有，由各自 config 的 water.enabled 控制（生成地形接管水面时见 waterOn）。
// 两种形态：
//   - 方形平面（water.mesh 为空）：center / size / level 摆放，水深来自碰撞体烘的高度图（ocean）
//   - 网格水面（water.mesh）：npm run terrain 生成的池塘形状，高度跟着原池面走（可以有多级），
//     套 env 变换，水深来自顶点属性 _depth（garden）
export function Water() {
  const enabled = useSceneCfg(waterOn)
  const walkable = useSceneCfg((c) => c.water.walkable)
  const level = useSceneCfg((c) => c.water.level)
  const meshPath = useSceneCfg((c) => c.water.mesh)
  // 走水：水面作为可站立的地面（spec §15-B 决定：ocean 浮岛之间可以走水）
  useEffect(() => {
    setWalkPlane(enabled && walkable ? level : null)
    return () => setWalkPlane(null)
  }, [enabled, walkable, level])
  if (!enabled) return null
  return meshPath ? <MeshWater path={meshPath} /> : <PlaneWater />
}

function PlaneWater() {
  const w = useSceneCfg((c) => c.water)
  const tier = useTier()
  const quality = capQuality(w.quality, tier.water)
  // 波浪需要足够的顶点；low 档减半
  const segments = Math.max(1, Math.round(w.segments * (quality === 'low' ? 0.5 : 1)))
  const geometry = useMemo(() => new PlaneGeometry(1, 1, segments, segments), [segments])
  useEffect(() => () => geometry.dispose(), [geometry])
  const { mesh, material } = useWaterSurface(false)
  const [cx, , cz] = w.center
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

function MeshWater({ path }: { path: string }) {
  const { scene } = useGLTF(url(path))
  const geometry = useMemo(() => {
    let g: BufferGeometry | null = null
    scene.traverse((o) => {
      if (o instanceof Mesh && !g) g = o.geometry as BufferGeometry
    })
    return g as BufferGeometry | null
  }, [scene])
  const t = useEnvTransform()
  // 多级水面：实时反射平面跟着离相机最近的那片水走（反射相机会裁掉平面以下的东西，
  // 平面放在高处时，低处水面的岸全被裁掉，只剩天空）。水面顶点稀疏取样，每帧找最近的一个。
  const samples = useMemo(() => {
    if (!geometry) return new Float32Array(0)
    const p = geometry.getAttribute('position')
    const step = Math.max(1, Math.floor(p.count / 800))
    const out: number[] = []
    for (let i = 0; i < p.count; i += step) out.push(p.getX(i), p.getY(i), p.getZ(i))
    return new Float32Array(out)
  }, [geometry])
  const { mesh, material } = useWaterSurface(true, (camera) => {
    const m = mesh.current
    if (!m || !samples.length) return null
    // 相机转到水面网格本地坐标里比较，结果再转回世界高度
    local.copy(camera).applyMatrix4(inverse.copy(m.matrixWorld).invert())
    let best = Infinity
    let y = 0
    for (let i = 0; i < samples.length; i += 3) {
      const d = (samples[i] - local.x) ** 2 + (samples[i + 2] - local.z) ** 2
      if (d < best) {
        best = d
        y = samples[i + 1]
      }
    }
    return local.set(samples[0], y, samples[2]).applyMatrix4(m.matrixWorld).y
  })
  if (!geometry) return null
  return (
    <group {...t}>
      <mesh ref={mesh} geometry={geometry} material={material} receiveShadow renderOrder={1} />
    </group>
  )
}

/**
 * 水面材质 + 实时反射 + 每帧同步 config（两种形态共用）。
 * reflectionLevel：给定相机位置返回反射平面的世界高度（多级水面用），null / 不传 = water.level。
 */
function useWaterSurface(vertexDepth: boolean, reflectionLevel?: (camera: Vector3) => number | null) {
  const w = useSceneCfg((c) => c.water)
  const tier = useTier()
  const quality = capQuality(w.quality, tier.water)
  const scene = useThree((s) => s.scene)
  const mesh = useRef<Mesh>(null)
  const planeY = useRef(NaN)

  const uniforms = useMemo(createWaterUniforms, [])
  const material = useMemo(() => createWaterMaterial(uniforms), [uniforms])
  useEffect(() => () => material.dispose(), [material])

  // 水深图（只有方形平面用）：碰撞体就绪后烘一次，只烘水面与场景边界（外扩一点）的交集；范围 / 高度变化时重烘
  const [colliderReady, setColliderReady] = useState(hasCollider)
  // 水底 mesh（渲染模型的地形）登记 / 变化时重烘
  const [bedVersion, setBedVersion] = useState(getWaterBedVersion)
  const [cx, , cz] = w.center
  const [bx0, , bz0] = useSceneCfg((c) => c.bounds.min)
  const [bx1, , bz1] = useSceneCfg((c) => c.bounds.max)
  const depthMap = useMemo(() => {
    if (vertexDepth || !colliderReady) return null
    const half = w.size / 2
    const x0 = Math.max(cx - half, bx0 - DEPTH_PAD)
    const x1 = Math.min(cx + half, bx1 + DEPTH_PAD)
    const z0 = Math.max(cz - half, bz0 - DEPTH_PAD)
    const z1 = Math.min(cz + half, bz1 + DEPTH_PAD)
    if (x1 <= x0 || z1 <= z0) return null
    return bakeDepthMap(w.level, [x0, z0, x1 - x0, z1 - z0])
  }, [vertexDepth, colliderReady, bedVersion, w.level, cx, cz, w.size, bx0, bz0, bx1, bz1])
  useEffect(() => () => depthMap?.texture.dispose(), [depthMap])
  const hasDepth = vertexDepth || depthMap !== null

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
    // 反射平面：水位高度的水平面（网格水面有多级时，其它级的反射会略有偏差）
    r.rotation.set(-Math.PI / 2, 0, 0)
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

  useFrame((state, dt) => {
    if (!colliderReady && hasCollider()) setColliderReady(true)
    if (bedVersion !== getWaterBedVersion()) setBedVersion(getWaterBedVersion())
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
    u.uShoreFade.value = hasDepth ? c.shoreFade : 0
    u.uOpacity.value = c.opacity
    u.uUseVertexDepth.value = vertexDepth ? 1 : 0
    u.uUseDepthColor.value = quality !== 'low' && hasDepth ? 1 : 0
    u.uUseFoam.value = quality === 'high' && hasDepth ? 1 : 0
    u.uDepthMap.value = depthMap?.texture ?? null
    if (depthMap) u.uDepthBounds.value.set(...depthMap.bounds)
    u.uMaxDepth.value = MAX_DEPTH
    u.uWaveAmp.value = c.waveAmplitude
    u.uWaveLen.value = c.waveLength
    u.uWaveSpeed.value = c.waveSpeed
    u.uWaveSteep.value = c.waveSteepness
    material.roughness = c.roughness
    // 环境反射也随 reflectionIntensity 缩放（没有海底的开放水面，全强度反射会把远处水面冲成天空色）
    material.envMapIntensity = c.reflectionIntensity

    const m = mesh.current
    if (reflector && m) {
      // 反射平面高度：多级水面时平滑地跟到最近那片水（瞬间跳变会让反射闪一下）
      const target = reflectionLevel?.(state.camera.position) ?? c.level
      const y = Number.isFinite(planeY.current) ? planeY.current + (target - planeY.current) * Math.min(1, dt * 3) : target
      planeY.current = y
      reflector.position.set(0, y, 0)
      reflector.updateMatrixWorld()
      // 渲染反射时把水面自己藏起来
      m.visible = false
      reflector.onBeforeRender(state.gl, scene, state.camera, undefined as never, undefined as never, undefined as never)
      reflector.visible = false
      m.visible = true
      u.uReflectionMap.value = reflector.getRenderTarget().texture
      // textureMatrix 作用于 Reflector 本地坐标；水面网格本地 → 世界 → Reflector 本地
      const texMatrix = (reflector.material as unknown as { uniforms: { textureMatrix: { value: Matrix4 } } }).uniforms
        .textureMatrix.value
      reflMatrix.copy(reflector.matrixWorld).invert().multiply(m.matrixWorld)
      u.uReflectionMatrix.value.multiplyMatrices(texMatrix, reflMatrix)
      u.uUseReflection.value = 1
    } else {
      u.uUseReflection.value = 0
    }
  })

  return { mesh, material }
}
