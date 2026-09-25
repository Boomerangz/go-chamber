// icon is the shared stroke for every drawn icon: one size family, one weight.
export function icon(size = 14) {
  return { size, strokeWidth: 1.5, className: 'icon', 'aria-hidden': true } as const
}
