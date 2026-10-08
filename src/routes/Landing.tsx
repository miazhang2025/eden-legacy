import { AudioBus } from '../audio/AudioBus'
import { useEffect } from 'react'
import { copy } from '../data/copy'
import { preloadEnv } from '../scene/EnvModel'
import { FILE_DEFAULTS } from '../state/useConfigStore'
import { useLangStore, type Lang } from '../state/useLangStore'
import { SCENE_ORDER, useRunStore } from '../state/useRunStore'
import { useRevealOnMount, useTransition } from '../ui/Transition'
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

// 背景里闪烁的小星星 / 爱心（纯装饰，placeholder）：[字符, left%, top%, 字号px, 动画延迟s]
const SPARKS: [string, number, number, number, number][] = [
  ['✦', 6, 12, 22, 0],
  ['♡', 46, 8, 18, 1.2],
  ['✧', 92, 30, 26, 0.6],
  ['✦', 52, 88, 16, 2.1],
  ['♡', 4, 78, 24, 1.6],
  ['✧', 40, 52, 14, 0.3],
  ['✦', 96, 84, 20, 2.6],
  ['★', 60, 18, 12, 1.9],
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

  return (
    <main className={`page landing landing--${lang}`}>
      {/* 背景图占位：美术到位后放 public/2d/landing.* */}
      <div className="landing__bg" />
      <div className="landing__sparks" aria-hidden="true">
        {SPARKS.map(([c, x, y, size, delay], i) => (
          <span key={i} style={{ left: `${x}%`, top: `${y}%`, fontSize: size, animationDelay: `${delay}s` }}>
            {c}
          </span>
        ))}
      </div>
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
        <section className="landing__intro">
          <p className="landing__eyebrow">{copy('landing.eyebrow')}</p>
          <h1 className="landing__title">{copy('landing.title')}</h1>
          <Win className="landing__about" title={copy('landing.about')}>
            <p className="landing__lede">{copy('landing.lede.1')}</p>
            <p className="landing__lede">{copy('landing.lede.2')}</p>
            <p className="landing__lede">{copy('landing.lede.3')}</p>
          </Win>
          <div className="landing__cta">
            <button className="btn btn--primary landing__enter" onClick={enter}>
              {copy('landing.button.enter')}
            </button>
            <p className="landing__tagline">{copy('landing.tagline')}</p>
          </div>
        </section>
        <section className="landing__journey" aria-label={copy('landing.howto')}>
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
              <p>{copy('landing.howto.end')}</p>
              <div className="landing__loading" aria-hidden="true">
                <i />
              </div>
            </div>
          </Win>
        </section>
      </div>
    </main>
  )
}
