// One-sided bars. A door (an exit pair's shared "barrier") may have "barred_from": "this_side" or "other_side",
// measured from the side the door is written on; missing = no bar. Whenever the door's definition is read or written
// from the other side of the pair, the value flips, so it never goes stale when places move or merge.
export const BAR_SIDES = ['this_side', 'other_side'];
/** The same door seen from the other side of the pair: "this_side" and "other_side" swap. */
export const flipBar = b => (b && typeof b === 'object' && BAR_SIDES.includes(b.barred_from) ? { ...b, barred_from: b.barred_from === 'this_side' ? 'other_side' : 'this_side' } : b);
