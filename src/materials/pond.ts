import { Color, Vector2, type Material } from 'three'
import type { SceneConfig } from '../config/schema'
import noise from './chunks/noise.glsl?raw'
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
  uPondColor: { value: new Color() },
  uPondTint: { value: 0.6 },
  uPondRoughness: { value: 0.05 },
  uPondNormalScale: { value: 1.5 },
  uPondNormalStrength: { value: 0.3 },
  uPondFlow: { value: new Vector2(1, 0) },
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
  u.uPondColor.value.set(p.color)
  u.uPondTint.value = p.tint
  u.uPondRoughness.value = p.roughness
  u.uPondNormalScale.value = p.normalScale
  u.uPondNormalStrength.value = p.normalStrength
  u.uPondFlow.value.set(Math.cos(p.flowDirectionDeg * DEG), Math.sin(p.flowDirectionDeg * DEG)).multiplyScalar(p.flowSpeed)
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
uniform vec3 uPondColor;
uniform float uPondTint;
uniform float uPondRoughness;
uniform float uPondNormalScale;
uniform float uPondNormalStrength;
uniform vec2 uPondFlow;
uniform vec3 uPondSkyColor;
uniform float uPondFresnelPower;
uniform float uPondReflection;
varying vec3 vEdenPondPos;
float edenPondMask = 0.0;
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
          shader.fragmentShader.includes('float edenNoise(') ? '' : noise
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        if (uPondEnabled > 0.5) {
          vec3 srgb = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
          float dist = distance(srgb, uPondMaskColor);
          edenPondMask = 1.0 - smoothstep(uPondTolerance - uPondSoftness, uPondTolerance + uPondSoftness, dist);
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
          float hx = edenNoise(p + vec2(e, 0.0) + f) - edenNoise(p - vec2(e, 0.0) + f)
                   + 0.5 * (edenNoise(p * 2.3 + vec2(e, 0.0) - f) - edenNoise(p * 2.3 - vec2(e, 0.0) - f));
          float hz = edenNoise(p + vec2(0.0, e) + f) - edenNoise(p - vec2(0.0, e) + f)
                   + 0.5 * (edenNoise(p * 2.3 + vec2(0.0, e) - f) - edenNoise(p * 2.3 - vec2(0.0, e) - f));
          vec3 nW = normalize(vec3(-hx * uPondNormalStrength, 1.0, -hz * uPondNormalStrength));
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
