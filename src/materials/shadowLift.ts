import type { Material } from 'three'

// 暗部提亮：美术把阴影 / AO 烘进了颜色贴图（cave 的岩壁），实时光照下这些暗部显得过重。
// 只抬贴图里低于阈值的暗部（在 sRGB 感知空间算，阈值直观），亮部不变，按比例缩放保留色相。
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
          float l = max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
          float ls = pow(l, 1.0 / 2.2);
          float t = max(uShadowLiftThreshold, 1e-3);
          float x = max(t - ls, 0.0);
          // 低于阈值的部分沿二次曲线抬起：阈值处平滑衔接，k <= 0.5 保证单调（暗的不会变得比亮的更亮）
          float k = 0.5 * uShadowLift${pond};
          float lifted = ls + k * x * x / t;
          diffuseColor.rgb *= pow(lifted / ls, 2.2);
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
