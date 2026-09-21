import { useEffect, type ReactElement } from 'react'
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
import { BlendFunction, ToneMappingMode } from 'postprocessing'
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
  ReinhardToneMapping,
  Vector2,
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

/** post 不传时用当前场景的配置（ending 页传自己的） */
export function PostFX({ post }: { post?: PostConfig }) {
  const scenePost = useSceneCfg((c) => c.post)
  const p = post ?? scenePost
  const tier = useTier()
  const gl = useThree((s) => s.gl)

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
    fx.push(<BrightnessContrast key="bc" brightness={p.grade.brightness} contrast={p.grade.contrast} />)
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

  return <EffectComposer multisampling={0}>{fx}</EffectComposer>
}
