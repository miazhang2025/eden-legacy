import { useEffect, useMemo, type ReactElement } from 'react'
import { useThree } from '@react-three/fiber'
import {
  Bloom,
  BrightnessContrast,
  ChromaticAberration,
  DepthOfField,
  EffectComposer,
  HueSaturation,
  N8AO,
  Noise,
  ToneMapping,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction, Effect, ToneMappingMode } from 'postprocessing'
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
  ReinhardToneMapping,
  Vector2,
  type ColorSpace,
  type ToneMapping as ThreeToneMapping,
} from 'three'
import type { PostConfig } from '../config/schema'
import { isTouchMode } from '../input/useInput'
import { useSceneCfg } from '../state/useConfigStore'
import { useTier } from '../state/useQualityStore'

// 后处理（spec §9.3 Post-processing）。档位决定能开到哪一层（spec §12.1）：
//   basic：bloom + 调色；mid：+ vignette + grain；full：全部（含 DOF / 色差；SSAO 仍需单独打开，移动端强制关）

const PP_MODE: Record<PostConfig['toneMapping'], ToneMappingMode> = {
  aces: ToneMappingMode.ACES_FILMIC,
  agx: ToneMappingMode.AGX,
  neutral: ToneMappingMode.NEUTRAL,
  reinhard: ToneMappingMode.REINHARD,
  linear: ToneMappingMode.LINEAR,
}
const THREE_MODE: Record<PostConfig['toneMapping'], ThreeToneMapping> = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  reinhard: ReinhardToneMapping,
  linear: LinearToneMapping,
}

/**
 * 把负值截到 0。HueSaturation 提饱和度 / BrightnessContrast 提对比度都会把高饱和暗色（如深蓝岩石）的
 * 某些通道推成负数；EffectPass 在效果之间插入的 sRGB ↔ 线性转换里有 pow()，负数进去得到 NaN，
 * 画面上就是一块块纯黑。inputColorSpace = null：本效果不触发色彩空间转换，在哪个空间都能直接截。
 */
class ClampNegativeEffect extends Effect {
  constructor() {
    super(
      'ClampNegativeEffect',
      'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(max(inputColor.rgb, 0.0), inputColor.a); }',
    )
    this.inputColorSpace = null as unknown as ColorSpace
  }
}

/**
 * 输出 alpha 置 1。alpha-to-coverage 的植被（如蕨类）边缘会把 alpha < 1 写进 RT，
 * 一路传到 canvas（three 的 context 总是带 alpha），页面底色会从叶子边缘透出来。放在最后，合并进同一个 pass，几乎没开销。
 */
class OpaqueEffect extends Effect {
  constructor() {
    super('OpaqueEffect', 'void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(inputColor.rgb, 1.0); }')
    this.inputColorSpace = null as unknown as ColorSpace
  }
}

/** post 不传时用当前场景的配置（ending 页传自己的） */
export function PostFX({ post }: { post?: PostConfig }) {
  const scenePost = useSceneCfg((c) => c.post)
  const p = post ?? scenePost
  const tier = useTier()
  const gl = useThree((s) => s.gl)
  const clamps = useMemo(() => [new ClampNegativeEffect(), new ClampNegativeEffect()], [])
  useEffect(() => () => clamps.forEach((c) => c.dispose()), [clamps])
  const opaque = useMemo(() => new OpaqueEffect(), [])
  useEffect(() => () => opaque.dispose(), [opaque])

  // 不走后处理时由渲染器做色调映射；走后处理时由 ToneMapping effect 在最后做（渲染到 RT 时 three 不做色调映射）
  useEffect(() => {
    gl.toneMapping = THREE_MODE[p.toneMapping]
  }, [gl, p.toneMapping])

  if (!p.enabled) return null

  const level = tier.post
  const mid = level === 'mid' || level === 'full'
  const full = level === 'full'
  const fx: ReactElement[] = []

  if (full && p.ssao.enabled && !isTouchMode()) {
    fx.push(<N8AO key="ssao" intensity={p.ssao.intensity} aoRadius={p.ssao.radius} halfRes quality="performance" />)
  }
  if (full && p.dof.enabled) {
    fx.push(
      <DepthOfField
        key="dof"
        worldFocusDistance={p.dof.focusDistance}
        worldFocusRange={p.dof.focalLength}
        bokehScale={p.dof.bokehScale}
      />,
    )
  }
  if (p.bloom.enabled) {
    fx.push(
      <Bloom
        key="bloom"
        mipmapBlur
        intensity={p.bloom.intensity}
        luminanceThreshold={p.bloom.threshold}
        luminanceSmoothing={p.bloom.smoothing}
        radius={p.bloom.radius}
      />,
    )
  }
  if (p.grade.enabled) {
    fx.push(<HueSaturation key="hs" hue={p.grade.hue} saturation={p.grade.saturation} />)
    fx.push(<primitive key="clamp-hs" object={clamps[0]} />)
    fx.push(<BrightnessContrast key="bc" brightness={p.grade.brightness} contrast={p.grade.contrast} />)
    fx.push(<primitive key="clamp-bc" object={clamps[1]} />)
  }
  if (full && p.chromaticAberration.enabled) {
    const o = p.chromaticAberration.offset
    fx.push(<ChromaticAberration key="ca" offset={new Vector2(o, o)} radialModulation={false} modulationOffset={0} />)
  }
  fx.push(<ToneMapping key="tm" mode={PP_MODE[p.toneMapping]} />)
  if (mid && p.vignette.enabled) fx.push(<Vignette key="vig" offset={p.vignette.offset} darkness={p.vignette.darkness} />)
  if (mid && p.noise.enabled) {
    fx.push(<Noise key="noise" premultiply blendFunction={BlendFunction.SCREEN} opacity={p.noise.opacity} />)
  }
  if (tier.msaa > 0) fx.push(<primitive key="opaque" object={opaque} />)

  // 场景渲染到离屏 RT，canvas 的 antialias 管不到；几何抗锯齿靠 RT 的 MSAA（按档位，远处细小物体的锯齿主要来自这里）
  return <EffectComposer multisampling={tier.msaa}>{fx}</EffectComposer>
}
