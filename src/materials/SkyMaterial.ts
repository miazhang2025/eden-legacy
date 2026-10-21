import { BackSide, Color, ShaderMaterial, Vector3 } from 'three'
import type { SceneConfig } from '../config/schema'

// 程序化天空：四段渐变（天顶 / 中段 / 地平线雾带 / 地面）+ 太阳圆盘与光晕 + 可选月亮（天体）。
// 同一个材质既画背景天球，也在 <Environment> 里渲染一次作为环境光，保证光照与看到的天空一致；
// environment.lightSky 打开时环境光改用另一套渐变色（如夜空背景 + 明亮的洞内打光）。
// 背景天球在地平线附近渐变到雾色（sky.fogBlend），远处被雾吞掉的地形与天空自然衔接。

const DEG = Math.PI / 180

export function createSkyMaterial() {
  return new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uTop: { value: new Color() },
      uMid: { value: new Color() },
      uHorizon: { value: new Color() },
      uBottom: { value: new Color() },
      uMidHeight: { value: 0.3 },
      uHorizonWidth: { value: 0.08 },
      uFogColor: { value: new Color() },
      uFogBlend: { value: 0 },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Color() },
      uSunSize: { value: 0.02 },
      uSunIntensity: { value: 1 },
      uSunGlow: { value: 0.3 },
      uSunGlowSpread: { value: 16 },
      uMoonEnabled: { value: 0 },
      uMoonDir: { value: new Vector3(0, 1, 0) },
      uMoonColor: { value: new Color() },
      uMoonSize: { value: 0.05 },
      uMoonSoftness: { value: 0.2 },
      uMoonIntensity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uBottom;
      uniform float uMidHeight;
      uniform float uHorizonWidth;
      uniform vec3 uFogColor;
      uniform float uFogBlend;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunSize;
      uniform float uSunIntensity;
      uniform float uSunGlow;
      uniform float uSunGlowSpread;
      uniform float uMoonEnabled;
      uniform vec3 uMoonDir;
      uniform vec3 uMoonColor;
      uniform float uMoonSize;
      uniform float uMoonSoftness;
      uniform float uMoonIntensity;
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 c;
        if (y >= 0.0) {
          // 地平线雾带 → 中段 → 天顶
          c = mix(uHorizon, uMid, smoothstep(0.0, uMidHeight, y));
          c = mix(c, uTop, smoothstep(uMidHeight, 1.0, y));
          c = mix(c, uHorizon, exp(-y / max(uHorizonWidth, 1e-3)) * 0.65);
        } else {
          c = mix(uHorizon, uBottom, smoothstep(0.0, max(uHorizonWidth * 3.0, 1e-3), -y));
        }
        // 地平线附近渐变到雾色（天体画在雾色之上）
        if (uFogBlend > 0.0) c = mix(c, uFogColor, 1.0 - smoothstep(0.0, uFogBlend, abs(y)));

        // 太阳：圆盘 + 光晕
        float sd = max(dot(d, normalize(uSunDir)), 0.0);
        c += uSunColor * pow(sd, uSunGlowSpread) * uSunGlow;
        if (uSunSize > 0.0) {
          float disk = smoothstep(cos(uSunSize), cos(uSunSize * 0.85), sd);
          c += uSunColor * disk * uSunIntensity;
        }

        // 月亮 / 天体：柔边圆盘，边缘略暗，像一颗半透明的大球
        if (uMoonEnabled > 0.5) {
          float md = dot(d, normalize(uMoonDir));
          float mask = smoothstep(cos(uMoonSize), cos(uMoonSize * (1.0 - uMoonSoftness * 0.5)), md);
          float r = acos(clamp(md, -1.0, 1.0)) / max(uMoonSize, 1e-4);
          vec3 moon = uMoonColor * (0.85 + 0.15 * (1.0 - r * r)) + uMoonColor * pow(r, 6.0) * 0.4;
          c = mix(c, moon, mask * clamp(uMoonIntensity, 0.0, 1.0));
          c += uMoonColor * max(uMoonIntensity - 1.0, 0.0) * mask;
        }

        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
}

/**
 * 从 config 写入天空 uniform（主光 position 决定太阳方向）。
 * forEnvironment：渲染环境光用——lightSky 打开时换成打光渐变色，且不混雾色（雾只影响看到的天空）
 */
export function updateSkyMaterial(m: ShaderMaterial, cfg: SceneConfig, forEnvironment = false) {
  const s = cfg.sky
  const u = m.uniforms
  const light = cfg.environment.lightSky
  const colors = forEnvironment && light?.enabled ? light : s
  u.uTop.value.set(colors.topColor)
  u.uMid.value.set(colors.midColor)
  u.uHorizon.value.set(colors.horizonColor)
  u.uBottom.value.set(colors.bottomColor)
  u.uFogColor.value.set(cfg.fog.color)
  u.uFogBlend.value = forEnvironment || cfg.fog.type === 'none' ? 0 : (s.fogBlend ?? 0)
  u.uMidHeight.value = s.midHeight
  u.uHorizonWidth.value = s.horizonWidth
  u.uSunDir.value.set(...cfg.lights.directional.position).normalize()
  u.uSunColor.value.set(s.sunColor)
  u.uSunSize.value = s.sunSize
  u.uSunIntensity.value = s.sunIntensity
  u.uSunGlow.value = s.sunGlow
  u.uSunGlowSpread.value = s.sunGlowSpread
  const moon = s.moon
  u.uMoonEnabled.value = moon.enabled ? 1 : 0
  const az = moon.azimuth * DEG
  const el = moon.elevation * DEG
  u.uMoonDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az))
  u.uMoonColor.value.set(moon.color)
  u.uMoonSize.value = moon.size
  u.uMoonSoftness.value = moon.softness
  u.uMoonIntensity.value = moon.intensity
}
