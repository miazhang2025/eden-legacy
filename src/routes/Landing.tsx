import { AudioBus } from '../audio/AudioBus'
import { useEffect } from 'react'
import { copy } from '../data/copy'
import { preloadEnv } from '../scene/EnvModel'
import { FILE_DEFAULTS } from '../state/useConfigStore'
import { useLangStore, type Lang } from '../state/useLangStore'
import { SCENE_ORDER, useRunStore } from '../state/useRunStore'
import { useRevealOnMount, useTransition } from '../ui/Transition'
import { DecoField, GlossyHeart, NextIcon, PlayIcon, PrevIcon, SparkleIcon, type DecoItem } from '../ui/Deco'
import { Win } from '../ui/Win'

/** Landing 上可能出现的 3D 物件，设计待定，本期不实现 */
function LandingArtifactSlot() {
  // TODO: 3D 物件设计确定后在这里实现（独立的小 Canvas，绝对定位，不影响现有排版）
  return null
}

const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'EN' },
  { id: 'zh', label: '中' },
]

// 背景里闪烁 / 漂浮的装饰（placeholder）：[类型, left%, top%, 尺寸px, 动画延迟s]
const DECO: DecoItem[] = [
  ['sparkle', 9, 14, 26, 0],
  ['heart', 88, 12, 34, 0.8],
  ['sparkle', 93, 38, 18, 0.6],
  ['note', 13, 46, 22, 1.4],
  ['sparkle', 56, 6, 14, 2.1],
  ['heart', 8, 74, 26, 1.6],
  ['sparkle', 30, 30, 12, 0.3],
  ['star', 72, 26, 16, 1.9],
  ['note', 84, 70, 20, 0.9],
  ['sparkle', 95, 86, 22, 2.6],
  ['sparkle', 22, 88, 16, 1.1],
]

/** 把步骤句子里的 {name} 换成高亮的场景名 */
function StepText({ scene }: { scene: string }) {
  const [before, after] = copy(`landing.step.${scene}.text`).split('{name}')
  return (
    <p className="landing__step-text">
      {before}
      <span className="landing__step-name">{copy(`landing.step.${scene}.name`)}</span>
      {after}
    </p>
  )
}

export default function Landing() {
  useRevealOnMount()
  // 订阅语言，切换时整页重渲染（copy() 本身不是 hook）
  const lang = useLangStore((s) => s.lang)
  const setLang = useLangStore((s) => s.setLang)

  // 停留在 landing 期间后台预热第一个场景的环境模型
  useEffect(() => {
    const { model, collider } = FILE_DEFAULTS.cave.env
    preloadEnv(model, collider)
  }, [])

  const enter = () => {
    AudioBus.resume()
    useRunStore.getState().reset()
    useTransition.getState().go('/cave')
  }

  // 底部滚动横幅：标语和副标题循环（两份，接缝无缝）
  const marquee = `${copy('landing.tagline')}  ♡  ${copy('landing.eyebrow')}  ✧  `

  return (
    <main className={`page landing landing--${lang}`}>
      {/* 背景图占位：美术到位后放 public/2d/landing.* */}
      <div className="landing__bg" />
      <DecoField items={DECO} className="landing__deco" />
      {/* 左侧糖果条纹丝带 + 上下两枚徽章 */}
      <aside className="landing__ribbon" aria-hidden="true">
        <span className="landing__badge landing__badge--top">
          <SparkleIcon />
        </span>
        <span className="landing__badge landing__badge--bottom">
          <GlossyHeart />
        </span>
      </aside>
      <div className="landing__artifact">
        <LandingArtifactSlot />
      </div>
      <div className="landing__lang" role="group" aria-label={copy('landing.lang.switch')}>
        {LANGS.map(({ id, label }) => (
          <button
            key={id}
            className="landing__lang-btn"
            aria-pressed={lang === id}
            lang={id === 'zh' ? 'zh-CN' : 'en'}
            onClick={() => setLang(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="landing__content">
        <header className="landing__hero">
          <p className="landing__banner">
            <span className="landing__banner-badge" aria-hidden="true">
              <SparkleIcon />
            </span>
            <span className="landing__eyebrow">{copy('landing.eyebrow')}</span>
          </p>
          <h1 className="landing__title">
            <SparkleIcon className="landing__title-spark landing__title-spark--a" />
            {copy('landing.title')}
            <SparkleIcon className="landing__title-spark landing__title-spark--b" />
          </h1>
          <p className="landing__tagline">{copy('landing.tagline')}</p>
          <div className="landing__cta">
            <button className="btn btn--primary landing__enter" onClick={enter}>
              <PlayIcon className="btn__icon" />
              {copy('landing.button.enter')}
            </button>
          </div>
        </header>
        <div className="landing__panels">
          <Win className="landing__about" title={copy('landing.about')}>
            <p className="landing__lede">{copy('landing.lede.1')}</p>
            <p className="landing__lede">{copy('landing.lede.2')}</p>
            <p className="landing__lede">{copy('landing.lede.3')}</p>
            <div className="landing__rating" aria-hidden="true">
              <span>★★★★★</span>
              <GlossyHeart className="landing__rating-heart" />
            </div>
          </Win>
          <section className="landing__journey" aria-label={copy('landing.howto')}>
            {/* 玩法做成播放列表：三个场景是三首曲目，底下一条播放器 */}
            <Win className="landing__howto" title={copy('landing.howto')}>
              <ol className="landing__steps">
                {SCENE_ORDER.map((scene, i) => (
                  <li key={scene} className={`landing__step landing__step--${scene}`}>
                    <span className="landing__step-num">{String(i + 1).padStart(2, '0')}</span>
                    <StepText scene={scene} />
                  </li>
                ))}
              </ol>
              <div className="landing__journey-end">
                <div className="landing__player" aria-hidden="true">
                  <span className="landing__player-btn">
                    <PrevIcon />
                  </span>
                  <span className="landing__player-btn landing__player-btn--play">
                    <PlayIcon />
                  </span>
                  <span className="landing__player-btn">
                    <NextIcon />
                  </span>
                  <div className="landing__loading">
                    <i />
                  </div>
                </div>
                <p>{copy('landing.howto.end')}</p>
              </div>
            </Win>
          </section>
        </div>
      </div>
      <div className="landing__marquee" aria-hidden="true">
        <span className="landing__marquee-badge">
          <GlossyHeart />
        </span>
        <div className="landing__marquee-track">
          <span>{marquee.repeat(3)}</span>
          <span>{marquee.repeat(3)}</span>
        </div>
      </div>
    </main>
  )
}
