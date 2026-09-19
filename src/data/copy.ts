// 唯一文案出口。界面里不出现硬编码字符串，所有文字按 key 从这里取。

const COPY: Record<string, string> = {
  // ---------- Landing ----------
  'landing.title': '生态标本盒',
  'landing.subtitle': '穿过地层、潮汐与花园，为这个世界留下三件标本',
  'landing.button.enter': '进入',

  // ---------- 场景提示语 ----------
  'scene.cave.prompt': '请选择一种你希望保存的地下生命痕迹',
  'scene.ocean.prompt': '请选择一种你希望保存的海洋生命',
  'scene.garden.prompt': '请选择一种你希望保存的花园生命',
  'card.button.collect': '收集',

  // ---------- 竖屏提示 ----------
  'orientation.hint': '请将设备横向放置',

  // ---------- 资产：洞穴 ----------
  'asset.cave_ore_01.name': '霜晶簇',
  'asset.cave_ore_01.desc': '在无光的岩缝里生长了上万年，每一道棱面都封存着一次地壳的呼吸。',
  'asset.cave_ore_02.name': '紫夜石',
  'asset.cave_ore_02.desc': '暗紫色的矿脉只在深处的寂静中缓慢结晶，触手微凉。',
  'asset.cave_mushroom_01.name': '萤伞菇',
  'asset.cave_mushroom_01.desc': '吸收岩壁的湿气发出幽绿微光，是洞穴里唯一会呼吸的灯。',
  'asset.cave_mushroom_02.name': '琥珀菌',
  'asset.cave_mushroom_02.desc': '菌伞像凝固的树脂，在黑暗中为路过的生命指出方向。',

  // ---------- 资产：海洋 ----------
  'asset.ocean_shell_01.name': '月纹贝',
  'asset.ocean_shell_01.desc': '壳上的螺纹记录着每一次潮起潮落，像一本合上的潮汐年历。',
  'asset.ocean_shell_02.name': '镜光螺',
  'asset.ocean_shell_02.desc': '螺壳内壁如镜，能把深海里微弱的光放大成一片星空。',
  'asset.ocean_fish_01.name': '蓝鳞游鱼',
  'asset.ocean_fish_01.desc': '成群游过时像一阵流动的蓝色的风，从不在同一片水域停留。',
  'asset.ocean_fish_02.name': '霞尾鱼',
  'asset.ocean_fish_02.desc': '尾鳍染着落日的颜色，只在黄昏时分游近海面。',

  // ---------- 资产：花园 ----------
  'asset.garden_flower_01.name': '晨露蔷薇',
  'asset.garden_flower_01.desc': '花瓣在清晨收集露水，正午之前便把它们还给土地。',
  'asset.garden_flower_02.name': '日轮菊',
  'asset.garden_flower_02.desc': '花盘永远追随阳光转动，阴天里也记得太阳的方向。',
  'asset.garden_butterfly_01.name': '青翼蝶',
  'asset.garden_butterfly_01.desc': '翅上的蓝并非色素，而是光在鳞片之间折射出的幻影。',
  'asset.garden_butterfly_02.name': '暮光蛾',
  'asset.garden_butterfly_02.desc': '黄昏时从花丛中醒来，循着最后一缕余温飞行。',

  // ---------- 标本盒（cave × ocean × garden 类别组合） ----------
  'box.ore_shell_flower.name': '恒久之匣',
  'box.ore_shell_flower.desc': '矿石、贝壳与花，三种缓慢的时间被安放在同一片黑暗里。',
  'box.ore_shell_butterfly.name': '静与翼',
  'box.ore_shell_butterfly.desc': '坚硬的沉积与轻盈的振翅，大地与天空在匣中相遇。',
  'box.ore_fish_flower.name': '流光之匣',
  'box.ore_fish_flower.desc': '晶体的冷光、鱼群的游动与花的绽放，在这里彼此映照。',
  'box.ore_fish_butterfly.name': '迁徙者',
  'box.ore_fish_butterfly.desc': '一块不会移动的石头，守护着两种永远在路上的生命。',
  'box.mushroom_shell_flower.name': '潮湿的梦',
  'box.mushroom_shell_flower.desc': '菌丝、潮汐与花瓣，都是水写给大地的信。',
  'box.mushroom_shell_butterfly.name': '微光纪',
  'box.mushroom_shell_butterfly.desc': '菌光、螺光与蝶翼的虹光，被收进同一个夜晚。',
  'box.mushroom_fish_flower.name': '生生之匣',
  'box.mushroom_fish_flower.desc': '从地底到海洋再到花园，生命在每一处都找到了自己的形状。',
  'box.mushroom_fish_butterfly.name': '游离者',
  'box.mushroom_fish_butterfly.desc': '它们从不属于某一个地方，却在这里第一次安静下来。',
  'box.fallback.desc': '三件来自不同世界的标本，被安放在同一个匣中。',

  // ---------- Ending ----------
  'ending.button.export': '导出照片',
  'ending.button.restart': '重新开始',
}

/** 按 key 取文案。缺失的 key 在开发环境下报警告并原样返回 key，方便发现遗漏。 */
export function copy(key: string): string {
  const text = COPY[key]
  if (text === undefined) {
    if (import.meta.env.DEV) console.warn(`[copy] 缺少文案: ${key}`)
    return key
  }
  return text
}
