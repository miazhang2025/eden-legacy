import { lazy } from 'react'

// Theatre 摆位工具的入口开关：仅 DEV 且带 ?theatre=1 时启用。
// 生产构建中 import.meta.env.DEV 为 false，整段（包括 lazy import）会被移除。
export const THEATRE_ENABLED =
  import.meta.env.DEV &&
  (new URLSearchParams(location.search).get('theatre') === '1' ||
    new URLSearchParams(location.hash.split('?')[1] ?? '').get('theatre') === '1')

export const TheatreSceneEditor = THEATRE_ENABLED
  ? lazy(() => import('./TheatreEditor').then((m) => ({ default: m.TheatreSceneEditor })))
  : null

export const TheatreEndingEditor = THEATRE_ENABLED
  ? lazy(() => import('./TheatreEditor').then((m) => ({ default: m.TheatreEndingEditor })))
  : null

export const TheatreSaveButton = THEATRE_ENABLED
  ? lazy(() => import('./TheatreEditor').then((m) => ({ default: m.TheatreSaveButton })))
  : null
