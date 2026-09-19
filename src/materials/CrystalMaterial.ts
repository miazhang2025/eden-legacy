import type { Material } from 'three'
import { createCSM, type EdenCSM } from './csm'
import { shared } from './uniforms'

// 晶体（spec §5.2D）：transmission + thickness + ior + attenuation，加一层假内部辉光（fresnel × emissive）。
// transmission 很贵：只给数量少、体积大的「主体」用；小碎晶退化为不透明 + 高 envMapIntensity。
// 是否透射由 roleBase（见 scene/envMaterials.ts）按档位与尺寸决定，这里只负责 shader。

const fragmentShader = /* glsl */ `
  uniform vec3 uCrystalGlowColor;
  uniform float uCrystalGlowIntensity;
  uniform float uCrystalFresnelPower;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewPosition);
    float fresnel = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), uCrystalFresnelPower);
    csm_Emissive += uCrystalGlowColor * uCrystalGlowIntensity * fresnel;
  }
`

export function createCrystalMaterial(source: Material): EdenCSM {
  const m = createCSM('physical', source, {
    fragmentShader,
    uniforms: shared,
    cacheKey: 'eden-crystal-v1',
  })
  m.__edenRole = 'crystal'
  return m
}
