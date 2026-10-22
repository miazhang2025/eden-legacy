import { useEffect, useMemo, type MutableRefObject, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Color, NormalBlending, PlaneGeometry, ShaderMaterial, type Group } from 'three'
import { getSceneCfg } from '../state/useConfigStore'

// 已发现资产的标记，颜色取资产 glowColor（光晕在着色器里再提一点饱和度，浅色资产也看得出颜色；光点用原色）：
//   光晕：资产身后一团柔和的彩色径向光，往远离镜头的方向推开一点，资产整个在它前面，不会被切开 / 盖住
//   光点：从资产中心向四周慢慢飘散的柔光圆点（散景光斑），飘远淡出、循环出现
// 都用普通半透明混合（不叠加发光），亮背景上不会过曝成白色；不打光，不影响周围环境的亮度。
// 位置由 CollectableAsset 逐帧写到 groupRef 上（资产中心，不跟着浮动 / 旋转 / 缩放）。

const COUNT = 48

const saturate = /* glsl */ `
vec3 edenSaturate(vec3 c, float s) {
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  return clamp(mix(vec3(l), c, s), 0.0, 1.0);
}
`

const haloVert = /* glsl */ `
uniform float uSize;
uniform float uPush;
varying vec2 vUv;
void main() {
  vUv = uv;
  // 广告牌：中心在资产中心，沿视线往后推 uPush，四个角在视图空间里展开
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xyz += normalize(mv.xyz) * uPush;
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`

const haloFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uLevel;
uniform float uSat;
uniform float uTime;
varying vec2 vUv;
${saturate}
void main() {
  float d = length(vUv * 2.0 - 1.0);
  if (d > 1.0) discard;
  // 高斯式衰减，边缘完全化开；轻微呼吸
  float a = exp(-d * d * 4.0) * (1.0 - smoothstep(0.8, 1.0, d));
  a *= 0.85 + 0.15 * sin(uTime * 1.6);
  gl_FragColor = vec4(edenSaturate(uColor, uSat), clamp(a * uLevel, 0.0, 1.0));
}
`

const moteVert = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uRadius;
uniform float uSpeed;
uniform float uSize;
varying float vFade;
void main() {
  // aSeed.xyz：单位球面上的发散方向；aSeed.w：相位 / 速度 / 大小的随机数
  float t = fract(uTime * uSpeed * (0.75 + 0.5 * aSeed.w) + aSeed.w * 13.0);
  // 先快后慢地往外飘，带一点上浮
  float d = 1.0 - (1.0 - t) * (1.0 - t);
  vec3 p = aSeed.xyz * d * uRadius;
  p.y += t * t * 0.25 * uRadius;
  // 刚冒出来和飘到最远时都淡掉
  vFade = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.55, 1.0, t));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (0.5 + 0.7 * fract(aSeed.w * 7.0)) * (0.7 + 0.5 * t) / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`

const moteFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uLevel;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  // 柔和的圆盘：中间实、边缘慢慢化开
  float a = (1.0 - smoothstep(0.4, 1.0, d)) * 0.8 + (1.0 - d) * (1.0 - d) * 0.2;
  gl_FragColor = vec4(uColor, clamp(a * vFade * uLevel, 0.0, 1.0));
}
`

const shared = { transparent: true, depthWrite: false, blending: NormalBlending }

export function FoundMarker({ color, level, groupRef }: { color: string; level: MutableRefObject<number>; groupRef: RefObject<Group> }) {
  const halo = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: haloVert,
        fragmentShader: haloFrag,
        uniforms: {
          uColor: { value: new Color() },
          uLevel: { value: 0 },
          uSat: { value: 1.5 },
          uTime: { value: 0 },
          uSize: { value: 1 },
          uPush: { value: 0.5 },
        },
        ...shared,
      }),
    [],
  )
  const motes = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: moteVert,
        fragmentShader: moteFrag,
        uniforms: {
          uColor: { value: new Color() },
          uLevel: { value: 0 },
          uTime: { value: 0 },
          uRadius: { value: 1 },
          uSpeed: { value: 0.3 },
          uSize: { value: 60 },
        },
        ...shared,
      }),
    [],
  )
  const haloGeo = useMemo(() => new PlaneGeometry(1, 1), [])
  const moteGeo = useMemo(() => {
    const g = new BufferGeometry()
    const seed = new Float32Array(COUNT * 4)
    for (let i = 0; i < COUNT; i++) {
      // 球面上均匀取方向（斐波那契球 + 一点抖动），粒子不会挤成一团
      const y = 1 - ((i + 0.5) / COUNT) * 2
      const r = Math.sqrt(1 - y * y)
      const a = i * 2.39996 + Math.random() * 0.5
      seed[i * 4] = Math.cos(a) * r
      seed[i * 4 + 1] = y
      seed[i * 4 + 2] = Math.sin(a) * r
      seed[i * 4 + 3] = Math.random()
    }
    // 位置全在着色器里算，position 只占位
    g.setAttribute('position', new BufferAttribute(new Float32Array(COUNT * 3), 3))
    g.setAttribute('aSeed', new BufferAttribute(seed, 4))
    return g
  }, [])
  useEffect(
    () => () => {
      halo.dispose()
      motes.dispose()
      haloGeo.dispose()
      moteGeo.dispose()
    },
    [halo, motes, haloGeo, moteGeo],
  )

  useEffect(() => {
    halo.uniforms.uColor.value.set(color)
    motes.uniforms.uColor.value.set(color)
  }, [color, halo, motes])

  useFrame((state) => {
    const f = getSceneCfg().flow
    const l = level.current
    const t = state.clock.elapsedTime
    const h = halo.uniforms
    h.uLevel.value = l * f.foundMarkerHaloOpacity
    h.uSat.value = f.foundMarkerSaturation
    h.uTime.value = t
    h.uSize.value = f.foundMarkerHaloSize
    h.uPush.value = f.foundMarkerHaloSize * 0.35
    const m = motes.uniforms
    m.uLevel.value = l * f.foundMarkerOpacity
    m.uTime.value = t
    m.uRadius.value = f.foundMarkerRadius
    m.uSpeed.value = f.foundMarkerSpeed
    m.uSize.value = f.foundMarkerSize * state.gl.getPixelRatio()
    if (groupRef.current) groupRef.current.visible = l > 0.001
  })

  return (
    <group ref={groupRef}>
      <mesh geometry={haloGeo} material={halo} frustumCulled={false} renderOrder={2} />
      <points geometry={moteGeo} material={motes} frustumCulled={false} renderOrder={3} />
    </group>
  )
}
