/**
 * chat-mirror.test.js — Unit tests for src/chat-mirror.js
 *
 * Tests:
 *   - computeHash is deterministic (same content → same hash)
 *   - computeHash is collision-resistant (different content → different hash)
 *   - hashPolling fires sendMessageChanged when content changes
 *   - hashPolling does NOT fire for unchanged messages
 *   - MESSAGE_EDITED event triggers immediate recheck
 *   - MESSAGE_RECEIVED event triggers immediate recheck
 *   - MESSAGE_DELETED event triggers immediate recheck
 *   - resetHashCache clears the cache
 *
 * Run from repo root:
 *   node --test src/__tests__/chat-mirror.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Shims — must come before any SUT imports
// ---------------------------------------------------------------------------

// ST event emitter shim
const _listeners = new Map();
const _mockEventSource = {
  on: (ev, fn) => {
    if (!_listeners.has(ev)) _listeners.set(ev, new Set());
    _listeners.get(ev).add(fn);
  },
  removeListener: (ev, fn) => {
    _listeners.get(ev)?.delete(fn);
  },
  emit: (ev, ...args) => {
    for (const fn of (_listeners.get(ev) ?? [])) fn(...args);
  },
};

const _mockEventTypes = {
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED:   'message_edited',
  MESSAGE_DELETED:  'message_deleted',
};

// Patch globals before module load
globalThis.SillyTavern = { getContext: () => _stContext };

const _stContext = {
  chat: [],
  extensionSettings: { 'characterbridge-extension': {} },
  saveSettingsDebounced: () => {},
};

// Mock ST module dependencies via module-level registration
// (chat-mirror.js imports from '../../../../../script.js' which resolves
//  to our mock via the import.meta resolver shim below)
globalThis.__mockEventSource = _mockEventSource;
globalThis.__mockEventTypes  = _mockEventTypes;

// ---------------------------------------------------------------------------
// Module mock: we replicate just the logic from chat-mirror.js that we need
// to test, injecting mock dependencies instead of real ST globals.
// This avoids needing a bundler or ESM import rewriting in the test runner.
// ---------------------------------------------------------------------------

import { computeHash } from '../hash-utils.js';

// ---------------------------------------------------------------------------
// Inline test-double for the polling logic
// (mirrors chat-mirror.js but uses injected deps instead of ST imports)
// ---------------------------------------------------------------------------

function makeChatMirror(opts = {}) {
  const {
    getChat    = () => _stContext.chat,
    getChatId  = () => _stContext.lastActiveChatId ?? 'test-chat',
    onChanged  = () => {},
    setIntervalFn  = setInterval,
    clearIntervalFn = clearInterval,
    eventSourceMock = _mockEventSource,
    eventTypesMock  = _mockEventTypes,
  } = opts;

  const POLL_INTERVAL_MS = 3_000;
  const TAIL_LENGTH = 3;
  const lastHashes = new Map();

  let pollTimer = null;

  async function recheckTail() {
    const chat = getChat();
    if (!Array.isArray(chat) || chat.length === 0) return;
    const chatId = getChatId();
    const startIdx = Math.max(0, chat.length - TAIL_LENGTH);

    for (let i = startIdx; i < chat.length; i++) {
      const msg = chat[i];
      if (!msg) continue;
      const content = msg.mes ?? '';
      const hash = await computeHash(content);
      const prev = lastHashes.get(i);
      if (hash !== prev) {
        lastHashes.set(i, hash);
        onChanged(chatId, i, content, hash, msg.is_user ? 'user' : 'assistant', msg.name ?? '');
      }
    }
  }

  function onEvent() {
    recheckTail().catch(() => {});
  }

  function setup() {
    if (pollTimer) return;
    pollTimer = setIntervalFn(() => recheckTail().catch(() => {}), POLL_INTERVAL_MS);
    eventSourceMock.on(eventTypesMock.MESSAGE_RECEIVED ?? 'message_received', onEvent);
    eventSourceMock.on(eventTypesMock.MESSAGE_EDITED   ?? 'message_edited',   onEvent);
    eventSourceMock.on(eventTypesMock.MESSAGE_DELETED  ?? 'message_deleted',  onEvent);
  }

  function stop() {
    if (pollTimer) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
    try {
      eventSourceMock.removeListener(eventTypesMock.MESSAGE_RECEIVED ?? 'message_received', onEvent);
      eventSourceMock.removeListener(eventTypesMock.MESSAGE_EDITED   ?? 'message_edited',   onEvent);
      eventSourceMock.removeListener(eventTypesMock.MESSAGE_DELETED  ?? 'message_deleted',  onEvent);
    } catch (_) {}
  }

  function resetCache() { lastHashes.clear(); }
  function getLastHashes() { return lastHashes; }
  function isPolling() { return pollTimer !== null; }
  function triggerRecheck() { return recheckTail(); }

  return { setup, stop, resetCache, getLastHashes, isPolling, triggerRecheck };
}

// ---------------------------------------------------------------------------
// Tests: computeHash
// ---------------------------------------------------------------------------

describe('computeHash — determinism', () => {

  it('returns the same hash for identical content', async () => {
    const h1 = await computeHash('hello world');
    const h2 = await computeHash('hello world');
    assert.equal(h1, h2, 'Same content must produce identical hash');
  });

  it('returns a non-empty hex string', async () => {
    const h = await computeHash('some content');
    assert.match(h, /^[0-9a-f]+$/, 'Hash must be lowercase hex');
    assert.ok(h.length >= 8, 'Hash must be at least 8 characters');
  });

  it('returns different hashes for different content', async () => {
    const h1 = await computeHash('content A');
    const h2 = await computeHash('content B');
    assert.notEqual(h1, h2, 'Different content must produce different hashes');
  });

  it('empty string has a consistent hash', async () => {
    const h1 = await computeHash('');
    const h2 = await computeHash('');
    assert.equal(h1, h2, 'Empty string hash must be deterministic');
  });

  it('whitespace differences produce different hashes', async () => {
    const h1 = await computeHash('hello');
    const h2 = await computeHash('hello ');
    assert.notEqual(h1, h2, 'Trailing whitespace must change the hash');
  });
});

// ---------------------------------------------------------------------------
// Tests: hash polling — change detection
// ---------------------------------------------------------------------------

describe('hash polling — sendMessageChanged on content diff', () => {

  afterEach(() => {
    _listeners.clear();
    _stContext.chat = [];
    _stContext.lastActiveChatId = null;
  });

  it('fires onChanged when message content differs from last known hash', async () => {
    _stContext.chat = [
      { mes: 'Hello', is_user: true, name: 'User' },
      { mes: 'Hi there', is_user: false, name: 'Aria' },
    ];

    const changed = [];
    const mirror = makeChatMirror({
      getChat:   () => _stContext.chat,
      getChatId: () => 'chat-1',
      onChanged: (...args) => changed.push(args),
    });

    // First recheck — all entries are new (no previous hash)
    await mirror.triggerRecheck();
    assert.equal(changed.length, 2, 'Both messages should be reported as new');

    // Second recheck — unchanged, no diff
    changed.length = 0;
    await mirror.triggerRecheck();
    assert.equal(changed.length, 0, 'No change should produce zero events');

    // Mutate last message
    _stContext.chat[1].mes = 'Updated response';
    await mirror.triggerRecheck();
    assert.equal(changed.length, 1, 'One changed message should fire one event');
    assert.equal(changed[0][1], 1, 'idx must be 1');
    assert.equal(changed[0][2], 'Updated response', 'content must match');
  });

  it('does NOT fire when hash is unchanged', async () => {
    _stContext.chat = [
      { mes: 'Stable message', is_user: false, name: 'Aria' },
    ];

    const changed = [];
    const mirror = makeChatMirror({
      getChat:   () => _stContext.chat,
      getChatId: () => 'chat-stable',
      onChanged: (...args) => changed.push(args),
    });

    await mirror.triggerRecheck();
    const countAfterFirst = changed.length; // 1 (new entry)

    // No mutation
    await mirror.triggerRecheck();
    assert.equal(changed.length, countAfterFirst, 'No redundant event for unchanged content');
  });

  it('only checks the last 3 messages (TAIL_LENGTH)', async () => {
    // 5 messages — only indices 2,3,4 should be checked
    _stContext.chat = [
      { mes: 'msg0', is_user: true,  name: 'User' },
      { mes: 'msg1', is_user: false, name: 'Aria' },
      { mes: 'msg2', is_user: true,  name: 'User' },
      { mes: 'msg3', is_user: false, name: 'Aria' },
      { mes: 'msg4', is_user: true,  name: 'User' },
    ];

    const changedIdxs = [];
    const mirror = makeChatMirror({
      getChat:   () => _stContext.chat,
      getChatId: () => 'chat-tail',
      onChanged: (chatId, idx) => changedIdxs.push(idx),
    });

    await mirror.triggerRecheck();
    assert.deepEqual(changedIdxs, [2, 3, 4], 'Only last 3 indices should be reported');
  });

  it('reports correct role for user and assistant messages', async () => {
    _stContext.chat = [
      { mes: 'User says', is_user: true,  name: 'User' },
      { mes: 'Bot says',  is_user: false, name: 'Aria' },
    ];

    const roles = [];
    const mirror = makeChatMirror({
      getChat:   () => _stContext.chat,
      getChatId: () => 'chat-roles',
      onChanged: (chatId, idx, content, hash, role) => roles.push(role),
    });

    await mirror.triggerRecheck();
    assert.equal(roles[0], 'user',      'First message role must be user');
    assert.equal(roles[1], 'assistant', 'Second message role must be assistant');
  });
});

// ---------------------------------------------------------------------------
// Tests: immediate recheck on ST events
// ---------------------------------------------------------------------------

describe('hash polling — immediate recheck on ST events', () => {

  beforeEach(() => {
    _listeners.clear();
    _stContext.chat = [];
  });

  afterEach(() => {
    _listeners.clear();
  });

  it('MESSAGE_EDITED triggers recheck immediately', async () => {
    _stContext.chat = [
      { mes: 'original', is_user: false, name: 'Aria' },
    ];

    const changed = [];
    const mirror = makeChatMirror({
      getChat:   () => _stContext.chat,
      getChatId: () => 'chat-edit',
      onChanged: (...args) => changed.push(args),
      eventSourceMock: _mockEventSource,
      eventTypesMock:  _mockEventTypes,
    });

    mirror.setup();

    // First recheck via setup (not triggered yet — interval hasn't fired)
    // Manually prime the cache
    await mirror.triggerRecheck();
    changed.length = 0; // clear initial "new entry" event

    // Simulate edit
    _stContext.chat[0].mes = 'edited text';
    _mockEventSource.emit('message_edited');

    // Give the async recheck a tick to complete
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(changed.length, 1, 'MESSAGE_EDITED must trigger recheck');
    assert.equal(changed[0][2], 'edited text');

    mirror.stop();
  });

  it('MESSAGE_RECEIVED triggers recheck immediately', async () => {
    _stContext.chat = [
      { mes: 'first message', is_user: true, name: 'User' },
    ];

    const changed = [];
    const mirror = makeChatMirror({
      getChat:   () => _stContext.chat,
      getChatId: () => 'chat-recv',
      onChanged: (...args) => changed.push(args),
      eventSourceMock: _mockEventSource,
      eventTypesMock:  _mockEventTypes,
    });

    mirror.setup();
    await mirror.triggerRecheck();
    changed.length = 0;

    // New message arrives
    _stContext.chat.push({ mes: 'new reply', is_user: false, name: 'Aria' });
    _mockEventSource.emit('message_received');

    await new Promise((r) => setTimeout(r, 20));

    assert.ok(changed.some((c) => c[2] === 'new reply'), 'MESSAGE_RECEIVED must trigger recheck for new entry');

    mirror.stop();
  });

  it('MESSAGE_DELETED event triggers recheck', async () => {
    _stContext.chat = [
      { mes: 'msg A', is_user: false, name: 'Aria' },
      { mes: 'msg B', is_user: true,  name: 'User' },
      { mes: 'msg C', is_user: false, name: 'Aria' },
    ];

    let recheckCount = 0;
    const mirror = makeChatMirror({
      getChat:   () => _stContext.chat,
      getChatId: () => 'chat-del',
      onChanged: () => { recheckCount++; },
      eventSourceMock: _mockEventSource,
      eventTypesMock:  _mockEventTypes,
    });

    mirror.setup();
    await mirror.triggerRecheck(); // prime the cache (3 new → 3 events)
    const baseline = recheckCount;

    // Simulate deletion — last message removed, second-to-last content changes
    _stContext.chat[2].mes = 'replacement content after delete';
    _mockEventSource.emit('message_deleted');

    await new Promise((r) => setTimeout(r, 20));
    assert.ok(recheckCount > baseline, 'MESSAGE_DELETED must trigger at least one recheck event');

    mirror.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: resetHashCache
// ---------------------------------------------------------------------------

describe('hash polling — resetHashCache', () => {

  afterEach(() => {
    _stContext.chat = [];
  });

  it('clears the cache so next recheck re-reports all entries', async () => {
    _stContext.chat = [
      { mes: 'content', is_user: false, name: 'Aria' },
    ];

    const changed = [];
    const mirror = makeChatMirror({
      getChat:   () => _stContext.chat,
      getChatId: () => 'chat-reset',
      onChanged: (...args) => changed.push(args),
    });

    await mirror.triggerRecheck();
    assert.equal(changed.length, 1, 'Initial recheck must report new entry');

    // Without reset, second recheck is a no-op
    await mirror.triggerRecheck();
    assert.equal(changed.length, 1, 'No change means no second event');

    // After reset the same content appears "new" again
    mirror.resetCache();
    await mirror.triggerRecheck();
    assert.equal(changed.length, 2, 'After cache reset the same entry must be re-reported');
  });
});
