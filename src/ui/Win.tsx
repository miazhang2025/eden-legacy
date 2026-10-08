import type { HTMLAttributes, ReactNode } from 'react'

interface WinProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  children: ReactNode
}

/** 复古系统窗口样式的面板：标题栏 + 三个装饰按钮 + 内容区（placeholder，后面换真实素材） */
export function Win({ title, children, className = '', ...rest }: WinProps) {
  return (
    <div className={`win ${className}`} {...rest}>
      <div className="win__bar">
        <span className="win__title">{title}</span>
        <span className="win__ctrls" aria-hidden="true">
          <i>–</i>
          <i>□</i>
          <i>×</i>
        </span>
      </div>
      <div className="win__body">{children}</div>
    </div>
  )
}
