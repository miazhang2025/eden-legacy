import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, BufferAttribute, NormalBlending, BufferGeometry, Color, CylinderGeometry, DoubleSide, ShaderMaterial, type Group, type Mesh } from 'three'
import { getSceneCfg } from '../state/useConfigStore'

// 已发现资产的标记：套在资产上的一根柔和竖直光柱（半透明彩色，边缘柔和、往上渐隐，有一道往上扫的亮带）+ 几颗上飘的光点，颜色取资产 glowColor。
// 第三人称机位很低，贴地光环会被压成一条线，所以用竖直的光柱。不打光，不影响周围环境的亮度。
// 位置由 CollectableAsset 逐帧写到 groupRef 上（贴地，不跟着资产浮动 / 旋转 / 缩放）。

const MOTES = 16

const beamVert = /* glsl */ `
varying float vH;
varying float vFacing;
void main() {
  vH = uv.y;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec3 v = normalize(cameraPosition - wp.xyz);
  // 水平方向的朝向：柱子正对镜头的中线最亮，两侧边缘淡出（体积感）
  vFacing = abs(dot(normalize(n.xz), normalize(v.xz + vec2(1e-5))));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const beamFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uLevel;
uniform float uTime;
uniform float uPulseSpeed;
varying float vH;
varying float vFacing;
void main() {
  // 插值可能让 vH 略超出 0–1，pow 负数会出 NaN（经过泛光会把整屏染黑），先钳住
  float h = clamp(vH, 0.0, 1.0);
  // 亮度集中在中线和边缘之间，中线（正压在资产上）留一点，资产能看清；最外缘柔和淡出
  float f = clamp(vFacing, 0.0, 1.0);
  float body = (0.3 + 0.7 * 4.0 * f * (1.0 - f)) * smoothstep(0.0, 0.4, f);
  float vertical = smoothstep(0.0, 0.08, h) * pow(1.0 - h, 1.6);
  // 往上扫的亮带
  float p = fract(uTime * uPulseSpeed);
  float d = (h - p) / 0.08;
  float sweep = exp(-d * d) * (1.0 - p);
  float a = clamp(body * (vertical * 0.55 + sweep * 0.6) * uLevel, 0.0, 1.0);
  gl_FragColor = vec4(uColor, a);
}
`

const moteVert = /* glsl */ `
attribute vec3 aSeed;
uniform float uTime;
uniform float uRadius;
uniform float uHeight;
uniform float uSize;
varying float vFade;
void main() {
  float h = fract(uTime * (0.12 + 0.1 * aSeed.z) + aSeed.z * 7.0);
  float ang = aSeed.x + h * 1.5;
  float rad = uRadius * (0.3 + 0.6 * aSeed.y);
  vec3 p = vec3(cos(ang) * rad, h * uHeight, sin(ang) * rad);
  vFade = sin(h * 3.14159);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (0.6 + 0.6 * aSeed.y) / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`

const moteFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uLevel;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.0, 1.0, d)) * vFade * uLevel;
  gl_FragColor = vec4(uColor, a);
}
`

export function FoundMarker({ color, level, groupRef }: { color: string; level: MutableRefObject<number>; groupRef: RefObject<Group> }) {
  const beamMesh = useRef<Mesh>(null)
  const beam = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: beamVert,
        fragmentShader: beamFrag,
        uniforms: { uColor: { value: new Color() }, uLevel: { value: 0 }, uTime: { value: 0 }, uPulseSpeed: { value: 0.5 } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        // 普通混合：是一层带颜色的半透明光，不往背景上加亮度（叠加发光在花园这种亮背景上会冲成白色）
        blending: NormalBlending,
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
          uHeight: { value: 1.5 },
          uSize: { value: 40 },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  )
  // 单位圆柱（半径 1、高 1、无盖），底面移到原点，按配置缩放
  const beamGeo = useMemo(() => new CylinderGeometry(1, 1, 1, 32, 1, true).translate(0, 0.5, 0), [])
  const moteGeo = useMemo(() => {
    const g = new BufferGeometry()
    const seed = new Float32Array(MOTES * 3)
    for (let i = 0; i < MOTES; i++) {
      seed[i * 3] = (i / MOTES) * Math.PI * 2 + Math.random() * 0.4
      seed[i * 3 + 1] = Math.random()
      seed[i * 3 + 2] = Math.random()
    }
    // 位置全在着色器里算，position 只占位
    g.setAttribute('position', new BufferAttribute(new Float32Array(MOTES * 3), 3))
    g.setAttribute('aSeed', new BufferAttribute(seed, 3))
    return g
  }, [])
  useEffect(
    () => () => {
      beam.dispose()
      beamGeo.dispose()
      motes.dispose()
      moteGeo.dispose()
    },
    [beam, beamGeo, motes, moteGeo],
  )

  useEffect(() => {
    beam.uniforms.uColor.value.set(color)
    motes.uniforms.uColor.value.set(color)
  }, [color, beam, motes])

  useFrame((state) => {
    const f = getSceneCfg().flow
    const t = state.clock.elapsedTime
    const l = level.current * f.foundMarkerOpacity
    beam.uniforms.uLevel.value = l
    beam.uniforms.uTime.value = t
    beam.uniforms.uPulseSpeed.value = f.foundMarkerPulseSpeed
    motes.uniforms.uLevel.value = l
    motes.uniforms.uTime.value = t
    motes.uniforms.uRadius.value = f.foundMarkerRadius
    motes.uniforms.uHeight.value = f.foundMarkerBeamHeight
    motes.uniforms.uSize.value = f.foundMarkerMoteSize * state.gl.getPixelRatio()
    if (groupRef.current) groupRef.current.visible = l > 0.001
    beamMesh.current?.scale.set(f.foundMarkerRadius, f.foundMarkerBeamHeight, f.foundMarkerRadius)
  })

  return (
    <group ref={groupRef}>
      <mesh ref={beamMesh} geometry={beamGeo} material={beam} renderOrder={2} />
      <points geometry={moteGeo} material={motes} frustumCulled={false} renderOrder={3} />
    </group>
  )
}
