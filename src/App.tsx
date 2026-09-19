import { Suspense } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import Ending from './routes/Ending'
import Landing from './routes/Landing'
import SceneCave from './routes/SceneCave'
import SceneGarden from './routes/SceneGarden'
import SceneOcean from './routes/SceneOcean'
import { OrientationGate } from './input/OrientationGate'
import { LookDevPanel } from './lookdev/lookdev'
import { Transition } from './ui/Transition'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/cave" element={<SceneCave />} />
        <Route path="/ocean" element={<SceneOcean />} />
        <Route path="/garden" element={<SceneGarden />} />
        <Route path="/ending" element={<Ending />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Transition />
      <OrientationGate />
      {LookDevPanel && (
        <Suspense fallback={null}>
          <LookDevPanel />
        </Suspense>
      )}
    </HashRouter>
  )
}
