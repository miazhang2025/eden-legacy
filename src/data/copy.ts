// 唯一文案出口。界面里不出现硬编码字符串，所有文字按 key 从这里取。

import { useLangStore } from '../state/useLangStore'

const COPY: Record<string, string> = {
  // ---------- 项目 ----------
  'app.name': '伊甸遗存录',
  'app.brand': '伊甸遗存录 · EDEN LEGACY',

  // ---------- Landing ----------
  'landing.eyebrow': '未来自然的生命档案',
  'landing.title': '伊甸遗存录',
  'landing.about': 'ABOUT PROJECT',
  'landing.lede.1': '这里保存的不是已经死亡的自然标本，而是仍然持续生长、回应与变化的生命系统。',
  'landing.lede.2': '穿越矿洞、海洋与花园。观察它们。靠近它们。感知它们的回应。',
  'landing.lede.3': '你所留下的，不是收藏，而是一份关于自然的记忆。',
  'landing.button.enter': '开始游戏',
  'landing.button.loading': '加载中',
  'landing.tagline': '每一次相遇，都会留下痕迹。',
  'landing.howto': 'HOW TO PLAY',
  'landing.lang.switch': '切换语言',
  // 步骤句子里的 {name} 会替换成场景名并高亮
  'landing.step.cave.name': '水晶矿洞 The Crystal Cave',
  'landing.step.cave.text': '进入 {name}，激活其中的矿物晶体。',
  'landing.step.ocean.name': '海洋领域 The Ocean Realm',
  'landing.step.ocean.text': '穿过 {name}，追随漂浮与流动的生命体。',
  'landing.step.garden.name': '未来花园 The Future Garden',
  'landing.step.garden.text': '进入 {name}，与不断生长的生物互动。',
  'landing.howto.end': '完成探索后，生成属于你的 Living Archive / 生命档案。',

  // ---------- 场景提示语 ----------
  'scene.cave.prompt': '岩层替时间藏住了许多东西。选一份，让它跟你离开。',
  'scene.ocean.prompt': '潮水会带走大多数相遇。留下一个，不让它消失。',
  'scene.garden.prompt': '花园从不停止更替。挑一种，让它在别处继续存在。',
  'card.button.collect': '收集',
  'card.title': '标本档案',
  'card.button.locked': '先去看看其他 {n} 件',
  'scene.progress': '已发现 {found} / {total}',
  'scene.progress.done': '都找到了，选择一件带走吧',

  // ---------- 竖屏提示 ----------
  'orientation.hint': '请将设备横向放置',

  // 资产 key：.name 主名 / .subname 名字下方的小字（英文版留空） / .desc 描述。注释里是原型物种。
  // ---------- 资产：洞穴 ----------
  // 摩洛哥蓝色重晶石
  'asset.cave_ore_01.name': '沉蓝晶脉',
  'asset.cave_ore_01.subname': 'Deep Azure Vein',
  'asset.cave_ore_01.desc': '生长于岩层裂隙中的蓝色晶体群，记录着地层深处缓慢结晶的时间。',
  // 水晶兰
  'asset.cave_ore_02.name': '幽辉隐花',
  'asset.cave_ore_02.subname': 'Ghostglow Bloom',
  'asset.cave_ore_02.desc': '一种不依赖阳光生长的半透明植物，只在微弱矿物反光中显现幽冷的光泽。',
  // Oxygyne
  'asset.cave_mushroom_01.name': '深隙异兰',
  'asset.cave_mushroom_01.subname': 'Riftveil Oxygyne',
  'asset.cave_mushroom_01.desc': '栖息于幽暗缝隙中的稀有异种植物，脆弱却始终保持着安静而隐秘的生命力。',
  // Mycena roseoflava
  'asset.cave_mushroom_02.name': '绯雾菌群',
  'asset.cave_mushroom_02.subname': 'Rose Mist Colony',
  'asset.cave_mushroom_02.desc': '附着在矿物裂隙间的微型菌群，在靠近时会释放出细微而柔亮的孢子光尘。',

  // ---------- 资产：海洋 ----------
  // 砗磲
  'asset.ocean_shell_01.name': '潮光巨贝',
  'asset.ocean_shell_01.subname': 'Tidal Lumen Clam',
  'asset.ocean_shell_01.desc': '一种巨大而缓慢的海洋生命，壳体内部储存着如潮汐般流动的柔和光泽。',
  // 笠螺
  'asset.ocean_shell_02.name': '附岩笠灵',
  'asset.ocean_shell_02.subname': 'Stoneveil Limpet',
  'asset.ocean_shell_02.desc': '紧贴岩面的微小贝类，以沉默而持久的方式守护着潮间带留下的痕迹。',
  // 裸海蝶
  'asset.ocean_fish_01.name': '浮翼海蝶',
  'asset.ocean_fish_01.subname': 'Driftwing Sea Angel',
  'asset.ocean_fish_01.desc': '轻盈透明的海洋生物，如同漂浮于水中的一枚薄翼，在流动中显露短暂而梦幻的身影。',
  // 斗鱼
  'asset.ocean_fish_02.name': '镜鳍游斗',
  'asset.ocean_fish_02.subname': 'Mirrorfin Betta',
  'asset.ocean_fish_02.desc': '拥有流动鳍翼与鲜明色彩的敏感鱼类，在光线变化中展现出近乎幻觉般的姿态。',

  // ---------- 资产：花园 ----------
  // 黑蝙蝠花
  'asset.garden_flower_01.name': '夜蝠幽花',
  'asset.garden_flower_01.subname': 'Nocturne Bat Bloom',
  'asset.garden_flower_01.desc': '形态如黑翼展开的异色花卉，在静止中带着一种神秘而近乎仪式般的气息。',
  // 翡翠葛
  'asset.garden_flower_02.name': '碧垂藤华',
  'asset.garden_flower_02.subname': 'Jade Cascade Vine',
  'asset.garden_flower_02.desc': '垂落生长的翡翠色花序如同被凝固的瀑流，为花园留下明亮而冷冽的生命痕迹。',
  // luna moth
  'asset.garden_butterfly_01.name': '月辉夜蛾',
  'asset.garden_butterfly_01.subname': 'Moonveil Moth',
  'asset.garden_butterfly_01.desc': '一只仿佛被夜色与月光共同塑成的蝶蛾，拖曳着柔长尾翼轻盈掠过花间。',
  // 杜伯矩蛱蝶
  'asset.garden_butterfly_02.name': '琥纹矩蝶',
  'asset.garden_butterfly_02.subname': 'Amber Crest Butterfly',
  'asset.garden_butterfly_02.desc': '拥有清晰纹路与稳定节奏的蝶类生命，在短暂停驻中展现花园最精致的秩序感。',

  // ---------- 标本盒（cave × ocean × garden 类别组合） ----------
  'box.mineral_shell_flower.name': '恒久之匣',
  'box.mineral_shell_flower.desc': '矿石、贝壳与花，三种缓慢的时间被安放在同一片黑暗里。',
  'box.mineral_shell_butterfly.name': '静与翼',
  'box.mineral_shell_butterfly.desc': '坚硬的沉积与轻盈的振翅，大地与天空在匣中相遇。',
  'box.mineral_fish_flower.name': '流光之匣',
  'box.mineral_fish_flower.desc': '晶体的冷光、鱼群的游动与花的绽放，在这里彼此映照。',
  'box.mineral_fish_butterfly.name': '迁徙者',
  'box.mineral_fish_butterfly.desc': '一块不会移动的石头，守护着两种永远在路上的生命。',
  'box.plant_shell_flower.name': '潮湿的梦',
  'box.plant_shell_flower.desc': '菌丝、潮汐与花瓣，都是水写给大地的信。',
  'box.plant_shell_butterfly.name': '微光纪',
  'box.plant_shell_butterfly.desc': '菌光、螺光与蝶翼的虹光，被收进同一个夜晚。',
  'box.plant_fish_flower.name': '生生之匣',
  'box.plant_fish_flower.desc': '从地底到海洋再到花园，生命在每一处都找到了自己的形状。',
  'box.plant_fish_butterfly.name': '游离者',
  'box.plant_fish_butterfly.desc': '它们从不属于某一个地方，却在这里第一次安静下来。',
  'box.fallback.desc': '三件来自不同世界的标本，被安放在同一个匣中。',

  // ---------- Ending ----------
  'ending.button.export': '导出照片',
  'ending.window.title': '生命档案',
  'ending.button.restart': '重新开始',
  'ending.photo.title': '标本照片',
  'ending.photo.save': '保存照片',
  'ending.photo.close': '关闭',
}

// 英文表只需覆盖已翻译的 key，缺的回落到中文。
const COPY_EN: Record<string, string> = {
  // ---------- 项目 ----------
  'app.name': 'Relics of Eden',
  'app.brand': 'RELICS OF EDEN',

  // ---------- Landing ----------
  'landing.eyebrow': 'A Living Archive of Future Nature',
  'landing.title': 'RELICS OF EDEN',
  'landing.about': 'ABOUT PROJECT',
  'landing.lede.1':
    'What is preserved here is not a collection of lifeless specimens, but a living system that continues to grow, respond, and change.',
  'landing.lede.2': 'Travel through the cave, ocean, and garden. Observe them. Approach them. Sense how they respond.',
  'landing.lede.3': 'What you leave behind is not a collection, but a memory of nature.',
  'landing.button.enter': 'START GAME',
  'landing.button.loading': 'LOADING',
  'landing.tagline': 'Every encounter leaves a trace.',
  'landing.howto': 'HOW TO PLAY',
  'landing.lang.switch': 'Switch language',
  'landing.step.cave.name': 'Veins of the Deep',
  'landing.step.cave.text': 'Enter {name}, explore and activate the mineral formations within.',
  'landing.step.ocean.name': 'Sanctuary of Tides',
  'landing.step.ocean.text': 'Cross {name}, explore and follow the drifting, flowing life forms.',
  'landing.step.garden.name': 'Garden of Becoming',
  'landing.step.garden.text': 'Enter {name}, explore and interact with organisms that continue to grow and transform.',
  'landing.howto.end': 'Complete your journey to reveal your own Living Archive.',

  // ---------- 场景提示语 ----------
  'scene.cave.prompt': 'The rock strata have hidden many things for time. Choose one, and let it leave with you.',
  'scene.ocean.prompt': 'The tide carries most encounters away. Leave one behind, and do not let it disappear.',
  'scene.garden.prompt': 'The garden never stops changing. Choose one, and let it continue somewhere else.',
  'card.button.collect': 'Collect',
  'card.title': 'Specimen File',
  'card.button.locked': 'See {n} more first',
  'scene.progress': 'Discovered {found} / {total}',
  'scene.progress.done': 'All found. Choose one to take with you.',

  // ---------- 竖屏提示 ----------
  'orientation.hint': 'Please rotate your device to landscape',

  // ---------- 资产：洞穴 ----------
  'asset.cave_ore_01.name': 'Deep Azure Vein',
  'asset.cave_ore_01.subname': '',
  'asset.cave_ore_01.desc':
    'A cluster of blue crystals growing within the fissures of rock strata, recording the slow passage of crystallization deep beneath the earth.',
  'asset.cave_ore_02.name': 'Ghostglow Bloom',
  'asset.cave_ore_02.subname': '',
  'asset.cave_ore_02.desc':
    'A translucent plant that grows without relying on sunlight, revealing its cold, spectral sheen only in the faint reflection of nearby minerals.',
  'asset.cave_mushroom_01.name': 'Riftveil Oxygyne',
  'asset.cave_mushroom_01.subname': '',
  'asset.cave_mushroom_01.desc':
    'A rare and unusual plant dwelling in dark crevices, fragile in form yet quietly sustaining a hidden vitality.',
  'asset.cave_mushroom_02.name': 'Rose Mist Colony',
  'asset.cave_mushroom_02.subname': '',
  'asset.cave_mushroom_02.desc':
    'A miniature fungal colony attached to mineral cracks, releasing fine, softly luminous spore-dust when approached.',

  // ---------- 资产：海洋 ----------
  'asset.ocean_shell_01.name': 'Tidal Lumen Clam',
  'asset.ocean_shell_01.subname': '',
  'asset.ocean_shell_01.desc':
    'A vast and slow-moving marine life form whose shell holds a soft radiance, flowing gently like the rhythm of the tide.',
  'asset.ocean_shell_02.name': 'Stoneveil Limpet',
  'asset.ocean_shell_02.subname': '',
  'asset.ocean_shell_02.desc':
    'A small shell creature clinging closely to rock surfaces, quietly and persistently guarding the traces left behind by the shoreline.',
  'asset.ocean_fish_01.name': 'Driftwing Sea Angel',
  'asset.ocean_fish_01.subname': '',
  'asset.ocean_fish_01.desc':
    'A light, translucent marine being, like a delicate wing suspended in water, revealing a fleeting and dreamlike presence as it drifts.',
  'asset.ocean_fish_02.name': 'Mirrorfin Betta',
  'asset.ocean_fish_02.subname': '',
  'asset.ocean_fish_02.desc':
    'A sensitive fish with flowing fins and striking colors, shifting through the light with an almost hallucinatory grace.',

  // ---------- 资产：花园 ----------
  'asset.garden_flower_01.name': 'Nocturne Bat Bloom',
  'asset.garden_flower_01.subname': '',
  'asset.garden_flower_01.desc':
    'An otherworldly flower unfolding like a pair of dark wings, carrying a mysterious, almost ritualistic presence in stillness.',
  'asset.garden_flower_02.name': 'Jade Cascade Vine',
  'asset.garden_flower_02.subname': '',
  'asset.garden_flower_02.desc':
    'Cascading clusters of jade-green blossoms hang like a frozen waterfall, leaving a vivid yet cool trace of life within the garden.',
  'asset.garden_butterfly_01.name': 'Moonveil Moth',
  'asset.garden_butterfly_01.subname': '',
  'asset.garden_butterfly_01.desc':
    'A moth seemingly shaped by moonlight and night itself, gliding softly through the flowers with long, trailing tails.',
  'asset.garden_butterfly_02.name': 'Amber Crest Butterfly',
  'asset.garden_butterfly_02.subname': '',
  'asset.garden_butterfly_02.desc':
    'A butterfly marked by precise patterns and measured rhythm, revealing the garden’s delicate sense of order in each brief pause.',

  // ---------- 标本盒 ----------
  // 矿物 × 贝类 × 花
  'box.mineral_shell_flower.name': 'Stone Tide Bloom',
  'box.mineral_shell_flower.desc': 'Stone, tide, and bloom converge here, preserving three different rhythms of nature.',
  // 矿物 × 贝类 × 蝶蛾
  'box.mineral_shell_butterfly.name': 'Shellwing Trace',
  'box.mineral_shell_butterfly.desc': 'Crystal and shell remain still, while wings carry their quiet memory elsewhere.',
  // 矿物 × 游动生命 × 花
  'box.mineral_fish_flower.name': 'Crystal Tide Bloom',
  'box.mineral_fish_flower.desc': 'Crystal stillness, drifting life, and fleeting bloom form a memory held in motion.',
  // 矿物 × 游动生命 × 蝶蛾
  'box.mineral_fish_butterfly.name': 'Crystal Drift Flight',
  'box.mineral_fish_butterfly.desc':
    'From buried crystal veins to moving waters and wandering wings, life continues across changing environments.',
  // 植物 × 贝类 × 花
  'box.plant_shell_flower.name': 'Rooted Tide Bloom',
  'box.plant_shell_flower.desc':
    'Rooted growth, tidal attachment, and garden bloom reveal the same quiet persistence of life.',
  // 植物 × 贝类 × 蝶蛾
  'box.plant_shell_butterfly.name': 'Root and Wing Passage',
  'box.plant_shell_butterfly.desc': 'Some lives root and remain, while others take wing toward new places to belong.',
  // 植物 × 游动生命 × 花
  'box.plant_fish_flower.name': 'Living Current Bloom',
  'box.plant_fish_flower.desc': 'From hidden growth to drifting waters and open bloom, life continues through constant change.',
  // 植物 × 游动生命 × 蝶蛾
  'box.plant_fish_butterfly.name': 'Wandering Life Trace',
  'box.plant_fish_butterfly.desc': 'Growth, drift, and flight form an unfinished journey, with life still moving onward.',
  'box.fallback.desc': 'Three specimens from three different worlds, laid together in one box.',

  // ---------- Ending ----------
  'ending.button.export': 'Export Photo',
  'ending.window.title': 'Living Archive',
  'ending.button.restart': 'Restart',
  'ending.photo.title': 'Specimen Photo',
  'ending.photo.save': 'Save Photo',
  'ending.photo.close': 'Close',
}

/**
 * 按 key 取当前语言的文案。缺失的 key 在开发环境下报警告并原样返回 key，方便发现遗漏。
 * 组件里需要随语言切换重渲染时，自己订阅 useLangStore。
 */
export function copy(key: string): string {
  const text = (useLangStore.getState().lang === 'en' ? COPY_EN[key] : undefined) ?? COPY[key]
  if (text === undefined) {
    if (import.meta.env.DEV) console.warn(`[copy] 缺少文案: ${key}`)
    return key
  }
  return text
}
