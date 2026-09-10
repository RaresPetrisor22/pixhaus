/**
 * The rights bitmask stored in `grants.rights_mask`.
 *
 * a delivery gallery is a grant of 3
 * (view + download), a proofing gallery is a grant of 5 (view + favorite), and
 * nothing downstream branches on which kind of gallery it is looking at.
 */
export const RIGHT = {
  view: 1,
  download: 2,
  favorite: 4,
} as const;

export type RightName = keyof typeof RIGHT;

export const RIGHT_NAMES = Object.keys(RIGHT) as RightName[];

export function hasRight(mask: number, right: RightName): boolean {
  return (mask & RIGHT[right]) !== 0;
}
