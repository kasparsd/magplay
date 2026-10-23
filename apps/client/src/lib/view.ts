// Redrawing a page from snapshots without a framework: each part of the page names the values it shows and is
// redrawn only when one of them changes (Object.is, like a dependency list), so open menus and focus stay put.

export interface Parts {
  /** Calls `draw` when any of `deps` differs from the last call for `part`. */
  when: (part: string, deps: readonly unknown[], draw: () => void) => void
  /** Draws `part` again on its next when(), such as after its panel is shown. */
  forget: (part: string) => void
}

export function parts (): Parts {
  const drawn = new Map<string, readonly unknown[]>()
  return {
    when: (part, deps, draw) => {
      const last = drawn.get(part)
      if (last && last.length === deps.length && last.every((value, i) => Object.is(value, deps[i]))) return
      drawn.set(part, deps)
      draw()
    },
    forget: part => { drawn.delete(part) },
  }
}
