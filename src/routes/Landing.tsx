import { AudioBus } from '../audio/AudioBus'
import { useEffect } from 'react'
import { copy } from '../data/copy'
import { preloadEnv } from '../scene/EnvModel'
import { FILE_DEFAULTS } from '../state/useConfigStore'
import { SCENE_ORDER, useRunStore } from '../state/useRunStore'
import { useRevealOnMount, useTransition } from '../ui/Transition'

/** Landing 上可能出现的 3D 物件，设计待定，本期不实现 */
function LandingArtifactSlot() {
  // TODO: 3D 物件设计确定后在这里实现（独立的小 Canvas，绝对定位，不影响现有排版）
  return null
}

export default function Landing() {
  useRevealOnMount()

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
    <main className="page landing">
      {/* 背景图占位：美术到位后放 public/2d/landing.* */}
      <div className="landing__bg" />
      <div className="landing__artifact">
        <LandingArtifactSlot />
      </div>
      <div className="landing__content">
        <section className="landing__intro">
          <p className="landing__eyebrow">{copy('landing.eyebrow')}</p>
          <h1 className="landing__title">{copy('app.name')}</h1>
          <p className="landing__lede">{copy('landing.lede.1')}</p>
          <p className="landing__lede">{copy('landing.lede.2')}</p>
          <button className="btn btn--primary landing__enter" onClick={enter}>
            {copy('landing.button.enter')}
          </button>
        </section>
        <section className="landing__journey" aria-label={copy('landing.journey')}>
          <p className="landing__journey-title">{copy('landing.journey')}</p>
          <ol className="landing__chapters">
            {SCENE_ORDER.map((scene) => (
              <li key={scene} className={`landing__chapter landing__chapter--${scene}`}>
                <span className="landing__chapter-num">{copy(`landing.chapter.${scene}.num`)}</span>
                <div className="landing__chapter-body">
                  <h2 className="landing__chapter-name">
                    {copy(`landing.chapter.${scene}.name`)}
                    <small>{copy(`landing.chapter.${scene}.place`)}</small>
                  </h2>
                  <p className="landing__chapter-desc">{copy(`landing.chapter.${scene}.desc`)}</p>
                  <p className="landing__chapter-finds">{copy(`landing.chapter.${scene}.finds`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  )
}
