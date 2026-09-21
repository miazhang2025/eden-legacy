import { Suspense, useEffect, useMemo, useState } from 'react'
import { TheatreEndingEditor, TheatreSaveButton } from '../lookdev/theatre'
import { Canvas, type RootState } from '@react-three/fiber'
import { AudioBus } from '../audio/AudioBus'
import { copy } from '../data/copy'
import { resolveBox } from '../data/specimenBoxes'
import { exportPhoto } from '../ending/ExportPhoto'
import { BoxInteraction } from '../ending/BoxInteraction'
import { EndingStage } from '../ending/EndingStage'
import { startReveal } from '../ending/reveal'
import { PostFX } from '../scene/PostFX'
import { SpecimenBox } from '../ending/SpecimenBox'
import { SpecimenTooltip } from '../ending/SpecimenTooltip'
import { useEndingUi } from '../ending/useEndingUi'
import { ALL_COMBOS, selectionsForCombo } from '../data/specimenBoxes'
import { RegisterCanvas } from '../scene/activeCanvas'
import { useConfigStore, useEndingCfg } from '../state/useConfigStore'
import { useDebugStore } from '../state/useDebugStore'
import { useRunStore } from '../state/useRunStore'
import { useRevealOnMount, useTransition } from '../ui/Transition'
import { EndingGuard } from './SceneGuard'

function EndingInner() {
  useRevealOnMount()
  // 进入时读一次 selections 并冻结：「重新开始」会 reset store，不能让淡出过程中画面变空
  const [realSelections] = useState(() => useRunStore.getState().selections)
  // DEV：look dev 面板「模拟组合」，不重玩就能切换 8 种组合预览
  const simulated = useDebugStore((s) => s.simulateCombo)
  const selections = useMemo(
    () => (simulated && ALL_COMBOS.includes(simulated) ? selectionsForCombo(simulated) : realSelections),
    [simulated, realSelections],
  )
  const box = useMemo(() => resolveBox(selections), [selections])

  // 组合补丁深合并进 ending config（spec §8.2）
  useEffect(() => {
    useConfigStore.getState().setEndingPatch(box.configPatch ?? null)
    return () => useConfigStore.getState().setEndingPatch(null)
  }, [box])
  const camera = useEndingCfg((c) => c.camera)
  const background = useEndingCfg((c) => c.background)
  const reveal = useEndingCfg((c) => c.reveal)
  const post = useEndingCfg((c) => c.post)
  const [gl, setGl] = useState<RootState['gl'] | null>(null)
  const exporting = useEndingUi((s) => s.exporting)
  const [shown, setShown] = useState(false)
  const [textShown, setTextShown] = useState(false)

  useEffect(() => {
    useConfigStore.getState().setActive('ending')
    startReveal()
    AudioBus.playAmbience('ending')
    AudioBus.playSfx('boxReveal')
    const a = requestAnimationFrame(() => setShown(true))
    const b = window.setTimeout(() => setTextShown(true), reveal.textDelay * 1000)
    return () => {
      cancelAnimationFrame(a)
      clearTimeout(b)
      AudioBus.stopAmbience()
    }
  }, [reveal.textDelay])

  const restart = () => {
    // 回到 Landing 还是直接进洞穴：待定（spec §15-F），暂回 Landing
    useRunStore.getState().reset()
    useTransition.getState().go('/')
  }

  return (
    <main className="page ending">
      <header className={`ending__text ${textShown ? 'is-visible' : ''}`}>
        <h1 className="ending__name">{box.name}</h1>
        <p className="ending__desc">{box.description}</p>
      </header>
      <div
        className="ending__stage"
        style={{ opacity: shown ? 1 : 0, transitionDuration: `${reveal.fadeDuration}s` }}
      >
        <Canvas
          shadows
          camera={{ fov: camera.fov, position: camera.position }}
          gl={{ antialias: true, preserveDrawingBuffer: true }}
          onCreated={(s) => {
            s.camera.lookAt(...camera.lookAt)
            setGl(s.gl)
          }}
        >
          <color attach="background" args={[background]} />
          <EndingStage />
          <BoxInteraction>
            <SpecimenBox selections={selections} />
          </BoxInteraction>
          <RegisterCanvas />
          <PostFX post={post} />
          {TheatreEndingEditor && (
            <Suspense fallback={null}>
              <TheatreEndingEditor />
            </Suspense>
          )}
        </Canvas>
      </div>
      <footer className={`ending__actions ${textShown ? 'is-visible' : ''}`}>
        <button
          className="btn"
          disabled={!gl || exporting}
          onClick={() => void exportPhoto(box, useConfigStore.getState().endingEffective.photo)}
        >
          {copy('ending.button.export')}
        </button>
        <button className="btn btn--primary" onClick={restart}>
          {copy('ending.button.restart')}
        </button>
      </footer>
      <SpecimenTooltip />
      {TheatreSaveButton && (
        <Suspense fallback={null}>
          <TheatreSaveButton id="ending" />
        </Suspense>
      )}
    </main>
  )
}

export default function Ending() {
  return (
    <EndingGuard>
      <EndingInner />
    </EndingGuard>
  )
}
