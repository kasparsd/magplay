import type { ReactNode } from 'react'
import { PATHS } from '../lib/icons.ts'
import type { IconName } from '../lib/icons.ts'
export function Icon ({ name }: { name: IconName }): ReactNode {
  return (
    <svg viewBox='0 0 24 24' aria-hidden='true' className={`icon icon-${name}`}>
      <path d={PATHS[name]} />
      {(name === 'back' || name === 'forward') && (
        <text x='12' y='16.6' textAnchor='middle' fontSize='7.5' fontWeight='700'>
          10
        </text>
      )}
    </svg>
  )
}
