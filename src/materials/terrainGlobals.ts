// 地形材质上的补丁（pond / detail / caustics）共享的片元全局变量。
// 两个补丁都可能单独存在，所以谁先编译谁负责声明，用字符串判断避免重复声明。
// 顺序约定（见 envMaterials.ts）：detail 先注册、pond 后注册，
// 这样 pond 的代码会排在 detail 之前，detail 才能读到 edenPondMask 把水面排除掉。

export const TERRAIN_GLOBALS = /* glsl */ `
float edenPondMask = 0.0;
float edenDetailFade = 0.0;
vec2 edenDetailUv = vec2(0.0);
`

/** 若片元着色器里还没有这些全局变量，返回声明；否则返回空串 */
export const terrainGlobals = (fragmentShader: string) =>
  fragmentShader.includes('float edenPondMask') ? '' : TERRAIN_GLOBALS
