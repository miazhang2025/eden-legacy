// 通用噪声（所有自定义材质共用）
float edenHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float edenNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(edenHash21(i), edenHash21(i + vec2(1.0, 0.0)), u.x),
    mix(edenHash21(i + vec2(0.0, 1.0)), edenHash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
