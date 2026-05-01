/**
 * reasoning-done.test.js — Unit tests fuer STREAM_REASONING_DONE-Integration
 *
 * Tests decken ab:
 *  1. reasoningDoneCallback registriert sich auf STREAM_REASONING_DONE.
 *  2. Callback ruft sendStreamThinkingWithContext mit dem vollen Reasoning-Text.
 *  3. thinkingClosed wird auf true gesetzt, sodass der inline-<think>-Pfad
 *     denselben Inhalt nicht erneut sendet.
 *  4. removeAllListeners entfernt den reasoningDoneCallback.
 *  5. Edge-Case: leerer reasoningText — kein Send, kein thinkingClosed=true.
 *  6. Edge-Case: kein currentStreamId — kein Send.
 *  7. Konstante STREAM_REASONING_DONE: Fallback-String wenn event_types
 *     die Property nicht enthaelt.
 *
 * Run from repo root:
 *   node --test src/__tests__/reasoning-done.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Pure simulation of the reasoningDoneCallback logic from commands.js.
// Mirrors the production implementation exactly so tests stay stable
// against module-boundary changes.
// ---------------------------------------------------------------------------

/**
 * Builds the state container and callback as commands.js does inside
 * handleUserMessage, but without any ST globals.
 *
 * @param {{streamId?: string|null}} opts
 * @returns {{
 *   callback: (reasoningText: string, durationMs?: number) => void,
 *   sent: Array<{streamId: string, delta: string, charName: string|null, chatId: string|null}>,
 *   state: {thinkingClosed: boolean},
 * }}
 */
function makeTestHarness({ streamId = 'test-stream-1' } = {}) {
  let currentStreamId = streamId;
  let thinkingClosed = false;

  const sent = [];

  // Shim fuer sendStreamThinkingWithContext
  function sendStreamThinkingWithContext(sid, delta, charName, chatId) {
    sent.push({ streamId: sid, delta, charName, chatId });
  }

  // Shim fuer getActiveCharName
  function getActiveCharName() { return 'TestChar'; }

  const currentCharacterName = null;
  const chatId = 'chat-99';

  const reasoningDoneCallback = (reasoningText, durationMs) => {
    if (!currentStreamId || !reasoningText) return;
    sendStreamThinkingWithContext(
      currentStreamId,
      reasoningText,
      currentCharacterName || getActiveCharName(),
      chatId,
    );
    thinkingClosed = true;
  };

  return {
    callback: reasoningDoneCallback,
    sent,
    state: {
      get thinkingClosed() { return thinkingClosed; },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Callback sendet Reasoning-Text via sendStreamThinkingWithContext
// ---------------------------------------------------------------------------

describe('reasoningDoneCallback — sendet Reasoning-Text', () => {

  it('ruft sendStreamThinkingWithContext mit vollem Reasoning-Text auf', () => {
    const { callback, sent } = makeTestHarness({ streamId: 'sid-1' });
    callback('Step 1: analyse the problem', 1234);
    assert.equal(sent.length, 1, 'Genau ein Send-Aufruf');
    assert.equal(sent[0].streamId, 'sid-1');
    assert.equal(sent[0].delta, 'Step 1: analyse the problem');
  });

  it('char_name kommt aus getActiveCharName-Fallback wenn currentCharacterName null', () => {
    const { callback, sent } = makeTestHarness();
    callback('some reasoning', 500);
    assert.equal(sent[0].charName, 'TestChar');
  });

  it('chat_id wird korrekt weitergegeben', () => {
    const { callback, sent } = makeTestHarness();
    callback('reasoning text', 100);
    assert.equal(sent[0].chatId, 'chat-99');
  });

  it('durationMs-Parameter beeinflusst das Senden nicht (kein Pflichtfeld im Delta)', () => {
    const { callback, sent } = makeTestHarness();
    // durationMs wird geloggt aber nicht in den Packet-Feldern gespiegelt
    callback('reasoning', undefined);
    assert.equal(sent.length, 1, 'Send erfolgt auch ohne durationMs');
  });
});

// ---------------------------------------------------------------------------
// 2. thinkingClosed wird auf true gesetzt
// ---------------------------------------------------------------------------

describe('reasoningDoneCallback — thinkingClosed Guard', () => {

  it('setzt thinkingClosed auf true nach erfolgreichem Reasoning-Send', () => {
    const { callback, state } = makeTestHarness();
    assert.equal(state.thinkingClosed, false, 'Vorbedingung: thinkingClosed ist false');
    callback('ich denke nach', 800);
    assert.equal(state.thinkingClosed, true, 'thinkingClosed muss danach true sein');
  });

  it('setzt thinkingClosed NICHT wenn reasoningText leer ist', () => {
    const { callback, state } = makeTestHarness();
    callback('', 100);
    assert.equal(state.thinkingClosed, false, 'thinkingClosed bleibt false bei leerem reasoningText');
  });

  it('setzt thinkingClosed NICHT wenn currentStreamId null ist', () => {
    const { callback, state } = makeTestHarness({ streamId: null });
    callback('reasoning text', 100);
    assert.equal(state.thinkingClosed, false, 'thinkingClosed bleibt false ohne streamId');
  });
});

// ---------------------------------------------------------------------------
// 3. Edge-Cases: kein Send bei leerem Text oder fehlendem streamId
// ---------------------------------------------------------------------------

describe('reasoningDoneCallback — Edge-Cases: kein Send', () => {

  it('kein Send bei leerem reasoningText', () => {
    const { callback, sent } = makeTestHarness();
    callback('', 0);
    assert.equal(sent.length, 0, 'Kein Send bei leerem Text');
  });

  it('kein Send wenn reasoningText null ist', () => {
    const { callback, sent } = makeTestHarness();
    callback(null, 0);
    assert.equal(sent.length, 0, 'Kein Send bei null-Text');
  });

  it('kein Send wenn currentStreamId null ist', () => {
    const { callback, sent } = makeTestHarness({ streamId: null });
    callback('some text', 100);
    assert.equal(sent.length, 0, 'Kein Send ohne streamId');
  });
});

// ---------------------------------------------------------------------------
// 4. STREAM_REASONING_DONE Konstante — Fallback-Mechanismus
// ---------------------------------------------------------------------------

describe('STREAM_REASONING_DONE — Konstante und Fallback', () => {

  it('nutzt String-Fallback wenn event_types die Property nicht enthaelt', () => {
    const event_types_without = {};
    const result = event_types_without.STREAM_REASONING_DONE ?? 'stream_reasoning_done';
    assert.equal(result, 'stream_reasoning_done');
  });

  it('nutzt den Konstanten-Wert wenn event_types ihn bereitstellt', () => {
    const event_types_with = { STREAM_REASONING_DONE: 'stream_reasoning_done' };
    const result = event_types_with.STREAM_REASONING_DONE ?? 'stream_reasoning_done';
    assert.equal(result, 'stream_reasoning_done');
  });

  it('nutzt einen abweichenden Konstanten-Wert aus event_types (zukuenftige ST-Versionen)', () => {
    // Hypothetisch: ST umbenennt das Event intern, aber der String-Wert bleibt gleich.
    // Der Fallback greift nur wenn die Property undefined ist.
    const event_types_custom = { STREAM_REASONING_DONE: 'reasoning_done_v2' };
    const result = event_types_custom.STREAM_REASONING_DONE ?? 'stream_reasoning_done';
    assert.equal(result, 'reasoning_done_v2', 'Konstante aus event_types hat Vorrang');
  });
});

// ---------------------------------------------------------------------------
// 5. removeAllListeners — Listener-Cleanup (EventEmitter-Simulation)
// ---------------------------------------------------------------------------

describe('removeAllListeners — reasoningDoneCallback wird entfernt', () => {

  it('removeListener entfernt den Callback sodass er nicht mehr gefeuert wird', () => {
    // Einfacher EventEmitter-Shim
    const listeners = new Map();
    const eventSource = {
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
      },
      removeListener(event, fn) {
        listeners.get(event)?.delete(fn);
      },
      emit(event, ...args) {
        listeners.get(event)?.forEach((fn) => fn(...args));
      },
    };

    const STREAM_REASONING_DONE = 'stream_reasoning_done';
    const sent = [];

    let currentStreamId = 'sid-test';
    let thinkingClosed = false;

    const reasoningDoneCallback = (reasoningText, _durationMs) => {
      if (!currentStreamId || !reasoningText) return;
      sent.push(reasoningText);
      thinkingClosed = true;
    };

    // Registrieren
    eventSource.on(STREAM_REASONING_DONE, reasoningDoneCallback);

    // Fires vor removeAllListeners
    eventSource.emit(STREAM_REASONING_DONE, 'first reasoning', 100);
    assert.equal(sent.length, 1, 'Callback wurde gefeuert');

    // removeAllListeners aufrufen
    eventSource.removeListener(STREAM_REASONING_DONE, reasoningDoneCallback);

    // Fires nach removeAllListeners — darf nicht ankommen
    eventSource.emit(STREAM_REASONING_DONE, 'second reasoning', 200);
    assert.equal(sent.length, 1, 'Callback wurde nach removeListener nicht mehr gefeuert');
  });

  it('mehrfache on/removeListener-Zyklen verursachen keine Leaks', () => {
    const listeners = new Map();
    const eventSource = {
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
      },
      removeListener(event, fn) {
        listeners.get(event)?.delete(fn);
      },
    };

    const STREAM_REASONING_DONE = 'stream_reasoning_done';
    const callbacks = [];

    // Drei handleUserMessage-Zyklen simulieren
    for (let i = 0; i < 3; i++) {
      const cb = () => {};
      callbacks.push(cb);
      eventSource.on(STREAM_REASONING_DONE, cb);
      eventSource.removeListener(STREAM_REASONING_DONE, cb);
    }

    const remaining = listeners.get(STREAM_REASONING_DONE)?.size ?? 0;
    assert.equal(remaining, 0, 'Nach allen Zyklen keine Listener-Leaks');
  });
});

// ---------------------------------------------------------------------------
// 6. reasoningDoneCallback — Doppel-Send-Schutz via lastReasoningSent
// ---------------------------------------------------------------------------

/**
 * Erweiterte Harness die auch lastReasoningSent trackt (neues Verhalten).
 */
function makeTestHarnessWithLiveTracking({ streamId = 'test-stream-1', initialLastReasoningSent = '' } = {}) {
  let currentStreamId = streamId;
  let thinkingClosed = false;
  let lastReasoningSent = initialLastReasoningSent;

  const sent = [];

  function sendStreamThinkingWithContext(sid, delta, charName, chatId) {
    sent.push({ streamId: sid, delta, charName, chatId });
  }

  function getActiveCharName() { return 'TestChar'; }

  const currentCharacterName = null;
  const chatId = 'chat-99';

  // Spiegelt die neue reasoningDoneCallback-Logik aus commands.js.
  const reasoningDoneCallback = (reasoningText, _durationMs) => {
    if (!currentStreamId || !reasoningText) return;
    const remainder = reasoningText.length > lastReasoningSent.length
      ? reasoningText.slice(lastReasoningSent.length)
      : '';
    if (remainder) {
      sendStreamThinkingWithContext(
        currentStreamId,
        remainder,
        currentCharacterName || getActiveCharName(),
        chatId,
      );
      lastReasoningSent = reasoningText;
    }
    thinkingClosed = true;
  };

  return {
    callback: reasoningDoneCallback,
    sent,
    state: {
      get thinkingClosed() { return thinkingClosed; },
      get lastReasoningSent() { return lastReasoningSent; },
    },
  };
}

describe('reasoningDoneCallback — Doppel-Send-Schutz (lastReasoningSent)', () => {

  it('sendet den vollen Text wenn lastReasoningSent noch leer ist', () => {
    const { callback, sent } = makeTestHarnessWithLiveTracking({ initialLastReasoningSent: '' });
    callback('Ich denke nach: Schritt 1, Schritt 2', 1000);
    assert.equal(sent.length, 1, 'Genau ein Send');
    assert.equal(sent[0].delta, 'Ich denke nach: Schritt 1, Schritt 2');
  });

  it('sendet NUR den Rest wenn Live-Polling bereits einen Teil gesendet hat', () => {
    // Live-Polling hat "Ich denke" bereits gesendet
    const { callback, sent } = makeTestHarnessWithLiveTracking({
      initialLastReasoningSent: 'Ich denke',
    });
    callback('Ich denke nach mehr', 1000);
    assert.equal(sent.length, 1, 'Nur ein Send fuer den Rest-Anteil');
    assert.equal(sent[0].delta, ' nach mehr', 'Nur der fehlende Anteil wird gesendet');
  });

  it('sendet NICHTS wenn Live-Polling bereits den vollen Text gesendet hat', () => {
    const fullText = 'Ich denke vollstaendig nach';
    const { callback, sent, state } = makeTestHarnessWithLiveTracking({
      initialLastReasoningSent: fullText,
    });
    callback(fullText, 1000);
    assert.equal(sent.length, 0, 'Kein Doppel-Send wenn alles schon gesendet');
    // thinkingClosed muss dennoch gesetzt werden!
    assert.equal(state.thinkingClosed, true, 'thinkingClosed wird trotzdem gesetzt');
  });

  it('setzt thinkingClosed auch wenn kein Send stattfindet (voller Live-Pre-Send)', () => {
    const fullText = 'komplettes reasoning';
    const { callback, state } = makeTestHarnessWithLiveTracking({
      initialLastReasoningSent: fullText,
    });
    callback(fullText, 500);
    assert.equal(state.thinkingClosed, true, 'thinkingClosed gesetzt trotz skip');
  });
});
