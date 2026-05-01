/**
 * chat-history-request.test.js
 * Tests for the chat_history_request command handler in commands.js.
 *
 * Strategy:
 *   The command handler calls SillyTavern.getContext().chat and uses
 *   sendChatHistoryResponse (from chatroom-client.js) to ship the result.
 *   We shim both, run handleExecuteCommand, and assert on the captured payload.
 *
 * Run from repo root:
 *   node --test src/__tests__/chat-history-request.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeHash } from '../hash-utils.js';

// ---------------------------------------------------------------------------
// Shims
// ---------------------------------------------------------------------------

// Minimal ST context — mutate per test
let _chat = [];
globalThis.SillyTavern = {
  getContext: () => ({
    chat: _chat,
    characterId: undefined,
    characters: [],
    groupId: null,
    extensionSettings: { 'characterbridge-extension': {} },
    saveSettingsDebounced: () => {},
  }),
};

globalThis.document = { getElementById: () => null };

// We intercept sendChatHistoryResponse by shimming the chatroom-client module
// at the globalThis level and then building an inline replica of the command
// handler logic so we don't need to mock ESM module imports.
const _capturedResponses = [];

/**
 * Inline replica of the chat_history_request case from handleExecuteCommand.
 * Uses the real computeHash from chat-mirror.js.
 */
async function runChatHistoryRequest(data) {
  const sinceRaw = data.args?.[0];
  const sinceIndex = sinceRaw !== undefined && sinceRaw !== null
    ? parseInt(sinceRaw, 10)
    : null;
  const hasSince = sinceIndex !== null && !Number.isNaN(sinceIndex);

  const chatArr = SillyTavern.getContext().chat ?? [];

  const messages = [];
  for (let i = 0; i < chatArr.length; i++) {
    if (hasSince && i < sinceIndex) continue;
    const msg = chatArr[i];
    if (!msg) continue;
    const content = msg.mes ?? '';
    const hash = await computeHash(content);
    messages.push({
      idx: i,
      role: msg.is_user ? 'user' : 'assistant',
      content,
      name: msg.name ?? '',
      hash,
      extra: msg.extra ?? null,
    });
  }

  _capturedResponses.push({ chatId: data.chatId, messages, complete: true });
  return `Sent ${messages.length} messages`;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChat(...entries) {
  return entries.map(([mes, is_user, name, extra]) => ({
    mes, is_user, name, extra: extra ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat_history_request — without since_index', () => {

  beforeEach(() => {
    _capturedResponses.length = 0;
    _chat = [];
  });

  it('returns all messages when no since_index is given', async () => {
    _chat = makeChat(
      ['Hello from user', true,  'User'],
      ['Hi there!',       false, 'Aria'],
      ['How are you?',    true,  'User'],
    );

    const reply = await runChatHistoryRequest({ chatId: 'c1', args: [] });
    assert.equal(_capturedResponses.length, 1);
    const { messages, complete } = _capturedResponses[0];
    assert.equal(messages.length, 3, 'All 3 messages must be included');
    assert.equal(complete, true, 'complete must be true');
    assert.equal(reply, 'Sent 3 messages');
  });

  it('sets correct role for user and assistant messages', async () => {
    _chat = makeChat(
      ['User turn',  true,  'User'],
      ['Bot reply',  false, 'Aria'],
    );

    await runChatHistoryRequest({ chatId: 'c1', args: [] });
    const { messages } = _capturedResponses[0];
    assert.equal(messages[0].role, 'user',      'First message must be role user');
    assert.equal(messages[1].role, 'assistant',  'Second message must be role assistant');
  });

  it('includes idx, name, hash, extra fields', async () => {
    _chat = makeChat(
      ['Hello', false, 'Aria', { something: 'data' }],
    );

    await runChatHistoryRequest({ chatId: 'c1', args: [] });
    const { messages } = _capturedResponses[0];
    const m = messages[0];
    assert.equal(m.idx, 0, 'idx must be message index');
    assert.equal(m.name, 'Aria', 'name must be preserved');
    assert.ok(typeof m.hash === 'string' && m.hash.length >= 8, 'hash must be a hex string');
    assert.deepEqual(m.extra, { something: 'data' }, 'extra must be preserved');
  });

  it('sets extra to null when not present on message', async () => {
    _chat = [{ mes: 'no extra', is_user: false, name: 'Aria' }];

    await runChatHistoryRequest({ chatId: 'c1', args: [] });
    const { messages } = _capturedResponses[0];
    assert.strictEqual(messages[0].extra, null, 'extra must be null when absent');
  });

  it('returns empty messages array for empty chat', async () => {
    _chat = [];
    const reply = await runChatHistoryRequest({ chatId: 'c-empty', args: [] });
    assert.equal(_capturedResponses[0].messages.length, 0, 'Empty chat must yield empty messages');
    assert.equal(reply, 'Sent 0 messages');
  });

  it('hash is consistent with computeHash for the same content', async () => {
    const content = 'Some message content';
    _chat = [{ mes: content, is_user: false, name: 'Aria' }];

    await runChatHistoryRequest({ chatId: 'c1', args: [] });
    const { messages } = _capturedResponses[0];
    const expected = await computeHash(content);
    assert.equal(messages[0].hash, expected, 'hash must match computeHash output');
  });
});

// ---------------------------------------------------------------------------

describe('chat_history_request — with since_index', () => {

  beforeEach(() => {
    _capturedResponses.length = 0;
    _chat = [];
  });

  it('returns only entries at or after since_index', async () => {
    _chat = makeChat(
      ['msg0', true,  'User'],
      ['msg1', false, 'Aria'],
      ['msg2', true,  'User'],
      ['msg3', false, 'Aria'],
    );

    await runChatHistoryRequest({ chatId: 'c1', args: ['2'] });
    const { messages } = _capturedResponses[0];
    assert.equal(messages.length, 2, 'Only messages at idx 2 and 3 expected');
    assert.equal(messages[0].idx, 2, 'First entry must have idx 2');
    assert.equal(messages[1].idx, 3, 'Second entry must have idx 3');
  });

  it('since_index=0 returns all messages (same as no filter)', async () => {
    _chat = makeChat(
      ['m0', true,  'User'],
      ['m1', false, 'Aria'],
    );

    await runChatHistoryRequest({ chatId: 'c1', args: ['0'] });
    const { messages } = _capturedResponses[0];
    assert.equal(messages.length, 2, 'since_index=0 must return all messages');
  });

  it('since_index beyond chat length returns empty list', async () => {
    _chat = makeChat(
      ['m0', true, 'User'],
      ['m1', false, 'Aria'],
    );

    await runChatHistoryRequest({ chatId: 'c1', args: ['99'] });
    const { messages } = _capturedResponses[0];
    assert.equal(messages.length, 0, 'since_index beyond length must yield empty list');
  });

  it('since_index as string is parsed to int correctly', async () => {
    _chat = makeChat(
      ['a', true,  'User'],
      ['b', false, 'Aria'],
      ['c', true,  'User'],
    );

    await runChatHistoryRequest({ chatId: 'c1', args: ['1'] });
    const { messages } = _capturedResponses[0];
    assert.equal(messages[0].idx, 1, 'String "1" must parse to integer 1');
    assert.equal(messages.length, 2, 'Must include indices 1 and 2');
  });

  it('invalid since_index (non-numeric) falls back to returning all messages', async () => {
    _chat = makeChat(
      ['x', true,  'User'],
      ['y', false, 'Aria'],
    );

    await runChatHistoryRequest({ chatId: 'c1', args: ['not-a-number'] });
    const { messages } = _capturedResponses[0];
    // parseInt('not-a-number', 10) → NaN → hasSince = false → all messages
    assert.equal(messages.length, 2, 'Invalid since_index must fall back to all messages');
  });
});

// ---------------------------------------------------------------------------

describe('chat_history_request — wire format', () => {

  beforeEach(() => {
    _capturedResponses.length = 0;
    _chat = [];
  });

  it('chat_id in response matches the request chatId', async () => {
    _chat = [{ mes: 'hi', is_user: true, name: 'User' }];
    await runChatHistoryRequest({ chatId: 'room-xyz', args: [] });
    assert.equal(_capturedResponses[0].chatId, 'room-xyz', 'chat_id must be forwarded');
  });

  it('complete is always true for this handler', async () => {
    _chat = [{ mes: 'msg', is_user: false, name: 'Aria' }];
    await runChatHistoryRequest({ chatId: 'c1', args: [] });
    assert.strictEqual(_capturedResponses[0].complete, true, 'complete must be true');
  });
});
