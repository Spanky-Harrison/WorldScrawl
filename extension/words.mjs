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
/** A [ws_wait: ...] tag body -> {args, sleep}: "2h", "sleep", "sleep 6h", "sleep until morning", "until dusk". */
export function parseWaitTag(body) {
    const t = String(body ?? '').trim();
    const m = /^(sleep|wait|rest)\b\s*(?:for\s+)?(.*)$/i.exec(t);
    return m ? { sleep: m[1].toLowerCase() === 'sleep', args: m[2].trim() } : { sleep: false, args: t };
}
