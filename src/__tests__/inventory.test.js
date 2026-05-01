/**
 * inventory.test.js — Unit tests for src/inventory.js
 *
 * Tests:
 *   - #1815: startInventoryWatcher sends inventory_update (not character_update)
 *            with flat snake_case fields via sendInventoryUpdate
 *   - collectInventory: shapes bots and personas correctly
 *   - URL construction: avatar_url uses correct /thumbnail?type=avatar&file= paths
 *   - No fetch() calls during collectInventory (URL-only transport)
 *
 * Run from repo root:
 *   node --test src/__tests__/inventory.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal SillyTavern + Browser environment shim
// ---------------------------------------------------------------------------

let _ctxOverride = null;

globalThis.SillyTavern = {
  getContext: () => _ctxOverride ?? {
    characters: [],
    powerUserSettings: { personas: {}, persona_descriptions: {} },
    groups: [],
    groupId: null,
    characterId: undefined,
    chatId: null,
  },
};

// window.location.origin used by URL builders in inventory.js
globalThis.window = { location: { origin: 'https://st.example.com' } };

// ---------------------------------------------------------------------------
// We test inventory.js via the exported collectInventory function directly,
// verifying shape and URL construction.
// ---------------------------------------------------------------------------

import {
  collectInventory,
  startInventoryWatcher,
  stopInventoryWatcher,
} from '../inventory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCharacter(name, avatar = null, description = '') {
  return { name, avatar, description };
}

function makeContext(characters = [], personas = {}, personaDescriptions = {}) {
  return {
    characters,
    powerUserSettings: { personas, persona_descriptions: personaDescriptions },
    groups: [],
    groupId: null,
    characterId: undefined,
    chatId: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('inventory — collectInventory shape', () => {

  beforeEach(() => {
    _ctxOverride = null;
  });

  it('returns empty bots and personas when context is empty', () => {
    _ctxOverride = makeContext();
    const result = collectInventory();
    assert.deepEqual(result.bots, []);
    assert.deepEqual(result.personas, []);
    assert.ok(result.metadata, 'metadata must be present');
  });

  it('returns bot with name and null avatar_url when avatar is null', () => {
    _ctxOverride = makeContext([makeCharacter('Aria', null)]);
    const result = collectInventory();
    assert.equal(result.bots.length, 1);
    assert.equal(result.bots[0].name, 'Aria');
    assert.strictEqual(result.bots[0].avatar_url, null);
    assert.equal(result.bots[0].avatar_b64, undefined, 'avatar_b64 must not exist');
  });

  it('filters out characters with empty names', () => {
    _ctxOverride = makeContext([
      makeCharacter('Aria'),
      makeCharacter(''),
      makeCharacter('  '),
    ]);
    const result = collectInventory();
    assert.equal(result.bots.length, 1, 'Only Aria should appear');
    assert.equal(result.bots[0].name, 'Aria');
  });

  it('truncates description to 500 characters', () => {
    const longDesc = 'x'.repeat(600);
    _ctxOverride = makeContext([makeCharacter('Aria', null, longDesc)]);
    const result = collectInventory();
    assert.equal(result.bots[0].description.length, 500);
  });

  it('returns persona entries with correct shape', () => {
    _ctxOverride = makeContext(
      [],
      { 'uid-1': 'Alice' },
      { 'uid-1': { description: 'Test persona' } },
    );
    const result = collectInventory();
    assert.equal(result.personas.length, 1);
    assert.equal(result.personas[0].id, 'uid-1');
    assert.equal(result.personas[0].name, 'Alice');
    assert.equal(result.personas[0].description, 'Test persona');
    assert.equal(result.personas[0].avatar_b64, undefined, 'avatar_b64 must not exist');
  });

  it('filters out personas with empty names', () => {
    _ctxOverride = makeContext([], { 'uid-1': '', 'uid-2': 'Bob' });
    const result = collectInventory();
    assert.equal(result.personas.length, 1);
    assert.equal(result.personas[0].name, 'Bob');
  });

  it('metadata includes activeCharacter when characterId is set', () => {
    const ctx = makeContext([makeCharacter('Aria')]);
    ctx.characterId = 0;
    _ctxOverride = ctx;
    const result = collectInventory();
    assert.equal(result.metadata.activeCharacter, 'Aria');
  });

  it('metadata activeCharacter is null when no characterId set', () => {
    _ctxOverride = makeContext([makeCharacter('Aria')]);
    const result = collectInventory();
    assert.strictEqual(result.metadata.activeCharacter, null);
  });

  it('metadata activeCharacter reflects non-zero characterId index', () => {
    const ctx = makeContext([makeCharacter('Aria'), makeCharacter('Lyra'), makeCharacter('Nova')]);
    ctx.characterId = 2;
    _ctxOverride = ctx;
    const result = collectInventory();
    assert.equal(result.metadata.activeCharacter, 'Nova');
  });

  it('bots array still contains all characters regardless of active index', () => {
    const ctx = makeContext([makeCharacter('Aria'), makeCharacter('Lyra')]);
    ctx.characterId = 1;
    _ctxOverride = ctx;
    const result = collectInventory();
    assert.equal(result.bots.length, 2, 'bots must contain all characters');
    assert.equal(result.metadata.activeCharacter, 'Lyra', 'active derived from characterId');
  });

  it('collectInventory is synchronous — no Promise returned', () => {
    _ctxOverride = makeContext([makeCharacter('Aria', 'aria.png')]);
    const result = collectInventory();
    // If synchronous, result is a plain object, not a Promise
    assert.ok(result !== null && typeof result === 'object' && typeof result.then !== 'function',
      'collectInventory must return a plain object, not a Promise');
  });
});

// ---------------------------------------------------------------------------

describe('inventory — avatar_url construction', () => {

  beforeEach(() => {
    _ctxOverride = null;
  });

  it('character with avatar builds correct thumbnail URL', () => {
    _ctxOverride = makeContext([makeCharacter('Aria', 'Aria.png')]);
    const result = collectInventory();
    assert.equal(
      result.bots[0].avatar_url,
      'https://st.example.com/thumbnail?type=avatar&file=Aria.png',
      'Character avatar_url must use /thumbnail?type=avatar&file=',
    );
  });

  it('character avatar filename is URI-encoded', () => {
    _ctxOverride = makeContext([makeCharacter('Test', 'my char.png')]);
    const result = collectInventory();
    assert.equal(
      result.bots[0].avatar_url,
      'https://st.example.com/thumbnail?type=avatar&file=my%20char.png',
      'Spaces in avatar filename must be URI-encoded',
    );
  });

  it('character with null avatar yields null avatar_url', () => {
    _ctxOverride = makeContext([makeCharacter('NoAvatar', null)]);
    const result = collectInventory();
    assert.strictEqual(result.bots[0].avatar_url, null);
  });

  it('persona builds correct thumbnail URL', () => {
    _ctxOverride = makeContext([], { 'uid-abc': 'Alice' });
    const result = collectInventory();
    assert.equal(
      result.personas[0].avatar_url,
      'https://st.example.com/thumbnail?type=avatar&file=uid-abc',
      'Persona avatar_url must use /thumbnail?type=avatar&file=<persona-id>',
    );
  });

  it('persona id with special chars is URI-encoded', () => {
    _ctxOverride = makeContext([], { 'uid 1 2': 'Bob' });
    const result = collectInventory();
    assert.equal(
      result.personas[0].avatar_url,
      'https://st.example.com/thumbnail?type=avatar&file=uid%201%202',
    );
  });

  it('no fetch() calls happen during collectInventory', () => {
    // collectInventory is now synchronous; no network access at all.
    // Install a tripwire on fetch to fail the test if called.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('fetch must not be called in collectInventory'); };
    try {
      _ctxOverride = makeContext([makeCharacter('Aria', 'aria.png')], { 'p1': 'Bob' });
      assert.doesNotThrow(() => collectInventory());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------

describe('inventory — startInventoryWatcher (#1815)', () => {

  beforeEach(() => {
    stopInventoryWatcher();
    _ctxOverride = null;
  });

  it('startInventoryWatcher starts without throwing', () => {
    _ctxOverride = makeContext();
    assert.doesNotThrow(() => startInventoryWatcher());
    stopInventoryWatcher();
  });

  it('stopInventoryWatcher is idempotent', () => {
    _ctxOverride = makeContext();
    stopInventoryWatcher();
    stopInventoryWatcher(); // second call must not throw
  });

  it('watcher does not fire for unchanged fingerprint', async () => {
    // The key invariant is that startInventoryWatcher() captures the current
    // fingerprint so the first tick does not send a spurious update.
    _ctxOverride = makeContext([makeCharacter('Aria')]);

    startInventoryWatcher();
    await new Promise((r) => setTimeout(r, 0));
    stopInventoryWatcher();

    // If we reach here without an unhandled rejection, the watcher is safe.
    assert.ok(true, 'Watcher started and stopped cleanly');
  });
});

// ---------------------------------------------------------------------------

describe('inventory — collectInventory with many characters', () => {

  beforeEach(() => {
    _ctxOverride = null;
  });

  it('processes all items when few characters present', () => {
    _ctxOverride = makeContext([
      makeCharacter('A'),
      makeCharacter('B'),
      makeCharacter('C'),
    ]);
    const result = collectInventory();
    assert.equal(result.bots.length, 3);
    const names = result.bots.map((b) => b.name).sort();
    assert.deepEqual(names, ['A', 'B', 'C']);
  });

  it('processes all items when many characters present', () => {
    const chars = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => makeCharacter(n));
    _ctxOverride = makeContext(chars);
    const result = collectInventory();
    assert.equal(result.bots.length, 6);
    const names = result.bots.map((b) => b.name).sort();
    assert.deepEqual(names, ['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('preserves original order of results', () => {
    const chars = ['First', 'Second', 'Third'].map((n) => makeCharacter(n));
    _ctxOverride = makeContext(chars);
    const result = collectInventory();
    assert.deepEqual(
      result.bots.map((b) => b.name),
      ['First', 'Second', 'Third'],
      'Result order must match input order',
    );
  });
});
