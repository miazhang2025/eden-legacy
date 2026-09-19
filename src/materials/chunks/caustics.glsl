// 焦散（spec §5.2C high 档）：程序化循环图案投射到水下地形，不做真实计算
uniform float uCausticsIntensity;
uniform float uCausticsScale;
uniform float uCausticsSpeed;
uniform float uWaterLevel;
uniform float uCausticsEnabled;

float edenCausticsPattern(vec2 p, float t) {
  float c = 0.0;
  vec2 q = p;
  for (int i = 0; i < 3; i++) {
    q += vec2(sin(q.y * 1.7 + t), cos(q.x * 1.3 - t * 0.8)) * 0.6;
    c += abs(sin(q.x + q.y));
  }
  return pow(1.0 - clamp(c / 3.0, 0.0, 1.0), 6.0);
}

// 水面以下的点：返回要叠加的焦散亮度
float edenCaustics(vec3 worldPos, float time) {
  if (uCausticsEnabled < 0.5) return 0.0;
  float depth = uWaterLevel - worldPos.y;
  if (depth <= 0.0) return 0.0;
  float fade = smoothstep(0.0, 0.3, depth) * exp(-depth * 0.35);
  return edenCausticsPattern(worldPos.xz * uCausticsScale, time * uCausticsSpeed) * uCausticsIntensity * fade;
}
