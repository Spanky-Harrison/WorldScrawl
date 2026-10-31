// Every id maker drops apostrophes (straight and curly) instead of splitting on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugId, newRoomId } from '../../plugin/ui/patches.mjs';
import { slugFor } from '../../plugin/ui/castdata.mjs';
import { freeId } from '../../plugin/npc.mjs';
import { freeId as extFreeId } from '../../extension/npc.mjs';
import { slugify } from '../../plugin/server.mjs';

test("apostrophes are dropped: Hesk's Room -> hesks_room", () => {
    for (const n of ["Hesk's Room", 'Hesk’s Room', 'Hesk‘s Room']) {
        assert.equal(newRoomId(n), 'hesks_room', n);
        assert.equal(slugId(n), 'hesks_room', n);
        assert.equal(slugFor(n), 'hesks-room', n);
        assert.equal(freeId(n), 'hesks-room', n);
        assert.equal(extFreeId(n), 'hesks-room', n);
        assert.equal(slugify(n), 'hesks-room', n);
    }
    assert.equal(newRoomId('The Burned Hall'), 'the_burned_hall');
});
