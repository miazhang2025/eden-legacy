// 假次表面散射（spec §5.2B）：廉价背光透射近似，不用 transmission
//   pow(saturate(dot(V, -(L + N * distortion))), power) * scale * thickness
// 只算主方向光 + 可选一盏点光。
uniform float uSSSEnabled;
uniform vec3 uSSSColor;
uniform float uSSSScale;
uniform float uSSSPower;
uniform float uSSSDistortion;
uniform float uSSSAmbient;
uniform float uSSSThickness;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSSSPointEnabled;
uniform vec3 uSSSPointPos;
uniform vec3 uSSSPointColor;

vec3 edenSSSLight(vec3 N, vec3 V, vec3 L, vec3 lightColor, float thickness) {
  vec3 H = normalize(L + N * uSSSDistortion);
  float t = pow(clamp(dot(V, -H), 0.0, 1.0), uSSSPower) * uSSSScale;
  return lightColor * (t + uSSSAmbient) * thickness;
}

vec3 edenSSS(vec3 worldPos, vec3 N, float thickness) {
  if (uSSSEnabled < 0.5) return vec3(0.0);
  vec3 V = normalize(cameraPosition - worldPos);
  float th = thickness * uSSSThickness;
  vec3 c = edenSSSLight(N, V, uSunDir, uSunColor, th);
  if (uSSSPointEnabled > 0.5) {
    vec3 toL = uSSSPointPos - worldPos;
    float att = 1.0 / (1.0 + dot(toL, toL) * 0.05);
    c += edenSSSLight(N, V, normalize(toL), uSSSPointColor, th) * att;
  }
  return c * uSSSColor;
}
