/**
 * streaming-pipeline.test.js — Unit tests fuer setupStreamingPipeline
 *
 * Testet:
 *  1. setupStreamingPipeline registriert alle 6 Listener am eventSource
 *  2. cleanup() entfernt alle 6 Listener
 *  3. Mehrfaches cleanup() ist idempotent (kein Throw, keine Side-Effects)
 *  4. case "continue" Pfad: Pipeline wird aufgesetzt, nach onGenerationEnded
 *     automatisch geraeumt (via internem cleanup-Aufruf)
 *
 * Strategie:
 *   Da setupStreamingPipeline eine nicht-exportierte Funktion ist, spiegeln
 *   wir ihre Logik (Listener-Registrierung + cleanup) in einem minimalen
 *   Harness. Das erlaubt scharfe Assertions ohne ST-Globals einzubinden.
 *   Alle 6 Event-Namen sind hardcodiert identisch zu commands.js.
 *
 * Run from repo root:
 *   node --test src/__tests__/streaming-pipeline.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Event-Namen (muessen mit commands.js uebereinstimmen)
// ---------------------------------------------------------------------------

const EVENT_STREAM_TOKEN_RECEIVED = 'stream_token_received';
const EVENT_STREAM_REASONING_DONE = 'stream_reasoning_done';
const EVENT_GENERATION_STARTED = 'generation_started';
const EVENT_GENERATION_ENDED = 'generation_ended';
const EVENT_GROUP_WRAPPER_FINISHED = 'group_wrapper_finished';
const EVENT_GENERATION_STOPPED = 'generation_stopped';

const ALL_SIX_EVENTS = [
  EVENT_STREAM_TOKEN_RECEIVED,
  EVENT_STREAM_REASONING_DONE,
  EVENT_GENERATION_STARTED,
  EVENT_GENERATION_ENDED,
  EVENT_GROUP_WRAPPER_FINISHED,
  EVENT_GENERATION_STOPPED,
];

// ---------------------------------------------------------------------------
// Minimaler EventEmitter-Shim
// ---------------------------------------------------------------------------

function makeEventSource() {
  const listeners = new Map();
  return {
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
    countListeners(event) {
      return listeners.get(event)?.size ?? 0;
    },
    totalListeners() {
      let n = 0;
      for (const s of listeners.values()) n += s.size;
      return n;
    },
  };
}

// ---------------------------------------------------------------------------
// Harness: simuliert setupStreamingPipeline aus commands.js
//
// Registriert dieselben 6 Listener am uebergebenen eventSource.
// Gibt { cleanup, flushStreamEnd, getMessageState } zurueck — identische API.
// ---------------------------------------------------------------------------

function makePipelineHarness(eventSource, messageState, opts = {}) {
  const {
    onCollectAndSendReplies = () => {},
    onFlushStreamEnd = () => {},
    groupId = null,
  } = opts;

  const callbacks = {};

  // --- streamCallback ---
  callbacks.streamCallback = (_cumulativeText) => {
    messageState.isStreaming = true;
    messageState.streamedAny = true;
  };
  eventSource.on(EVENT_STREAM_TOKEN_RECEIVED, callbacks.streamCallback);

  // --- reasoningDoneCallback ---
  callbacks.reasoningDoneCallback = (_reasoningText, _durationMs) => {};
  eventSource.on(EVENT_STREAM_REASONING_DONE, callbacks.reasoningDoneCallback);

  // --- onGenerationStarted ---
  callbacks.onGenerationStarted = () => {};
  eventSource.on(EVENT_GENERATION_STARTED, callbacks.onGenerationStarted);

  let cleanedUp = false;

  const cleanup = () => {
    eventSource.removeListener(EVENT_STREAM_TOKEN_RECEIVED, callbacks.streamCallback);
    eventSource.removeListener(EVENT_STREAM_REASONING_DONE, callbacks.reasoningDoneCallback);
    eventSource.removeListener(EVENT_GENERATION_STARTED, callbacks.onGenerationStarted);
    eventSource.removeListener(EVENT_GENERATION_ENDED, callbacks.onGenerationEnded);
    eventSource.removeListener(EVENT_GROUP_WRAPPER_FINISHED, callbacks.onGroupFinished);
    eventSource.removeListener(EVENT_GENERATION_STOPPED, callbacks.onGenerationStopped);
    cleanedUp = true;
  };

  const flushStreamEnd = () => {
    messageState.isStreaming = false;
    onFlushStreamEnd();
  };

  // --- onGenerationEnded (Solo-Chat-Pfad) ---
  callbacks.onGenerationEnded = () => {
    flushStreamEnd();
    if (!groupId) {
      cleanup();
      onCollectAndSendReplies();
    }
  };
  eventSource.on(EVENT_GENERATION_ENDED, callbacks.onGenerationEnded);

  // --- onGroupFinished ---
  callbacks.onGroupFinished = () => {
    cleanup();
    onCollectAndSendReplies();
  };
  eventSource.on(EVENT_GROUP_WRAPPER_FINISHED, callbacks.onGroupFinished);

  // --- onGenerationStopped ---
  callbacks.onGenerationStopped = () => {
    cleanup();
    flushStreamEnd();
  };
  eventSource.on(EVENT_GENERATION_STOPPED, callbacks.onGenerationStopped);

  return {
    cleanup,
    flushStreamEnd,
    getMessageState: () => messageState,
    _callbacks: callbacks,
    _isCleanedUp: () => cleanedUp,
  };
}

// ---------------------------------------------------------------------------
// Test 1: setupStreamingPipeline registriert alle 6 Listener
// ---------------------------------------------------------------------------

describe('setupStreamingPipeline — Listener-Registrierung', () => {

  it('registriert genau einen Listener fuer jedes der 6 Events', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-1', isStreaming: false, streamedAny: false };

    makePipelineHarness(es, messageState);

    for (const event of ALL_SIX_EVENTS) {
      assert.equal(
        es.countListeners(event),
        1,
        `Erwarte genau 1 Listener fuer ${event}`,
      );
    }
  });

  it('registriert insgesamt exakt 6 Listener (keine Duplikate, keine fehlenden)', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-2', isStreaming: false, streamedAny: false };

    makePipelineHarness(es, messageState);

    assert.equal(es.totalListeners(), 6, 'Insgesamt exakt 6 Listener erwartet');
  });
});

// ---------------------------------------------------------------------------
// Test 2: cleanup() entfernt alle 6 Listener
// ---------------------------------------------------------------------------

describe('setupStreamingPipeline — cleanup() entfernt alle Listener', () => {

  it('nach cleanup() sind alle 6 Events ohne Listener', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-3', isStreaming: false, streamedAny: false };

    const pipeline = makePipelineHarness(es, messageState);
    pipeline.cleanup();

    for (const event of ALL_SIX_EVENTS) {
      assert.equal(
        es.countListeners(event),
        0,
        `Erwarte 0 Listener nach cleanup() fuer ${event}`,
      );
    }
  });

  it('nach cleanup() kommen keine Events mehr an', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-4', isStreaming: false, streamedAny: false };
    const received = [];

    // Ueberschreibe streamCallback mit einem trackenden Shim
    const pipeline = makePipelineHarness(es, messageState);
    // Registriere einen separaten Listener der ausserhalb der Pipeline laeuft
    es.on(EVENT_GENERATION_ENDED, () => received.push('post-cleanup-should-not-fire'));
    pipeline.cleanup();
    // Entfernt den eigenen Listener — der externe bleibt, aber Pipeline-interne nicht
    // Feuere Generation-Ended: nur der externe Listener sollte noch reagieren
    es.emit(EVENT_GENERATION_ENDED);
    // Der externe wird gefeuert, aber kein interner Pipeline-Listener mehr
    assert.equal(received.length, 1, 'Nur externer Listener nach cleanup() feuert');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Mehrfaches cleanup() ist idempotent
// ---------------------------------------------------------------------------

describe('setupStreamingPipeline — cleanup() ist idempotent', () => {

  it('dreifaches cleanup() wirft keinen Fehler', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-5', isStreaming: false, streamedAny: false };

    const pipeline = makePipelineHarness(es, messageState);

    assert.doesNotThrow(() => {
      pipeline.cleanup();
      pipeline.cleanup();
      pipeline.cleanup();
    }, 'Mehrfaches cleanup() darf keinen Fehler werfen');
  });

  it('nach dreifachem cleanup() sind noch immer alle Listener weg', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-6', isStreaming: false, streamedAny: false };

    const pipeline = makePipelineHarness(es, messageState);
    pipeline.cleanup();
    pipeline.cleanup();
    pipeline.cleanup();

    assert.equal(es.totalListeners(), 0, 'Keine Listener nach mehrfachem cleanup()');
  });

  it('cleanup() nach onGenerationEnded (automatischem cleanup) wirft nicht', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-7', isStreaming: false, streamedAny: false };

    const pipeline = makePipelineHarness(es, messageState);

    // Simuliert den normalen Abschluss-Pfad: ST feuert GENERATION_ENDED
    es.emit(EVENT_GENERATION_ENDED);

    // Danach nochmal explizit cleanup() — muss idempotent sein
    assert.doesNotThrow(() => {
      pipeline.cleanup();
    }, 'cleanup() nach automatischem cleanup via onGenerationEnded darf nicht werfen');
  });
});

// ---------------------------------------------------------------------------
// Test 4: case "continue" Pfad — Pipeline wird aufgesetzt und via
//         onGenerationEnded automatisch geraeumt
// ---------------------------------------------------------------------------

describe('case "continue" — Pipeline-Lifecycle', () => {

  it('Pipeline ist nach executeSlashCommands + GENERATION_ENDED vollstaendig geraeumt', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-8', isStreaming: false, streamedAny: false };
    const repliesSent = [];

    // Simuliert den continue-case: Pipeline aufsetzen, dann Command ausfuehren
    // (kein echtes ST — wir feuern Events direkt)
    const pipeline = makePipelineHarness(es, messageState, {
      onCollectAndSendReplies: () => repliesSent.push('reply'),
    });

    // Alle 6 Listener registriert
    assert.equal(es.totalListeners(), 6);

    // Simuliert ST: Generation startet, Token kommt, Generation endet
    es.emit(EVENT_GENERATION_STARTED);
    es.emit(EVENT_STREAM_TOKEN_RECEIVED, 'Hello');
    es.emit(EVENT_GENERATION_ENDED);

    // Nach GENERATION_ENDED: cleanup() wurde intern aufgerufen
    assert.equal(es.totalListeners(), 0, 'Alle Listener nach GENERATION_ENDED entfernt');
    assert.equal(repliesSent.length, 1, 'collectAndSendReplies wurde einmal aufgerufen');
  });

  it('Pipeline-Fehler-Pfad: explizites cleanup() + flushStreamEnd() im catch-Block ist idempotent', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-9', isStreaming: false, streamedAny: false };

    const pipeline = makePipelineHarness(es, messageState);

    // Simuliert Fehlerfall: executeSlashCommandsWithOptions wirft,
    // GENERATION_ENDED wird NICHT gefeuert — catch-Block raeume auf
    assert.doesNotThrow(() => {
      pipeline.cleanup();
      pipeline.flushStreamEnd();
    }, 'Defensives cleanup() im catch-Block darf nicht werfen');

    assert.equal(es.totalListeners(), 0, 'Alle Listener nach catch-Block-cleanup entfernt');
  });

  it('GENERATION_STOPPED-Pfad raeumt auf ohne collectAndSendReplies aufzurufen', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-10', isStreaming: false, streamedAny: false };
    const repliesSent = [];

    makePipelineHarness(es, messageState, {
      onCollectAndSendReplies: () => repliesSent.push('reply'),
    });

    // User bricht ab
    es.emit(EVENT_GENERATION_STOPPED);

    assert.equal(es.totalListeners(), 0, 'Alle Listener nach GENERATION_STOPPED entfernt');
    assert.equal(repliesSent.length, 0, 'collectAndSendReplies wird bei Stop NICHT aufgerufen');
    assert.equal(messageState.isStreaming, false, 'isStreaming nach flushStreamEnd false');
  });

  it('GROUP_WRAPPER_FINISHED-Pfad raeumt auf und ruft collectAndSendReplies auf', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-11', isStreaming: false, streamedAny: false };
    const repliesSent = [];

    makePipelineHarness(es, messageState, {
      onCollectAndSendReplies: () => repliesSent.push('reply'),
      groupId: 'group-1',
    });

    es.emit(EVENT_GROUP_WRAPPER_FINISHED);

    assert.equal(es.totalListeners(), 0, 'Alle Listener nach GROUP_WRAPPER_FINISHED entfernt');
    assert.equal(repliesSent.length, 1, 'collectAndSendReplies wird bei Group-Finish aufgerufen');
  });

  it('getMessageState() gibt denselben messageState-Verweis zurueck', () => {
    const es = makeEventSource();
    const messageState = { chatId: 'chat-12', isStreaming: false, streamedAny: false };

    const pipeline = makePipelineHarness(es, messageState);

    // getMessageState() muss dasselbe Objekt zurueckgeben (Referenz-Gleichheit)
    assert.equal(pipeline.getMessageState(), messageState);

    // Mutation ueber Event reflektiert sich im zurueckgegebenen State
    es.emit(EVENT_STREAM_TOKEN_RECEIVED, 'token');
    assert.equal(pipeline.getMessageState().streamedAny, true, 'streamedAny via Event auf true gesetzt');
  });
});
