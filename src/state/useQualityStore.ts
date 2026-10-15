import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { getGPUTier } from 'detect-gpu'
import { create } from 'zustand'
import type { QualityTier, TierSettings } from '../config/schema'
import { isTouchMode } from '../input/useInput'
import { getGlobalCfg, useGlobalCfg } from './useConfigStore'

// 质量档位（spec §12.1 / §12.2）
// 判定顺序：?quality= 强制 > 设备默认（移动端 low / 桌面 high）> detect-gpu 细化（只会往下调，只用于移动端）
// 运行时帧率守门：连续不达标 → 降一档，只降不升（默认只在移动端开启）。

const ORDER: QualityTier[] = ['low', 'mid', 'high']
const lower = (a: QualityTier, b: QualityTier) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b)

type Source = 'default' | 'gpu' | 'query' | 'panel' | 'auto'

interface QualityState {
  tier: QualityTier
  source: Source
  /** 自动降档是否生效（look dev 时可锁定档位） */
  autoDowngrade: boolean
  log: string[]
  setTier(tier: QualityTier, source: Source): void
  setAutoDowngrade(on: boolean): void
}

function queryTier(): QualityTier | null {
  const read = (q: string) => new URLSearchParams(q).get('quality')
  const v = read(location.search) ?? read(location.hash.split('?')[1] ?? '')
  return v === 'low' || v === 'mid' || v === 'high' ? v : null
}

const initial = (): Pick<QualityState, 'tier' | 'source'> => {
  const q = queryTier()
  if (q) return { tier: q, source: 'query' }
  const g = getGlobalCfg().quality
  return { tier: isTouchMode() ? g.mobileDefault : g.desktopDefault, source: 'default' }
}

export const useQualityStore = create<QualityState>()((set) => ({
  ...initial(),
  // ?quality= 强制指定时视为锁定，不自动降档；桌面固定 high，不自动降档（加载时的掉帧会被误判），只在移动端默认开启
  autoDowngrade: getGlobalCfg().quality.frameGuard.enabled && !queryTier() && isTouchMode(),
  log: [],
  setTier: (tier, source) =>
    set((s) => ({ tier, source, log: [...s.log, `${new Date().toLocaleTimeString()} ${s.tier} → ${tier}（${source}）`].slice(-20) })),
  setAutoDowngrade: (autoDowngrade) => set({ autoDowngrade }),
}))

// 启动时用 detect-gpu 细化一次（跑分表自托管在 public/benchmarks，不走外部 CDN）。
// 只用于移动端：桌面的跑分表经常把能流畅跑 high 的显卡判成低档，桌面固定用 desktopDefault
if (useQualityStore.getState().source === 'default' && isTouchMode()) {
  getGPUTier({ benchmarksURL: `${import.meta.env.BASE_URL}benchmarks` })
    .then((r) => {
      const s = useQualityStore.getState()
      if (s.source !== 'default') return
      const gpu: QualityTier = r.tier <= 1 ? 'low' : r.tier === 2 ? 'mid' : 'high'
      const tier = lower(s.tier, gpu)
      console.info(`[quality] detect-gpu tier ${r.tier}（${r.gpu ?? 'unknown'}）→ ${tier}`)
      if (tier !== s.tier) s.setTier(tier, 'gpu')
    })
    .catch(() => {
      /* 检测失败时保持默认档位，由帧率守门兜底 */
    })
}

/** 当前档位的效果上限 */
export function useTier(): TierSettings {
  const tier = useQualityStore((s) => s.tier)
  return useGlobalCfg((c) => c.quality.tiers[tier])
}
export const getTier = (): TierSettings => getGlobalCfg().quality.tiers[useQualityStore.getState().tier]

/** 把某个效果自己的 quality 限制在当前档位上限以内 */
export const capQuality = (own: QualityTier, cap: QualityTier) => lower(own, cap)

/** 帧率守门：放在场景 Canvas 内 */
export function FrameGuard() {
  const acc = useRef({ elapsed: 0, bad: 0, avgDt: 1 / 60 })
  const cfg = useGlobalCfg((c) => c.quality.frameGuard)
  const tier = useQualityStore((s) => s.tier)

  useEffect(() => {
    acc.current = { elapsed: 0, bad: 0, avgDt: 1 / 60 }
  }, [tier])

  useFrame((_, dt) => {
    const s = useQualityStore.getState()
    const a = acc.current
    a.elapsed += dt
    if (!s.autoDowngrade || s.tier === 'low' || a.elapsed < cfg.warmup) return
    const target = isTouchMode() ? cfg.targetFpsMobile : cfg.targetFpsDesktop
    // 滚动平均帧时间（时间常数 0.5s），避免单帧卡顿误判
    a.avgDt += (dt - a.avgDt) * (1 - Math.exp(-dt / 0.5))
    a.bad = 1 / a.avgDt < target * cfg.threshold ? a.bad + dt : 0
    if (a.bad >= cfg.window) {
      const next = ORDER[ORDER.indexOf(s.tier) - 1]
      s.setTier(next, 'auto')
      console.warn(`[quality] 连续 ${cfg.window}s 低于 ${Math.round(target * cfg.threshold)}fps，自动降档 → ${next}`)
      a.bad = 0
      a.elapsed = 0
    }
  })
  return null
}

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__qualityStore = useQualityStore
