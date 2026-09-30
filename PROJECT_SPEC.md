# 伊甸遗存录（Eden Legacy）· Web 体验项目 Spec

> 本文件是给实现方（Claude Code / 工程师）的唯一真源文档。  
> 实现时如果发现文档与代码冲突，以本文件为准；如果本文件有缺口，先在「待确认问题」区追加问题，不要自行发明产品逻辑。

---

## 0. 一句话描述

《伊甸遗存录》是一个五页的网页体验：玩家从 2D landing 进入三个 3D 场景，在每个场景中用第三人称角色控制器行走探索，每个场景从 4 个候选生态资产中采集 1 个；三次选择被持久化，最终在 2D 的 ending 页面组合成一个巴洛克风格的 3D「生态标本盒」，可交互并导出照片。

同时必须交付一个独立的 **Tech Art Look Dev 面板**，能实时调节场景里尽可能多的参数（光照 / 材质 / 相机 / 粒子 / 后处理 / 雾 / 水面），并导出 config 文件直接替换场景的设定数值。

---

## 1. 硬性技术约定

| 项 | 决定 |
|---|---|
| 框架 | React 18 + TypeScript + Vite |
| 3D | three.js + @react-three/fiber + @react-three/drei |
| 后处理 | @react-three/postprocessing (postprocessing 库) |
| 状态 | zustand（含 persist middleware） |
| 路由 | react-router-dom（HashRouter，方便静态托管） |
| 包管理 | npm |
| 调参面板 | Tweakpane v4（不是 leva —— 需要 schema 驱动的自动构建和整树导出） |
| 物理 | **不引入物理引擎**。角色移动用射线检测 + 手写碰撞（见 §6.1） |
| 自定义材质 | three-custom-shader-material（CSM）—— 在 MeshPhysicalMaterial 基础上注入自定义 vertex/fragment，保留 three 的光照与 IBL |
| 摆位工具 | @theatre/studio + @theatre/r3f，**仅 devDependencies，不进生产 bundle**（见 §9.5） |
| 资产格式 | .glb（Draco 压缩）+ KTX2/basis 贴图 |
| 目标平台 | Desktop 优先 + **移动端必须支持**，但**仅横屏**。竖屏时全屏遮罩提示旋转设备（见 §11） |

**绝对不要做的事**
- 不要把任何视觉数值硬编码在组件里。所有可调数值必须来自 `src/config/scenes/*.json`（见 §9）。
- 不要在三个场景之间用 props 传递选择结果。只能走 zustand store。
- 不要为「3D 物品出现在 landing page」写实现。Landing 目前是纯 2D，3D 物件是**待定占位**，只在布局里留一个空的 `<LandingArtifactSlot />`（返回 null + TODO 注释）。
- **不要在组件里写字符串。** 所有界面文字、资产名、描述、标本盒命名一律走 `data/copy.ts` 的 `copy(key)`（见 §4.2）。

### 1.1 视觉方针（覆盖 slide 上的技术约定）

**slide 里写的技术限制（「无水体」「无水面反射」等）一律作废**，那是提案阶段的保守写法。实际方针是：

> 在保证性能的前提下，视觉效果尽可能做满。

- 水面、风动植被、假次表面散射、体积感光照、后处理全部可以上，见 §5.2。
- 约束不是「少做效果」，而是「每个效果必须有分级开关 + 有可测的开销」。任何新效果落地时必须同时提供：config 里的 `enabled` 开关、`quality: 'low'|'mid'|'high'` 档位、以及在 look dev 面板里可见的开销（帧时间变化）。
- 性能不达标时的处置顺序：先降分辨率与档位，再关效果，**最后才简化美术**。
- 详见 §12 的分级与预算。

---

## 2. 目录结构

```
src/
  main.tsx
  App.tsx                      # 路由 + 全局 transition 层
  routes/
    Landing.tsx                # Page 1 (2D)
    SceneCave.tsx              # Page 2 — Scene 03 水晶洞穴
    SceneOcean.tsx             # Page 3 — Scene 01 海洋
    SceneGarden.tsx            # Page 4 — Scene 02 花园
    Ending.tsx                 # Page 5 (2D + 3D 标本盒)
  scene/
    SceneShell.tsx             # 三个场景共用的外壳：Canvas / 灯光 / 雾 / 后处理 / 调试入口
    CharacterController.tsx    # 角色控制器
    FollowCamera.tsx
    CollectZone.tsx            # 核心采集区触发器
    CollectableAsset.tsx       # 单个可采集资产（含 proximity / 高亮 / 采集按钮）
    AssetFlow.tsx              # 四选一的完整流程状态机（见 §6.3）
    Water.tsx                  # 三个场景共用，由各自 config 的 water.enabled 控制
    Particles/
      index.tsx                # 统一粒子系统入口，由 config 驱动
  ending/
    SpecimenBox.tsx            # 3D 标本盒
    SpecimenSlot.tsx           # 三个固定 slot
    ExportPhoto.ts             # 截图合成 + 下载
  ui/
    CollectPrompt.tsx          # 「请选择一种你希望保存的…」
    AssetInfoCard.tsx          # pop up card：名称 + 一句简短描述 + 收集按钮
    Transition.tsx             # 全屏 fade
  state/
    useRunStore.ts             # 玩家进度 + 三次选择（persist）
    useConfigStore.ts          # look dev 运行时 config（不 persist）
  data/
    assets.ts                  # 12 个候选资产的定义
    specimenBoxes.ts           # 组合结果的命名 + 描述规则
    copy.ts                    # 全部文案（唯一文案出口）
  audio/
    AudioBus.ts                # 环境音 / SFX 总线，当前全部静音 placeholder
  input/
    useInput.ts                # 键鼠 + 触屏统一输入层
    TouchControls.tsx          # 虚拟摇杆 + 拖拽转视角（仅移动端挂载）
    OrientationGate.tsx        # 竖屏遮罩
  config/
    schema.ts                  # config 的 TS 类型 + tweakpane 元信息
    scenes/
      cave.json
      ocean.json
      garden.json
      ending.json
  lookdev/
    LookDevPanel.tsx           # Tweakpane 挂载
    buildPanel.ts              # schema → tweakpane 自动构建
    exportConfig.ts            # 导出 / 导入 JSON
    TheatreEditor.tsx          # 仅 DEV：@theatre/r3f editable 包装（见 §9.5）
theatre/                       # 仅 DEV：Theatre state 文件，中间产物
  <scene>.theatre-project-state.json
scripts/
  bake-theatre.ts              # Theatre state → assets.ts / scenes/*.json（单向）
public/
  models/
    env/ocean.glb              # 已有（见 §4.3）
    env/garden.glb             # 已有
    env/cave.glb               # 暂缺，占位
    colliders/                 # 低模碰撞体（由 env 模型减面导出）
    assets/                    # 12 个候选资产，全部占位
  textures/ hdri/ audio/ 2d/
```

---

## 3. 页面流与全局状态机

```
Landing (2D)
   │  [进入按钮]
   ▼
Scene 03 水晶洞穴  ──选择1个──►  Scene 01 海洋  ──选择1个──►  Scene 02 花园  ──选择1个──►  Ending
```

- 场景顺序**固定**为 洞穴 → 海洋 → 花园（注意：这是 slide 上的播放顺序，与 Scene 编号不一致，按播放顺序实现，编号只作为资产命名保留）。
- 场景之间一律通过 `<Transition>` 全屏 fade out → 路由切换 → fade in。
- 任一场景未完成选择时，禁止跳转下一页（路由 guard：读 `useRunStore`）。
- 直接访问 `/ending` 但选择不全 → 重定向回第一个未完成的场景。

### `useRunStore`

```ts
type SceneId = 'cave' | 'ocean' | 'garden'

interface RunState {
  selections: Record<SceneId, string | null>   // value = assetId
  order: SceneId[]                              // ['cave','ocean','garden'] 固定
  select(scene: SceneId, assetId: string): void
  reset(): void
  isComplete(): boolean
  nextRoute(): string
}
```

- 用 zustand `persist`（sessionStorage，key: `ecobox.run.v1`）。刷新不丢进度。
- `reset()` 在 Ending 页面的「重新开始」按钮和 Landing 的进入按钮里调用（进入时清空上一轮）。
- `selections` 是**唯一**决定 ending 标本盒形态的输入。ending 不允许读任何其它来源。

---

## 4. 数据模型：12 个候选资产

固定结构：3 个场景 × 每场景 4 选 1 = 12 个候选，玩家最终得到 3 个资产的组合。

```ts
interface CollectableAssetDef {
  id: string                  // e.g. 'cave_ore_01'
  scene: SceneId
  category: string            // 见下表
  name: string                // 显示名
  description: string         // 一句简短描述（pop up card 用）
  model: string               // /models/... .glb
  worldPosition: [number,number,number]   // 场景中的摆放位置
  worldRotation?: [number,number,number]
  scale?: number
  specimenScale?: number      // 在标本盒里的缩放（通常和场景里不同）
  glowColor: string           // 被选中时的自发光色
}
```

| 场景 | 播放顺序 | 四个候选的类别 | UI 提示语 |
|---|---|---|---|
| `cave` — Scene 03 水晶洞穴（地层遗境） | 1 | 矿石类 ×2 / 蘑菇类 ×2 | 「请选择一种你希望保存的地下生命痕迹」 |
| `ocean` — Scene 01 海洋（潮汐圣殿） | 2 | 贝类 ×2 / 鱼类 ×2 | 「请选择一种你希望保存的海洋生命」 |
| `garden` — Scene 02 花园（万物花园） | 3 | 花卉 ×2 / 蝴蝶或蝶蛾 ×2 | 「请选择一种你希望保存的花园生命」 |

`data/assets.ts` 先用占位模型（drei 内置几何体）填满 12 条，等美术资产到位再替换 `model` 字段。**不要因为没有模型就少写条目。**

### 4.2 文案

- `data/copy.ts` 导出 `copy(key)`（例如 `copy('scene.cave.prompt')`、`copy('asset.cave_ore_01.name')`），按 key 返回文案；缺失的 key 在开发环境报警告。
- 所有 UI 文字（提示语、按钮、标本盒名称与描述、资产名与描述）都从这里取，界面里**不出现任何硬编码字符串**。
- 当前文案为初稿（由实现方按场景与类别撰写），改措辞只需改 `copy.ts` 一个文件。

### 4.3 现有环境模型

目前有两个环境 glb，先用于 look dev，其余一律占位：

| 文件 | 对应场景 | 内容 | 注意 |
|---|---|---|---|
| `env/ocean.glb` | `ocean` | 浮空岩台群 + 巨型贝壳 + 珊瑚/晶簇，冷蓝紫调，模型自带若干上升粒子发射点 | 岛台是分离的多块，需要确认可行走的连通性 |
| `env/garden.glb` | `garden` | 一块完整地形岛，含池塘、汀步石、多种花卉与植被，约 61 个物体 | **模型里有池塘水面几何** —— 见下方冲突说明 |
| `env/cave.glb` | `cave` | 暂缺 | 用 garden 或 ocean 临时顶替跑通流程，不要因此改架构 |

**关于 garden 的池塘**：slide 原写「无水体、无水面反射」，作废。garden.glb 里的池塘按完整水体处理（反射 + 折射 + 焦散，见 §5.2），只是尺度小、反射分辨率可以比 ocean 低。

> **M5 实测更正**：garden.glb 里**没有池塘水面几何，也没有凹陷**。池塘是画在地形贴图上的一块平面（北池塘整片高 1.71，南池塘 1.19–1.21，与周围草地几乎同高）。名为「水」的 mesh 是出生点附近一个竖直的、完全透明（alpha = 0）的物体，与池塘无关。因此 garden 的水面默认关闭，见 §15-H。

**模型处理流水线（已实现：`npm run models`，脚本 `scripts/optimize-models.mjs`）**
- 原始模型放 `art/env/<scene>.glb`（不进部署包），脚本生成 `public/models/env/<scene>.glb`（渲染）与 `public/models/colliders/<scene>.glb`（碰撞）。
- 实测：两个模型的高模主要是花草类小物件（单株 2–3 万面），地形本身面数不高。碰撞体按「剔除小物件 + 三角面上限 20k」生成，而非固定减面 90%；与渲染模型的高度差 p95 < 2cm。
- 渲染模型当前为 Draco + WebP（garden 39→7.3MB，ocean 22→4.9MB）。**KTX2 待办**：需安装 KTX-Software（`toktx`）后把 `webp` 换成 `etc1s/uastc`；在此之前显存占用未下降（garden 约 58 张 1K 贴图 ≈ 320MB，超出 §12.3 的 120MB 预算）。
- 模型均无顶点色；材质名为 C4D 导出的数字，未使用 `veg_` / `crystal_` / `water_` 前缀（见 §14-12），接入自定义材质前需美术按约定重新命名导出。

原始约定（供参考）：
1. 导出一份减面 ≥90% 的低模作为 `colliders/<scene>.glb`，只用于射线检测与碰撞，不渲染（`visible=false`）。
2. 渲染用高模走 Draco + KTX2 压缩。
3. 植被/花卉这类重复物体尽量转 InstancedMesh（garden 的 61 物体里大部分是重复植被）。
4. 模型自带的粒子发射点（ocean 里那些细丝状喷发）请导出为**空物体 / 命名点**（`emitter_*`），粒子由 §9.3 的粒子系统按 config 生成，不要用模型里烘死的几何。

### 4.4 美术第二版接入（2026-09，已完成）

美术把新的场景 glb、贴图、草模型、HDRI 放进 `public/`，已全部接入。约定如下：

**目录分工**：`art/` 放源文件（不进部署包），`public/` 只放运行时真正要下载的东西。
`art/env/*.glb`（新场景模型，旧版备份在 `art/env/_v1/`）、`art/textures/<scene>/*.jpg|png`（原始贴图）、
`art/character/*.fbx`（角色动画，尚未接入）、`art/hdri/*.hdr`（原始 HDRI）、`art/grass/`（草模型，未采用）。
`npm run models` / `npm run hdri` 负责把它们处理进 `public/`。dist 从 206MB 降到 28MB。

**贴图按文件名自动接到网格**（`scripts/assign-textures.mjs`，被 `npm run models` 调用）：
- 贴图命名 `SC<编号>[-<编号>]_<用途>.jpg|png`，例如 `SC08_land.jpg`、`SC30-41_archangel.jpg`（一张贴图覆盖 30–41 号）。
- 网格名就是编号（`8`、`36.`），特例：`stem*` → 1 号；`水` 是花瓣上滴落的**水珠**（不是水面），按玻璃质感走 `droplet_crystal`。
- **材质名 = 贴图文件名**，所以材质角色能按名字里的用途关键词自动推断（`land|rock|ground` → 静态，`poppy|coral|leaf` → 植被，`crystal|bubble|shell|droplet` → 晶体，见 `src/scene/materialOverrides.ts` 的 `defaultRole`）。美术以后换贴图不用改代码。
- 一个编号有多张贴图时用脚本里的 `PICK` 指定（已确认 12/13 = bigpoppy、14 = daisy）；没有同号贴图的用 `OVERRIDES` 借用邻近编号。
- **仍缺的贴图**：garden 的 SC12、SC13、SC48、SC49、SC50 五个编号（当前借用 14/47/46/45），补齐后删掉对应 `OVERRIDES` 即可。
- ocean 的 21–23 号是海草，不是粒子发射点。

**模型尺度**：新模型 `env.scale = 1`（旧版是缩放过的），position 按包围盒重新居中：garden/cave `[1.36, 1.37, 11.36]`、ocean `[-2.03, 0, 4.88]`。出生点、采集区（garden/cave 中心 `(-7, 3)` 半径 7，ocean `(7, -8)` 半径 5.5）与 12 个资产坐标随之重摆。

**cave 仍无模型**：暂时借用 garden 的 glb + 碰撞体，靠 config 的光照/雾/色调区分。真模型到位后只改 `cave.json` 的 `env` 与摆位。

**草模型不采用**：`art/grass/` 里 grassb 7626 面/簇、grassc 4309 面/簇，而单簇只有 8cm 高，铺满 garden 需要数千簇 → 千万级三角面。程序化草（`src/scene/Grass.tsx`）11 万片叶子合计仅 55 万面。结论是保留程序化草，草模型只可能用于近景点缀。

**HDRI（`npm run hdri`，脚本 `scripts/process-hdri.mjs`）**：原图放 `art/hdri/`，脚本自己解码 / 降采样 / 重编码 Radiance RGBE（sharp 不支持 .hdr），输出 1024×512、每张 2MB 到 `public/hdri/`（原始三张共 45MB）。
`EnvironmentConfig` 支持**打光与背景用两张不同的 HDRI**：`hdri` 负责 `scene.environment`，`hdriBackground` 只换天空（drei `<Environment background="only">`），`backgroundIntensity` 单独控制天空亮度而不影响打光。
当前取值：garden 用 bluesky 打光 + pinksky 当背景（intensity 0.35 / background 0.7 / rotationY 1.57，这个朝向能看到云层和落日光）；ocean 用 qwantani dusk 同时打光与背景（0.5 / 0.7 / 1.57）；cave 仍是程序化天空。程序化天空在 HDRI 背景开启时自动隐藏，随时可在面板里切回。

---

---

## 5. 场景通用架构（config-driven）

`SceneShell` 接收 `sceneId`，做这些事：

1. 读 `config/scenes/<sceneId>.json` 作为初始值，写入 `useConfigStore`。
2. 场景内**所有**组件通过 `useConfigStore(s => s.config.<path>)` 读数值，绝不读 json 直接值 —— 这样 look dev 面板改动能实时生效。
3. 渲染顺序：环境（HDRI/雾/天空）→ 地形与静态模型 → 水面（water.enabled 时）→ 粒子 → 角色 → 采集资产 → 后处理。
4. 在 dev 或 `?lookdev=1` 时挂载 `<LookDevPanel sceneId={sceneId} />`。

场景差异（必须遵守）：

场景差异（水体不再是差异项，三个场景都可以有水）：

| | cave | ocean | garden |
|---|---|---|---|
| 水体 | 地下水潭 / 湿润地面（可选，config 控制） | 主水面，最高规格 | 池塘 + 汀步，中等规格 |
| 植被风动 | 少量（菌类轻微摆动） | 珊瑚/水草类的水流摆动（同一套 shader，改参数） | 重度使用 |
| 主要视觉重点 | 晶体透射 + 体积光 | 水面 + 反射 + 焦散 | 风动植被 + 假 SSS |

### 5.1 边界与引导（重要）

场景是**有边界的自由探索**，不是线性通道，也不是无限地形：

- **边界**：每个场景在 config 里定义一个 `bounds`（AABB 或多边形，优先 AABB：`min/max` 两个 vec3）。角色位置每帧 clamp 在 bounds 内。
- 触碰边界时的反馈：轻微阻力 + 屏幕边缘可选的淡色 vignette 提示（`bounds.feedback` 开关），**不弹文字**。
- 掉出地形（射线未命中）时把角色拉回上一个合法位置，不做死亡/重生。
- **视觉引导**：因为核心目标是采集，四个候选资产必须在远处就能被看见并吸引玩家走过去。引导手段（全部由 config 控制强弱、可单独关）：
  1. `beacon` —— **发光粒子，不做光柱**。分两级：
     - `beacon.zone`：采集区中心一团缓慢漂浮、呼吸闪烁的发光粒子（萤火 / 浮游光点的感觉），远距离可见，把玩家引向采集区；玩家进入采集区后减弱。
     - `beacon.asset`：进入采集区后，每个资产周围点亮一小簇环绕漂浮的发光粒子；进入 proximity 后减弱。
  2. `rimGlow` —— 资产自身的边缘光/自发光呼吸；
  3. `pathHint` —— 可选的地面微光/汀步引导（garden 的汀步石天然适合），默认关闭。
- 引导强度随距离变化：`beaconFalloff` 定义远/近两档强度，避免走近后过曝。
- **不要**用箭头、minimap、任务列表这类 HUD 引导。引导只能是场景内的光与粒子。

### 5.2 自定义 shader 层（视觉核心，三个场景共用）

统一放在 `src/materials/`，全部基于 CSM 扩展 MeshPhysicalMaterial，**共享同一套 uniform 更新器**（一个 `useFrame` 统一推 `uTime`/`uWind`，不要每个材质各跑一个）。

```
src/materials/
  csm.ts                 # CSM 封装 + uniform 注册表
  VegetationMaterial.ts  # 风动 + 假 SSS
  WaterMaterial.ts       # 水面
  CrystalMaterial.ts     # 晶体透射（cave/ocean 的晶簇与贝壳）
  chunks/
    wind.glsl
    fakeSSS.glsl
    caustics.glsl
```

#### A. 风动植被 `VegetationMaterial`

顶点位移，三层叠加：

| 层 | 作用 | 参数 |
|---|---|---|
| 主风 | 整株沿风向弯曲 | `windDirection(vec2)`、`windStrength`、`windSpeed`、`windScale`（噪声空间频率） |
| 阵风 | 低频大尺度脉冲，制造成片的起伏 | `gustStrength`、`gustFrequency`、`gustScale` |
| 抖动 | 叶尖高频细碎摆动 | `flutterStrength`、`flutterFrequency` |

- 位移量按顶点高度加权：用顶点色 R 通道或局部 Y 归一化作 `stiffness` 遮罩，根部不动、顶端最大。**优先约定用顶点色 R = 柔软度**，导出模型时刷好；没有顶点色时回落到局部 Y 归一化。
- 噪声用 world position 采样，保证 InstancedMesh 里每株相位不同，不需要每实例额外属性。
- 花朵头部可额外加一个绕自身轴的小幅摆动（`headSwayStrength`）。
- ocean 场景复用同一材质，把 `windSpeed` 调慢、`flutter` 调低，就是水流摆动；不要为水下植物另写一套。
- 风向/强度是**场景级 uniform**，可以被 look dev 面板实时改，也可被采集确认时的事件短暂放大（一阵风）。

#### B. 假次表面散射（fake SSS）

叶片/花瓣/菌伞/珊瑚通用，走廉价的背光透射近似，不要用 `transmission`（太贵）：

- 核心项：`pow(saturate(dot(viewDir, -lightDir + normal * distortion)), power) * scale * thickness`。
- 参数：`sssColor`、`sssScale`、`sssPower`、`sssDistortion`、`sssAmbient`、`thicknessMap`（没有贴图时用常数 `thickness`，或用顶点色 G 通道）。
- 只对主方向光（+ 可选一盏指定点光）计算，不遍历所有光源。
- 约定：**顶点色 R = 风柔软度，G = 厚度，B = 备用**。模型没刷顶点色时全部回落常数，不报错。

#### C. 水面 `WaterMaterial`

按档位实现，`water.quality` 控制：

**已实现的水面动画**：水面网格按 `water.segments` 细分，vertex shader 里叠三层 Gerstner 波（`waveAmplitude` / `waveLength` / `waveSpeed` / `waveSteepness`），高度与横向位移一起做，并解析求出波浪法线，再与小尺度涟漪法线叠加。low 档细分自动减半。

| 档 | 包含 |
|---|---|
| low | 法线贴图扰动 + 菲涅尔 + 反射用 envMap（无实时反射） |
| mid | + 平面实时反射（Reflector，降分辨率渲染）+ 深度衰减的水色渐变 |
| high | + 屏幕空间折射、岸边泡沫（用深度差）、焦散投射到水下地形 |

- 参数：`shallowColor`、`deepColor`、`depthFalloff`、`normalMapScale`、`flowSpeed`、`flowDirection`、`fresnelPower`、`reflectionIntensity`、`reflectionResolution`、`refractionStrength`、`foamWidth`、`foamColor`、`causticsIntensity/Scale/Speed`。
- 实时反射**只渲染必要图层**（地形 + 天空 + 大件，排除粒子与小植被），用 layer mask 控制。
- 反射分辨率是最大的性能旋钮，必须在面板里单独暴露，且移动端默认降一档。
- 焦散用投影贴图（一张循环焦散贴图 + 水面法线扰动），不做真实计算。

#### D. 晶体 `CrystalMaterial`

- cave 的晶簇、ocean 的贝壳/晶体用：`transmission` + `thickness` + `ior` + `attenuationColor`，加一层假内部辉光（fresnel × emissive）。
- transmission 是真贵的那个，只给**数量少、体积大**的主体晶体用；小碎晶用不透明 + 高 envMapIntensity 伪装。这条是硬规则。

### 5.2c 地形细节贴图 detail（已实现）

美术的地形贴图摊到几十米的地形上，走近了每个像素有半米大，糊成一片。`src/materials/detail.ts` 给**地形类材质**（材质名含 `land|landscape|ground|terrain`）打补丁，在近处叠一层平铺的细节贴图：

- 颜色叠加用「中灰不变」的乘法（`diffuse *= mix(1, detail*2, strength)`），所以细节只加质感、不改地形原本的色彩分布。
- 法线扰动只做加法（不替换原法线），保留地形本身的大形起伏。
- 投影用世界 XZ 平面（地形基本水平），陡坡按法线 y 淡出，避免竖直面上的拉伸。
- 距离淡出（默认 8m 起、35m 全无），远处回到原贴图，既省采样也避免整片地面出现平铺花纹。
- 平铺重复用第二套「旋转 37° + 缩小 0.37×」的 uv 混合打散（`breakup`），代价是颜色和法线各多一次采样。
- 池塘水面不叠细节：`detail` 必须在 `pond` **之前**注册（见 `envMaterials.ts` 注释），这样 pond 的代码在片元里排在前面，detail 才读得到 `edenPondMask`。两个补丁共享的片元全局变量放在 `src/materials/terrainGlobals.ts`，谁先编译谁负责声明。
- 档位（`TierSettings.detail`）：low = 关闭，mid = 单层采样，high = 加打散。
- 当前只有 garden 开启（`textures/detail/grass_detail_512.png` + 法线，strength 0.3 / normalStrength 0.5 / scale 0.6）。ocean、cave 的 `detail.map` 留空 = 关闭。

### 5.2d 池塘水面动画（已实现）

贴图池塘（§15-H）原本只有一层缓慢流动的噪声法线，看不出在动。现在是三层叠加：

1. **主流动**：两层大尺度噪声反向推移（`flowSpeed` / `flowDirectionDeg`）。
2. **细涟漪**：小尺度、更快，沿主流动的垂直方向穿过（`rippleScale` / `rippleSpeed` / `rippleStrength`）。
3. **缓慢起伏**：整片水面的法线强度随时间与位置做正弦呼吸，模拟风掠过（`swell` / `swellSpeed`）。

实测（同机位隔 2 秒两帧的像素差）：池塘区域平均变化 20.5，旁边草地只有 5.5（草的变化来自风动），水面动得清楚且不「沸腾」。

### 5.2b 已实现（M5）

- **材质角色**：模型材质名没有按 `veg_` / `crystal_` / `water_` 前缀导出，所以角色做成 config 字段 `materials.<name>.role`（`static | vegetation | crystal | water | emitter`），面板里每个材质有 role 下拉框；没配时按名字前缀推断。当前分类：
  - garden / cave：7、13、14、16–20、22、25、28–30、42–52、stem = vegetation；其余 static。
  - ocean：9–13（玻璃球 / 玻璃管）、16（巨贝）、19–20（水晶簇）= crystal；14、15、24–36（珊瑚 / 海葵）= vegetation；21–23（细丝喷发）= emitter；其余 static。
- **emitter**：隐藏模型里的几何，取包围盒中心作为发射点，交给 `role: modelEmitters` 的粒子池。
- **植被**：风动三层 + 假 SSS 都在 `VegetationMaterial`；阴影深度材质带同样的风动位移，阴影会跟着摆。柔软度 / 厚度在加载时烘成顶点属性（没有顶点色时按 mesh 内世界高度归一化）。
- **晶体**：是否 transmission 由档位与尺寸决定（包围盒最长边 ≥ `crystal.mainMinSize` 算主体）。
- **水面**：`Water.tsx` 是一张平面；水深来自一次性从碰撞体烘的高度图（不需要每帧深度 pass）；mid 起用 three 的 Reflector 做平面反射（反射相机只看第 0 层 = 地形，植被在第 1 层、粒子在第 2 层）；high 用 physical transmission 做屏幕空间折射，并给静态地形材质注入焦散。
- **环境光**：默认程序化（渐变天空球 + 主光方向的亮斑，渲染一次成环境贴图，不需要下载）；`environment.mode = 'hdri'` 时读 `public/hdri/` 下的文件。
- **引导**：`beaconZone`（采集区中心的发光粒子团）与 `beaconAsset`（进入采集区后四个资产周围点亮）两个粒子池，强度随距离与流程阶段变化（config `beacon` 段）。采集确认时 `burst` 池在被选资产处爆发一次，同时刮一阵风（`wind.confirmGust*`）。
- 各效果的 `enabled` 开关、档位上限都能在面板调；`quality` 字段目前只有水面有（其它效果由全局档位表控制）。

### 5.3 粒子系统（自研，WebGL）

不引入第三方粒子库（理由见 §16 ADR-001）。自己写，但按下面的方案写 —— 这套设计参考了 r3f-vfx 的架构与参数模型。

#### A. 无状态粒子（默认方案）

本项目的粒子量级是几百到几千，**不需要 GPGPU / ping-pong RT / compute**。用「无状态」实现：

- `InstancedBufferGeometry` + 自定义 vertex shader。
- 每个粒子的 `seed`、`spawnOffset`、`lifetimePhase`、`sizeRand`、`colorIndex` 作为 instanced attribute，**初始化时写一次，永不更新**。
- 位置完全由时间解析求出：`position = f(seed, uTime)`。噪声、上升、漂移、旋转都是 `uTime` 的函数。
- 每帧的 CPU 开销 = 传一个 `uTime` uniform。没有回读，没有 RT，没有 GC。
- 适用：洞穴浮尘/孢子、海洋气泡/浮游光点、花园花粉、beacon 引导发光粒子 —— 即本项目 95% 的粒子。

#### B. 事件式 burst

采集确认那一下需要事件触发：同一套材质，加 `uBurstStartTime` uniform，粒子的生命周期相对它计算。一次性播放，播完整体不可见。不需要为它单独建系统。

#### C. 粒子池 + 命名发射器

**每个场景只建一个粒子池，不是每个效果一个。** 池按名字注册，多个发射点共享同一套 geometry/material/draw call：

```ts
// 一个池，多个发射点
<ParticlePool name="ambient" maxParticles={2000} config={cfg.particles.ambient} />
<ParticleEmitter pool="ambient" position={[...]} />   // beacon ×4 共享
```

否则你一个场景里环境粒子 ×1 + beacon ×4 + burst ×1 就是 6 套 draw call 和 6 份材质，纯浪费。

#### D. 生命周期曲线：烘成纹理

size / opacity / velocity over lifetime **不要传控制点进 uniform**。用贝塞尔曲线在 JS 里烘成一张 1D 纹理（或多条曲线打包进一张 RGBA 纹理的不同通道），shader 用 `progress` 采样。

- 好处：曲线精度不受控制点数量限制，shader 里只有一次纹理采样，比多段 mix 便宜。
- config 里存曲线控制点（可编辑），构建时或运行时烘成纹理并缓存。

#### E. Soft particles（降级实现）

标准做法要深度图，WebGL 下得多渲一张深度 RT，成本不值。退化方案：

- 按粒子到相机的距离淡出（近处淡出，避免糊脸）；
- 按粒子高度到地面的距离淡出（用生成时记录的地面高度，不实时查询）。

视觉上覆盖 80% 的穿模问题，零额外 pass。**除非实测发现穿模明显**，否则不上真 soft particles。

#### F. 排序

粒子默认用 additive blending（不需要排序）。只有 normal blending 的粒子才需要深度排序 —— 尽量避免走到这一步；若必须，用 CPU 端按距离粗排（每 N 帧一次，N 进 config），不做逐帧精确排序。

#### G. 参数命名对齐

粒子 config 的字段名**直接照抄 r3f-vfx 的 props 命名**（`emitterShape` / `emitterRadius` / `fadeOpacityCurve` / `turbulence.{intensity,frequency,speed}` / `startPositionAsDirection` / `softDistance` / `blending` / `appearance` …）。

理由：那套命名被真实使用打磨过，省得自己发明；而且如果将来项目迁到 WebGPU，config 展开即是它的 props，零翻译成本。

---

## 6. 三个场景的交互流程（逐帧对齐 slide）

### 6.1 角色控制器 `CharacterController`

- 第三人称。WASD / 方向键移动，鼠标拖拽或右键转视角，Shift 加速（可选）。
- 移动逻辑：在角色下方发一条向下射线打到地形 mesh，取交点 y 作为脚底高度；水平移动前先向移动方向发一条短射线，命中 `collider` 层则阻挡。
- 相机：`FollowCamera` 用 damping 跟随，参数（distance / height / fov / damping / shoulderOffset）全部来自 config。
- 移动速度、转身速度、重力/贴地平滑也进 config。
- 角色模型先用占位胶囊体 + 简单 idle/walk 状态切换接口（`playAnim('idle'|'walk')`），等角色资产到位替换。

### 6.2 场景进入与采集区

1. 场景加载完成 → fade in → 玩家自由行走探索（此时无 UI 干扰）。
2. 玩家走入 `CollectZone`（一个隐形的圆形/盒形触发区，位置半径进 config）→ 触发 UI 提示语（见 §4 表格），提示语以淡入方式出现在屏幕中部/下部。
3. 四个可选资产出现（淡入 + 轻微浮动）。出现方式：一直在场景中但未激活 → 进入采集区后点亮，同时 §5.1 的 `beacon.asset` 点亮、`beacon.zone` 减弱。

### 6.3 四选一流程状态机 `AssetFlow`

```
IDLE → PROMPTED → INSPECTING(assetId) → CONFIRMED(assetId) → RESOLVED → EXIT
```

- `PROMPTED`：提示语 + 四个资产全部处于「可采集」外观（原地轻微发光 + 少量粒子）。
- `INSPECTING`：玩家靠近某个资产（距离阈值进 config）→ 弹出 `AssetInfoCard`：**名称 + 一句简短描述 + 收集按钮**。离开范围则收起卡片，回到 `PROMPTED`。同时支持「点击即收藏」（点击资产等价于按收集按钮）。
- `CONFIRMED`：点击收集按钮 →
  1. 被选资产**原地**轻微发光增强 + 少量粒子上升，随后淡出消失；
  2. 其余三个资产同步淡出（保留可配置开关 `othersFadeOut: true|false`，默认 true —— slide 上写的是「或者不变」，用 config 控制）；
  3. 写入 `useRunStore.select(scene, assetId)`；
  4. 收起所有采集 UI。
- `RESOLVED` → 画面渐出 → 路由跳到下一场景；花园场景则跳到 Ending。

一个场景只能采集一次，`CONFIRMED` 之后禁用所有采集交互。

---

## 7. Page 1 — Landing（2D）

- 纯 2D：全屏视觉（背景图 / 视频海报图占位，参考 slide 的火山岛屿图，放 `public/2d/landing.*`）+ 标题 + 一个「进入」按钮。
- 按钮：`reset()` → 跳转 `/cave`。
- `<LandingArtifactSlot />`：空组件 + TODO 注释，**本期不实现**（可能会有 3D 物件，设计待定）。布局上给它预留一个绝对定位容器，不影响现有排版。
- 需要一个极简的加载/预热：在 landing 停留期间后台 preload cave 场景的关键资产（drei `useGLTF.preload`）。

---

## 8. Page 5 — Ending（2D 主体 + 3D 标本盒）

### 8.1 组合逻辑

1. 后台读取 `useRunStore.selections` 的三个 assetId（洞穴×1 + 海洋×1 + 花园×1）。
2. 三个资产按**预设固定位置**自动组合进巴洛克标本盒构图：
   - `SpecimenSlot` 三个固定 slot（`slotA/B/C`），位置、朝向、缩放全部在 `config/scenes/ending.json` 里定义；
   - slot 与场景的映射固定：`slotA = cave, slotB = ocean, slotC = garden`（不随选择变化）；
   - 每个资产用它的 `specimenScale` 而不是场景里的 scale。
3. 标本盒整体淡入 → 显示标本盒名称 + 一句简短描述。

**已实现（M6）**：入场是自己写的时间线（`ending/reveal.ts`，不用 Theatre 时间轴，见 ADR-003）：画布 CSS 淡入 → 标本盒从 `reveal.boxScaleFrom` 放到 1 → 三件标本按 `specimenStagger` 依次从 `specimenFrom` 偏移落位并淡入 → `textDelay` 后文字与按钮淡入。
Ending 页有自己的灯光舞台（`ending/EndingStage.tsx`）：影棚式上下渐变环境贴图 + 主光方向的柔光板（渲染一次），主光投影（标本在背板上落影），以及独立的后处理段 `post`（与场景共用 `PostFX`，配置分开）。相关参数在 `ending.json` 的 `reveal` / `environment` / `shadows` / `post` 段。
4. 结束：出现「导出照片」和「重新开始」。

### 8.2 标本盒命名与变体规则（`data/specimenBoxes.ts`）

- 需要一个函数 `resolveBox(selections): BoxResult`。
- 按 **category 三元组** 查表（每场景 2 个类别 → 2×2×2 = 8 种组合），每种组合一条记录；查不到则回落到模板串联。
- 名称与描述走 `copy.ts`（§4.2）。

```ts
interface BoxResult {
  id: string                 // e.g. 'ore_shell_flower'
  name: string               // copy(`box.<id>.name`)
  description: string        // copy(`box.<id>.desc`)
  configPatch?: DeepPartial<EndingConfig>   // 见下
}
```

- **组合影响 ending 外观的可能性必须预留**：`configPatch` 是对 `ending.json` 的深合并补丁，可以改画框材质、背景色、灯光、后处理调色等。当前 8 条记录的 `configPatch` 全部留空（`{}`），外观完全固定；之后要做差异化时只填这个字段，不改渲染代码。
- Look dev 面板需要一个「模拟组合」下拉，能在不重玩的情况下切换 8 种组合预览 patch 效果。

### 8.2b 画框：暂定 3D，但要可换

- `ending.json` 里 `frame.mode: '3d' | 'plane'`。当前默认 `'3d'`（加载画框 glb 占位）。
- `'plane'` 模式下画框改为一张带透明通道的 2D 贴图平面，摆在标本之前/之后由 `frame.planeDepth` 决定。
- 两种模式下三个 slot 的 transform 都由同一份 config 驱动，切换模式不需要重摆物件。
- 三个 slot 的 position / rotation / scale **必须全部暴露在 look dev 面板里并可导出**，因为构图还没定，要留足调试余地。额外给每个 slot 一个 `autoFit` 开关：开启时按资产包围盒自动缩放到 slot 的目标尺寸，关闭时用手调数值。

### 8.3 3D 简单交互

- 标本盒可用鼠标拖拽做有限范围的旋转（yaw/pitch 各限制在 ±N 度，N 进 config）+ 滚轮小幅缩放（有 min/max clamp）。
- 不做自由 orbit，不允许转到背面。
- 鼠标 hover 单个标本 → 显示该资产的名称/描述小 tooltip。
- 2D 部分：画框外的版式、文字、按钮都是 DOM 层，3D canvas 嵌在中间区域。

**已实现（M6）**：`ending/BoxInteraction.tsx` 包住标本盒——拖拽旋转 yaw / pitch 各限制在 ±N 度（`interaction.yawLimitDeg / pitchLimitDeg`），滚轮沿视线方向缩放（`zoomMin / zoomMax`），带阻尼；松手 `returnDelay` 秒后缓慢回正；静止时轻微呼吸摆动（`idleSwayDeg`）。悬停标本显示名称 / 描述提示框并增强自发光（`specimen.hoverEmissive`）；触屏上点按切换提示框。参数都在 `ending.json` 的 `interaction` / `specimen` 段，面板可调。

### 8.4 照片导出 `ExportPhoto.ts`

- renderer 用 `preserveDrawingBuffer: true`（或导出时手动 `gl.render()` 后立刻 `toDataURL`）。
- 导出流程：
  1. 临时隐藏 UI/tooltip；
  2. 以 `exportScale`（默认 2）渲染一帧到离屏尺寸；
  3. 新建 2D canvas，按 config 的 `frame` 设定绘制底图/边框/标题文字（PNG 叠加或纯绘制），再把 3D 帧 drawImage 进去；
  4. `toBlob('image/png')` → 下载，文件名 `specimen-<boxSlug>-<timestamp>.png`；
  5. 恢复 UI。
- 导出尺寸、边距、是否带文字、是否带 logo 全部进 `ending.json`。

**已实现（M6）**：参数在 `ending.json` 的 `photo` 段（倍率、边距、底色、边框、标题 / 描述字号与颜色、logo 路径与大小）。3D 帧用「临时提高像素比渲染一帧并立刻读取」的方式获取（同一任务内完成，屏幕上看不到放大的画布），不依赖离屏 RT，色调映射与屏幕一致。导出的是当前视角（包括用户拖拽 / 缩放后的状态）。logo 默认关闭（`public/2d/logo.png` 到位后打开 `includeLogo`）。

---

## 9. Tech Art Look Dev 面板（独立交付物，重要）

### 9.1 目标

在任意场景按 `` ` `` 或访问 `?lookdev=1` 打开面板，实时调节场景里尽可能多的参数，导出一个 JSON，**可以直接替换 `src/config/scenes/<scene>.json`**，重启后场景外观完全一致。

### 9.2 架构

- `config/schema.ts` 定义每个参数的：类型（number/color/vec3/bool/select/file）、默认值、`min/max/step`、分组路径、label。
- `lookdev/buildPanel.ts` 遍历 schema 自动生成 Tweakpane 的 folder / binding —— **新增参数只需改 schema，不需要动面板代码**。
- 所有 binding 直接写 `useConfigStore` 的 config 对象（immer 风格 set），场景组件订阅后立即响应。
- 面板顶部按钮区：
  - `Export JSON` → 下载当前场景 config（文件名 = `<sceneId>.json`，结构与 `config/scenes/` 完全一致，可直接覆盖）；
  - `Export All` → 打包三个场景 + ending 的 config（zip 或单个合并 json，任选其一实现，注明）；
  - `Import JSON` → 读本地 json 覆盖当前运行时 config；
  - `Copy to clipboard`；
  - `Reset to file defaults`；
  - `Screenshot`（导出当前视角 PNG，方便对比 look）。
- 面板状态（展开的 folder、当前 preset）存 localStorage，刷新不丢。

**已实现（M4）**
- 打开：`npm run dev` 后在任意页面按 `` ` ``，或 URL 带 `?lookdev=1`（放在 `#` 之前）。仅 DEV，生产包不含（`npm run check:bundle` 校验）。
- 结构：上方「工具」（文件 / 性能 / 调试），下方「Look Dev · <id>」是由 `config/schema.ts` 自动生成的参数树。
- `schema.ts` 里的 `SchemaFor<T>` 类型保证 config 每个字段都有 schema 项，漏写会编译报错。新增参数的步骤：改 `SceneConfig` / `EndingConfig` 类型 → 在 `SCENE_SCHEMA` / `ENDING_SCHEMA` 里加一项（范围、步长、说明）→ 在四个 json 里加默认值。面板代码不用动。
- `Export All` 选的是「单个合并 json」：`lookdev-all.json` = `{ cave, ocean, garden, ending }`，`Import JSON` 同时支持单个场景文件和合并文件。
- 材质：按 material name 分组，顶部「按 mesh 定位」下拉可从 mesh 名跳到它的材质；每个材质有「恢复模型原值」。导出时 `materials` 只保留与模型原值不同的字段。
- 性能：fps 图、frame ms、draw calls、triangles、geometries、textures；「测开销」对任意效果开关做 A/B 平均帧时间对比，结果记入 `docs/perf.md`。
- 调试（不属于 config，不导出）：free-fly 相机（OrbitControls）、跳过场景（等同 K 键）、Ending「模拟组合」（8 种组合预览 + `configPatch` 已接入深合并）。
- 折叠状态与面板开关存 localStorage。「preset」暂未实现（目前没有预设需求，需要时再加）。
- 尚未出现在面板里的参数（粒子、水面、风动、假 SSS、晶体、后处理、质量档位、HDRI、阴影等）随 M5 的效果实现一起加入 schema。

### 9.3 必须暴露的参数清单

**Camera**：fov、near、far、followDistance、followHeight、shoulderOffset、damping、lookAtOffset、rotateSpeed、pitch 限制、是否启用 free-fly debug camera。

**Lights**：
- ambient：color、intensity
- hemisphere：skyColor、groundColor、intensity
- directional（主光）：color、intensity、position(vec3)、target、castShadow、shadow.mapSize、shadow.bias、normalBias、shadow camera 范围
- 每场景 2–4 个 point/spot（数组，可增删）：color、intensity、distance、decay、position、angle、penumbra
- environment：HDRI 选择、environmentIntensity、environmentRotation、background 开关

**Fog / Atmosphere**：type（none/linear/exp2）、color、near/far 或 density、height fog 开关与参数。

**Materials**（按 mesh 分组或按 material name 分组，二者都要能定位）：color、roughness、metalness、emissive、emissiveIntensity、normalScale、clearcoat、transmission、ior、thickness、attenuationColor、envMapIntensity、opacity/transparent、alphaTest、side、wireframe（debug）。
> 实现要求：启动时遍历场景收集所有唯一 material name，动态生成 folder。config 里以 `materials: { "<name>": {...} }` 存储，未在 config 出现的 material 保持模型自带值。

**Particles**（实现方案见 §5.3，字段名对齐 r3f-vfx）：按池分组，每池一组参数 —— enabled、maxParticles、emitterShape（point/box/sphere/cone/disk/edge）、emitterRadius、emitterAngle、emitterHeight、emitterDirection、emitterSurfaceOnly、startPosition、startPositionAsDirection、lifetime[min,max]、speed[min,max]、direction(Range3D)、gravity、friction{intensity,easing}、turbulence{intensity,frequency,speed}、size[min,max]、colorStart[]、colorEnd[]、intensity、blending、appearance、fadeSizeCurve、fadeOpacityCurve、velocityCurve（曲线走 §5.3D 的烘纹理）、rotation、rotationSpeed、alphaMap、flipbook{rows,columns}、softDistance、depthTest、renderOrder。
> 每个发射点（emitter）单独一组：position、emitCount、delay、direction 覆盖、localDirection。
> 至少覆盖：洞穴浮尘/孢子、海洋气泡/浮游光点、花园花粉、beacon 发光粒子（zone ×1 + asset ×4）、采集确认 burst（burst 参数独立一组）。

**Water**（三个场景都可能有，见 §5.2C）：quality 档位、shallowColor、deepColor、depthFalloff、normalMapScale、flowSpeed、flowDirection、fresnelPower、reflectionIntensity、reflectionResolution、reflectionLayers（勾选哪些图层进反射）、refractionStrength、foamWidth、foamColor、caustics（intensity/scale/speed）。

**Vegetation / Wind**（见 §5.2A）：windDirection、windStrength、windSpeed、windScale、gust（strength/frequency/scale）、flutter（strength/frequency）、headSway、stiffness 来源切换（顶点色 / 局部 Y）。风是场景级，改一处全场景植被同步。

**Fake SSS**（见 §5.2B）：sssColor、sssScale、sssPower、sssDistortion、sssAmbient、thickness（常数或贴图通道切换）、参与计算的光源选择。要能单独开关以便对比。

**Crystal**：transmission、thickness、ior、attenuationColor、attenuationDistance、内部辉光强度、fresnel power。

**Post-processing**：bloom（intensity/threshold/smoothing/radius）、tonemapping（模式 + exposure）、vignette、chromaticAborration、depthOfField（focusDistance/focalLength/bokehScale）、noise/grain、colorGrading（hue/saturation/contrast/brightness/lift-gamma-gain 至少 basic 三档）、SSAO（可选，注明性能开关）。

**Render**：exposure、shadow type、pixelRatio clamp、antialias、performance monitor 开关、FPS/drawcall 显示。

**Bounds / 引导**：bounds min-max、边界反馈开关与强度、beacon（zone / asset 两组：范围半径、粒子数、颜色、亮度、呼吸速度、远近两档强度、falloff 距离）、rimGlow 强度与呼吸速度、pathHint 开关与强度。

**Audio**（素材未到位，先建总线）：master / ambience / sfx 三条总线的音量与 mute、ambience 淡入淡出时长、采集音效音量。参数现在就要在 config 和面板里存在，播放的是静音占位。

**Asset flow 调试**：采集区半径、proximity 阈值、`othersFadeOut` 开关、发光强度、淡出时长、跳过场景按钮（debug：直接写入一个 selection 并跳下一场景）、模拟组合下拉（见 §8.2）。

**移动端**：触屏摇杆灵敏度、转视角灵敏度、移动端 pixelRatio 上限、移动端后处理降级开关（默认关掉 DOF/SSAO）。

**Ending 专属**（`ending.json`）：三个 slot 的 transform、盒体材质、画框灯光、旋转限制、缩放限制、导出尺寸/边距/背景。

### 9.4 Config JSON 结构示例（`cave.json` 骨架）

```json
{
  "version": 1,
  "scene": "cave",
  "camera": { "fov": 45, "followDistance": 6, "followHeight": 2.2, "damping": 0.12 },
  "character": { "moveSpeed": 3.2, "turnSpeed": 6, "groundSmoothing": 0.2 },
  "render": { "exposure": 1.0, "shadowType": "pcfsoft", "pixelRatioMax": 2 },
  "environment": { "hdri": "/hdri/cave.hdr", "intensity": 0.8, "rotationY": 0, "background": false },
  "fog": { "type": "exp2", "color": "#2a1f4d", "density": 0.035 },
  "lights": {
    "ambient": { "color": "#4a3f7a", "intensity": 0.3 },
    "directional": { "color": "#cbb9ff", "intensity": 1.2, "position": [8, 14, 6], "castShadow": true, "shadowBias": -0.0005 },
    "points": [
      { "name": "crystal_glow_a", "color": "#7ef9ff", "intensity": 3, "distance": 12, "position": [-4, 2, 3] }
    ]
  },
  "materials": {
    "crystal": { "roughness": 0.05, "metalness": 0, "transmission": 0.9, "ior": 1.6, "emissive": "#3ad6ff", "emissiveIntensity": 0.4 }
  },
  "particles": [
    { "name": "dust", "enabled": true, "count": 600, "spawnShape": "box", "spawnSize": [20, 8, 20], "lifetime": [6, 12], "size": [0.02, 0.06], "velocity": [0, 0.05, 0], "noise": { "strength": 0.1, "frequency": 0.4 }, "color": "#d9c9ff", "blending": "additive" }
  ],
  "post": {
    "bloom": { "enabled": true, "intensity": 0.8, "threshold": 0.7, "radius": 0.6 },
    "dof": { "enabled": false },
    "vignette": { "enabled": true, "offset": 0.3, "darkness": 0.6 },
    "grade": { "saturation": 1.05, "contrast": 1.1, "brightness": 0 }
  },
  "flow": { "zoneCenter": [0, 0, -10], "zoneRadius": 8, "proximity": 2.2, "othersFadeOut": true, "fadeDuration": 1.2 }
}
```

三个场景 json 都含 `water` 段，用 `water.enabled` 开关。

> 注意：本示例的 `particles` 字段是早期写法，**以 §5.3G / §9.3 为准**（r3f-vfx 命名，按池 + `emitters[]` 组织）。

### 9.5 Theatre.js —— dev-time 摆放工具

Tweakpane 面板负责调数值，**摆位置交给 Theatre.js**（`@theatre/studio` + `@theatre/r3f`）。在浏览器里用 gizmo 直接拖拽比在面板里输 position/rotation/scale 的数字快一个量级。

**硬性约束：Theatre 只存在于开发期，绝不进生产 bundle。**

- `@theatre/studio` 与 `@theatre/r3f` 装为 `devDependencies`，挂载点用 `import.meta.env.DEV` 包住，并确保生产构建里被 tree-shake 掉（构建后检查 bundle 里不含 `theatre` 字样，提供 `npm run check:bundle` 脚本，CI 中调用）。
- `@theatre/core` 同样**不进生产**。生产代码只读自己的 config，不播放 Theatre 的 state。

**资产摆位不走 Theatre**：12 个候选资产的位置 / 旋转 / 缩放在 `config/scenes/<scene>.json` 的 `assets` 段，由 look dev 面板「资产摆位 assets」调节并随 Export JSON 导出。面板打开时可走位摆放：走到位置按 `1`–`4` 把对应资产放到角色前方 1.5m，`5` 把出生点设为当前位置与朝向。

**用它摆什么**：

| 对象 | 落到哪 |
|---|---|
| ending 三个 slot 的 transform | `config/scenes/ending.json` |
| ~~采集区 `zoneCenter` / `zoneRadius`~~（已取消：资产散落，四个都看过才能收集）| `config/scenes/*.json` 的 `flow` 段 |
| beacon 与各粒子发射点的 `position` | `config/scenes/*.json` 的 `particles[].emitters[]` |
| 灯光位置（点光/主光）| `config/scenes/*.json` 的 `lights` 段 |

**工作流**：

```
dev 环境挂 studio → gizmo 拖拽 → 保存 state
  → theatre/<scene>.theatre-project-state.json
  → npm run bake:theatre
  → 数值写回 assets.ts / scenes/*.json
  → 生产只读后者
```

- 烘焙脚本 `scripts/bake-theatre.ts`：读 Theatre 导出的 state，按上表映射写回自己的 config。**单向**：Theatre → config，不反向。

**已实现的用法（M3）**：
1. `npm run dev`，访问 `http://localhost:5173/?theatre=1#/<scene>`（`?theatre=1` 放在 `#` 之前）；只有 DEV + 这个参数才加载 studio。
2. 左侧大纲里是本场景所有可摆放对象（`zone`（已弃用）、`spawn`、`light:directional`、`light:point:<name>`；ending 页为 `slot:slotA/B/C`）。点左上角**相机图标**打开带 gizmo 的编辑视图。代理物体只在编辑视图可见，拖动时游戏画面实时跟随。
3. 右下角「保存摆位」→ 写入 `theatre/<scene>.theatre-project-state.json`（经 dev server 中间件）。
4. `npm run bake:theatre`（或 `-- <scene>` 只烘一个）→ 写回 `src/config/scenes/*.json`。只写被拖动过的对象和分量。
- 约定：`zone` 已弃用；`spawn` 的旋转 y = 出生朝向。
- `npm run build && npm run check:bundle` 校验生产包不含 Theatre / Tweakpane。
- Theatre 的 state 文件进版本库（方便下次接着拖），但它是**中间产物**，真源是烘出来的 config。两者不一致时以 config 为准。
- 目录：`theatre/`（state 文件）+ `scripts/bake-theatre.ts`（烘焙脚本）。

**不做的事**：不使用 Theatre 的时间轴/关键帧功能，过场与序列的时长、缓动仍然写在 config 里由自己的代码播放（见 §16 ADR-003）。

---

## 10. 音频（占位）

- `audio/AudioBus.ts` 建三条总线：`ambience` / `sfx` / `master`，接口 `playAmbience(sceneId)`、`playSfx(name)`。
- 现在**没有素材**：所有调用走静音占位（不加载文件，只打 console.debug），但调用点必须已经埋好 —— 场景进入/退出、进入采集区、靠近资产、点击收集、标本盒淡入、导出照片。
- 浏览器自动播放限制：在 Landing 的「进入」按钮上 `resume()` AudioContext。
- 素材到位后只需要往 `public/audio/` 放文件并填 `audio.json` 映射表。

## 11. 移动端（横屏）

- 支持触屏行走，**仅横屏**。`OrientationGate` 在竖屏时铺满全屏，显示旋转提示（文案 + 图标），不卸载场景。
- 输入统一走 `useInput()`：桌面读键鼠，移动端读虚拟摇杆（左下，移动）+ 右半屏拖拽（转视角）。上层逻辑不区分设备。
- 交互适配：pop up card 的收集按钮在移动端加大热区；「点击资产即收藏」在触屏上等价于点按。
- 性能降级：移动端自动 `pixelRatio ≤ 1.5`、关闭 DOF/SSAO、粒子数 ×0.5、阴影降为单光源低分辨率。降级系数写在 config 的 `mobile` 段，可在面板里调，且可强制模拟移动端档位（`?tier=mobile`）。
- iOS Safari 注意：`100vh` 问题用 `dvh`；全屏导出照片走下载而非 Web Share（先不做分享）。

## 12. 性能预算与质量分级

视觉不设上限，但每个效果都必须能被降级。

### 12.1 质量档位

`quality: 'low' | 'mid' | 'high'`，默认按设备能力自动判定（`detect-gpu` 做 GPU tier 检测，跑分表自托管在 `public/` 不走外部 CDN + 首 3 秒帧时间采样），可被 `?quality=` 强制覆盖，也可在面板里切换用于对比。

| | low（移动端默认） | mid | high（桌面默认） |
|---|---|---|---|
| pixelRatio | ≤1.25 | ≤1.5 | ≤2 |
| 水面 | low 档（envMap 反射） | mid（实时反射，半分辨率） | high（反射 + 折射 + 焦散 + 泡沫） |
| 风动 | 主风层 only | 主风 + 阵风 | 三层全开 |
| 假 SSS | 关 | 开，单光源 | 开，主光 + 一盏点光 |
| transmission 晶体 | 全部退化为不透明 | 仅主体 | 主体 + 次级 |
| 阴影 | 关或超低 | 1024，单光源 | 2048，单光源 + 软阴影 |
| 粒子数 | ×0.4 | ×0.7 | ×1.0 |
| 后处理 | bloom + 调色 | + vignette + grain | 全开（含 DOF） |

**已实现（M5）**：档位表在 `src/config/global.json` 的 `quality.tiers`（面板「Global」区块可调、可导出）。判定顺序：`?quality=low|mid|high` 强制（同时锁定，不自动降档）> 设备默认（移动端 `mobileDefault`、桌面 `desktopDefault`）> `detect-gpu` 细化（跑分表自托管在 `public/benchmarks/`，只会往下调）。面板「调试」里可切换档位、关闭自动降档。

### 12.2 帧率守门

- 目标：桌面 60fps，移动端 30fps。
- 运行时监控滚动平均帧时间，连续 2 秒低于目标 80% → 自动降一档（最多降到 low），并在面板里打日志。**自动降级只降不升**，避免来回抖动。
- 面板里可关闭自动降级（look dev 时必须能锁死在 high）。

### 12.3 资产预算

- 每场景 draw call 目标 < 150（植被走 InstancedMesh 后应远低于此）。
- 每场景总纹理 < 120MB（KTX2 后）。
- 场景切换时 dispose 上一场景资源，避免三场景叠加爆显存。
- HDRI 用 1k/2k，不用 4k（`npm run hdri` 自动降到 1k，原图留在 `art/hdri/`，见 §4.4）。
- 实时反射 pass 是第二份完整渲染，只走必要图层。
- 每加一个效果，在面板里记录其开/关的帧时间差，写进 `docs/perf.md`。没有实测数据的效果不算完成。桌面数据由实现方记录，移动端数据由团队真机补测。
- 档位与移动端的优先级：先按 `quality` 档位定基线，再叠加 `mobile` 段；单个效果自身的 quality（如 `water.quality`）不得高于全局档位。

## 13. 资产与工程约定

- 每个场景 draw call 目标 < 150，总纹理 < 120MB（KTX2 后）。
- 每个场景入口做 loading（drei `<Loader>` 或自定义 2D 遮罩），loading 完成再 fade in。
- 场景切换时卸载上一场景资源（`useGLTF.clear` 或 dispose），避免三场景叠加爆显存。
- HDRI 用 1k/2k，不用 4k（`npm run hdri` 自动降到 1k，原图留在 `art/hdri/`，见 §4.4）。
- 阴影只开主光，且用固定范围的 shadow camera。

---

## 13. 实现顺序（建议给 Claude Code 的里程碑）

> 因为两个环境模型已经到位、而资产与文案没有，M4（look dev 面板）优先级被提前 —— 面板一旦可用，ocean / garden 两个场景就能先进入调光调材质阶段，与占位流程并行推进。

1. **M0 骨架**：Vite + R3F + 路由五页 + `useRunStore` + `Transition` + 路由 guard。用色块占位，跑通完整流程（landing → 三场景 → ending → 重开）。
2. **M1 状态机制**：`AssetFlow` 完整状态机 + 12 个占位资产 + pop up card + 三次选择写入 store + ending 读取并摆进三个 slot。**这一步先把「记住选择影响 ending 形态」验证透，再做画面。**
3. **M2 角色控制器**：载入 `ocean.glb` / `garden.glb` + 低模碰撞体，`CharacterController` + `FollowCamera` + 射线贴地 + bounds clamp。同时接触屏输入与横屏门（移动端越早验证越好）。
4. **M3 Config 化**：把 M0–M2 里所有数值抽到 `config/schema.ts` + 四个 json。同时接入 Theatre（§9.5）把 12 个资产、采集区、发射点摆到位并烘回 config —— 摆位早做，后面每一步都省事。
5. **M4 Look Dev 面板**：schema 驱动的 Tweakpane + 导出/导入/预设。此时面板即成为后续所有美术调试的唯一入口，ocean / garden 可以开始正式 look dev。
6. **M5 场景 look**：先落地 §5.2 的四套材质（植被风动 + 假 SSS → 水面 → 晶体），再做粒子系统（含 beacon 引导）与后处理。每套材质落地即接入面板并记录帧时间开销。同时实现 §12.1 的质量档位切换。
7. **M6 Ending**：标本盒交互 + 命名规则 + `configPatch` 机制 + 照片导出。
8. **M7 Landing 2D** 视觉落地 + 预热 + 打磨过场 + 音频总线接线。

---

## 14. 已确认的决定（Q1–Q7，已归档）

1. **资产**：已有 `ocean.glb` / `garden.glb` 两个环境模型，先用于 look dev；cave 环境、12 个候选资产、角色模型、画框全部占位。
2. **场景规模**：有边界，边界内自由探索；用场景内的发光粒子与自发光做视觉引导（§5.1），不用 HUD。
3. **文案**：~~全部用中文假字~~ → 已改为真实文案初稿（§4.2），由实现方撰写，团队后续修改措辞。
4. **画框**：待定，暂按 3D 实现，但 slot transform 与 `frame.mode` 必须可调可切换（§8.2b）。
5. **移动端**：支持，且仅横屏（§11）。
6. **音频**：要，素材未到位，先建总线与调用点（§10）。
7. **Ending 变体**：暂时固定，但通过 `configPatch` 预留按组合改外观的能力（§8.2）。
8. **视觉方针**：slide 里的技术限制作废。在性能可控的前提下效果做满 —— 三个场景都可有水体、植被要风动、植物要假次表面散射（§1.1、§5.2）。每个效果必须带分级开关与实测开销（§12）。
9. **采集区与资产**：四个候选资产都在 `CollectZone` 内部。
10. **点击即收藏**：只在 proximity 范围内生效；范围外点击资产无效。
11. **ocean 视角**：水上场景，角色在岩台上行走，水面只需从上方看，不做水下渲染。
12. **材质识别**：glb 里按材质名前缀识别自定义材质：`veg_`（植被风动 + 假 SSS）、`crystal_`（晶体）、`water_`（水面）。美术导出时按此命名。
13. **Look dev 面板不进生产**：面板、`` ` `` 快捷键、`?lookdev=1` 只在 `import.meta.env.DEV` 下存在，生产 bundle 不含 Tweakpane。
14. **面板导出规则**：
    - 导出的是 base config，不包含质量档位降级、`mobile` 段叠加、`configPatch` 叠加后的结果。
    - `materials` 只导出与模型自带值不同的字段；未改动的保持模型原值。
    - 按 mesh 定位只是导航入口，改动仍按该 mesh 的 material name 存储。
    - `useConfigStore` 在内存里按 sceneId 分别保存本次会话的改动，切换场景不丢；刷新会丢。`Export All` 导出本次会话改过的场景 + 其余场景的文件原值，格式为单个合并 json。
15. **Ending hover**：移动端改为点按显示 tooltip。
16. **文案接口**：`data/copy.ts` 按 key 取文案，例如 `copy('scene.cave.prompt')`；改文案只改这一个文件。
17. **category key**：`ore / mushroom / shell / fish / flower / butterfly`（蝶蛾归入 `butterfly`）。
18. **工程**：npm；项目用 git 仓库管理，CI 用 GitHub Actions（至少跑 build + `check:bundle`）；质量档位检测使用 `detect-gpu`。
19. **引导**：不做光柱，用发光粒子（§5.1）。
20. **ocean 走水**（§15-B）：浮岛之间可以在水面上走。实现：`water.walkable = true` 时水面作为可站立的地面（地形与水面取高者），水面抬到浮岛底部（`water.level = 0.6`），bounds 扩到覆盖所有浮岛。浮岛整体下移 1.2（`env.position.y = 0.35`），岛底都没入水面 0.36–0.83，看不到水面与岛之间的缝。
21. **角色 / 尺度**（§15-C/D）：尺度暂保持现状（按最长边 60 单位归一化）。**第一人称已实现**：`camera.mode: 'third' | 'first'`（first 时相机放在 `camera.eyeHeight`，角色自动隐藏）。两种视角共用同一套平滑：相机位置与视线目标都按 `camera.damping` 做阻尼插值，只有刚进场景 / 切换视角 / 被地形遮挡时才直接吸附，另有 `character.visible` 可在第三人称下单独隐藏角色。移动 / 碰撞 / 采集判定不受影响，第一人称下走近资产照样弹卡片、点击收藏。当前默认仍是第三人称，面板里可切换。尚未做鼠标锁定（现在靠拖拽转视角）；若将来要锁定鼠标，需要再定「点击资产收藏」的替代交互（准星或按键）。
22. **KTX2**：已安装 KTX-Software 4.4.2（`~/tools/KTX`，可用环境变量 `KTX_BIN` 覆盖），`npm run models` 输出 ETC1S 贴图。garden 贴图显存约 320MB → 约 40MB。运行时 KTX2 / Basis 解码器自托管在 `public/basis/`。
23. **garden 池塘**（§15-H）：用 shader 做水，不改模型。地形材质（`pond.material = '8'`）按「与池塘色的距离」生成遮罩，遮罩内叠流动波纹法线、低粗糙度反射、偏水色与菲涅尔天空色。参数在 config `pond` 段。池塘仍可行走（贴图池塘没有深度）。
25. **garden 程序化草**：一个 draw call 的草叶网格，跟随相机、按世界格对齐（叶子钉在世界里不滑动），位置 / 高度 / 朝向 / 颜色全在 vertex shader 里由格子哈希算出，CPU 每帧只推相机位置。
    - 哪里长草：`npm run models` 离线从原始地形贴图烘一张密度图（`public/models/env/garden.grass.png` + 同名 `.json` 范围），绿色处长草，池塘 / 汀步石 / 石拱 / 大花下不长。
    - 贴地：加载时从碰撞体烘一张高度图（256²，一次性）。
    - 风：复用植被的风动 uniform（`grass.windInfluence` 缩放）；背光透光复用假 SSS。
    - 性能：不投射阴影、不进水面反射（植被层）；远处按 `radius × fadeStart` 起缩小消失；数量 = `grass.count`（high 档 11 万片）× 档位表 `grass` 倍率（low 0.2 / mid 0.5 / high 1）。
    - cave 暂用 garden 模型但默认不开草（洞穴里不该有草坪）。
24. **天空盒**：HDRI 到位前用程序化天空（config `sky` 段：四段渐变 + 地平线雾带 + 太阳光晕 + 可选月亮 / 天体）。程序化环境光也用同一个天空 shader 渲染，光照与看到的天空一致。garden / ocean 的初始配色取自参考图；HDRI 到位后把 `environment.mode` 改为 `hdri` 并填 `hdri` 路径即可。

## 15. 仍未解决的问题

- **A. cave 场景**：环境模型什么时候有？在那之前 cave 用哪个模型顶替（默认拿 ocean.glb 换个 config）？
- **B. ocean 场景连通性**：ocean.glb 是多块分离的浮空岩台，角色能在块与块之间走吗？还是每块之间不可达、玩家只在主台面活动？这直接决定 bounds 是一个盒子还是多个区域。
- **C. 角色**：第三人称是有可见角色模型，还是就一个看不见的移动视角？如果有角色，是人形还是别的（决定动画与相机高度）。
- **D. 单位与尺度**：两个 glb 的 1 单位 = 1 米吗？角色相对地形应该多大？没有基准的话我会按「地形最长边 = 60 单位」归一化，之后再改。
- **F. 回退与重进**（待定）：采集后浏览器后退回到已完成场景怎么处理；未完成 cave 直接访问 `/ocean` 是否重定向；Ending「重新开始」回 Landing 还是 cave。
- **G. 导出照片的画框**（待定）：`frame.mode = '3d'` 时画框已在 3D 帧里，§8.4 第 3 步的 2D 边框是否还要叠加。
- **M2 实测补充**：
  - B（**已决定：走水，见 §14-20**）：ocean.glb 由 7 块互不相连的浮空岛组成，模型内无水面。当前按默认方案只让玩家在最大的一块（约 22×15 单位）上活动，采集区与四个资产都摆在这块岛上。
  - D：两个模型尺度差约 5 倍（garden 最长边 8.4，ocean 39.8）。当前按「最长边 ≈ 60 单位」分别归一化（config `env.scale`），结果是 garden 里 1.7m 高的角色和雏菊差不多高、罂粟花高数倍 —— 需确认这是想要的「微缩」感，还是要把角色 / 地形尺度改掉。
  - E：两个模型均无顶点色，风动遮罩将回落到局部 Y 归一化。
  - garden 的池塘底部目前可以行走（水面网格不在碰撞体里），M5 做水面时一并加「水域不可进入」的规则。
- **H. garden 池塘**（新增，M5）——**已决定：用 shader 做水，见 §14-23**。原问题：模型里没有池塘水面几何，也没有凹陷（见 §4.3 更正），水面系统无法判断哪里是水。要做真水面，需要美术二选一：(a) 把池塘挖成真实凹陷，再在池塘高度放水面平面（config `water.level`）；(b) 单独导出一个池塘水面面片，材质名以 `water_` 开头，会自动套用水面材质。在此之前 garden 的 `water.enabled = false`，池塘区域也可以行走。
- **E. 顶点色**：§5.2 约定顶点色 R = 风柔软度、G = 厚度。现有两个 glb 的植被刷了顶点色吗？没刷的话我先用局部 Y 归一化顶替，但效果会明显差一截（整株一起摆而不是根部固定），建议后续在 Blender 里补刷。

---

## 16. 技术选型决策记录（ADR）

记录**否决**的方案与理由，避免三个月后重新纠结一遍。

### ADR-001 — 不引入 r3f-vfx（Three-VFX）作为粒子依赖

- **日期**：项目启动期
- **背景**：`mustache-dev/Three-VFX`（npm: `r3f-vfx`，MIT）是 GPU compute 驱动的粒子系统，功能面完整（soft particles、GPU 排序、curl noise、attractor、碰撞、曲线、几何体粒子 + PBR）。
- **否决理由**：
  1. 它**必须跑在 WebGPURenderer 上** —— 核心包从 `three/webgpu` 引 three、从 `three/tsl` 引 TSL、用 `instancedArray` 存储缓冲。不能塞进普通 WebGL 场景。
  2. 本项目面向大众传播，移动端占比高。安卓 WebGPU 覆盖仍碎片化（需 Android 12+ 且 GPU 厂商受限，部分要 Android 16+），iOS 需 26+。为它改成 WebGPU 栈会牺牲下限。
  3. 它的 WebGL fallback 把模拟退回 CPU —— 正是移动端最不能承受的。
  4. 它的核心优势（GPU compute 撑十万级粒子）本项目用不上：我们只需要几千。
- **保留采纳的部分**：参数命名（§5.3G）、粒子池 + 命名发射器架构（§5.3C）、曲线烘纹理（§5.3D）、算法思路（curl noise / attractor / stretch by speed，MIT 可移植）。
- **重新评估的触发条件**：项目改为桌面向，或 WebGPU 移动端覆盖率显著提升。

### ADR-002 — WebGL 为基线，不走 WebGPU/TSL

- **理由**：同 ADR-001 第 2、3 条。移动端下限 > 桌面端上限。
- **代价**：§5.2 的材质用 CSM + GLSL chunk 实现，比 TSL 啰嗦；将来迁移有成本。
- **缓解**：材质拆成独立 chunk 文件（`materials/chunks/*.glsl`），迁移时按文件重写而不是满仓库找。

### ADR-003 — Theatre.js 只做 dev-time 摆位工具，不进生产

- **背景**：`theatre-js/theatre`（12.7k star，core Apache-2.0，studio AGPL-3.0，studio 仅开发期使用故 AGPL 不影响发行）是可视化时间轴 + 场景编辑器，`@theatre/r3f` 提供 gizmo 拖拽与 state 导出。
- **采纳**：用它摆 12 个资产、ending 三个 slot、采集区、发射点、灯光位置（§9.5）。gizmo 比在面板里输数字快得多。
- **不采纳**：不把 `@theatre/core` 带进生产、不用它的时间轴播放过场。理由：
  1. 本项目的序列很少（每场景一个采集确认序列 + 标本盒入场 + 过场淡入淡出），手写百来行即可，不值得为此增加生产依赖与 bundle 体积 —— 面向大众传播 + 移动端，每几十 KB 都要算；
  2. 项目已是 config 驱动架构，时长与缓动放 config 里与其它参数同源管理更一致；
  3. 公开仓库的 README 长期挂着「1.0 开发临时移至私有仓库」的公告，公开发布节奏不明。**作为 dev 工具这个风险几乎为零**（工具停更不影响生产代码），作为生产依赖则不然。
- **重新评估的触发条件**：需要多轨道精细镜头编排（进场运镜、标本盒多段演出）时，再评估把 core 带进生产。
