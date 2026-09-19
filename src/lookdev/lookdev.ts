import { lazy } from 'react'

// Look dev 面板入口：仅 DEV（spec §14-13：不进生产）。生产构建中整段被移除。
export const LookDevPanel = import.meta.env.DEV ? lazy(() => import('./LookDevPanel')) : null
