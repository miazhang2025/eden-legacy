import { useId, type CSSProperties, type ReactNode } from 'react'

// 装饰小物件（Y2K 粉色复古界面）：发光四角星、光泽爱心、播放器图标、卷草花饰框。纯装饰，全部 aria-hidden。

/** 四角星（闪光） */
export function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0C12.9 8 16 11.1 24 12C16 12.9 12.9 16 12 24C11.1 16 8 12.9 0 12C8 11.1 11.1 8 12 0Z" fill="currentColor" />
    </svg>
  )
}

/** 光泽爱心：径向渐变 + 左上高光，像糖果 / 果冻 */
export function GlossyHeart({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg className={className} viewBox="0 0 32 29" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}g`} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor="#fff4f9" />
          <stop offset="0.45" stopColor="#ffc1dc" />
          <stop offset="1" stopColor="#f08fbd" />
        </radialGradient>
      </defs>
      <path
        d="M16 28.5C14.6 27.3 1 18.5 1 9.2C1 4.6 4.6 1 9.1 1C12 1 14.6 2.6 16 5C17.4 2.6 20 1 22.9 1C27.4 1 31 4.6 31 9.2C31 18.5 17.4 27.3 16 28.5Z"
        fill={`url(#${id}g)`}
        stroke="#fff"
        strokeWidth="1.5"
      />
      <ellipse cx="9" cy="8" rx="3.6" ry="2.2" fill="#fff" opacity="0.85" transform="rotate(-30 9 8)" />
    </svg>
  )
}

export function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.5L13 8L4 13.5Z" fill="currentColor" />
    </svg>
  )
}
export function PrevIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3H5V13H3ZM13 3V13L5.5 8Z" fill="currentColor" />
    </svg>
  )
}
export function NextIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11 3H13V13H11ZM3 3V13L10.5 8Z" fill="currentColor" />
    </svg>
  )
}
export function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5.5 3L6.5 1.5H9.5L10.5 3H13.5C14.3 3 15 3.7 15 4.5V12.5C15 13.3 14.3 14 13.5 14H2.5C1.7 14 1 13.3 1 12.5V4.5C1 3.7 1.7 3 2.5 3ZM8 12A3.5 3.5 0 1 0 8 5A3.5 3.5 0 1 0 8 12Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  )
}

/** 散落的装饰：[类型, left%, top%, 尺寸px, 动画延迟s] */
export type DecoItem = ['sparkle' | 'heart' | 'note' | 'star', number, number, number, number]

/** 背景里闪烁 / 漂浮的星星、爱心、音符 */
export function DecoField({ items, className = '' }: { items: DecoItem[]; className?: string }) {
  return (
    <div className={`deco-field ${className}`} aria-hidden="true">
      {items.map(([kind, x, y, size, delay], i) => {
        const style = { left: `${x}%`, top: `${y}%`, width: size, height: size, fontSize: size, animationDelay: `${delay}s` } as CSSProperties
        return (
          <span key={i} className={`deco deco--${kind}`} style={style}>
            {kind === 'sparkle' && <SparkleIcon />}
            {kind === 'heart' && <GlossyHeart />}
            {kind === 'note' && '♪'}
            {kind === 'star' && '☆'}
          </span>
        )
      })}
    </div>
  )
}

/** 卷草花饰的一角（左上角朝向，其它三角用 CSS 翻转） */
function FlourishCorner() {
  return (
    <svg className="flourish__corner" viewBox="0 0 64 64" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        {/* 主卷：沿角落弯过来，末端卷成小螺旋 */}
        <path d="M2 62C2 30 14 8 40 4C48 3 54 6 54 12C54 17 48 19 45 16C42 13 45 9 48 10" />
        {/* 竖向那边的小卷 */}
        <path d="M4 44C10 40 16 41 17 46C18 50 14 53 11 51C8.5 49.5 10 46 12.5 46.5" />
        {/* 内侧细卷 */}
        <path d="M14 22C20 18 27 19 28 24C28.8 27.5 25.5 29.5 23 28C21 26.8 22 24 24 24.5" />
      </g>
      <circle cx="30" cy="12" r="1.6" fill="currentColor" />
      <circle cx="9" cy="30" r="1.6" fill="currentColor" />
    </svg>
  )
}

/** 顶 / 底中间的花饰：两侧对卷 + 中间一颗心 */
function FlourishCrest() {
  return (
    <svg className="flourish__crest" viewBox="0 0 120 28" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M0 22C20 22 34 20 44 12C49 8 47 2 42 3C38 4 38 9 42 9.5" />
        <path d="M120 22C100 22 86 20 76 12C71 8 73 2 78 3C82 4 82 9 78 9.5" />
      </g>
      <path
        d="M60 25C59.2 24.3 51.5 19.3 51.5 14C51.5 11.4 53.5 9.4 56 9.4C57.7 9.4 59.2 10.3 60 11.7C60.8 10.3 62.3 9.4 64 9.4C66.5 9.4 68.5 11.4 68.5 14C68.5 19.3 60.8 24.3 60 25Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** 卷草花饰框（参考：黑底粉色线描花框）：四角卷草 + 上下居中花饰，边线随内容伸缩 */
export function OrnateFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flourish ${className}`}>
      <FlourishCorner />
      <FlourishCorner />
      <FlourishCorner />
      <FlourishCorner />
      <FlourishCrest />
      <FlourishCrest />
      {/* 边线：上下各两段（中间让给花饰），左右各一段 */}
      <i className="flourish__line flourish__line--t1" />
      <i className="flourish__line flourish__line--t2" />
      <i className="flourish__line flourish__line--b1" />
      <i className="flourish__line flourish__line--b2" />
      <i className="flourish__line flourish__line--l" />
      <i className="flourish__line flourish__line--r" />
      <div className="flourish__body">{children}</div>
    </div>
  )
}
