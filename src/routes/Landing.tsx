import { AudioBus } from '../audio/AudioBus'
import { useEffect } from 'react'
import { copy } from '../data/copy'
import { preloadEnv } from '../scene/EnvModel'
import { FILE_DEFAULTS } from '../state/useConfigStore'
import { useRunStore } from '../state/useRunStore'
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
        <h1 className="landing__title">{copy('landing.title')}</h1>
        <p className="landing__subtitle">{copy('landing.subtitle')}</p>
        <button className="btn btn--primary" onClick={enter}>
          {copy('landing.button.enter')}
        </button>
      </div>
    </main>
  )
}
