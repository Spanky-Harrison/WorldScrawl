// Inputs for the prompt snapshot test: every prompt builder, called with fixed inputs. prompts.snapshot.json holds
// what the code produced before the prompts moved to plugin/prompts/default.json; the default text must match it.
const exitA = { direction: 'north', to: 'r:inn/hall', to_name: 'Hall', to_display_name: 'Hall', to_summary: 'A long hall.', description: 'An oak door.' };
const exitB = { direction: 'trapdoor', to: 'r:inn/cellar', to_name: 'Cellar', hidden: true, obscured: true };
const loc = { address: 'r:inn/common', name: 'Common Room', display_name: 'Common Room', description: 'A smoky room.', exits: [exitA, exitB], views: [],
    region: { name: 'Riverton' }, subregion: { name: 'The Inn' }, effective_notes: { region: 'A river town.', subregion: 'A rowdy inn.' } };
const said = 'The player wrote: "I look around and head north."';
const rooms = [{ display_name: 'Hall', summary: 'A long hall.' }, { display_name: 'Yard', summary: 'A muddy yard.' }];
const move = { direction: 'north', from: 'r:inn/hall', from_name: 'Hall', to: 'r:inn/common', to_name: 'Common Room' };
const trip = { ...move, path: ['Square', 'Gate', 'Common Room'], seconds: 600, traversal: ['A slippery step.'] };
const c1 = { area_name: 'The Inn', area: 'r:inn', region_name: 'Riverton', outline: [{ address: 'r:inn/common', name: 'Common Room', area_name: 'The Inn', exits: [{ direction: 'north', to: 'r:inn/hall', door: 'open' }] }] };
const k = { region_name: 'Riverton', region_notes: 'A river town.', area_name: 'The Inn', area_notes: 'Rowdy.', name: 'Hall', location: 'r:inn/hall', description: 'A long hall.' };
const pctx = { rooms: { 'r:inn/common': { name: 'Common Room' } }, areas: { 'r:inn': 'Rowdy.' }, outline: c1.outline,
    neighbors: [{ address: 'r:inn/hall', name: 'Hall', description: 'Long.', exits: [{ direction: 'south', to: 'r:inn/common', description: 'Back.' }] }], mentions: [{ where: 'r:inn', field: 'notes', text: 'Common Room is loud.' }] };
const ectx = { region: { name: 'Riverton', notes: 'A river town.' }, subregion: { name: 'The Inn', notes: 'Rowdy.' }, neighbors: [{ name: 'Hall', short: 'Long.' }, { name: 'Yard' }] };
const intent = (o = {}) => ({ loc, exitLines: ['- north (to Hall)', '- trapdoor'], said, moveDirs: ['north', 'trapdoor'], movePlaces: [{ label: 'Square' }],
    canOpen: true, canLook: true, canOpenDoor: true, canCloseDoor: true, canNewDoor: true, onlyLook: false, options: ['north', 'trapdoor', 'Square', 'stay'], ...o });
const looks = [{ kind: 'see', peek: true, via: 'north', name: 'Hall', description: 'Long.' }, { kind: 'see', through_closed: true, via: 'window', name: 'Yard', description: 'Mud.' },
    { kind: 'see', via: 'north', name: 'Hall', description: 'Long.', opened: true, sight: 'clear' }, { kind: 'see', window: true, name: 'Yard', description: 'Mud.' },
    { kind: 'threshold', via: 'north', description: 'An oak door.', unknown: true }, { kind: 'threshold', via: 'gate', description: 'Iron.', shut: true, name: 'Yard' },
    { kind: 'threshold', via: 'gate', description: 'Iron.', peek: true }, { kind: 'closed', via: 'north', stuck: 'is locked' }, { kind: 'closed', via: 'north', word: 'way' },
    { kind: 'closed', via: 'north' }, { kind: 'listen', via: 'north', sound: 'clear' }, { kind: 'listen', via: 'north', sound: 'none' }, { kind: 'listen', via: 'north' }, { kind: 'nothing', via: 'north', opened: true }];
const facts = [[null, false, {}], [move, false, { date: 'Morning, day 3', weather: 'It rains.', took: '' }], [trip, true, { took: '10 minutes', date: 'Noon' }],
    [move, false, { dig: { direction: 'hole' } }], [null, false, { look: looks[2] }], [null, false, { door: { type: 'stuck', direction: 'north', why: 'is locked' } }],
    [null, true, { newDoor: true }], [null, false, { newDoor: true }], [null, false, { door: { type: 'open_door', direction: 'north' } }], [null, false, { door: { type: 'close_door', direction: 'gate' } }],
    [null, false, { dig: { direction: 'hole', to_name: 'Cellar' } }], [null, false, { digFailed: true }], [null, false, { lookAround: true }], [{ ...trip, stopped: true }, false, {}]];
const pl = opDocs => ({ opDocs });
export const cases = ({ ext, patches, placeform }) => ({
    'pick.system': ext.pickSys(),
    'dig.system': ext.digSys(),
    'dig.question': ext.digPrompt(loc, said, ext.digOptions(rooms), ['north', 'east'], true),
    'dig.question.existing_only': ext.digPrompt({ ...loc, description: undefined }, said, ext.digOptions(rooms), [], false),
    'dig.question.retry': ext.digPrompt(loc, said, [], [], true, 'there is already an exit "north" here'),
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
    'expand.notes': placeform.expandPrompt(ectx, { field: 'notes', kind: 'subregion' }),
    'expand.bare': placeform.expandPrompt({}, {}),
    'change.scope.system': ext.scopeSys(),
    'change.scope': ext.scopePrompt(c1, { start: 3, id: 7, story: 'The inn burns.', what: 'Fire!' }),
    'change.system': ext.patchSys(pl(patches.opDocs)),
    'change.patch': patches.patchPrompt(pctx, { story: 'The inn burns.', what: 'Fire!', err: 'bad op', range: '#3-#7' }),
    'change.patch.bare': patches.patchPrompt({ outline: [] }, {}),
    'discover.system': ext.discoverSys(),
    'discover.question': ext.discoverPrompt(k, { exits: 'south -> r:inn/common', near: 'none', story: 'They open the green door.', start: 2, id: 5, note: 'green door', err: '' }),
    'discover.question.retry': ext.discoverPrompt(k, { exits: 'none', near: 'none', story: 'x', start: 2, id: 5, note: '', err: 'no name' }),
    'narration.flag_hint': ext.flagHint(),
    'narration.wait_hint': ext.waitHint(),
    'narration.exits_hint': ext.render('narration.exits_hint'),
    'narration.arrival_reminder': ext.arrivalReminder(loc, move),
    'narration.new_door.tools': ext.newDoorLine('You', 'Hall', true),
    'narration.new_door': ext.newDoorLine('You', 'Hall', false),
    'narration.stay_put': ext.stayPutLine('You', 'Hall'),
    ...Object.fromEntries(looks.map((l, i) => [`narration.look.${i}`, ext.lookText('You', 'Hall', l)])),
    ...Object.fromEntries(facts.map(([m, t, x], i) => [`narration.facts.${i}`, ext.factsText(loc, m, t, x)])),
});
