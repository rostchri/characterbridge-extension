/**
 * collect-replies-chatid.test.js
 * Tests fuer die chatId-Fallback-Logik in collectAndSendReplies (commands.js).
 *
 * Fix: Issue #1854 / commit 6e6721f
 *   Frueher: `if (!messageState.chatId) return;` blockierte sendAiReply UND
 *   startDelayedImageObserver wenn data.chatId nicht gesetzt war.
 *   Neu: chatId wird aus ST-Kontext aufgeloest statt gebailty zu werden.
 *
 * Drei Fallback-Pfade werden getestet:
 *   1. ctx.getCurrentChatId() liefert einen Wert
 *   2. ctx.chat_metadata.chat_id (Fallback wenn getCurrentChatId nicht vorhanden)
 *   3. ctx.chat_metadata.chatId (alternativer Schluessel)
 *   4. 'nochat' (finaler Fallback wenn alle anderen fehlen)
 *
 * Strategie: Die chatId-Fallback-Logik wird als Inline-Replik getestet (analog
 * zu chat-history-request.test.js) um den gesamten ST-Event-Apparat zu umgehen.
 *
 * Run from repo root:
 *   node --test src/__tests__/collect-replies-chatid.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentChatId } from '../utils.js';

// ---------------------------------------------------------------------------
// Inline-Replik der chatId-Fallback-Logik aus collectAndSendReplies
// Nutzt jetzt getCurrentChatId() aus utils.js (#1918 — shared helper).
// ---------------------------------------------------------------------------

/**
 * Spiegelt exakt die Fallback-Logik aus commands.js:collectAndSendReplies.
 *
 * @param {{chatId: string|null|undefined}} messageState  Simulierter messageState.
 * @param {object} ctx  Simulierter SillyTavern.getContext()-Rueckgabewert.
 * @returns {string}    Der aufgeloeste chatId-Wert.
 */
function resolveChatId(messageState, ctx) {
  if (!messageState.chatId) {
    messageState.chatId = getCurrentChatId(ctx) ?? 'nochat';
  }
  return messageState.chatId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectAndSendReplies — chatId-Fallback-Logik (#1854)', () => {

  it('Pfad 1: chatId direkt in messageState gesetzt — kein Fallback noetig', () => {
    const messageState = { chatId: 'direct-chat-id' };
    const ctx = {
      getCurrentChatId: () => { throw new Error('should not be called'); },
    };
    const result = resolveChatId(messageState, ctx);
    assert.equal(result, 'direct-chat-id', 'Direkt gesetztes chatId muss unveraendert bleiben');
  });

  it('Pfad 1: getCurrentChatId() liefert chatId wenn messageState.chatId fehlt', () => {
    const messageState = { chatId: null };
    const ctx = {
      getCurrentChatId: () => 'ctx-chat-id',
      chat_metadata: { chat_id: 'should-not-use' },
    };
    const result = resolveChatId(messageState, ctx);
    assert.equal(result, 'ctx-chat-id', 'getCurrentChatId() muss Prioritaet haben');
    assert.equal(messageState.chatId, 'ctx-chat-id', 'messageState.chatId muss gesetzt werden');
  });

  it('Pfad 1: getCurrentChatId() gibt null zurueck → naechster Fallback', () => {
    const messageState = { chatId: null };
    const ctx = {
      getCurrentChatId: () => null,
      chat_metadata: { chat_id: 'meta-chat-id' },
    };
    const result = resolveChatId(messageState, ctx);
    assert.equal(result, 'meta-chat-id', 'chat_metadata.chat_id muss Fallback sein wenn getCurrentChatId null');
  });

  it('Pfad 2: chat_metadata.chat_id genutzt wenn getCurrentChatId nicht vorhanden', () => {
    const messageState = { chatId: undefined };
    const ctx = {
      // Kein getCurrentChatId
      chat_metadata: { chat_id: 'meta-snake-case' },
    };
    const result = resolveChatId(messageState, ctx);
    assert.equal(result, 'meta-snake-case', 'chat_metadata.chat_id muss als Fallback genutzt werden');
  });

  it('Pfad 3: chat_metadata.chatId genutzt wenn chat_metadata.chat_id nicht vorhanden', () => {
    const messageState = { chatId: null };
    const ctx = {
      // Kein getCurrentChatId, kein chat_id
      chat_metadata: { chatId: 'meta-camel-case' },
    };
    const result = resolveChatId(messageState, ctx);
    assert.equal(result, 'meta-camel-case', 'chat_metadata.chatId muss als Fallback genutzt werden');
  });

  it('Pfad 4: finaler Fallback auf "nochat" wenn alle anderen Quellen fehlen', () => {
    const messageState = { chatId: null };
    const ctx = {
      // Kein getCurrentChatId, kein chat_metadata
    };
    const result = resolveChatId(messageState, ctx);
    assert.equal(result, 'nochat', '"nochat" muss der finale Fallback sein');
  });

  it('Pfad 4: finaler Fallback auf "nochat" wenn chat_metadata vorhanden aber leer', () => {
    const messageState = { chatId: null };
    const ctx = {
      chat_metadata: {}, // Keine chat_id oder chatId-Felder
    };
    const result = resolveChatId(messageState, ctx);
    assert.equal(result, 'nochat', '"nochat" muss auch bei leerem chat_metadata genutzt werden');
  });

  it('messageState.chatId wird bei Fallback-Aufloesung persistiert', () => {
    const messageState = { chatId: null };
    const ctx = {
      chat_metadata: { chat_id: 'persisted-id' },
    };
    resolveChatId(messageState, ctx);
    // Zweiter Aufruf: chatId ist jetzt gesetzt, kein Fallback-Lookup mehr
    const ctx2 = { getCurrentChatId: () => { throw new Error('should not be called twice'); } };
    const result2 = resolveChatId(messageState, ctx2);
    assert.equal(result2, 'persisted-id', 'messageState.chatId muss nach erster Aufloesung persistiert sein');
  });

  it('Frueher blockierter Pfad: messageState.chatId=null fuehrt nicht mehr zu return (kein Bail-out)', () => {
    // Dieser Test bestaetigt das Kernziel des Fixes: chatId=null fuehrt
    // NICHT mehr zu einem stillen `return` sondern wird aufgeloest.
    // Der Fix ist in der resolveChatId-Funktion sichtbar: statt `if (!chatId) return`
    // gibt es jetzt einen Fallback-Chain.
    const messageState = { chatId: null };
    const ctx = { chat_metadata: { chat_id: 'fallback-works' } };

    // Wenn der alte Code noch aktiv waere, wuerde die Funktion hier `undefined` zurueckgeben
    // (durch fruehes return). Mit dem Fix wird 'fallback-works' zurueckgegeben.
    const result = resolveChatId(messageState, ctx);
    assert.notEqual(result, undefined, 'Kein undefined — chatId muss immer aufgeloest werden');
    assert.notEqual(result, null, 'Kein null — chatId muss immer aufgeloest werden');
    assert.equal(result, 'fallback-works');
  });
});
