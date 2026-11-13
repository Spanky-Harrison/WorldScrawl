// Text helpers shared by the extension, the server and the map window. Pure: no DOM, Node or fetch.

/** Sentence blocks (a newline also ends one); joined they give back the text's words. */
export function splitSentences(text) {
    const out = [];
    for (const line of String(text ?? '').split(/\n+/)) {
        const parts = line.match(/[^.!?\u2026]+(?:[.!?\u2026]+["'\u201d\u2019)\]*]*(?=\s|$)|$)/g) ?? [];
        for (const p of parts) { const t = p.trim(); if (t) out.push(t); }
    }
    return out;
}
const words = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** The least share of the old text a light touch must keep. */
export const KEEP_MIN = 0.5;
/**
 * How much of `before` an edit kept: the share (0..1) of its sentences that `after` still holds word for word
 * (case and punctuation aside). A text of `exempt` sentences or fewer counts as kept (1): a one-sentence text can only
 * change by rewording it. Rewording one of two sentences keeps half. The one keep check for light touches on places and people.
 */
export function keepShare(before, after, { exempt = 1 } = {}) {
    const was = splitSentences(before).map(words).filter(Boolean);
    if (was.length <= exempt) return 1;
    const now = ` ${words(after)} `;
    return was.filter(s => now.includes(` ${s} `)).length / was.length;
}
