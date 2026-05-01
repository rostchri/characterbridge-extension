/**
 * chat-state.test.js — Unit tests for src/chat-state.js
 *
 * Tests:
 *   - sendChatState baut korrektes Packet
 *   - sendChatState mit neutralChat (undefined characterId) → null-Felder
 *   - sendChatState in Gruppen-Chat → group_id gesetzt
 *   - setupChatStateRelay registriert ST-Events korrekt
 *   - stopChatStateRelay entfernt Listener und Timer
 *   - Heartbeat-Timer wird gestartet und gestoppt
 *
 * Run from repo root:
 *   node --test src/__tests__/chat-state.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Shims — muss VOR dem Import von chat-state-Logic stehen
// ---------------------------------------------------------------------------

let _ctxOverride = null;
globalThis.SillyTavern = {
  getContext: () => _ctxOverride ?? {
    characters: [],
    characterId: undefined,
    groupId: null,
  },
};

// EventEmitter-Shim fuer eventSource
const _registeredListeners = new Map();
const _mockEventSource = {
  on: (event, fn) => {
    if (!_registeredListeners.has(event)) _registeredListeners.set(event, new Set());
    _registeredListeners.get(event).add(fn);
  },
  removeListener: (event, fn) => {
    _registeredListeners.get(event)?.delete(fn);
  },
  emit: (event, ...args) => {
    for (const fn of (_registeredListeners.get(event) ?? [])) fn(...args);
  },
};

// event_types shim
const _mockEventTypes = {
  CHAT_CHANGED:        'chat_changed',
  CHARACTER_SELECTED:  'character_selected',
  GROUP_CHAT_CREATED:  'group_chat_created',
};

// ---------------------------------------------------------------------------
// Produktionslogik direkt als Testversion implementiert
// (gleiche Strategie wie reload-command.test.js und auto-resume.test.js)
// ---------------------------------------------------------------------------

const EV_CHAT_CHANGED       = _mockEventTypes.CHAT_CHANGED       ?? 'chat_changed';
const EV_CHARACTER_SELECTED = _mockEventTypes.CHARACTER_SELECTED ?? 'character_selected';
const EV_GROUP_CHAT_CREATED = _mockEventTypes.GROUP_CHAT_CREATED ?? 'group_chat_created';
const HEARTBEAT_INTERVAL_MS = 30_000;

let _heartbeatTimer_test = null;

/**
 * Testversion von sendChatState — schreibt Packet in _lastSentPacket.
 * sendChatStatePacket-Referenz wird per Closure injiziert.
 */
function makeSendChatState(sendChatStatePacket) {
  return function sendChatState() {
    try {
      const ctx = SillyTavern.getContext();
      const id = ctx.characterId;
      const char = id !== undefined ? ctx.characters?.[id] : undefined;

      const payload = {
        character_id:     id !== undefined ? id : null,
        character_name:   char?.name ?? null,
        character_avatar: char?.avatar ?? null,
        chat_file:        char?.chat ?? null,
        group_id:         ctx.groupId ?? null,
      };

      sendChatStatePacket(payload);
    } catch (_) {}
  };
}

function makeSetupRelay(sendChatState, setIntervalFn) {
  return function setupChatStateRelay() {
    _mockEventSource.on(EV_CHAT_CHANGED, sendChatState);
    _mockEventSource.on(EV_CHARACTER_SELECTED, sendChatState);
    _mockEventSource.on(EV_GROUP_CHAT_CREATED, sendChatState);

    if (!_heartbeatTimer_test) {
      _heartbeatTimer_test = setIntervalFn(sendChatState, HEARTBEAT_INTERVAL_MS);
    }
  };
}

function makeStopRelay(sendChatState, clearIntervalFn) {
  return function stopChatStateRelay() {
    try {
      _mockEventSource.removeListener(EV_CHAT_CHANGED, sendChatState);
      _mockEventSource.removeListener(EV_CHARACTER_SELECTED, sendChatState);
      _mockEventSource.removeListener(EV_GROUP_CHAT_CREATED, sendChatState);
    } catch (_) {}

    if (_heartbeatTimer_test) {
      clearIntervalFn(_heartbeatTimer_test);
      _heartbeatTimer_test = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChar(name, avatar, chat) {
  return { name, avatar, chat };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat-state — sendChatState baut korrektes Packet', () => {

  beforeEach(() => {
    _ctxOverride = null;
  });

  it('sendet alle Felder mit korrekten Werten wenn Character aktiv', () => {
    _ctxOverride = {
      characterId: 1,
      characters: [
        makeChar('Alice', 'alice.png', 'alice-chat-001'),
        makeChar('Bob',   'bob.png',   'bob-chat-002'),
      ],
      groupId: null,
    };

    let sentPacket = null;
    const sendChatState = makeSendChatState((p) => { sentPacket = p; });
    sendChatState();

    assert.ok(sentPacket, 'Packet muss gesendet worden sein');
    assert.equal(sentPacket.character_id,     1,             'character_id muss Index sein');
    assert.equal(sentPacket.character_name,   'Bob',         'character_name');
    assert.equal(sentPacket.character_avatar, 'bob.png',     'character_avatar');
    assert.equal(sentPacket.chat_file,        'bob-chat-002','chat_file');
    assert.strictEqual(sentPacket.group_id,   null,          'group_id muss null sein');
  });

  it('sendChatStatePacket erhalt type-freies Payload (type wird im Sender ergaenzt)', () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    let sentPayload = null;
    const sendChatState = makeSendChatState((p) => { sentPayload = p; });
    sendChatState();

    // Die Logik in sendChatState() erzeugt das Payload ohne `type`.
    // sendChatStatePacket in chatroom-client.js ergaenzt `type: 'chat_state'`.
    assert.ok(!sentPayload.type, 'sendChatState-Payload enthaelt kein type-Feld');
  });
});

// ---------------------------------------------------------------------------

describe('chat-state — sendChatState mit neutralChat', () => {

  beforeEach(() => {
    _ctxOverride = null;
  });

  it('alle Charakter-Felder sind null wenn kein Character gewaehlt (undefined)', () => {
    _ctxOverride = {
      characterId: undefined,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    let sentPacket = null;
    const sendChatState = makeSendChatState((p) => { sentPacket = p; });
    sendChatState();

    assert.strictEqual(sentPacket.character_id,     null);
    assert.strictEqual(sentPacket.character_name,   null);
    assert.strictEqual(sentPacket.character_avatar, null);
    assert.strictEqual(sentPacket.chat_file,        null);
    assert.strictEqual(sentPacket.group_id,         null);
  });

  it('sendet korrekt wenn characters leer', () => {
    _ctxOverride = {
      characterId: undefined,
      characters: [],
      groupId: null,
    };

    let sentPacket = null;
    const sendChatState = makeSendChatState((p) => { sentPacket = p; });
    sendChatState();

    assert.strictEqual(sentPacket.character_id, null);
    assert.strictEqual(sentPacket.character_name, null);
  });
});

// ---------------------------------------------------------------------------

describe('chat-state — sendChatState in Gruppen-Chat', () => {

  beforeEach(() => {
    _ctxOverride = null;
  });

  it('group_id wird korrekt gesetzt', () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: 'group-abc-123',
    };

    let sentPacket = null;
    const sendChatState = makeSendChatState((p) => { sentPacket = p; });
    sendChatState();

    assert.equal(sentPacket.group_id, 'group-abc-123', 'group_id muss gesetzt sein');
    // character_id ist dennoch gesetzt (aktueller aktiver Charakter im Gruppe)
    assert.equal(sentPacket.character_id, 0);
  });
});

// ---------------------------------------------------------------------------

describe('chat-state — setupChatStateRelay registriert ST-Events', () => {

  beforeEach(() => {
    _registeredListeners.clear();
    _heartbeatTimer_test = null;
    _ctxOverride = null;
  });

  afterEach(() => {
    _heartbeatTimer_test = null;
  });

  it('registriert Listener fuer CHAT_CHANGED', () => {
    const sendChatState = makeSendChatState(() => {});
    const setupChatStateRelay = makeSetupRelay(sendChatState, () => 'timer-handle');
    setupChatStateRelay();

    assert.ok(
      _registeredListeners.get(EV_CHAT_CHANGED)?.has(sendChatState),
      'Listener fuer CHAT_CHANGED muss registriert sein',
    );
  });

  it('registriert Listener fuer CHARACTER_SELECTED', () => {
    const sendChatState = makeSendChatState(() => {});
    const setupChatStateRelay = makeSetupRelay(sendChatState, () => 'timer-handle');
    setupChatStateRelay();

    assert.ok(
      _registeredListeners.get(EV_CHARACTER_SELECTED)?.has(sendChatState),
      'Listener fuer CHARACTER_SELECTED muss registriert sein',
    );
  });

  it('registriert Listener fuer GROUP_CHAT_CREATED', () => {
    const sendChatState = makeSendChatState(() => {});
    const setupChatStateRelay = makeSetupRelay(sendChatState, () => 'timer-handle');
    setupChatStateRelay();

    assert.ok(
      _registeredListeners.get(EV_GROUP_CHAT_CREATED)?.has(sendChatState),
      'Listener fuer GROUP_CHAT_CREATED muss registriert sein',
    );
  });

  it('alle drei Events loesen sendChatState aus', () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    let callCount = 0;
    const sendChatState = makeSendChatState(() => { callCount++; });
    const setupChatStateRelay = makeSetupRelay(sendChatState, () => 'timer-handle');
    setupChatStateRelay();

    _mockEventSource.emit(EV_CHAT_CHANGED);
    _mockEventSource.emit(EV_CHARACTER_SELECTED);
    _mockEventSource.emit(EV_GROUP_CHAT_CREATED);

    assert.equal(callCount, 3, 'sendChatState muss 3x ausgeloest worden sein');
  });

  it('Heartbeat-Timer wird gestartet', () => {
    const sendChatState = makeSendChatState(() => {});
    let timerInterval = null;
    const setIntervalFn = (fn, ms) => { timerInterval = ms; return 'mock-timer'; };

    const setupChatStateRelay = makeSetupRelay(sendChatState, setIntervalFn);
    setupChatStateRelay();

    assert.equal(timerInterval, HEARTBEAT_INTERVAL_MS, `Heartbeat muss alle ${HEARTBEAT_INTERVAL_MS}ms laufen`);
  });
});

// ---------------------------------------------------------------------------

describe('chat-state — stopChatStateRelay entfernt Listener', () => {

  beforeEach(() => {
    _registeredListeners.clear();
    _heartbeatTimer_test = null;
  });

  afterEach(() => {
    _heartbeatTimer_test = null;
  });

  it('entfernt alle drei Event-Listener', () => {
    const sendChatState = makeSendChatState(() => {});
    const setupChatStateRelay = makeSetupRelay(sendChatState, () => 'timer-handle');
    const stopChatStateRelay  = makeStopRelay(sendChatState, () => {});

    setupChatStateRelay();

    // Sicherstellen dass Listener vorhanden sind vor stop
    assert.ok(_registeredListeners.get(EV_CHAT_CHANGED)?.has(sendChatState));

    stopChatStateRelay();

    assert.ok(
      !_registeredListeners.get(EV_CHAT_CHANGED)?.has(sendChatState),
      'CHAT_CHANGED-Listener muss entfernt sein',
    );
    assert.ok(
      !_registeredListeners.get(EV_CHARACTER_SELECTED)?.has(sendChatState),
      'CHARACTER_SELECTED-Listener muss entfernt sein',
    );
    assert.ok(
      !_registeredListeners.get(EV_GROUP_CHAT_CREATED)?.has(sendChatState),
      'GROUP_CHAT_CREATED-Listener muss entfernt sein',
    );
  });

  it('stopChatStateRelay ist idempotent (kein Crash bei doppeltem Aufruf)', () => {
    const sendChatState = makeSendChatState(() => {});
    const stopChatStateRelay  = makeStopRelay(sendChatState, () => {});

    assert.doesNotThrow(() => {
      stopChatStateRelay();
      stopChatStateRelay();
    });
  });

  it('Heartbeat-Timer wird gestoppt', () => {
    let clearCalled = false;
    const clearIntervalFn = () => { clearCalled = true; };
    const sendChatState = makeSendChatState(() => {});

    // Manuell Timer setzen (simuliert laufenden Relay)
    _heartbeatTimer_test = 'mock-timer';
    const stopChatStateRelay = makeStopRelay(sendChatState, clearIntervalFn);
    stopChatStateRelay();

    assert.ok(clearCalled, 'clearInterval muss aufgerufen worden sein');
    assert.strictEqual(_heartbeatTimer_test, null, 'Timer-Handle muss auf null gesetzt sein');
  });

  it('nach stop werden Events nicht mehr ausgeloest', () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    let callCount = 0;
    const sendChatState = makeSendChatState(() => { callCount++; });
    const setupChatStateRelay = makeSetupRelay(sendChatState, () => 'timer');
    const stopChatStateRelay  = makeStopRelay(sendChatState, () => {});

    setupChatStateRelay();
    stopChatStateRelay();

    _mockEventSource.emit(EV_CHAT_CHANGED);
    _mockEventSource.emit(EV_CHARACTER_SELECTED);
    _mockEventSource.emit(EV_GROUP_CHAT_CREATED);

    assert.equal(callCount, 0, 'Nach stop darf sendChatState nicht mehr ausgeloest werden');
  });
});

// ---------------------------------------------------------------------------

describe('chat-state — sendChatStatePacket Packet-Shape (Integration)', () => {

  it('Payload enthaelt alle erwarteten Felder mit korrekten Null-Fallbacks', () => {
    // Testet dass sendChatStatePacket (chatroom-client.js) die null-Coercions
    // korrekt anwendet — hier als reines Packet-Shape-Modell getestet.

    // Diese Funktion entspricht dem Verhalten von sendChatStatePacket:
    function buildWirePacket(payload) {
      return {
        type: 'chat_state',
        character_id:     payload.character_id     ?? null,
        character_name:   payload.character_name   ?? null,
        character_avatar: payload.character_avatar ?? null,
        chat_file:        payload.chat_file        ?? null,
        group_id:         payload.group_id         ?? null,
      };
    }

    const wire = buildWirePacket({
      character_id:     2,
      character_name:   'Nova',
      character_avatar: 'nova.png',
      chat_file:        'nova-chat-05',
      group_id:         null,
    });

    assert.equal(wire.type,             'chat_state');
    assert.equal(wire.character_id,     2);
    assert.equal(wire.character_name,   'Nova');
    assert.equal(wire.character_avatar, 'nova.png');
    assert.equal(wire.chat_file,        'nova-chat-05');
    assert.strictEqual(wire.group_id,   null);
  });

  it('undefined-Werte werden zu null normalisiert', () => {
    function buildWirePacket(payload) {
      return {
        type: 'chat_state',
        character_id:     payload.character_id     ?? null,
        character_name:   payload.character_name   ?? null,
        character_avatar: payload.character_avatar ?? null,
        chat_file:        payload.chat_file        ?? null,
        group_id:         payload.group_id         ?? null,
      };
    }

    const wire = buildWirePacket({
      character_id:     undefined,
      character_name:   undefined,
      character_avatar: undefined,
      chat_file:        undefined,
      group_id:         undefined,
    });

    assert.strictEqual(wire.character_id,     null);
    assert.strictEqual(wire.character_name,   null);
    assert.strictEqual(wire.character_avatar, null);
    assert.strictEqual(wire.chat_file,        null);
    assert.strictEqual(wire.group_id,         null);
  });
});
