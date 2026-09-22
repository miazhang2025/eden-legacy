import { Color, Vector2, type Material } from 'three'
import type { SceneConfig } from '../config/schema'
import noise from './chunks/noise.glsl?raw'
import { terrainGlobals } from './terrainGlobals'
import { shared } from './uniforms'

// 贴图池塘的水面 shader（spec §15-H 决定：garden 的池塘是画在地形贴图上的，用 shader 在地形材质上做水）。
// 按「与池塘颜色的距离」生成遮罩，遮罩内：叠流动波纹法线、压低粗糙度 / 去金属度（环境反射随之出现）、
// 往水色偏、掠射角叠天空色。与 caustics.ts 的补丁串在同一条 onBeforeCompile 链上。

export const pondUniforms = {
  uPondEnabled: { value: 0 },
  /** 池塘在贴图里的颜色（sRGB 分量，与贴图解码后转回 sRGB 的值比较） */
  uPondMaskColor: { value: new Color() },
  uPondTolerance: { value: 0.12 },
  uPondSoftness: { value: 0.06 },
  uPondLevel: { value: 0 },
  uPondLevelTol: { value: 0.4 },
  uPondDarkCut: { value: 0.06 },
  uPondColor: { value: new Color() },
  uPondTint: { value: 0.6 },
  uPondRoughness: { value: 0.05 },
  uPondNormalScale: { value: 1.5 },
  uPondNormalStrength: { value: 0.3 },
  uPondFlow: { value: new Vector2(1, 0) },
  /** 细涟漪层：比主流动更小更快，水面才看得出在动 */
  uPondRippleScale: { value: 6 },
  uPondRippleSpeed: { value: 0.6 },
  uPondRippleStrength: { value: 0.5 },
  /** 缓慢起伏：整片水面法线强度随时间呼吸，模拟风掠过 */
  uPondSwell: { value: 0.35 },
  uPondSwellSpeed: { value: 0.25 },
  uPondSkyColor: { value: new Color() },
  uPondFresnelPower: { value: 4 },
  uPondReflection: { value: 0.6 },
}

const DEG = Math.PI / 180

export function updatePondUniforms(cfg: SceneConfig) {
  const p = cfg.pond
  const u = pondUniforms
  u.uPondEnabled.value = p.enabled ? 1 : 0
  // 遮罩色按 sRGB 分量比较（Color.set 会转成线性，这里转回来）
  u.uPondMaskColor.value.set(p.maskColor).convertLinearToSRGB()
  u.uPondTolerance.value = p.tolerance
  u.uPondSoftness.value = p.softness
  u.uPondLevel.value = p.level
  u.uPondLevelTol.value = p.levelTolerance
  u.uPondDarkCut.value = p.darkCut
  u.uPondColor.value.set(p.color)
  u.uPondTint.value = p.tint
  u.uPondRoughness.value = p.roughness
  u.uPondNormalScale.value = p.normalScale
  u.uPondNormalStrength.value = p.normalStrength
  u.uPondFlow.value.set(Math.cos(p.flowDirectionDeg * DEG), Math.sin(p.flowDirectionDeg * DEG)).multiplyScalar(p.flowSpeed)
  u.uPondRippleScale.value = p.rippleScale
  u.uPondRippleSpeed.value = p.rippleSpeed
  u.uPondRippleStrength.value = p.rippleStrength
  u.uPondSwell.value = p.swell
  u.uPondSwellSpeed.value = p.swellSpeed
  u.uPondSkyColor.value.set(cfg.sky.horizonColor)
  u.uPondFresnelPower.value = p.fresnelPower
  u.uPondReflection.value = p.reflection
}

const PATCHED = Symbol('eden-pond')

const header = /* glsl */ `
uniform float uTime;
uniform float uPondEnabled;
uniform vec3 uPondMaskColor;
uniform float uPondTolerance;
uniform float uPondSoftness;
uniform float uPondLevel;
uniform float uPondLevelTol;
uniform float uPondDarkCut;
uniform vec3 uPondColor;
uniform float uPondTint;
uniform float uPondRoughness;
uniform float uPondNormalScale;
uniform float uPondNormalStrength;
uniform vec2 uPondFlow;
uniform float uPondRippleScale;
uniform float uPondRippleSpeed;
uniform float uPondRippleStrength;
uniform float uPondSwell;
uniform float uPondSwellSpeed;
uniform vec3 uPondSkyColor;
uniform float uPondFresnelPower;
uniform float uPondReflection;
varying vec3 vEdenPondPos;
`

export function patchPond(material: Material) {
  const m = material as Material & { [PATCHED]?: true }
  if (m[PATCHED]) return
  m[PATCHED] = true
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer)
    Object.assign(shader.uniforms, pondUniforms, { uTime: shared.uTime })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEdenPondPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvEdenPondPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    // uTime 可能已被焦散补丁声明，去掉本补丁的重复声明
    const needTime = !shader.fragmentShader.includes('uniform float uTime;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${(needTime ? header : header.replace('uniform float uTime;', ''))}\n${
          terrainGlobals(shader.fragmentShader)
        }\n${shader.fragmentShader.includes('float edenNoise(') ? '' : noise}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        if (uPondEnabled > 0.5) {
          vec3 srgb = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
          // 颜色：接近池塘色，或者足够暗（池塘深处在贴图里是纯黑）
          float dist = distance(srgb, uPondMaskColor);
          float byColor = 1.0 - smoothstep(uPondTolerance - uPondSoftness, uPondTolerance + uPondSoftness, dist);
          float lum = dot(srgb, vec3(0.3, 0.59, 0.11));
          float byDark = 1.0 - smoothstep(uPondDarkCut, uPondDarkCut * 2.0, lum);
          // 高度带：池塘是一块平面，只有这个高度附近才可能是水（避免阴影里的暗像素被误判）
          float byHeight = 1.0 - smoothstep(uPondLevelTol, uPondLevelTol * 1.6, abs(vEdenPondPos.y - uPondLevel));
          edenPondMask = max(byColor, byDark) * byHeight;
          diffuseColor.rgb = mix(diffuseColor.rgb, uPondColor, edenPondMask * uPondTint);
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, uPondRoughness, edenPondMask);',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, edenPondMask);',
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        if (edenPondMask > 0.001) {
          vec2 p = vEdenPondPos.xz * uPondNormalScale;
          vec2 f = uPondFlow * uTime;
          float e = 0.12;
          // 主流动：两层大尺度噪声，方向相反，形成缓慢推移的起伏
          float hx = edenNoise(p + vec2(e, 0.0) + f) - edenNoise(p - vec2(e, 0.0) + f)
                   + 0.5 * (edenNoise(p * 2.3 + vec2(e, 0.0) - f) - edenNoise(p * 2.3 - vec2(e, 0.0) - f));
          float hz = edenNoise(p + vec2(0.0, e) + f) - edenNoise(p - vec2(0.0, e) + f)
                   + 0.5 * (edenNoise(p * 2.3 + vec2(0.0, e) - f) - edenNoise(p * 2.3 - vec2(0.0, e) - f));
          // 细涟漪：小尺度、更快，斜着穿过主流动方向
          vec2 rp = vEdenPondPos.xz * uPondNormalScale * uPondRippleScale;
          vec2 rf = vec2(-uPondFlow.y, uPondFlow.x) * uPondRippleSpeed * uTime * 6.0;
          float re = 0.35;
          float rx = edenNoise(rp + vec2(re, 0.0) + rf) - edenNoise(rp - vec2(re, 0.0) + rf);
          float rz = edenNoise(rp + vec2(0.0, re) + rf) - edenNoise(rp - vec2(0.0, re) + rf);
          hx += rx * uPondRippleStrength;
          hz += rz * uPondRippleStrength;
          // 风掠过的缓慢呼吸：整体强度随时间起落
          float swell = 1.0 + uPondSwell * sin(uTime * uPondSwellSpeed * 6.2831 + vEdenPondPos.x * 0.15 + vEdenPondPos.z * 0.1);
          float amp = uPondNormalStrength * swell;
          vec3 nW = normalize(vec3(-hx * amp, 1.0, -hz * amp));
          vec3 nV = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          normal = normalize(mix(normal, nV, edenPondMask));
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        if (edenPondMask > 0.001) {
          vec3 V = normalize(cameraPosition - vEdenPondPos);
          vec3 nWorld = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float fresnel = pow(1.0 - clamp(dot(nWorld, V), 0.0, 1.0), uPondFresnelPower);
          totalEmissiveRadiance += uPondSkyColor * fresnel * uPondReflection * edenPondMask;
        }`,
      )
  }
  const prevKey = m.customProgramCacheKey?.bind(m)
  m.customProgramCacheKey = () => `${prevKey?.() ?? ''}|eden-pond`
  m.needsUpdate = true
}
