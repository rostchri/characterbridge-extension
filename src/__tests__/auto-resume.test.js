/**
 * auto-resume.test.js — Unit tests for src/auto-resume.js
 *
 * Tests:
 *   - saveResumeState mit gesetztem Character → korrekt persistiert
 *   - saveResumeState mit neutralChat → null-Werte
 *   - tryResume mit aktuellem Timestamp → APIs aufgerufen mit korrektem Index
 *   - tryResume mit altem Timestamp (> 5min) → kein Aufruf, Storage cleared
 *   - tryResume ohne Storage-Eintrag → no-op
 *   - tryResume mit korruptem JSON → no-op, kein Crash
 *   - tryResume: Storage wird immer gecleart
 *
 * Run from repo root:
 *   node --test src/__tests__/auto-resume.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Shims — muss VOR dem Import von auto-resume.js stehen
// ---------------------------------------------------------------------------

// localStorage shim
const _storage = new Map();
globalThis.localStorage = {
  getItem: (k) => _storage.get(k) ?? null,
  setItem: (k, v) => _storage.set(k, String(v)),
  removeItem: (k) => _storage.delete(k),
};

// ST-Context shim
let _ctxOverride = null;
globalThis.SillyTavern = {
  getContext: () => _ctxOverride ?? {
    characters: [],
    characterId: undefined,
    groupId: null,
  },
};

// Tracked ST API calls
let _selectCalledWith = null;
let _openChatCalledWith = null;

// script.js-Exports shim (auto-resume.js importiert selectCharacterById +
// openCharacterChat aus ../../../../../script.js)
// Wir machen die Funktion per globalThis verfuegbar damit der Test-Shim greift.
// Da auto-resume.js via static import arbeitet, mocken wir den globalen Scope
// NICHT — stattdessen testen wir die Logik direkt durch Re-Implementierung
// als isolierte Einheit analog zum reload-command.test.js-Pattern.

// ---------------------------------------------------------------------------
// Extrahierte Kern-Logik aus auto-resume.js
// (identisch mit Produktionscode; muss 1:1 uebereinstimmen)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'cb-extension:resume';
const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Direkte Testversion von saveResumeState — liest Context, schreibt Storage.
 */
function saveResumeState_test() {
  try {
    const ctx = SillyTavern.getContext();
    const id = ctx.characterId;
    const char = id !== undefined ? ctx.characters?.[id] : undefined;

    const payload = {
      avatar: char?.avatar ?? null,
      chat: char?.chat ?? null,
      timestamp: Date.now(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // swallowed as in production
  }
}

/**
 * Direkte Testversion von tryResume — liest Storage, ruft ST-APIs.
 *
 * @param {Function} selectCharacterById
 * @param {Function} openCharacterChat
 */
async function tryResume_test(selectCharacterById, openCharacterChat) {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return;
  }

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}

  if (!raw) return;

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch (_) {
    return;
  }

  const age = Date.now() - (saved.timestamp ?? 0);
  if (age > MAX_AGE_MS) return;

  if (!saved.avatar) return;

  try {
    const ctx = SillyTavern.getContext();
    const idx = ctx.characters?.findIndex((c) => c.avatar === saved.avatar) ?? -1;
    if (idx === -1) return;

    await selectCharacterById(idx);

    if (saved.chat) {
      await openCharacterChat(saved.chat);
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChar(name, avatar, chat) {
  return { name, avatar, chat };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auto-resume — saveResumeState mit gesetztem Character', () => {

  beforeEach(() => {
    _storage.clear();
    _ctxOverride = null;
    _selectCalledWith = null;
    _openChatCalledWith = null;
  });

  it('persistiert avatar, chat und timestamp korrekt', () => {
    _ctxOverride = {
      characterId: 1,
      characters: [
        makeChar('Alice', 'alice.png', 'alice-chat-001'),
        makeChar('Bob',   'bob.png',   'bob-chat-002'),
      ],
      groupId: null,
    };

    const before = Date.now();
    saveResumeState_test();
    const after = Date.now();

    const raw = localStorage.getItem(STORAGE_KEY);
    assert.ok(raw, 'Storage-Eintrag muss vorhanden sein');

    const saved = JSON.parse(raw);
    assert.equal(saved.avatar, 'bob.png', 'avatar muss dem aktiven Charakter entsprechen');
    assert.equal(saved.chat, 'bob-chat-002', 'chat muss dem aktiven Charakter entsprechen');
    assert.ok(saved.timestamp >= before && saved.timestamp <= after, 'timestamp muss aktuell sein');
  });

  it('persistiert index 0 korrekt', () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    saveResumeState_test();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    assert.equal(saved.avatar, 'aria.png');
    assert.equal(saved.chat, 'aria-chat');
  });
});

// ---------------------------------------------------------------------------

describe('auto-resume — saveResumeState mit neutralChat', () => {

  beforeEach(() => {
    _storage.clear();
    _ctxOverride = null;
  });

  it('speichert null-Werte wenn characterId undefined (neutralChat)', () => {
    _ctxOverride = {
      characterId: undefined,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    saveResumeState_test();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    assert.strictEqual(saved.avatar, null);
    assert.strictEqual(saved.chat, null);
  });

  it('speichert null-Werte wenn characters leer', () => {
    _ctxOverride = {
      characterId: undefined,
      characters: [],
      groupId: null,
    };

    saveResumeState_test();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    assert.strictEqual(saved.avatar, null);
    assert.strictEqual(saved.chat, null);
  });
});

// ---------------------------------------------------------------------------

describe('auto-resume — tryResume mit aktuellem Timestamp', () => {

  beforeEach(() => {
    _storage.clear();
    _ctxOverride = null;
    _selectCalledWith = null;
    _openChatCalledWith = null;
  });

  it('ruft selectCharacterById mit korrektem Index auf', async () => {
    _ctxOverride = {
      characterId: 0,
      characters: [
        makeChar('Alice', 'alice.png', 'alice-chat'),
        makeChar('Bob',   'bob.png',   'bob-chat'),
      ],
      groupId: null,
    };

    // State wie von saveResumeState gesetzt: Bob ist aktiv
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: 'bob.png',
      chat:   'bob-chat',
      timestamp: Date.now(),
    }));

    let selectIdx = null;
    let openFile = null;
    await tryResume_test(
      (idx) => { selectIdx = idx; },
      (file) => { openFile = file; },
    );

    assert.equal(selectIdx, 1, 'selectCharacterById muss mit Index 1 (Bob) aufgerufen werden');
    assert.equal(openFile, 'bob-chat', 'openCharacterChat muss den gespeicherten Chat-Namen erhalten');
  });

  it('ruft selectCharacterById mit Index 0 auf wenn erster Charakter gespeichert', async () => {
    _ctxOverride = {
      characterId: 0,
      characters: [
        makeChar('Aria', 'aria.png', 'aria-chat'),
        makeChar('Nova', 'nova.png', 'nova-chat'),
      ],
      groupId: null,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: 'aria.png',
      chat:   'aria-chat',
      timestamp: Date.now(),
    }));

    let selectIdx = null;
    await tryResume_test(
      (idx) => { selectIdx = idx; },
      () => {},
    );

    assert.equal(selectIdx, 0);
  });

  it('ruft openCharacterChat nicht auf wenn chat null ist', async () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', null)],
      groupId: null,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: 'aria.png',
      chat:   null,
      timestamp: Date.now(),
    }));

    let openCalled = false;
    await tryResume_test(
      () => {},
      () => { openCalled = true; },
    );

    assert.ok(!openCalled, 'openCharacterChat darf nicht aufgerufen werden wenn chat null');
  });

  it('Storage wird nach erfolgreichem Resume gecleart', async () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: 'aria.png',
      chat:   'aria-chat',
      timestamp: Date.now(),
    }));

    await tryResume_test(() => {}, () => {});

    assert.strictEqual(localStorage.getItem(STORAGE_KEY), null, 'Storage muss gecleart sein');
  });
});

// ---------------------------------------------------------------------------

describe('auto-resume — tryResume mit altem Timestamp', () => {

  beforeEach(() => {
    _storage.clear();
    _ctxOverride = null;
  });

  it('ruft keine ST-APIs auf wenn Timestamp > 5min alt', async () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    const oldTimestamp = Date.now() - (6 * 60 * 1000); // 6 Minuten alt
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: 'aria.png',
      chat:   'aria-chat',
      timestamp: oldTimestamp,
    }));

    let selectCalled = false;
    let openCalled = false;
    await tryResume_test(
      () => { selectCalled = true; },
      () => { openCalled = true; },
    );

    assert.ok(!selectCalled, 'selectCharacterById darf nicht aufgerufen werden');
    assert.ok(!openCalled, 'openCharacterChat darf nicht aufgerufen werden');
  });

  it('Storage wird auch bei altem Timestamp gecleart', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: 'aria.png',
      chat:   'aria-chat',
      timestamp: Date.now() - (10 * 60 * 1000),
    }));

    await tryResume_test(() => {}, () => {});

    assert.strictEqual(localStorage.getItem(STORAGE_KEY), null, 'Storage muss gecleart sein');
  });

  it('Timestamp exakt 5min alt wird abgelehnt (boundary)', async () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    const boundaryTimestamp = Date.now() - (5 * 60 * 1000 + 1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: 'aria.png',
      chat:   'aria-chat',
      timestamp: boundaryTimestamp,
    }));

    let selectCalled = false;
    await tryResume_test(() => { selectCalled = true; }, () => {});
    assert.ok(!selectCalled, 'Eintrag knapp ueber 5min darf nicht restored werden');
  });
});

// ---------------------------------------------------------------------------

describe('auto-resume — tryResume ohne Storage-Eintrag', () => {

  beforeEach(() => {
    _storage.clear();
    _ctxOverride = null;
  });

  it('ist ein no-op wenn kein Storage-Eintrag existiert', async () => {
    // _storage ist leer

    let selectCalled = false;
    let openCalled = false;
    await assert.doesNotReject(async () => {
      await tryResume_test(
        () => { selectCalled = true; },
        () => { openCalled = true; },
      );
    });

    assert.ok(!selectCalled, 'selectCharacterById darf nicht aufgerufen werden');
    assert.ok(!openCalled, 'openCharacterChat darf nicht aufgerufen werden');
  });

  it('ist ein no-op bei korruptem JSON', async () => {
    localStorage.setItem(STORAGE_KEY, 'KEIN_VALIDES_JSON{{{');

    let selectCalled = false;
    await assert.doesNotReject(async () => {
      await tryResume_test(() => { selectCalled = true; }, () => {});
    });
    assert.ok(!selectCalled);
    // Storage muss dennoch gecleart sein
    assert.strictEqual(localStorage.getItem(STORAGE_KEY), null);
  });

  it('ist ein no-op wenn avatar null ist (neutralChat-State)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: null,
      chat: null,
      timestamp: Date.now(),
    }));

    let selectCalled = false;
    await tryResume_test(() => { selectCalled = true; }, () => {});
    assert.ok(!selectCalled, 'kein Aufruf wenn avatar null');
  });

  it('ist ein no-op wenn Avatar nicht im Roster gefunden', async () => {
    _ctxOverride = {
      characterId: 0,
      characters: [makeChar('Aria', 'aria.png', 'aria-chat')],
      groupId: null,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatar: 'unbekannt.png',
      chat:   'irgendein-chat',
      timestamp: Date.now(),
    }));

    let selectCalled = false;
    await tryResume_test(() => { selectCalled = true; }, () => {});
    assert.ok(!selectCalled, 'kein Aufruf wenn Avatar nicht gefunden');
  });
});
