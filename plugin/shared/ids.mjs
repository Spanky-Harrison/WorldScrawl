// Ids made from names. One rule for every id built from a name (people met in play, world ids, new rooms'
// addresses): lowercase, apostrophes dropped ("Hesk's" -> "hesks"), every run of anything else becomes one "-",
// no "-" at either end, at most `max` characters (cut, then trimmed again), and `fallback` when nothing is left.

/** "The Drowned Rat's Cellar" -> "the-drowned-rats-cellar". */
export function slug(text, { max = Infinity, fallback = '' } = {}) {
    const trim = s => s.replace(/^-+|-+$/g, '');
    return trim(trim(String(text ?? '').toLowerCase().replace(/['\u2019\u2018]/g, '').replace(/[^a-z0-9]+/g, '-')).slice(0, max)) || fallback;
}
