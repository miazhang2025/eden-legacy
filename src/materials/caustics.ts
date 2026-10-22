import type { Material } from 'three'
import { shared } from './uniforms'
import noise from './chunks/noise.glsl?raw'
import caustics from './chunks/caustics.glsl?raw'

// 焦散投射（spec §5.2C high 档）：给静态地形材质打补丁，水面以下的片元叠加程序化焦散。
// 是否生效由共享 uniform uCausticsEnabled 控制（档位 / 水面开关），不需要重新编译。

// Symbol.for：开发时热更新会把本模块再加载一份，全局共享的标记才能防止同一材质被补两遍（重复声明，编译失败）
const PATCHED = Symbol.for('eden-caustics')

export function patchCaustics(material: Material) {
  const m = material as Material & { [PATCHED]?: true }
  if (m[PATCHED]) return
  m[PATCHED] = true
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer)
    Object.assign(shader.uniforms, {
      uTime: shared.uTime,
      uWaterLevel: shared.uWaterLevel,
      uCausticsEnabled: shared.uCausticsEnabled,
      uCausticsIntensity: shared.uCausticsIntensity,
      uCausticsScale: shared.uCausticsScale,
      uCausticsSpeed: shared.uCausticsSpeed,
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEdenCausticsPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvEdenCausticsPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying vec3 vEdenCausticsPos;\n${noise}\n${caustics}`)
      .replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\ngl_FragColor.rgb += diffuseColor.rgb * edenCaustics(vEdenCausticsPos, uTime);',
      )
  }
  const prevKey = m.customProgramCacheKey?.bind(m)
  m.customProgramCacheKey = () => `${prevKey?.() ?? ''}|eden-caustics`
  m.needsUpdate = true
}
