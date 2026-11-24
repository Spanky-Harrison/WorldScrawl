// Inputs for the prompt snapshot test: every prompt builder, called with fixed inputs. prompts.snapshot.json holds
// what the code produced before the prompts moved to plugin/prompts/default.json; the default text must match it.
import { intentLine } from '../../../extension/owners.mjs';
import { glimpseLines, doorWord } from '../../../extension/brackets.mjs';
import { aftermathLine, relocationNote } from '../../../extension/expiry.mjs';
import { expiryNarratorNote, trackerExpiryLines } from '../../../extension/npcexpiry.mjs';
import { npcSlices, offmapAbsentLine, sayLine } from '../../../extension/npc.mjs';
import { trackerLeftBehind } from '../../../extension/tracker.mjs';
import { durationWords } from '../../../extension/words.mjs';
const exitA = { direction: 'north', to: 'r:inn/hall', to_name: 'Hall', to_display_name: 'Hall', to_summary: 'A long hall.', description: 'An oak door.' };
const exitB = { direction: 'trapdoor', to: 'r:inn/cellar', to_name: 'Cellar', hidden: true, obscured: true };
const loc = { address: 'r:inn/common', name: 'Common Room', display_name: 'Common Room', description: 'A smoky room.', exits: [exitA, exitB], views: [],
    region: { name: 'Riverton' }, subregion: { name: 'The Inn' }, effective_lore: { region: 'A river town.', subregion: 'A rowdy inn.' } };
const said = 'The player wrote: "I look around and head north."';
const rooms = [{ display_name: 'Hall', summary: 'A long hall.' }, { display_name: 'Yard', summary: 'A muddy yard.' }];
const move = { direction: 'north', from: 'r:inn/hall', from_name: 'Hall', to: 'r:inn/common', to_name: 'Common Room' };
const trip = { ...move, path: ['Square', 'Gate', 'Common Room'], seconds: 600, traversal: ['A slippery step.'] };
const c1 = { area_name: 'The Inn', area: 'r:inn', region_name: 'Riverton', outline: [{ address: 'r:inn/common', name: 'Common Room', area_name: 'The Inn', exits: [{ direction: 'north', to: 'r:inn/hall', door: 'open' }] }] };
const k = { region_name: 'Riverton', region_notes: 'A river town.', area_name: 'The Inn', area_notes: 'Rowdy.', name: 'Hall', location: 'r:inn/hall', description: 'A long hall.' };
const pctx = { rooms: { 'r:inn/common': { name: 'Common Room' } }, areas: { 'r:inn': 'Rowdy.' }, outline: c1.outline,
    neighbors: [{ address: 'r:inn/hall', name: 'Hall', description: 'Long.', exits: [{ direction: 'south', to: 'r:inn/common', description: 'Back.' }] }], mentions: [{ where: 'r:inn', field: 'lore', text: 'Common Room is loud.' }] };
const ectx = { region: { name: 'Riverton', lore: 'A river town.' }, subregion: { name: 'The Inn', lore: 'Rowdy.' }, neighbors: [{ name: 'Hall', short: 'Long.' }, { name: 'Yard' }] };
const intent = (o = {}) => ({ loc, exitLines: ['- north (to Hall)', '- trapdoor'], said, moveDirs: ['north', 'trapdoor'], movePlaces: [{ label: 'Square' }],
    canOpen: true, canLook: true, canOpenDoor: true, canCloseDoor: true, canNewDoor: true, onlyLook: false, options: ['north', 'trapdoor', 'Square', 'stay'], ...o });
const looks = [{ kind: 'see', peek: true, via: 'north', name: 'Hall', description: 'Long.' }, { kind: 'see', through_closed: true, via: 'window', name: 'Yard', description: 'Mud.' },
    { kind: 'see', via: 'north', name: 'Hall', description: 'Long.', opened: true, sight: 'clear' }, { kind: 'see', window: true, name: 'Yard', description: 'Mud.' },
    { kind: 'threshold', via: 'north', description: 'An oak door.', unknown: true }, { kind: 'threshold', via: 'gate', description: 'Iron.', shut: true, name: 'Yard' },
    { kind: 'threshold', via: 'gate', description: 'Iron.', peek: true }, { kind: 'closed', via: 'north', stuck: 'is locked' }, { kind: 'closed', via: 'north', word: 'way' },
    { kind: 'closed', via: 'north' }, { kind: 'listen', via: 'north', sound: 'clear' }, { kind: 'listen', via: 'north', sound: 'none' }, { kind: 'listen', via: 'north' }, { kind: 'nothing', via: 'north', opened: true },
    { kind: 'threshold', via: 'north', description: 'An oak door with a grille.', through_closed: true, name: 'Yard' }];
const facts = [[null, false, {}], [move, false, { date: 'Morning, day 3', weather: 'It rains.', took: '', timeNudge: true }], [trip, true, { took: '10 minutes', date: 'Noon', timeNudge: true }],
    [move, false, { dig: { direction: 'hole' } }], [null, false, { look: looks[2] }], [null, false, { door: { type: 'stuck', direction: 'north', why: 'is locked' } }],
    [null, true, { newDoor: true }], [null, false, { newDoor: true }], [null, false, { door: { type: 'open_door', direction: 'north' } }], [null, false, { door: { type: 'close_door', direction: 'gate' } }],
    [null, false, { dig: { direction: 'hole', to_name: 'Cellar' } }], [null, false, { digFailed: true }], [null, false, { lookAround: true }], [{ ...trip, stopped: true }, false, {}],
    [null, false, { date: 'Noon, day 3' }]]; // R4 N8: a plain stay in the same part of the day: the time without the nudge
const pl = opDocs => ({ opDocs });
export const cases = ({ ext, patches, placeform }) => ({
    'pick.system': ext.pickSys(),
    'dig.system': ext.digSys(),
    'dig.question': ext.digPrompt(loc, said, ext.digOptions(rooms), ['north', 'east'], true),
    'dig.question.existing_only': ext.digPrompt({ ...loc, description: undefined }, said, ext.digOptions(rooms), [], false),
    'dig.question.retry': ext.digPrompt(loc, said, [], [], true, 'there is already an exit "north" here'),
    'intent.bracket_target': ext.bracketTargetPrompt(loc, { word: 'move', target: 'up the stairs' }, [{ key: 'north', label: 'north to the Hall' }, { key: 'village_square', label: 'Village Square' }]),
    'look.target': ext.lookTargetPrompt(loc, said, [exitA], true),
    'look.target.nowindow': ext.lookTargetPrompt(loc, said, [exitA, exitB], false),
    'look.closed_door': ext.closedDoorPrompt(said, exitA),
    'look.view': ext.viewPickPrompt(loc, said, rooms),
    'door.pick.open': ext.doorPickPrompt(loc, said, [exitA, exitB], 'open_door'),
    'door.pick.close': ext.doorPickPrompt(loc, said, [exitA], 'close_door'),
    'intent.system': ext.intentSys(),
    'intent.all': ext.intentPrompt(intent()),
    'intent.none': ext.intentPrompt(intent({ canOpen: false, canLook: false, canOpenDoor: false, canCloseDoor: false, canNewDoor: false, movePlaces: [] })),
    'intent.onlylook': ext.intentPrompt(intent({ onlyLook: true, moveDirs: [], movePlaces: [], exitLines: [] })),
    'travel.system': ext.travelSys(),
    'travel.question': ext.travelYesNoPrompt(loc, said),
    'expand.system': ext.expandSys(),
    'expand.room': placeform.expandPrompt(ectx, { field: 'description', text: 'Dusty.', name: 'Attic', kind: 'room' }),
    'expand.notes': placeform.expandPrompt(ectx, { field: 'lore', kind: 'subregion' }),
    'expand.bare': placeform.expandPrompt({}, {}),
    'change.scope.system': ext.scopeSys(),
    'change.scope': ext.scopePrompt(c1, { start: 3, id: 7, story: 'The inn burns.', what: 'Fire!' }),
    'change.system': ext.patchSys(pl(patches.opDocs)),
    'change.patch': patches.patchPrompt(pctx, { story: 'The inn burns.', what: 'Fire!', err: 'bad op', range: '#3-#7' }),
    'change.patch.bare': patches.patchPrompt({ outline: [] }, {}),
    'change.what.tracker': ext.flagWhat({ note: 'Fire!', hint: 'The Inn', source: 'tracker' }),
    'change.what.player': ext.flagWhat({ note: 'Fire!', source: 'command' }),
    'change.what.narrator': ext.flagWhat({ note: 'Fire!', hint: 'The Inn', source: 'tag' }),
    'discover.system': ext.discoverSys(),
    'discover.question': ext.discoverPrompt(k, { exits: 'south -> r:inn/common', near: 'none', story: 'They open the green door.', start: 2, id: 5, note: 'green door', err: '' }),
    'discover.question.existing': ext.discoverPrompt(k, { exits: 'none', near: 'none', story: 'x', start: 2, id: 5, note: 'green door', err: '', existing: ext.roomOptions([{ name: 'Village Square', display_name: 'Village Square (Streets)', summary: 'Busy.', address: 'r:s/square' }]) }),
    'discover.question.retry': ext.discoverPrompt(k, { exits: 'none', near: 'none', story: 'x', start: 2, id: 5, note: '', err: 'no name' }),
    'narration.exits_hint': ext.render('narration.exits_hint'),
    'pick.said': ext.render('pick.said', { message: 'I look around and head north.' }), // R6: the same line the intent, look, door, dig and travel cases quote as said
    'narration.arrival_reminder': ext.arrivalReminder(loc, move),
    'narration.new_door.tools': ext.newDoorLine('You', 'Hall', true),
    'narration.new_door': ext.newDoorLine('You', 'Hall', false),
    'narration.stay_put': ext.stayPutLine('You', 'Hall'),
    ...Object.fromEntries(looks.map((l, i) => [`narration.look.${i}`, ext.lookText('You', 'Hall', l)])),
    ...Object.fromEntries(facts.map(([m, t, x], i) => [`narration.facts.${i}`, ext.factsText(loc, m, t, x)])),
    ...Object.fromEntries([false, true].map(t => [`narration.lore_index.${t ? 'tools' : 'tags'}`, ext.loreBits({ ...loc, lore_chain: [{ level: 'subregion', name: 'The Inn', text: 'Run by {{npc:hesk}}.' }, { level: 'region', name: 'Riverton', text: 'A river town.' }] }, t).lore_index])),
    'npc.appearance_intent.light': intentLine({ intent: 'braids tied back', fields: 'outfit', scope: 'light' }, 1),
    'npc.appearance_intent.written': intentLine({ intent: 'braids tied back', fields: 'outfit', scope: 'light', layer: { outfit: 'Widow\'s black; her braids are tied back.' } }, 2),
    'npc.appearance_intent.full': intentLine({ intent: 'turned into a gnoll', fields: 'body', scope: 'heavy' }, 1),
    'npc.appearance_intent.replace': intentLine({ kind: 'baseline', field: 'outfit', text: 'A grey travelling cloak.' }, 3),
    'npc.tracker.system': ext.trackerSys(),
    'npc.tracker': ext.trackerPrompt({
        scrap: ext.trackerScrap({
            placeName: 'Uncommon Room', displayName: 'Uncommon Room (The Uncommon Room)',
            placeDescription: 'A long hall with a copper bar.',
            exits: 'out (Village Square)',
            time: { part: 'morning', time: '08:10' },
            weather: 'Fog outside.',
            peopleLines: ext.trackerPeopleLines([{ id: 'hesk', name: 'Hesk', looks: 'copper braids', body: 'Tall, raw-boned.', outfit: "Widow's black.", facts: ['keeps the keys'], memory: ['Joe lied about the coin.'], disposition: 'indifferent', dispositionReason: 'Strangers are customers until they make trouble.' }]),
        }),
        player: 'I look around.', story: 'You look around. Hesk stands at the bar.',
    }),

    // ---- R5 (N7): narrator lines moved out of code into narration.* entries.
    'narration.glimpses': glimpseLines({ exits: [{ direction: 'up', view: 'open', to: 'a', to_name: 'Attic', to_summary: 'Dusty.' }, { direction: 'gate', view: 'open', sight: 'clear', to: 'b', to_name: 'Yard', to_summary: 'Muddy.' }] }).join('\n'),
    'narration.door_word': ['north', 'out', 'gate', 'trapdoor'].map(doorWord).join(' | '),
    'narration.durations': [45, 60, 2700, 3600, 5400, 9000, 8100, 95400].map(durationWords).join(' | '),
    'narration.relocated_gone': relocationNote([{ is_system: true, mes: '', extra: { worldscrawl_notice_kind: 'missing', worldscrawl_notice_expired: true, worldscrawl_location: 'r:inn/common' } }], loc, 'Ana and Hesk'),
    'narration.relocated_missing': relocationNote([{ is_system: true, mes: '', extra: { worldscrawl_notice_kind: 'missing', worldscrawl_location: 'r:inn/common' } }], loc, 'You'),
    'narration.aftermath_gone': aftermathLine({ kind: 'gone', gone: 'r:inn/stall', gone_name: 'Pop-up Stall', place_name: 'Market Lane', why: 'a temporary change ended' }),
    'narration.aftermath_lost_exits': aftermathLine({ kind: 'lost_exits', lost: ['north', 'gate'], place_name: 'Common Room (The Inn)', why: 'a temporary change ended' }),
    'narration.person_wore_off': expiryNarratorNote([{ shown: 'the landlady', what: 'turned into a gnoll', looks: 'copper braids', body: 'Tall, raw-boned', outfit: "Widow's black." }], 'Ana and Hesk'),
    'narration.npc_elsewhere': offmapAbsentLine({ id: 'hesk', name: 'Hesk', unknownAs: 'the landlady' }, { activity: 'asleep', where: 'her own room', near: { kind: 'map', name: 'The Drowned Rat' } }),
    'narration.npc_overdue': [{ id: 'narration.npc_due', vars: { name: 'Hesk', place: 'the forge', activity: 'work' } }, { id: 'narration.npc_late', vars: { name: 'Hesk', late: durationWords(3600), activity: 'work' } }, { id: 'narration.npc_moved_on', vars: { name: 'Tam' } }].map(sayLine).join('\n'),
    'narration.people': (({ npcs_present, npc_focus }) => `${npcs_present}\n---\n${npc_focus}`)(npcSlices([{ id: 'hesk', name: 'Hesk', unknownAs: 'the landlady', line: 'The landlady.', looks: 'copper braids', activity: 'pouring drinks', body: 'Tall, raw-boned.', outfit: "Widow's black.", manner: 'Brisk.', voice: 'Low.', memory: ['Joe lied about the keys.'], facts: ['keeps the keys'], deep: { history: 'Born in Riverton.', secrets: ['owes money'], relationships: { Bo: 'her cousin' } }, disposition: { player: { value: 'wary', reason: 'a broken mug' } } }, { id: 'tam', name: 'Tam', line: 'A carter.', activity: 'x', activityKind: 'with_player' }], { id: 'hesk', depth: 'deep' }, { pc: 'Ana' })),
    'npc.tracker.left_behind': trackerLeftBehind([{ id: 'hesk', name: 'the landlady', unknownAs: 'the landlady', nameKnown: false, looks: 'copper braids', from: 'Common Room' }]),
    'npc.tracker.expired': trackerExpiryLines([{ id: 'hesk', handle: 'pq29k', shown: 'the landlady', what: 'turned into a gnoll' }]),
});
