/**
 * Vectr Nav Icon for DSH Settings rail and status badges.
 *
 * Vector SVG icon embodying Vectr's semantic vector and lightning characteristics.
 * Follows DSH theme colors with currentColor.
 *
 * @module dsh-vectr-client/client/VectrNavIcon
 */

import type { CSSProperties, ReactNode } from 'react'

export interface VectrNavIconProps {
  size?: number | undefined
  className?: string | undefined
  style?: CSSProperties | undefined
}

/**
 * Dedicated Vectr Vector / Lightning Icon for navigation and toolbars.
 */
export function VectrNavIcon(props: VectrNavIconProps): ReactNode {
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
        ...props.style,
      }}
      aria-hidden="true"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}
