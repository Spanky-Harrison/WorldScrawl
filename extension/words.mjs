// Pure word checks and prompt lines used by the extension (no SillyTavern imports, so unit tests can load this).

/** A look / perception word. */
export const LOOK_RE = /\b(?:look|looks|looked|looking|peer|peers|peered|peering|peek|peeks|peeked|peeking|gaze|gazes|gazed|gazing|glance|glances|glanced|glancing|listen|listens|listened|listening|watch|watches|watched|watching|see|sees|saw|seeing|stare|stares|stared|staring|observe|observes|observed|observing|eye|eyes|eyed|eyeing|squint|squints|squinted|squinting)\b/i;
/** A movement word: the player is (also) trying to go somewhere. */
export const MOVE_RE = /\b(?:go|goes|going|went|gone|walk|walks|walked|walking|head|heads|headed|heading|step|steps|stepped|stepping|leave|leaves|left|leaving|enter|enters|entered|entering|exit|exits|exited|exiting|move|moves|moved|moving|run|runs|ran|running|climb|climbs|climbed|climbing|travel|travels|travelled|traveled|travelling|traveling|return|returns|returned|returning|wander|wanders|wandered|wandering|stroll|strolls|strolled|strolling|hurry|hurries|hurried|hurrying|rush|rushes|rushed|rushing|dash|dashes|dashed|dashing|sneak|sneaks|sneaked|snuck|sneaking|creep|creeps|crept|creeping|jump|jumps|jumped|jumping|leap|leaps|leapt|leaped|leaping|crawl|crawls|crawled|crawling|follow|follows|followed|following|descend|descends|descended|descending|ascend|ascends|ascended|ascending|come|comes|came|coming|get out|gets out|got out|pass through|passes through|passed through|through it|into)\b/i;
/** Only looking (a perception word, no movement word): the intent question offers no move options. */
export const lookOnly = text => LOOK_RE.test(String(text ?? '')) && !MOVE_RE.test(String(text ?? ''));
/** The stay-put line for a turn with no move. */
export const stayPutLine = (who, here) => `${who} has NOT moved this turn and is still at ${here}. No move happened: do not describe ${who} leaving, stepping out, going through any exit or arriving anywhere else. Everything this turn happens in ${here}.`;

// ---- Narrator wait: ws_wait tool args and the [ws_wait: ...] tag (non-tools mode).
export const WAIT_TAG = /\[ws_wait:\s*([^\]]{0,100})\]/i;
/** Tool/tag arguments -> parseWait text: {duration, until} -> "2h" or "until morning". */
export function waitArgs({ duration = '', until = '' } = {}) {
    const u = String(until ?? '').trim();
    return u ? `until ${u.replace(/^until\s+/i, '')}` : String(duration ?? '').trim();
}
/** A short narrator reason for a wait: trimmed, quotes and trailing dots dropped, at most 80 characters ('' when absent). */
export const waitReason = r => String(r ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.\s]+$/, '').slice(0, 80);
/**
 * A [ws_wait: ...] tag body -> {args, sleep, reason}: "2h", "sleep", "sleep 6h", "sleep until morning", "until dusk",
 * each optionally followed by "| reason" (also "; reason" or " - reason"). The reason is optional and only shown.
 */
export function parseWaitTag(body) {
    let t = String(body ?? '').trim(), reason = '';
    const cut = /\s*(?:\||;|\s[-–—]\s)\s*/.exec(t);
    if (cut) { reason = waitReason(t.slice(cut.index + cut[0].length)); t = t.slice(0, cut.index).trim(); }
    const m = /^(sleep|wait|rest)\b\s*(?:for\s+)?(.*)$/i.exec(t);
    return m ? { sleep: m[1].toLowerCase() === 'sleep', args: m[2].trim(), reason } : { sleep: false, args: t, reason };
}

// ---- Lenient tag reading: the model's obvious short forms become the documented tags before any tag is read.
export const FLAG_ACTIONS = ['change', 'discover', 'wait', 'sleep', 'npc', 'name', 'lore', 'found'];
export const NPC_ACTIONS = ['fact', 'memory', 'disposition', 'leave', 'staying', 'follow', 'stay', 'seek'];
const ANY_WS_TAG = /\[\s*ws[_ ]([a-z]+)\s*(?:[:|]\s*([^\]]*?))?\s*\]/gi;
const headAct = (rest, acts) => String(rest ?? '').replace(/^\s*([a-z]+)\s*(?:[:|]\s*|$)/i, (m, k) => (acts.includes(k.toLowerCase()) ? `${k.toLowerCase()}${m.trim().length > k.length || /\S/.test(rest.slice(m.length)) ? ' | ' : ''}` : m));
/**
 * [ws_found | Hesk], [ws_found: Hesk], [WS_Flag : Found|Hesk], [ws_memory | hesk | ...], [ws_sleep: until morning] ...
 * -> [ws_flag: found | Hesk], [ws_npc: memory | hesk | ...], [ws_wait: sleep until morning]. Unknown [ws_...] tags are left as they are.
 */
export function normalizeWsTags(text) {
    return String(text ?? '').replace(ANY_WS_TAG, (all, w, rest = '') => {
        const k = w.toLowerCase(), r = String(rest ?? '').trim();
        if (k === 'flag') return r ? `[ws_flag: ${headAct(r, [...FLAG_ACTIONS, 'place'])}]` : all;
        if (k === 'npc') return !r ? all : NPC_ACTIONS.includes(r.split(/[\s:|]/)[0].toLowerCase()) ? `[ws_npc: ${headAct(r, NPC_ACTIONS)}]` : `[ws_flag: npc | ${r}]`; // [ws_npc | Name] is the npc flag
        if (k === 'wait') return `[ws_wait: ${r}]`;
        if (k === 'sleep') return `[ws_wait: sleep${r ? ` ${r}` : ''}]`;
        if (FLAG_ACTIONS.includes(k)) return `[ws_flag: ${k}${r ? ` | ${r}` : ''}]`;
        if (NPC_ACTIONS.includes(k)) return `[ws_npc: ${k}${r ? ` | ${r}` : ''}]`;
        return all;
    });
}
/** [ws_...] tags still in a reply after every reader ran: the engine couldn't read them. */
export const unreadTags = text => [...String(text ?? '').matchAll(/\[\s*ws[_ ][^\]]{0,300}\]/gi)].map(m => m[0]);
