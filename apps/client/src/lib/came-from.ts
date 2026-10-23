// The page this one was opened from, for "←" links (lib/back.ts). In-app navigation leaves document.referrer as it
// was when the document loaded, so the router records the previous location here; after a full load it is the referrer.

let previous: string | null = null

/** Called by the router as each in-app navigation that changes the page or its query begins, before the new page renders. */
export function recordNavigation (from: string): void {
  previous = location.origin + from
}

/** The absolute URL of the previous page, as document.referrer would give it. */
export const cameFrom = (): string => previous ?? document.referrer
