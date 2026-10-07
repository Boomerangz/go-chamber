// touchScreen tells a phone or tablet driven by a finger: focusing a text
// field there opens the on-screen keyboard, so nothing takes the focus
// unasked.
export function touchScreen(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches
}
