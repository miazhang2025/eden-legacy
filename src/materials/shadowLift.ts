import type { Material } from 'three'

// 暗部提亮：美术把阴影 / AO 烘进了颜色贴图（cave 的岩壁），实时光照下这些暗部显得过重。
// 只抬贴图里低于阈值的暗部（按最亮通道在 sRGB 感知空间算，阈值直观），亮部不变，按比例缩放保留色相；
// 极暗的压缩噪点抬起时去饱和，避免蓝 / 红色块。
// 数值由材质覆盖 shadowLift / shadowLiftThreshold 控制（uniform，不重新编译）；0 = 无效果。

const PATCHED = Symbol('eden-shadow-lift')

export interface ShadowLiftUniforms {
  uShadowLift: { value: number }
  uShadowLiftThreshold: { value: number }
}

type Patched = Material & { [PATCHED]?: ShadowLiftUniforms }

/**
 * 必须在 pond / detail 之后注册：onBeforeCompile 链上它最后执行，此时能看到池塘补丁的 edenPondMask，
 * 池塘区域（靠贴图暗色识别）不提亮
 */
export function patchShadowLift(material: Material) {
  const m = material as Patched
  if (m[PATCHED]) return
  const uniforms: ShadowLiftUniforms = { uShadowLift: { value: 0 }, uShadowLiftThreshold: { value: 0.5 } }
  m[PATCHED] = uniforms
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    const pond = shader.fragmentShader.includes('edenPondMask') ? ' * (1.0 - edenPondMask)' : ''
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uShadowLift;\nuniform float uShadowLiftThreshold;')
      .replace(
        // color_fragment 紧跟 map_fragment，插在这里能排在其它补丁对 map_fragment 的修改之后
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        if (uShadowLift > 0.0) {
          // 按最亮通道算倍数（不用亮度）：饱和的蓝 / 红亮度权重很小，按亮度算会被放大十几倍成刺眼的色块
          float v = max(max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b), 1e-4);
          float vs = pow(v, 1.0 / 2.2);
          float t = max(uShadowLiftThreshold, 1e-3);
          float x = max(t - vs, 0.0);
          // 低于阈值的部分沿二次曲线抬起：阈值处平滑衔接，k <= 0.5 保证单调（暗的不会变得比亮的更亮）
          float k = 0.5 * uShadowLift${pond};
          float lifted = vs + k * x * x / t;
          float gain = pow(lifted / vs, 2.2);
          vec3 c = diffuseColor.rgb * gain;
          // 极暗像素的颜色多半是贴图压缩在黑底边缘留下的噪点：抬起时越暗越往同亮度的灰靠，不冒出高饱和的蓝 / 红块
          float noisy = (1.0 - smoothstep(0.04, 0.16, vs)) * clamp(gain - 1.0, 0.0, 1.0);
          diffuseColor.rgb = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), noisy);
        }`,
      )
  }
  const prevKey = m.customProgramCacheKey?.bind(m)
  m.customProgramCacheKey = () => `${prevKey?.() ?? ''}|eden-shadow-lift`
  m.needsUpdate = true
}

/** 写入数值（未打补丁的材质忽略） */
export function setShadowLift(material: Material, lift: number, threshold: number) {
  const u = (material as Patched)[PATCHED]
  if (!u) return
  u.uShadowLift.value = lift
  u.uShadowLiftThreshold.value = threshold
}
