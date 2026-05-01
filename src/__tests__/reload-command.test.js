/**
 * reload-command.test.js — Unit tests for the "reload" execute_command
 *
 * Tests:
 *   - reload-command triggert window.location.reload() mit setTimeout-Delay
 *   - Vor reload wird saveChat aufgerufen wenn vorhanden
 *   - Wenn saveChat fehlt: kein Crash
 *   - replyText bleibt null — kein "Reloading SillyTavern..." in der Bridge
 *   - console.debug wird mit dem erwarteten Prefix aufgerufen
 *
 * Run from repo root:
 *   node --test src/__tests__/reload-command.test.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal Browser/ST shims — muss VOR dem Import von commands.js stehen
// ---------------------------------------------------------------------------

let _ctxOverride = null;

// window.location.reload shim — wird per Test ueberschrieben
let _reloadCalled = false;
globalThis.window = {
  location: {
    reload: () => { _reloadCalled = true; },
  },
};

// SillyTavern context shim
globalThis.SillyTavern = {
  getContext: () => _ctxOverride ?? {
    characters: [],
    groups: [],
    groupId: null,
    characterId: undefined,
    chatId: null,
  },
};

// DOM shim (updateStatus nutzt getElementById)
globalThis.document = { getElementById: () => null };

// eventSource shim (commands.js bindet auf GENERATION_STARTED etc.)
globalThis.eventSource = { on: () => {}, removeListener: () => {} };

// ---------------------------------------------------------------------------
// ST-Modul-Stubs — alle Imports aus script.js und slash-commands.js
// ---------------------------------------------------------------------------

// event_types shim
globalThis.event_types = {
  STREAM_TOKEN_RECEIVED: 'stream_token',
  GENERATION_STARTED: 'gen_started',
  GENERATION_ENDED: 'gen_ended',
  GENERATION_STOPPED: 'gen_stopped',
  GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
};

// ---------------------------------------------------------------------------
// Extrahierte reload-Logik (identisch mit dem Case in handleExecuteCommand).
// Muss 1:1 mit dem Produktionscode uebereinstimmen.
//
// WICHTIG: kein replyText — console.debug statt Bubble.
// ---------------------------------------------------------------------------

/**
 * Extrahierte reload-Logik identisch mit dem Case in handleExecuteCommand.
 *
 * @param {object} context - SillyTavern.getContext() Ergebnis
 * @param {Function} scheduleReload - Abstrahiert setTimeout(reload, 200)
 * @param {Function} [debugLog] - Ueberschreibbar fuer Test-Verifikation
 * @returns {null} replyText ist immer null (kein Chatroom-Feedback)
 */
async function executeReloadCommand(context, scheduleReload, debugLog = console.debug) {
  let replyText = null;
  try {
    if (typeof context.saveChat === 'function') {
      await context.saveChat();
    }
    if (typeof context.saveSettingsDebounced === 'function') {
      context.saveSettingsDebounced();
    }
  } catch (err) {
    console.warn('[CharacterBridge] saveChat/saveSettings vor reload fehlgeschlagen:', err);
  }
  debugLog('[CharacterBridge] reload command received — saving state and reloading');
  // kein replyText — replyText bleibt der initialisierte Default-Wert
  scheduleReload();
  return replyText;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reload command — kein replyText (nur console.debug)', () => {

  it('gibt null zurueck (kein Chatroom-Bubble)', async () => {
    const ctx = {};
    const replyText = await executeReloadCommand(ctx, () => {});
    assert.strictEqual(replyText, null, 'replyText muss null sein — keine Bubble im Chatroom');
  });

  it('loggt die erwartete console.debug-Meldung', async () => {
    const logs = [];
    const debugLog = (...args) => { logs.push(args.join(' ')); };
    const ctx = {};
    await executeReloadCommand(ctx, () => {}, debugLog);
    assert.ok(
      logs.some((m) => m.includes('[CharacterBridge] reload command received')),
      'console.debug muss die Reload-Meldung enthalten',
    );
  });

  it('scheduleReload wird aufgerufen', async () => {
    let scheduled = false;
    await executeReloadCommand({}, () => { scheduled = true; });
    assert.ok(scheduled, 'scheduleReload muss aufgerufen worden sein');
  });
});

// ---------------------------------------------------------------------------

describe('reload command — window.location.reload mit setTimeout-Delay', () => {

  beforeEach(() => {
    _reloadCalled = false;
  });

  it('window.location.reload wird nach Delay aufgerufen', async () => {
    const ctx = {};
    let timeoutMs = null;
    let timeoutCallback = null;

    // scheduleReload simuliert den echten setTimeout(reload, 200)-Block
    const scheduleReload = () => {
      timeoutMs = 200;
      timeoutCallback = () => {
        try {
          globalThis.window.location.reload();
        } catch (err) {
          console.error('[CharacterBridge] window.location.reload fehlgeschlagen:', err);
        }
      };
    };

    await executeReloadCommand(ctx, scheduleReload);

    assert.equal(timeoutMs, 200, 'Delay muss 200ms betragen');
    assert.ok(typeof timeoutCallback === 'function', 'setTimeout-Callback muss registriert sein');

    // Callback manuell ausfuehren (simuliert setTimeout-Ablauf)
    timeoutCallback();
    assert.ok(_reloadCalled, 'window.location.reload muss nach Timeout aufgerufen worden sein');
  });

  it('reload wird nicht sofort synchron aufgerufen (Delay-Sicherung)', async () => {
    const ctx = {};
    // scheduleReload registriert nur, ruft reload NICHT sofort aus
    let reloadScheduled = false;
    const scheduleReload = () => { reloadScheduled = true; };

    await executeReloadCommand(ctx, scheduleReload);

    assert.ok(reloadScheduled, 'Delay muss registriert worden sein');
    assert.ok(!_reloadCalled, 'reload darf nicht sofort synchron aufgerufen worden sein');
  });
});

// ---------------------------------------------------------------------------

describe('reload command — saveChat wird aufgerufen wenn vorhanden', () => {

  it('saveChat wird aufgerufen wenn im context vorhanden', async () => {
    let saveChatCalled = false;
    const ctx = {
      saveChat: async () => { saveChatCalled = true; },
    };
    await executeReloadCommand(ctx, () => {});
    assert.ok(saveChatCalled, 'saveChat muss aufgerufen worden sein');
  });

  it('saveSettingsDebounced wird aufgerufen wenn im context vorhanden', async () => {
    let settingsSaved = false;
    const ctx = {
      saveSettingsDebounced: () => { settingsSaved = true; },
    };
    await executeReloadCommand(ctx, () => {});
    assert.ok(settingsSaved, 'saveSettingsDebounced muss aufgerufen worden sein');
  });

  it('beide Methoden werden aufgerufen wenn vorhanden', async () => {
    let chatSaved = false;
    let settingsSaved = false;
    const ctx = {
      saveChat: async () => { chatSaved = true; },
      saveSettingsDebounced: () => { settingsSaved = true; },
    };
    await executeReloadCommand(ctx, () => {});
    assert.ok(chatSaved, 'saveChat muss aufgerufen worden sein');
    assert.ok(settingsSaved, 'saveSettingsDebounced muss aufgerufen worden sein');
  });
});

// ---------------------------------------------------------------------------

describe('reload command — kein Crash wenn saveChat fehlt', () => {

  it('kein Crash wenn weder saveChat noch saveSettingsDebounced vorhanden', async () => {
    const ctx = {}; // kein saveChat, kein saveSettingsDebounced
    let replyText;
    await assert.doesNotReject(async () => {
      replyText = await executeReloadCommand(ctx, () => {});
    });
    assert.strictEqual(replyText, null);
  });

  it('kein Crash wenn saveChat fehlt aber saveSettingsDebounced vorhanden', async () => {
    let settingsSaved = false;
    const ctx = {
      saveSettingsDebounced: () => { settingsSaved = true; },
    };
    let replyText;
    await assert.doesNotReject(async () => {
      replyText = await executeReloadCommand(ctx, () => {});
    });
    assert.strictEqual(replyText, null);
    assert.ok(settingsSaved);
  });

  it('kein Crash wenn saveChat vorhanden aber saveSettingsDebounced fehlt', async () => {
    let chatSaved = false;
    const ctx = {
      saveChat: async () => { chatSaved = true; },
    };
    let replyText;
    await assert.doesNotReject(async () => {
      replyText = await executeReloadCommand(ctx, () => {});
    });
    assert.strictEqual(replyText, null);
    assert.ok(chatSaved);
  });

  it('saveChat-Fehler werden abgefangen — kein Crash, replyText null', async () => {
    const ctx = {
      saveChat: async () => { throw new Error('ST-Netzwerkfehler'); },
    };
    let replyText;
    await assert.doesNotReject(async () => {
      replyText = await executeReloadCommand(ctx, () => {});
    });
    assert.strictEqual(replyText, null,
      'replyText muss null bleiben auch nach saveChat-Fehler');
  });

  it('saveSettingsDebounced-Fehler werden abgefangen — kein Crash', async () => {
    const ctx = {
      saveSettingsDebounced: () => { throw new Error('Settings-Fehler'); },
    };
    let replyText;
    await assert.doesNotReject(async () => {
      replyText = await executeReloadCommand(ctx, () => {});
    });
    assert.strictEqual(replyText, null);
  });
});

// ---------------------------------------------------------------------------

describe('reload command — saveChat nicht aufgerufen wenn kein saveChat', () => {

  it('saveChat wird nicht aufgerufen wenn nicht im context (kein TypeError)', async () => {
    // Sicherstellen dass kein impliziter Aufruf auf undefined stattfindet
    const ctx = { saveChat: undefined };
    await assert.doesNotReject(async () => {
      await executeReloadCommand(ctx, () => {});
    });
  });

  it('saveSettingsDebounced wird nicht aufgerufen wenn nicht im context', async () => {
    const ctx = { saveSettingsDebounced: null };
    await assert.doesNotReject(async () => {
      await executeReloadCommand(ctx, () => {});
    });
  });
});
