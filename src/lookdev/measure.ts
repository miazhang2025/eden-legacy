import type { Accessor, BuildContext } from './buildPanel'

/** 采样 frames 帧的平均帧间隔（ms） */
function sampleFrameMs(frames: number): Promise<number> {
  return new Promise((resolve) => {
    let n = 0
    let sum = 0
    let last = performance.now()
    const tick = (t: number) => {
      sum += t - last
      last = t
      if (++n >= frames) resolve(sum / frames)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

const WARMUP_FRAMES = 20
const SAMPLE_FRAMES = 120

/**
 * 某个开关打开 / 关闭时的平均帧时间。测完恢复原值。
 * 注意：浏览器帧率被显示器刷新率封顶，效果开销小于余量时 Δ 会接近 0；
 * 要看真实开销请在性能吃紧的设备上测，或配合 DevTools Performance 面板。
 */
export async function measureToggle(ctx: BuildContext, acc: Accessor): Promise<{ on: number; off: number }> {
  const original = acc.read(ctx.getConfig())
  const set = (v: boolean) => ctx.update((d) => acc.write(d, v))
  try {
    set(true)
    await sampleFrameMs(WARMUP_FRAMES)
    const on = await sampleFrameMs(SAMPLE_FRAMES)
    set(false)
    await sampleFrameMs(WARMUP_FRAMES)
    const off = await sampleFrameMs(SAMPLE_FRAMES)
    return { on, off }
  } finally {
    ctx.update((d) => acc.write(d, original))
  }
}
