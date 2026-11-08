import type { IntersectionConfig } from '../types';

/**
 * Lane layout derived from the road widths (single source of truth for sim + acts + editor).
 *
 *   North-South road : 4 lanes (2 per direction). Inner lane = the left-turn lane, outer lane = straight.
 *   East-West road   : 2 lanes (1 per direction), narrower.
 *
 * Positions are lane CENTRES. nsInner/nsOuter are |x|; ewLane is |z|.
 *   northbound lanes: x = +nsInner (player, left-turner), x = +nsOuter
 *   southbound lanes: x = -nsInner (oncoming left-turn lane), x = -nsOuter (oncoming straight)
 *   westbound lane  : z = -ewLane (exit lane of the story's left turn)
 *   eastbound lane  : z = +ewLane
 */
export function lanes(c: Pick<IntersectionConfig, 'nsHalfWidth' | 'ewHalfWidth'>) {
  return {
    nsInner: c.nsHalfWidth / 4,
    nsOuter: (c.nsHalfWidth * 3) / 4,
    ewLane: c.ewHalfWidth / 2,
  };
}
