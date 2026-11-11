// Card descriptors: the only per-type card code that decides what a card shows. Pure (no DOM): the chat and the map
// window build the same card from the same plain data, and plugin/ui/card.mjs draws it. Each adapter declares its
// allowed actions from ACTIONS below (the card shows exactly those, in its own fixed order and labels).

/** The action matrix: which actions each card type may offer in each state. An adapter's list is filtered through it. */
export const ACTIONS = {
    place: { working: ['again', 'discard'], review: ['again', 'edit', 'close', 'scope', 'extra:newroom', 'rewrite', 'approve', 'discard'], failed: ['again', 'discard'], kept: ['edit', 'close', 'save', 'off', 'undo'], off: ['on', 'undo'], info: ['again', 'discard'] },
    // A person change whose rewrite failed keeps Edit and the scope switch: the Change box is how it is asked again.
    person: { working: ['again', 'discard'], review: ['again', 'edit', 'close', 'scope', 'rewrite', 'approve', 'discard'], failed: ['again', 'edit', 'close', 'scope', 'rewrite', 'discard'], kept: ['edit', 'close', 'save', 'off', 'undo'], off: ['on', 'undo'], info: [] },
    expiry: { info: ['edit', 'close', 'save'] },
    // Approve while it is still preparing saves the card as soon as it is ready (the call in flight, never a second one).
    remember: { working: ['approve', 'discard'], review: ['again', 'edit', 'close', 'rewrite', 'approve', 'discard'], failed: ['again', 'discard'] },
    fact: { review: ['edit', 'close', 'approve', 'discard'], kept: ['edit', 'close', 'save', 'off', 'undo'], off: ['on', 'undo'] },
    found: { kept: ['edit', 'close', 'save', 'off', 'undo'], off: ['on', 'undo'] },
    wait: { review: ['edit', 'close', 'approve', 'discard'] },
    job: { working: [], failed: ['again'] },
};
/** The actions a type may offer in a state. */
export const allowedActions = (type, state) => ACTIONS[type]?.[state] ?? [];
/** Keep only what the matrix allows (an adapter can't add a button the matrix doesn't have). */
export function within(type, state, actions) {
    const ok = new Set(allowedActions(type, state));
    return actions.filter(a => a && ok.has(a.id));
}
const act = (id, title, decides = false, more = {}) => ({ id, title, decides, ...more });

/**
 * A proposed map change (area flag in review). v: {key, invalid, summary, relocateTo, busy ('light'|'full'|''), scoped,
 * full, why, rewriteError, preview, editing, intent, unmerged, mergedNames}.
 */
export function placeReview(v) {
    const state = v.busy ? 'working' : 'review';
    const notes = [];
    if (v.relocateTo) notes.push({ text: `The party will be moved to ${v.relocateTo}.`, tone: 'info', cls: 'worldscrawl_relocate' });
    if (v.busy) notes.push({ text: `🗺 Rewriting the text as ${v.busy === 'full' ? 'a full rewrite' : 'a light touch'}…`, tone: 'busy', cls: 'worldscrawl_rewriting' });
    else if (v.scoped) notes.push({ text: `${v.full ? 'Full rewrite' : 'Light touch'}${v.why ? `: ${v.why}` : ''}`, tone: 'scope', cls: 'worldscrawl_scope' });
    if (v.rewriteError && !v.busy) notes.push({ text: `⚠ ${v.rewriteError}`, tone: 'error', cls: 'worldscrawl_rewrite_error' });
    const actions = v.busy
        ? [act('again', 'Ask again with this story range', true), act('discard', 'Leave the map as it is', true)]
        : [act('again', 'Ask again with this story range', true),
            v.editing ? act('close', 'Forget the edits and keep the suggestion as it was') : act('edit', 'Change, add or remove parts of this change before approving it'),
            v.scoped ? act('scope', v.full ? 'Rewrite the text again, changing only what this names (exits, rooms and durations stay as they are)' : 'Rewrite the text again so it fits what the place is now (exits, rooms and durations stay as they are)', true, { to: v.full ? 'light' : 'full' }) : null,
            !v.editing && v.unmerged ? act('extra:newroom', `Add a separate new room instead of connecting to ${(v.mergedNames ?? []).join(', ')}`) : null,
            v.editing ? act('rewrite', 'Work out the map change again from the edited Change line', true) : null,
            act('approve', 'Put this change on the map', true),
            act('discard', 'Leave the map as it is', true)];
    return {
        key: v.key, type: 'place', state, pending: true, cls: 'worldscrawl_flagreview',
        title: v.invalid ? "🗺 The suggested change didn't fit the map. Press Edit to fix it (Approve opens the editor):" : '🗺 Proposed map change:',
        summary: v.summary ?? [], notes,
        panel: { type: 'place', preview: v.preview },
        editor: v.editing ? { key: v.key, intent: { label: 'Change:', value: v.intent ?? '', cls: 'worldscrawl_flag_intent' }, fields: [], form: 'patch' } : null,
        actions: within('place', state, actions),
    };
}

/**
 * A proposed person (appearance) change. v: {key, who, phase ('working'|'review'|'failed'), summary, panelRows, scoped,
 * heavy, why, clockError, editing, intent, fields: [{key, label, value, data}]}.
 */
export function personReview(v) {
    const phase = v.phase || 'working';
    const notes = [];
    if (v.clockError) notes.push({ text: v.clockError, tone: 'error', cls: 'worldscrawl_clock_error' });
    if (v.scoped) notes.push({ text: `${v.heavy ? 'Full rewrite' : 'Light touch'}${v.why ? `: ${v.why}` : ''}`, tone: 'scope', cls: 'worldscrawl_scope' });
    const summary = phase === 'review' ? (v.summary?.length ? v.summary : [`${v.who}: no change to body or outfit`]) : [];
    const actions = [act('again', 'Ask again for this body and outfit', true)];
    if (phase !== 'working') actions.push(v.editing ? act('close', 'Forget the edits and keep the suggestion as it was') : act('edit', 'Change what this does before approving it'));
    if (v.scoped && phase !== 'working') actions.push(act('scope', v.heavy ? 'Rewrite again, changing only what this names' : 'Rewrite again, reworking anything this change affects', true, { to: v.heavy ? 'light' : 'heavy' }));
    if (v.editing) actions.push(act('rewrite', 'Rewrite the body and outfit for the edited change', true));
    if (phase === 'review') actions.push(act('approve', v.editing ? 'Apply the body and outfit exactly as typed in the boxes' : 'Apply the reviewed body and outfit', true));
    actions.push(act('discard', 'Do not change this person', true));
    return {
        key: v.key, type: 'person', state: phase, pending: true, cls: 'worldscrawl_npcpending',
        title: phase === 'failed' ? `👤 Appearance for ${v.who} did not resolve.` : phase === 'review' ? '👤 Proposed person change:' : `👤 Preparing a change to ${v.who}…`,
        summary, notes,
        panel: phase === 'review' ? { type: 'fields', title: v.who, tag: 'person', rows: v.panelRows ?? [] } : null,
        editor: v.editing ? { key: v.key, intent: { label: 'Change:', value: v.intent ?? '', cls: 'worldscrawl_npc_intent' }, fields: phase === 'review' ? (v.fields ?? []) : [] } : null,
        actions: within('person', phase, actions),
    };
}

/**
 * A kept person (appearance) change on its message. v: {key, state ('kept'|'off'), text, editing, intent, hasIntent,
 * fields: [{key, label, value, data}]}. Edit opens the same Change: + Body/Outfit editor as the review card.
 */
export function personKept(v) {
    const state = v.state === 'off' ? 'off' : 'kept';
    const actions = state === 'off'
        ? [act('on', 'Use this change again', true), act('undo', 'Remove this change (deleting the message does the same)', true)]
        : [v.editing ? act('close', 'Forget the edits') : act('edit', 'Change the words or the body and outfit text of this change'),
            v.editing ? act('save', 'Keep the body and outfit exactly as typed (or ask again for an edited Change line)', true) : null,
            act('off', 'Keep the change here but stop using it', true),
            act('undo', 'Remove this change (deleting the message does the same)', true)];
    return {
        key: v.key, type: 'person', state, pending: false, cls: 'worldscrawl_npcchange',
        title: v.text, summary: [], notes: [], panel: null,
        editor: v.editing ? { key: v.key, intent: v.hasIntent === false ? null : { label: 'Change:', value: v.intent ?? '', cls: 'worldscrawl_npc_intent' }, fields: v.fields ?? [] } : null,
        actions: within('person', state, actions),
    };
}

/**
 * A person's temporary change ran out (info, already applied). v: {key, who, what, rows (before = while it lasted,
 * after = now), editing, fields, edited}. Edit opens Body/Outfit; Approve edited writes a new kept change.
 */
export function personExpiry(v) {
    const actions = v.edited ? [] : v.editing
        ? [act('close', 'Forget the edits'), act('save', `Keep ${v.who}'s body and outfit exactly as typed in the boxes`, true)]
        : [act('edit', `Change what ${v.who} went back to`)];
    return {
        key: v.key, type: 'expiry', state: 'info', pending: false, cls: 'worldscrawl_npcexpired',
        title: '👤 A temporary change ran out:', summary: [`${v.who}: "${v.what}" ran out`], notes: [],
        panel: v.rows?.length ? { type: 'fields', title: v.who, tag: 'ran out', rows: v.rows } : null,
        editor: v.editing ? { key: v.key, intent: null, fields: v.fields ?? [] } : null,
        actions: within('expiry', 'info', actions),
    };
}

/**
 * A temporary map change ran out under the party (the passage sealed). v: {key, name, preview (before = with the
 * temporary change, after = now) or null while it loads, loadError, editing, intent, edited}. Edit opens the map form
 * and Change:; Approve edited stamps a new kept map change on the notice.
 */
export function placeExpiry(v) {
    const actions = v.edited ? [] : v.editing
        ? [act('close', 'Forget the edits'), act('save', 'Put the edited change on the map, for good, from this notice on', true)]
        : [act('edit', 'Change what the place went back to (starts from the change that ran out, kept for good)')];
    const notes = [];
    if (!v.preview && !v.edited) notes.push({ text: v.loadError ? `⚠ ${v.loadError}` : 'Working out what changed…', tone: v.loadError ? 'error' : 'muted', cls: 'worldscrawl_expiry_loading' });
    return {
        key: v.key, type: 'expiry', state: 'info', pending: false, cls: 'worldscrawl_placeexpired',
        title: '🗺 A temporary map change ran out:', summary: [`${v.name} ran out`], notes,
        panel: v.preview ? { type: 'place', preview: v.preview } : null,
        editor: v.editing ? { key: v.key, intent: { label: 'Change:', value: v.intent ?? '', cls: 'worldscrawl_flag_intent' }, fields: [], form: 'patch' } : null,
        actions: within('expiry', 'info', actions),
    };
}

/** The Remember card's fields, in order: [key, label, kind]. `starts` is the disposition ("friendly — why"). */
export const REMEMBER_FIELDS = [['name', 'Name', 'text'], ['line', 'Line', 'text'], ['looks', 'Looks', 'textarea'], ['manner', 'Manner', 'textarea'], ['voice', 'Speech', 'textarea'],
    ['body', 'Body', 'textarea'], ['outfit', 'Wearing', 'textarea'], ['history', 'History', 'textarea'], ['starts', 'Starts', 'text'], ['facts', 'Facts', 'list']];
/** A parsed remember answer as editor text: {name, line, …, starts, facts (one per line)}. */
export function rememberValues(got = {}) {
    const d = got.disposition;
    return { name: got.name ?? '', line: got.line ?? '', looks: got.looks ?? '', manner: got.manner ?? '', voice: got.voice ?? '', body: got.body ?? '', outfit: got.outfit ?? '',
        history: got.history ?? '', starts: d?.value ? `${d.value}${d.reason ? ` — ${d.reason}` : ''}` : '', facts: (got.facts ?? []).join('\n') };
}
const lc = t => String(t ?? '').toLowerCase();
/** Which fields hold each made-up detail (by its words appearing there): {fields: {key: [details]}, loose: [details in no field]}. */
export function inventedFields(got = {}) {
    const vals = rememberValues(got), fields = {}, loose = [];
    for (const x of got.invented ?? []) {
        const at = REMEMBER_FIELDS.map(([k]) => k).filter(k => k !== 'name' && lc(vals[k]).includes(lc(x).trim()));
        if (!at.length) loose.push(x);
        for (const k of at) (fields[k] ??= []).push(x);
    }
    return { fields, loose };
}
/** The made-up details left after the player changed `changed` fields: a changed field's marks go, the rest stay. */
export function inventedAfter(got = {}, changed = []) {
    const { fields } = inventedFields(got), gone = new Set(changed.flatMap(k => fields[k] ?? []));
    return (got.invented ?? []).filter(x => !gone.has(x));
}

/**
 * The Remember card. v: {key, name, suggested, phase ('working'|'review'|'failed'), saving, got, editing, values, intent}.
 * The panel is a new person (empty befores); made-up details are marked ⚠ on their fields.
 */
export function rememberReview(v) {
    const phase = v.saving ? 'working' : v.phase || 'working', got = v.got;
    const notes = [];
    if (v.saving) notes.push({ text: 'Saving…', tone: 'muted', cls: 'worldscrawl_remember_preparing' });
    else if (phase === 'working') notes.push({ text: 'Preparing…', tone: 'muted', cls: 'worldscrawl_remember_preparing' });
    else if (phase === 'failed') notes.push({ text: 'Could not prepare the card.', tone: 'error', cls: 'worldscrawl_remember_failed' });
    let summary = [], panel = null;
    if (phase === 'review' && got) {
        summary = [`New person: ${got.name} — ${got.line}`, ...(got.unknownAs ? [`Shown as "${got.unknownAs}" until the name is learned`] : [])];
        const vals = rememberValues(got), inv = inventedFields(got);
        panel = { type: 'fields', title: got.name, tag: 'new person', rows: REMEMBER_FIELDS.filter(([k]) => k !== 'name').map(([k, label]) => ({ field: k, label: `${label}${inv.fields[k] ? ` ⚠ made up: ${inv.fields[k].join('; ')}` : ''}`, before: '', after: vals[k] })) };
        if (got.invented?.length) notes.push({ text: `Made up to fill gaps (not in the story): ${got.invented.map(x => `⚠ ${x}`).join('; ')}`, tone: 'warn', cls: 'worldscrawl_invented' });
    }
    const actions = [];
    if (phase === 'review' || phase === 'failed') actions.push(act('again', 'Ask the model again', true));
    if (phase === 'review') actions.push(v.editing ? act('close', 'Forget the edits') : act('edit', 'Change any part of this card before saving it'));
    if (phase === 'review' && v.editing) actions.push(act('rewrite', 'Ask again with the Change note: every field you typed stays as you typed it, the model fills only the rest', true));
    if (phase !== 'failed') actions.push(act('approve', phase === 'working' ? `Remember ${v.name} (saves the card as soon as it is ready)` : v.editing ? 'Save the card exactly as typed in the boxes' : `Save ${got?.name ?? v.name} as shown`, true));
    actions.push(act('discard', 'Not this scene. You can be asked again after the scene changes.', true));
    const vals = v.values ?? rememberValues(got ?? {});
    return {
        key: v.key, type: 'remember', state: phase, pending: true, cls: 'worldscrawl_remembercard', locked: !!v.saving,
        title: v.suggested ? `Remember ${v.name}? They have come up a few times.` : `Remember ${v.name}?`,
        summary, notes, panel,
        editor: v.editing && phase === 'review' ? { key: v.key, intent: { label: 'Change:', value: v.intent ?? '', cls: 'worldscrawl_remember_intent', title: 'A note for Rewrite with this, e.g. "older, and she runs the ferry"' },
            fields: REMEMBER_FIELDS.map(([k, label, kind]) => ({ key: k, label, value: vals[k] ?? '', kind, cls: `worldscrawl_remember_${k}`, ...(k === 'starts' ? { placeholder: 'hostile, unfriendly, indifferent, friendly or helpful — why' } : {}) })) } : null,
        actions: within('remember', phase, actions),
    };
}

/**
 * A kept (or turned off) map change. v: {key, state ('kept'|'off'), what, editing, intent, preview (while editing),
 * inactive, cantApply}. Edit opens the same in-card editor as the review card (map form + Change:).
 */
export function placeKept(v) {
    const state = v.state === 'off' ? 'off' : 'kept';
    const notes = [];
    if (v.inactive) notes.push({ text: v.inactive, tone: 'muted', cls: 'worldscrawl_inactive' });
    else if (v.cantApply) notes.push({ text: `⚠ can't apply: ${v.cantApply}`, tone: 'error', cls: 'worldscrawl_cant_apply' });
    const actions = state === 'off'
        ? [act('on', 'Put this change back on the map', true), act('undo', 'Remove this change (deleting the message does the same)', true)]
        : [v.editing ? act('close', 'Forget the edits') : act('edit', 'Change this kept change here; it stays on this message'),
            v.editing ? act('save', 'Put the edited change on the map in place of this one', true) : null,
            v.inactive ? null : act('off', 'Take this change off the map for now (it stays here; turn it on again any time)', true),
            act('undo', 'Remove this change (deleting the message does the same)', true)];
    return {
        key: v.key, type: 'place', state, pending: false, cls: state === 'off' ? 'worldscrawl_change_off' : 'worldscrawl_change_kept',
        title: state === 'off' ? `🗺 Map change turned off: ${v.what}` : `🗺 Map changed here: ${v.what}`, summary: [], notes,
        panel: v.editing ? { type: 'place', preview: v.preview ?? null } : null,
        editor: v.editing ? { key: v.key, intent: { label: 'Change:', value: v.intent ?? '', cls: 'worldscrawl_flag_intent' }, fields: [], form: 'patch' } : null,
        actions: within('place', state, actions),
    };
}

/**
 * A person note (fact, memory, disposition, a remembered person, and the automatic rows: follow, name, schedule…).
 * v: {key, state ('review' for a pending lasting fact | 'kept' | 'off'), title, editing, editable, fields: [{key, label, value, kind}]
 * (the editor's boxes), rows (a panel, e.g. a remembered person's), tag, invented}.
 */
export function personNote(v) {
    const state = v.state === 'review' ? 'review' : v.state === 'off' ? 'off' : 'kept';
    const editable = v.editable ?? (v.fields ?? []).length > 0;
    const notes = v.invented ? [{ text: v.invented, tone: 'warn', cls: 'worldscrawl_invented' }] : [];
    const actions = state === 'review'
        ? [v.editing ? act('close', 'Forget the edits') : act('edit', 'Change the words before approving'), act('approve', v.editing ? 'Add this to them for good, exactly as typed' : 'Add this to them for good', true), act('discard', 'Do not change this person', true)]
        : state === 'off'
            ? [act('on', 'Use this note again', true), act('undo', 'Remove this note (deleting the message does the same)', true)]
            : [editable ? (v.editing ? act('close', 'Forget the edits') : act('edit', 'Edit this note')) : null, editable && v.editing ? act('save', 'Keep the note exactly as typed', true) : null,
                act('off', 'Keep the note here but stop using it', true), act('undo', 'Remove this note (deleting the message does the same)', true)];
    return {
        key: v.key, type: 'fact', state, pending: state === 'review', cls: state === 'review' ? 'worldscrawl_npcpending' : 'worldscrawl_npcchange',
        title: v.title, summary: [], notes,
        panel: v.rows?.length ? { type: 'fields', title: v.who ?? '', tag: v.tag ?? 'person', rows: v.rows } : null,
        editor: v.editing && editable ? { key: v.key, intent: null, fields: v.fields } : null,
        actions: within('fact', state, actions),
    };
}

/** A person found at a place ("her 'the bar' is now …"). v: {key, state, title, editing, place}. */
export function foundKept(v) {
    const state = v.state === 'off' ? 'off' : 'kept';
    const actions = state === 'off'
        ? [act('on', 'Use this find again', true), act('undo', 'Remove this find (deleting the message does the same)', true)]
        : [v.editing ? act('close', 'Forget the edits') : act('edit', 'Change the room this where-label resolves to'), v.editing ? act('save', 'Use the room in the box', true) : null,
            act('off', 'Stop using this find', true), act('undo', 'Remove this find (deleting the message does the same)', true)];
    return {
        key: v.key, type: 'found', state, pending: false, cls: 'worldscrawl_found', title: v.title, summary: [], notes: [], panel: null,
        editor: v.editing ? { key: v.key, intent: null, fields: [{ key: 'place', label: 'Room', value: v.place ?? '', kind: 'place', cls: 'worldscrawl_found_place', placeholder: 'a room address or its name' }] } : null,
        actions: within('found', state, actions),
    };
}
