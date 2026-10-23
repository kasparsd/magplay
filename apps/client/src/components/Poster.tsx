// A plain title tile in place of a poster, as ui.ts posterTile() draws it.
import type { ReactNode } from 'react'
import { tint } from '../lib/ui.ts'

export const Poster = ({ title, large = false }: { title: string, large?: boolean }): ReactNode =>
  <div className={`poster ${tint(title)}${large ? ' large' : ''}`} aria-hidden='true'>{title}</div>
