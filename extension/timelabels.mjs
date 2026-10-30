// Game-time labels on narrator messages, computed live from the clock (never stored), so an earlier wait that is
// edited or deleted moves every later label. Pure: the caller passes clockAt(index) and dateAt(seconds).
export const GAP_SECONDS = 5 * 60; // elapsed time is shown when more than this passed since the previous narrator message
const isNarr = m => m && !m.is_user && !m.is_system && !m.extra?.worldscrawl_notice;
export function clockText(d, hoursPerDay = 24) {
    if (hoursPerDay !== 24) return d.time;
    const h = d.hour % 12 || 12;
    return `${h}:${String(d.minute).padStart(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}`;
}
export function elapsedText(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return `+${d ? `${d}d` : ''}${h ? `${h}h` : ''}${m && !d ? `${m}m` : ''}` || '+0m';
}
/**
 * The label for message `i`, or null when it is not a narrator message.
 * clock(i) -> game seconds at i; date(seconds) -> {hour, minute, time, day_number}; startDay: day_number at 0 seconds.
 * The day ("Day 3, 7:00 AM") is shown on the first narrator message and whenever the day changed since the previous one.
 */
export function timeLabel(chat, i, { clock, date, startDay, hoursPerDay = 24, gap = GAP_SECONDS }) {
    if (!isNarr(chat?.[i])) return null;
    let p = i - 1; while (p >= 0 && !isNarr(chat[p])) p--;
    const now = clock(i), d = date(now), day = d.day_number - startDay + 1;
    const prev = p >= 0 ? clock(p) : null, pd = prev == null ? null : date(prev);
    const showDay = !pd || pd.day_number !== d.day_number;
    const time = clockText(d, hoursPerDay);
    const since = prev != null && now - prev > gap ? elapsedText(now - prev) : '';
    return { text: `${showDay ? `Day ${day}, ` : ''}${time}${since ? ` (${since})` : ''}`, day, time, since, seconds: now };
}
