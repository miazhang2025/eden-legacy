// 风动植被：三层叠加（spec §5.2A）
//   主风：整株沿风向弯曲；阵风：低频大尺度脉冲；抖动：叶尖高频细碎摆动 + 花头绕竖轴摆动
// 噪声用 world position 采样，InstancedMesh 里每株相位自然不同。
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindSpeed;
uniform float uWindScale;
uniform float uGustStrength;
uniform float uGustFrequency;
uniform float uGustScale;
uniform float uFlutterStrength;
uniform float uFlutterFrequency;
uniform float uHeadSway;
uniform float uWindLayers;
uniform float uGustBoost;
uniform float uStiffnessPower;

vec3 edenWindOffset(vec3 wp, float softness) {
  float w = pow(clamp(softness, 0.0, 1.0), uStiffnessPower);
  vec2 dir = uWindDir;
  float phase = dot(wp.xz, dir) * uWindScale * 6.2831853;
  float bend = uWindStrength * (0.6 + 0.4 * sin(phase - uTime * uWindSpeed));
  if (uWindLayers > 1.5) {
    bend += uGustStrength * edenNoise(wp.xz * uGustScale - dir * uTime * uGustFrequency);
  }
  bend *= 1.0 + uGustBoost;
  vec3 offset = vec3(dir.x, 0.0, dir.y) * bend * w;
  if (uWindLayers > 2.5) {
    float f = sin(uTime * uFlutterFrequency + dot(wp, vec3(7.1, 3.7, 5.3)));
    offset += vec3(f, 0.5 * f, -f) * uFlutterStrength * w;
    float sway = sin(uTime * 1.3 + wp.x * 0.7 + wp.z * 0.3) * uHeadSway * w * w;
    offset.xz += vec2(-dir.y, dir.x) * sway;
  }
  // 弯曲时顶端略微下沉，近似保持茎长
  offset.y -= length(offset.xz) * 0.35 * w;
  return offset;
}
