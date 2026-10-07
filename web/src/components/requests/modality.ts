// The page was last used with the keyboard or a pointer: an answer given
// from the keyboard keeps the owner on the keyboard's path (the next request,
// the transcript and its shortcuts), not in the composer.
export type Modality = 'keyboard' | 'pointer'

let last: Modality = 'pointer'

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => { last = 'keyboard' }, true)
  window.addEventListener('pointerdown', () => { last = 'pointer' }, true)
}

export function lastInput(): Modality {
  return last
}
