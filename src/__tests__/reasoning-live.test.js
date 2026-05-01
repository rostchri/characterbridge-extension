/**
 * reasoning-live.test.js — Unit tests fuer Live-Reasoning-Polling in streamCallback
 *
 * Testet die Logik aus dem neuen Live-Reasoning-Block am Anfang von streamCallback
 * in commands.js. ST aktualisiert chat[lastIdx].extra.reasoning pro Streaming-Tick —
 * wir pollen diesen Wert und senden nur Deltas per stream_thinking.
 *
 * Abgedeckte Faelle:
 *  1. Erster Tick sendet den vollstaendigen Reasoning-Text als erstes Delta.
 *  2. Weitere Ticks senden nur den neu hinzugekommenen Anteil (Delta).
 *  3. thinkingClosed === true → kein weiteres Polling (kein Send).
 *  4. chat-Array leer → kein Crash, kein Send.
 *  5. chat[i].extra undefined → kein Crash, kein Send.
 *  6. chat[i].extra.reasoning undefined → kein Crash (faellt auf '' zurueck).
 *  7. Defensiver Reset: reasoning wird kuerzer (Rueckschritt) → cursor reset.
 *  8. mehrere Ticks mit unveraendertem Reasoning → kein Doppel-Send.
 *  9. SillyTavern.getContext() wirft → kein Crash (Fehler wird nur gewarnt).
 *
 * Run from repo root:
 *   node --test src/__tests__/reasoning-live.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Harness: isolierte Simulation der Live-Reasoning-Polling-Logik
// ---------------------------------------------------------------------------

/**
 * Baut einen Test-Kontext auf, der die Live-Reasoning-Polling-Logik aus
 * streamCallback in commands.js isoliert ausfuehrt — ohne ST-Globals.
 *
 * @param {{
 *   thinkingClosed?: boolean,
 *   streamId?: string|null,
 *   charName?: string|null,
 *   chatId?: string|null,
 *   getContextFn?: () => {chat: Array},
 * }} opts
 * @returns {{
 *   runPoll: () => void,
 *   sent: Array<{streamId: string, delta: string, charName: string|null, chatId: string|null}>,
 *   state: {lastReasoningSent: string},
 *   warnings: string[],
 * }}
 */
function makeLiveReasoningHarness({
  thinkingClosed = false,
  streamId = 'sid-live-1',
  charName = null,
  chatId = 'chat-live-99',
  getContextFn = () => ({ chat: [] }),
} = {}) {
  let lastReasoningSent = '';
  const sent = [];
  const warnings = [];

  // Shims
  function sendStreamThinkingWithContext(sid, delta, cn, cid) {
    sent.push({ streamId: sid, delta, charName: cn, chatId: cid });
  }
  function getActiveCharName() { return 'FallbackChar'; }

  // Direkte Uebertragung der Live-Reasoning-Polling-Logik aus commands.js.
  // Wird pro Tick aufgerufen (entspricht einem STREAM_TOKEN_RECEIVED-Aufruf).
  function runPoll() {
    if (!thinkingClosed) {
      try {
        const ctx = getContextFn();
        const chat = ctx.chat;
        if (chat && chat.length > 0) {
          const lastIdx = chat.length - 1;
          const reasoningNow = chat[lastIdx]?.extra?.reasoning ?? '';
          if (reasoningNow.length > lastReasoningSent.length) {
            const newReasoning = reasoningNow.slice(lastReasoningSent.length);
            if (newReasoning) {
              sendStreamThinkingWithContext(
                streamId,
                newReasoning,
                charName || getActiveCharName(),
                chatId,
              );
              lastReasoningSent = reasoningNow;
            }
          } else if (reasoningNow.length < lastReasoningSent.length) {
            // Defensiver Reset
            lastReasoningSent = reasoningNow;
          }
        }
      } catch (err) {
        warnings.push(String(err));
      }
    }
  }

  return {
    runPoll,
    sent,
    warnings,
    state: {
      get lastReasoningSent() { return lastReasoningSent; },
      setLastReasoningSent(v) { lastReasoningSent = v; },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Erster Tick sendet vollstaendigen Text
// ---------------------------------------------------------------------------

describe('Live-Reasoning-Polling — erster Tick', () => {

  it('sendet den kompletten Reasoning-Text beim ersten Tick', () => {
    const chat = [{ extra: { reasoning: 'Schritt 1: Analyse' } }];
    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    runPoll();

    assert.equal(sent.length, 1, 'Genau ein Send-Aufruf');
    assert.equal(sent[0].delta, 'Schritt 1: Analyse');
    assert.equal(sent[0].streamId, 'sid-live-1');
    assert.equal(sent[0].chatId, 'chat-live-99');
  });

  it('charName kommt aus getActiveCharName-Fallback wenn charName null', () => {
    const chat = [{ extra: { reasoning: 'thinking...' } }];
    const { runPoll, sent } = makeLiveReasoningHarness({
      charName: null,
      getContextFn: () => ({ chat }),
    });

    runPoll();

    assert.equal(sent[0].charName, 'FallbackChar');
  });
});

// ---------------------------------------------------------------------------
// 2. Weitere Ticks senden nur Deltas
// ---------------------------------------------------------------------------

describe('Live-Reasoning-Polling — Delta-Logik ueber mehrere Ticks', () => {

  it('sendet pro Tick nur den neuen Anteil', () => {
    // Simuliert ST, das extra.reasoning pro Tick akkumuliert
    let reasoning = '';
    const ticks = ['Schritt 1', 'Schritt 1 und 2', 'Schritt 1 und 2 und 3'];
    const chat = [{ extra: { get reasoning() { return reasoning; } } }];

    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    for (const tick of ticks) {
      reasoning = tick;
      runPoll();
    }

    assert.equal(sent.length, 3, 'Drei Sends fuer drei Ticks');
    assert.equal(sent[0].delta, 'Schritt 1');
    assert.equal(sent[1].delta, ' und 2');
    assert.equal(sent[2].delta, ' und 3');
  });

  it('kein Doppel-Send wenn reasoning unveraendert bleibt', () => {
    const chat = [{ extra: { reasoning: 'unverändert' } }];
    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    // Erster Tick sendet
    runPoll();
    // Zweiter und dritter Tick: selber Text — kein weiterer Send
    runPoll();
    runPoll();

    assert.equal(sent.length, 1, 'Nur ein Send, keine Duplikate');
  });
});

// ---------------------------------------------------------------------------
// 3. thinkingClosed === true → kein Polling
// ---------------------------------------------------------------------------

describe('Live-Reasoning-Polling — thinkingClosed Guard', () => {

  it('sendet nichts wenn thinkingClosed bereits true ist', () => {
    const chat = [{ extra: { reasoning: 'sollte nicht gesendet werden' } }];
    const { runPoll, sent } = makeLiveReasoningHarness({
      thinkingClosed: true,
      getContextFn: () => ({ chat }),
    });

    runPoll();
    runPoll();

    assert.equal(sent.length, 0, 'Kein Send wenn thinkingClosed');
  });
});

// ---------------------------------------------------------------------------
// 4. chat-Array leer → kein Crash, kein Send
// ---------------------------------------------------------------------------

describe('Live-Reasoning-Polling — leeres chat-Array', () => {

  it('kein Crash und kein Send bei chat = []', () => {
    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat: [] }),
    });

    assert.doesNotThrow(() => runPoll());
    assert.equal(sent.length, 0, 'Kein Send bei leerem chat');
  });

  it('kein Crash bei chat = null', () => {
    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat: null }),
    });

    assert.doesNotThrow(() => runPoll());
    assert.equal(sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. chat[i].extra undefined → kein Crash
// ---------------------------------------------------------------------------

describe('Live-Reasoning-Polling — extra undefined', () => {

  it('kein Crash wenn chat[i].extra undefined ist', () => {
    const chat = [{ mes: 'hello', extra: undefined }];
    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    assert.doesNotThrow(() => runPoll());
    assert.equal(sent.length, 0, 'Kein Send wenn extra undefined');
  });

  it('kein Crash wenn chat[i] vollstaendig undefined-Properties hat', () => {
    // chat[i].extra?.reasoning faellt auf '' zurueck durch ?? ''
    const chat = [{}];
    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    assert.doesNotThrow(() => runPoll());
    assert.equal(sent.length, 0);
  });

  it('kein Crash wenn chat[i].extra.reasoning undefined ist', () => {
    const chat = [{ extra: {} }];
    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    assert.doesNotThrow(() => runPoll());
    assert.equal(sent.length, 0, 'undefined reasoning faellt auf leeren String zurueck');
  });
});

// ---------------------------------------------------------------------------
// 6. Defensiver Reset: reasoning wird kuerzer (Rueckschritt)
// ---------------------------------------------------------------------------

describe('Live-Reasoning-Polling — defensiver Reset', () => {

  it('setzt lastReasoningSent zurueck wenn reasoning kuerzer wird', () => {
    let reasoning = 'Langer Text der schon gesendet wurde';
    const chat = [{ extra: { get reasoning() { return reasoning; } } }];
    const { runPoll, state } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    // Erster Tick: normaler Send
    runPoll();
    assert.equal(state.lastReasoningSent, 'Langer Text der schon gesendet wurde');

    // ST setzt reasoning intern zurueck (sehr unwahrscheinlich, aber defensiv)
    reasoning = 'Kurz';
    runPoll();

    // lastReasoningSent muss auf den neuen kuerzeren Wert gesetzt werden
    assert.equal(state.lastReasoningSent, 'Kurz', 'Cursor wurde defensiv zurueckgesetzt');
  });

  it('sendet kein zusaetzliches Delta bei Rueckschritt (nur cursor-reset)', () => {
    let reasoning = 'Urspruenglicher Text';
    const chat = [{ extra: { get reasoning() { return reasoning; } } }];
    const { runPoll, sent } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    runPoll();  // sendet 'Urspruenglicher Text'
    const sentAfterFirst = sent.length;

    reasoning = 'Kurz';  // Rueckschritt
    runPoll();  // kein Send, nur cursor-reset

    assert.equal(sent.length, sentAfterFirst, 'Kein Send beim Rueckschritt selbst');
  });
});

// ---------------------------------------------------------------------------
// 7. getContext() wirft → kein Crash, Warning wird ausgegeben
// ---------------------------------------------------------------------------

describe('Live-Reasoning-Polling — getContext Fehlerbehandlung', () => {

  it('kein Crash wenn getContext() eine Exception wirft', () => {
    const { runPoll, warnings } = makeLiveReasoningHarness({
      getContextFn: () => { throw new Error('ST context not available'); },
    });

    assert.doesNotThrow(() => runPoll());
    assert.equal(warnings.length, 1, 'Warning wurde ausgegeben');
    assert.match(warnings[0], /ST context not available/);
  });

  it('spätere Ticks arbeiten weiter nach recoverbarem Fehler', () => {
    let shouldThrow = true;
    const chat = [{ extra: { reasoning: 'nach-fehler' } }];
    const { runPoll, sent, warnings } = makeLiveReasoningHarness({
      getContextFn: () => {
        if (shouldThrow) throw new Error('transient error');
        return { chat };
      },
    });

    runPoll();  // wirft → kein Send
    shouldThrow = false;
    runPoll();  // funktioniert

    assert.equal(warnings.length, 1, 'Nur eine Warning vom ersten Tick');
    assert.equal(sent.length, 1, 'Send nach Fehler-Recovery');
    assert.equal(sent[0].delta, 'nach-fehler');
  });
});

// ---------------------------------------------------------------------------
// 8. lastReasoningSent-Reset via onGenerationStarted
// ---------------------------------------------------------------------------

describe('Live-Reasoning-Polling — Reset beim neuen Stream', () => {

  it('nach Reset auf leeren String sendet der naechste Tick wieder den vollen Text', () => {
    const chat = [{ extra: { reasoning: 'Reasoning fuer Stream 2' } }];
    const { runPoll, sent, state } = makeLiveReasoningHarness({
      getContextFn: () => ({ chat }),
    });

    // Simuliere: lastReasoningSent war aus vorherigem Stream befuellt
    state.setLastReasoningSent('alter Inhalt vom letzten Stream');

    // onGenerationStarted setzt lastReasoningSent = '' → naechster Poll sendet alles
    state.setLastReasoningSent('');

    runPoll();

    assert.equal(sent.length, 1, 'Nach Reset wird alles neu gesendet');
    assert.equal(sent[0].delta, 'Reasoning fuer Stream 2');
  });
});
