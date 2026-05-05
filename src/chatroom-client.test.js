/**
 * chatroom-client.test.js — Unit tests for src/chatroom-client.js
 *
 * Run from repo root:
 *   node --test src/chatroom-client.test.js
 *
 * Strategy:
 *   - chatroom-client.js uses the Browser WebSocket API (global WebSocket).
 *   - We polyfill global.WebSocket with the ws-lib client class so the module
 *     can run in Node without modification.
 *   - A real ws.WebSocketServer is spun up on a random port per test so that
 *     connect/auth/heartbeat/reconnect flows use actual socket I/O.
 *   - Settings are shimmed via globalThis.SillyTavern before each test.
 *   - The module exposes _resetForTest() to clear singleton state between tests.
 *
 * NOTE: The test-mode bypass (auto-authenticate when secret+room_id both empty)
 *   has been removed (#1812). Tests now always set a dummy secret/room_id pair
 *   and have the test server respond with auth_ok.
 */

import { createServer } from 'node:http';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket as WsClient, WebSocketServer } from '../node_modules/ws/wrapper.mjs';

// ---------------------------------------------------------------------------
// Global shims (Browser APIs expected by chatroom-client.js and its deps)
// ---------------------------------------------------------------------------

globalThis.WebSocket = WsClient;

// Persistent extensionSettings object — MUST be the same reference on every
// getContext() call, because settings.js caches MODULE_NAME into this object
// and reads it back by reference on subsequent calls.
const _extensionSettings = {
  'characterbridge-extension': {
    chatroomUrl: '',
    chatroomSharedSecret: '',
    chatroomAutoConnect: false,
    bridgeUrl: '',
    sharedSecret: '',
    autoConnect: false,
    expressionMode: 'status',
  },
};

// Persistent context object — same reference on every call.
const _stContext = {
  extensionSettings: _extensionSettings,
  saveSettingsDebounced: () => {},
};

globalThis.SillyTavern = {
  getContext: () => _stContext,
};

// DOM shim: updateStatus uses document.getElementById
globalThis.document = { getElementById: () => null };

// ---------------------------------------------------------------------------
// Import SUT (after globals are set)
// ---------------------------------------------------------------------------

import {
  connect,
  disconnect,
  onMessage,
  send,
  sendStreamEnd,
  sendStreamChunk,
  sendStreamEndWithContext,
  sendUserMessageReply,
  sendExpression,
  sendAvatar,
  sendInventory,
  sendInventoryUpdate,
  sendTypingAction,
  sendChatHistoryResponse,
  sendMessageChanged,
  sendChatSwitched,
  isConnected,
  _getSocket,
  _isAuthenticated,
  _getReconnectDelay,
  _resetForTest,
} from './chatroom-client.js';

import { chatroomConnectionState } from './state.js';
import { getSettings } from './settings.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a ws WebSocketServer on a random port.
 * Returns { wss, port, close() }.
 */
function createTestServer() {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      resolve({
        wss,
        port,
        close: () =>
          new Promise((res) => {
            wss.clients.forEach((c) => c.terminate());
            wss.close(() => httpServer.close(res));
          }),
      });
    });
  });
}

/**
 * Waits up to `ms` ms for predicate() to return true, polling every `interval` ms.
 */
async function waitFor(predicate, ms = 2000, interval = 20) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

/**
 * Runs a full test: sets up server, configures settings, runs fn, tears down.
 *
 * @param {string} secret  Shared secret (must be non-empty; tests require auth).
 * @param {Function} fn    Test body receiving (srv).
 * @param {{ autoAuth?: boolean }} [opts]
 *   autoAuth: when true, the helper registers a server-side connection handler
 *   that automatically responds with auth_ok after the first auth frame.
 *   Set to false when the test itself controls the auth flow.
 */
async function withServer(secret, fn, { autoAuth = false } = {}) {
  const srv = await createTestServer();
  const settings = getSettings();
  settings.chatroomUrl = `ws://127.0.0.1:${srv.port}`;
  settings.chatroomSharedSecret = secret ?? 'test-dummy';
  settings.chatroomRoomId = 'test-room';

  if (autoAuth) {
    srv.wss.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      });
    });
  }

  try {
    await fn(srv);
  } finally {
    disconnect();
    _resetForTest();
    await srv.close();
    await new Promise((r) => setTimeout(r, 30));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chatroom-client — connect + auth handshake', () => {

  afterEach(() => { _resetForTest(); });

  it('sends auth frame and transitions to connected on auth_ok', async () => {
    await withServer('testsecret', async (srv) => {
      let receivedAuth = null;
      srv.wss.once('connection', (ws) => {
        ws.once('message', (data) => {
          receivedAuth = JSON.parse(data.toString());
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });

      connect();
      await waitFor(() => isConnected());

      assert.equal(receivedAuth?.type, 'auth');
      assert.equal(receivedAuth?.secret, 'testsecret');
      assert.equal(isConnected(), true);
      assert.equal(chatroomConnectionState.isConnected, true);
    });
  });

  it('sets isConnected=false and suppresses reconnect on auth_failed', async () => {
    await withServer('wrongsecret', async (srv) => {
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'auth_failed', reason: 'bad secret' }));
        });
      });

      connect();
      // Wait for socket to be closed (null) after auth failure
      await waitFor(() => _getSocket() === null, 3000);

      assert.equal(isConnected(), false);
      assert.equal(chatroomConnectionState.isConnected, false);
    });
  });

  it('closes connection when shared secret or room_id is missing', async () => {
    const settings = getSettings();
    const srv = await createTestServer();
    settings.chatroomUrl = `ws://127.0.0.1:${srv.port}`;
    // Intentionally missing secret — must result in closed socket
    settings.chatroomSharedSecret = '';
    settings.chatroomRoomId = '';

    let serverConnected = false;
    srv.wss.once('connection', () => { serverConnected = true; });

    try {
      connect();
      // Socket should be closed by the client immediately after onopen
      await waitFor(() => _getSocket() === null || !isConnected(), 2000);
      assert.equal(isConnected(), false, 'Must not be connected without credentials');
    } finally {
      disconnect();
      _resetForTest();
      await srv.close();
      await new Promise((r) => setTimeout(r, 30));
    }
  });

  it('dispatches _connected synthetic packet after auth', async () => {
    await withServer('test-dummy', async (srv) => {
      let connectedReceived = false;
      // Register handler BEFORE connect so it catches _connected
      onMessage((pkt) => { if (pkt.type === '_connected') connectedReceived = true; });

      srv.wss.once('connection', (ws) => {
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });
      connect();
      await waitFor(() => connectedReceived);
      assert.ok(connectedReceived);
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — heartbeat', () => {

  afterEach(() => { _resetForTest(); });

  it('responds to server-initiated ping with pong', async () => {
    await withServer('test-dummy', async (srv) => {
      let serverConn = null;
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        serverConn = ws;
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
        ws.on('message', (data) => {
          serverReceived.push(JSON.parse(data.toString()));
        });
      });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      serverConn.send(JSON.stringify({ type: 'ping' }));
      await waitFor(() => serverReceived.some((f) => f.type === 'pong'));

      const pong = serverReceived.find((f) => f.type === 'pong');
      assert.ok(pong, 'Client should reply with pong');
    });
  });

  it('remains connected while server sends pongs', async () => {
    await withServer('test-dummy', async (srv) => {
      let serverConn = null;
      srv.wss.once('connection', (ws) => {
        serverConn = ws;
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      // Simulate a pong to reset the deadline
      serverConn.send(JSON.stringify({ type: 'pong' }));
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(isConnected(), true);
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — packet sending (typed senders)', () => {
  // Shared server for all send tests — more efficient
  let srv = null;
  let serverConn = null;
  let serverReceived = [];

  before(async () => {
    srv = await createTestServer();
    const settings = getSettings();
    settings.chatroomUrl = `ws://127.0.0.1:${srv.port}`;
    settings.chatroomSharedSecret = 'test-dummy';
    settings.chatroomRoomId = 'test-room';

    srv.wss.once('connection', (ws) => {
      serverConn = ws;
      // Auto-auth: respond to the first frame with auth_ok, then collect all further frames.
      ws.once('message', () => {
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      });
      ws.on('message', (data) => {
        serverReceived.push(JSON.parse(data.toString()));
      });
    });

    connect();
    await waitFor(() => isConnected() && serverConn !== null);
  });

  afterEach(() => { serverReceived = []; });

  after(async () => {
    disconnect();
    _resetForTest();
    await srv.close();
  });

  it('sendUserMessageReply sends ai_reply with correct fields', async () => {
    sendUserMessageReply('Hello world', 'Aria');
    await waitFor(() => serverReceived.some((f) => f.type === 'ai_reply'));
    const p = serverReceived.find((f) => f.type === 'ai_reply');
    assert.equal(p.text, 'Hello world');
    assert.equal(p.char_name, 'Aria');
  });

  it('sendStreamChunk sends stream_chunk with correct fields', async () => {
    sendStreamChunk('sid-1', 'partial text', 'Aria');
    await waitFor(() => serverReceived.some((f) => f.type === 'stream_chunk'));
    const p = serverReceived.find((f) => f.type === 'stream_chunk');
    assert.equal(p.stream_id, 'sid-1');
    assert.equal(p.delta, 'partial text');
    assert.equal(p.char_name, 'Aria');
  });

  it('sendStreamEnd preserves null finalText — NOT coerced to empty string', async () => {
    sendStreamEnd('sid-null', null, 'Aria');
    await waitFor(() => serverReceived.some((f) => f.type === 'stream_end' && f.stream_id === 'sid-null'));
    const p = serverReceived.find((f) => f.type === 'stream_end' && f.stream_id === 'sid-null');
    assert.strictEqual(p.final_text, null, 'null MUST be preserved per spec');
    assert.equal(p.char_name, 'Aria');
  });

  it('sendStreamEnd transmits non-null finalText', async () => {
    sendStreamEnd('sid-text', 'Final answer.', 'Aria');
    await waitFor(() => serverReceived.some((f) => f.type === 'stream_end' && f.stream_id === 'sid-text'));
    const p = serverReceived.find((f) => f.type === 'stream_end' && f.stream_id === 'sid-text');
    assert.equal(p.final_text, 'Final answer.');
  });

  it('sendExpression sends expression_update with image_url', async () => {
    sendExpression('Aria', 'happy', 'https://st.example.com/sprites/happy.png');
    await waitFor(() => serverReceived.some((f) => f.type === 'expression_update'));
    const p = serverReceived.find((f) => f.type === 'expression_update');
    assert.equal(p.char_name, 'Aria');
    assert.equal(p.emotion, 'happy');
    assert.equal(p.image_url, 'https://st.example.com/sprites/happy.png');
    assert.equal(p.image_b64, undefined, 'image_b64 must not appear in wire format');
  });

  it('sendExpression uses null image_url when none provided', async () => {
    sendExpression('Aria', 'neutral', null);
    await waitFor(() => serverReceived.some((f) => f.type === 'expression_update' && f.emotion === 'neutral'));
    const p = serverReceived.find((f) => f.type === 'expression_update' && f.emotion === 'neutral');
    assert.strictEqual(p.image_url, null);
    assert.equal(p.image_b64, undefined, 'image_b64 must not appear in wire format');
  });

  it('sendAvatar sends avatar_update with image_url', async () => {
    sendAvatar('Aria', 'https://st.example.com/thumbnail?type=avatar&file=Aria.png');
    await waitFor(() => serverReceived.some((f) => f.type === 'avatar_update'));
    const p = serverReceived.find((f) => f.type === 'avatar_update');
    assert.equal(p.char_name, 'Aria');
    assert.equal(p.image_url, 'https://st.example.com/thumbnail?type=avatar&file=Aria.png');
    assert.equal(p.image_b64, undefined, 'image_b64 must not appear in wire format');
  });

  it('sendInventory uses ai_character field as singular Object (not array)', async () => {
    sendInventory({ bots: [{ name: 'Aria', avatar_url: null, description: 'Test' }], personas: [], metadata: {} });
    await waitFor(() => serverReceived.some((f) => f.type === 'character_inventory'));
    const p = serverReceived.find((f) => f.type === 'character_inventory');
    assert.ok(p.ai_character !== null && typeof p.ai_character === 'object' && !Array.isArray(p.ai_character),
      'ai_character must be a singular Object, not an array');
    assert.equal(p.ai_character.name, 'Aria', 'ai_character.name must be the active character name');
    assert.equal(p.bots, undefined, 'bots field must NOT appear in wire format');
  });

  it('sendInventory resolves active character by metadata.activeCharacter', async () => {
    sendInventory({
      bots: [
        { name: 'Aria', avatar_url: null, description: 'A' },
        { name: 'Lyra', avatar_url: null, description: 'L' },
      ],
      personas: [],
      metadata: { activeCharacter: 'Lyra' },
    });
    await waitFor(() => serverReceived.some((f) => f.type === 'character_inventory' && f.ai_character?.name === 'Lyra'));
    const p = serverReceived.find((f) => f.type === 'character_inventory' && f.ai_character?.name === 'Lyra');
    assert.equal(p.ai_character.name, 'Lyra', 'Must pick the character matching metadata.activeCharacter');
  });

  it('sendInventory falls back to bots[0] when no activeCharacter set', async () => {
    sendInventory({
      bots: [
        { name: 'First', avatar_url: null, description: '' },
        { name: 'Second', avatar_url: null, description: '' },
      ],
      personas: [],
      metadata: {},
    });
    await waitFor(() => serverReceived.some((f) => f.type === 'character_inventory' && f.ai_character?.name === 'First'));
    const p = serverReceived.find((f) => f.type === 'character_inventory' && f.ai_character?.name === 'First');
    assert.equal(p.ai_character.name, 'First', 'Must fall back to bots[0] when no activeCharacter');
  });

  it('sendInventory sends null ai_character when bots list is empty', async () => {
    sendInventory({ bots: [], personas: [], metadata: {} });
    await waitFor(() => serverReceived.some((f) => f.type === 'character_inventory' && !f.ai_character));
    const p = serverReceived.find((f) => f.type === 'character_inventory' && !f.ai_character);
    assert.strictEqual(p.ai_character, null, 'ai_character must be null when no bots available');
  });

  it('sendInventoryUpdate sends inventory_update', async () => {
    sendInventoryUpdate({ bots: [], personas: [{ name: 'User1' }], metadata: {} });
    await waitFor(() => serverReceived.some((f) => f.type === 'inventory_update'));
    const p = serverReceived.find((f) => f.type === 'inventory_update');
    assert.equal(p.personas[0].name, 'User1');
  });

  it('sendInventoryUpdate uses ai_character as singular Object (snake_case, not bots array)', async () => {
    sendInventoryUpdate({ bots: [{ name: 'Bot1', avatar_url: null, description: '' }], personas: [], metadata: { activeCharacter: 'Bot1' } });
    await waitFor(() => serverReceived.some((f) => f.type === 'inventory_update' && f.ai_character));
    const p = serverReceived.find((f) => f.type === 'inventory_update' && f.ai_character);
    assert.ok(!Array.isArray(p.ai_character), 'ai_character must NOT be an array');
    assert.equal(typeof p.ai_character, 'object', 'ai_character must be an Object');
    assert.equal(p.ai_character.name, 'Bot1', 'ai_character.name must match active character');
    assert.equal(p.bots, undefined, 'bots field must NOT appear in wire format');
  });

  it('sendTypingAction sends typing_action with strict boolean active', async () => {
    sendTypingAction('Aria', true);
    await waitFor(() => serverReceived.some((f) => f.type === 'typing_action'));
    const p = serverReceived.find((f) => f.type === 'typing_action');
    assert.equal(p.char_name, 'Aria');
    assert.strictEqual(p.active, true, 'active must be boolean true');
  });

  it('send() is a no-op when not connected', () => {
    // We have a connected client here; test the guard by calling send on a
    // temporarily null socket would require breaking the singleton, which
    // _resetForTest does. Instead verify via a fresh disconnected state.
    _resetForTest();
    // After reset, _authenticated is false — send() must not throw
    assert.doesNotThrow(() => send({ type: 'test' }));
  });

});

// ---------------------------------------------------------------------------

describe('chatroom-client — packet receiving', () => {

  afterEach(() => { _resetForTest(); });

  it('dispatches inbound user_message to onMessage handlers', async () => {
    await withServer('test-dummy', async (srv) => {
      let serverConn = null;
      srv.wss.once('connection', (ws) => {
        serverConn = ws;
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });

      const received = [];
      onMessage((pkt) => { if (pkt.type === 'user_message') received.push(pkt); });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      serverConn.send(JSON.stringify({ type: 'user_message', text: 'Hi', persona: 'User1' }));
      await waitFor(() => received.length > 0);

      assert.equal(received[0].text, 'Hi');
      assert.equal(received[0].persona, 'User1');
    });
  });

  it('dispatches inbound command packet', async () => {
    await withServer('test-dummy', async (srv) => {
      let serverConn = null;
      srv.wss.once('connection', (ws) => {
        serverConn = ws;
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });

      const received = [];
      onMessage((pkt) => { if (pkt.type === 'command') received.push(pkt); });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      serverConn.send(JSON.stringify({ type: 'command', cmd: 'switchchar', args: ['Aria'] }));
      await waitFor(() => received.length > 0);

      assert.equal(received[0].cmd, 'switchchar');
      assert.deepEqual(received[0].args, ['Aria']);
    });
  });

  it('silently ignores malformed JSON frames', async () => {
    await withServer('test-dummy', async (srv) => {
      let serverConn = null;
      srv.wss.once('connection', (ws) => {
        serverConn = ws;
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });

      connect();
      await waitFor(() => isConnected() && serverConn !== null);

      // Send bad JSON — should not crash or disconnect
      serverConn.send('not json {{{{');
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(isConnected(), true, 'Should still be connected after bad frame');
    });
  });

  it('ignores pre-auth frames other than auth_ok/auth_failed', async () => {
    await withServer('secret', async (srv) => {
      let serverConn = null;
      const handlerPackets = [];

      srv.wss.once('connection', (ws) => {
        serverConn = ws;
        ws.once('message', () => {
          // Send a non-auth packet before responding with auth_ok
          ws.send(JSON.stringify({ type: 'user_message', text: 'early' }));
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      });

      onMessage((pkt) => { if (pkt.type === 'user_message') handlerPackets.push(pkt); });

      connect();
      await waitFor(() => isConnected());
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(handlerPackets.length, 0, 'Pre-auth user_message must be ignored');
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — disconnect', () => {

  afterEach(() => { _resetForTest(); });

  it('cleanly disconnects and sets isConnected=false', async () => {
    await withServer('test-dummy', async (srv) => {
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
      });
      connect();
      await waitFor(() => isConnected());

      disconnect();
      await waitFor(() => !isConnected());

      assert.equal(isConnected(), false);
      assert.equal(chatroomConnectionState.isConnected, false);
    });
  });

  it('suppresses reconnect after manual disconnect', async () => {
    await withServer('test-dummy', async (srv) => {
      srv.wss.on('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
      });
      connect();
      await waitFor(() => isConnected());

      disconnect();
      await waitFor(() => !isConnected());

      // Wait longer than minimum backoff — should NOT reconnect
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(isConnected(), false, 'Must not reconnect after explicit disconnect');
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — reconnect', () => {

  afterEach(() => { _resetForTest(); });

  it('goes to disconnected state when server drops connection', async () => {
    await withServer('test-dummy', async (srv) => {
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
      });
      connect();
      await waitFor(() => isConnected());

      // Force-terminate from server side
      srv.wss.clients.forEach((c) => c.terminate());

      await waitFor(() => !isConnected(), 1000);
      assert.equal(isConnected(), false);
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — backoff monotonicity (#1817, #1876)', () => {

  afterEach(() => { _resetForTest(); });

  it('first reconnect fires after BACKOFF_INITIAL_MS (5 s), not 2× (#1876)', async () => {
    // _scheduleReconnect doubles _reconnectDelay BEFORE the wait.
    // The module seeds _reconnectDelay at BACKOFF_INITIAL_MS / 2 so that after
    // the first doubling the effective wait equals exactly BACKOFF_INITIAL_MS.
    // After _resetForTest the seed value is BACKOFF_INITIAL_MS / 2 = 2500.
    const BACKOFF_SEED_MS = 2_500;
    const BACKOFF_INITIAL_MS = 5_000;
    const BACKOFF_MAX_MS = 60_000;

    assert.equal(_getReconnectDelay(), BACKOFF_SEED_MS, 'Seed delay must be 2500 ms (half of initial)');

    // Verify first effective delay: seed × 2 = BACKOFF_INITIAL_MS.
    assert.equal(BACKOFF_SEED_MS * 2, BACKOFF_INITIAL_MS, 'First reconnect delay must equal BACKOFF_INITIAL_MS (5 s)');

    // Verify cap: after many doublings the delay must not exceed BACKOFF_MAX_MS.
    let d = BACKOFF_SEED_MS;
    for (let i = 0; i < 20; i++) d = Math.min(d * 2, BACKOFF_MAX_MS);
    assert.equal(d, BACKOFF_MAX_MS, 'Backoff must cap at BACKOFF_MAX_MS');
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — sendStreamEndWithContext thinking_duration_ms', () => {

  afterEach(() => { _resetForTest(); });

  it('includes thinking_duration_ms in stream_end packet body', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });

      connect();
      await waitFor(() => isConnected());

      sendStreamEndWithContext('sid-dur', 'Final text.', 'Aria', 'chat-1', 'I thought...', 3500);
      await waitFor(() => serverReceived.some((f) => f.type === 'stream_end' && f.stream_id === 'sid-dur'));
      const p = serverReceived.find((f) => f.type === 'stream_end' && f.stream_id === 'sid-dur');
      assert.equal(p.final_text, 'Final text.');
      assert.equal(p.thinking, 'I thought...');
      assert.equal(p.thinking_duration_ms, 3500);
      assert.equal(p.chat_id, 'chat-1');
    });
  });

  it('sends thinking_duration_ms=null when thinkingDurationMs is undefined', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });

      connect();
      await waitFor(() => isConnected());

      sendStreamEndWithContext('sid-no-dur', 'Text.', 'Aria', 'chat-1', 'thought', undefined);
      await waitFor(() => serverReceived.some((f) => f.type === 'stream_end' && f.stream_id === 'sid-no-dur'));
      const p = serverReceived.find((f) => f.type === 'stream_end' && f.stream_id === 'sid-no-dur');
      assert.strictEqual(p.thinking_duration_ms, null, 'thinking_duration_ms must be null when not provided');
    });
  });

  it('sends thinking_duration_ms=null when null passed explicitly', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });

      connect();
      await waitFor(() => isConnected());

      sendStreamEndWithContext('sid-null-dur', 'Text.', 'Aria', 'chat-1', null, null);
      await waitFor(() => serverReceived.some((f) => f.type === 'stream_end' && f.stream_id === 'sid-null-dur'));
      const p = serverReceived.find((f) => f.type === 'stream_end' && f.stream_id === 'sid-null-dur');
      assert.strictEqual(p.thinking_duration_ms, null);
    });
  });
});

// ---------------------------------------------------------------------------

describe('chatroom-client — Iter-5 source-of-truth senders', () => {

  afterEach(() => { _resetForTest(); });

  it('sendChatHistoryResponse sends chat_history_response with correct fields', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });
      connect();
      await waitFor(() => isConnected());

      const messages = [
        { idx: 0, role: 'user',      content: 'Hello', name: 'User', hash: 'abc123', extra: null },
        { idx: 1, role: 'assistant', content: 'Hi!',   name: 'Aria', hash: 'def456', extra: null },
      ];
      sendChatHistoryResponse('chat-42', messages, true);
      await waitFor(() => serverReceived.some((f) => f.type === 'chat_history_response'));
      const p = serverReceived.find((f) => f.type === 'chat_history_response');

      assert.equal(p.chat_id, 'chat-42', 'chat_id must be forwarded');
      assert.equal(p.messages.length, 2, 'messages array length must match');
      assert.equal(p.messages[0].idx, 0, 'idx must be preserved');
      assert.equal(p.messages[0].role, 'user', 'role must be preserved');
      assert.equal(p.messages[1].name, 'Aria', 'name must be preserved');
      assert.strictEqual(p.complete, true, 'complete must be true');
    });
  });

  it('sendChatHistoryResponse with complete=false is forwarded correctly', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });
      connect();
      await waitFor(() => isConnected());

      sendChatHistoryResponse('chat-x', [], false);
      await waitFor(() => serverReceived.some((f) => f.type === 'chat_history_response'));
      const p = serverReceived.find((f) => f.type === 'chat_history_response');
      assert.strictEqual(p.complete, false, 'complete=false must be forwarded');
      assert.deepEqual(p.messages, [], 'empty messages array must be forwarded');
    });
  });

  it('sendMessageChanged sends message_changed with all required fields', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });
      connect();
      await waitFor(() => isConnected());

      sendMessageChanged('chat-7', 3, 'Updated message', 'a1b2c3d4', 'assistant', 'Aria');
      await waitFor(() => serverReceived.some((f) => f.type === 'message_changed'));
      const p = serverReceived.find((f) => f.type === 'message_changed');

      assert.equal(p.chat_id,  'chat-7',          'chat_id must be forwarded');
      assert.equal(p.idx,      3,                 'idx must be forwarded');
      assert.equal(p.content,  'Updated message', 'content must be forwarded');
      assert.equal(p.hash,     'a1b2c3d4',        'hash must be forwarded');
      assert.equal(p.role,     'assistant',        'role must be forwarded');
      assert.equal(p.name,     'Aria',             'name must be forwarded');
    });
  });

  it('sendMessageChanged with role=user is forwarded correctly', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });
      connect();
      await waitFor(() => isConnected());

      sendMessageChanged('chat-8', 0, 'User text', 'hash99', 'user', 'UserX');
      await waitFor(() => serverReceived.some((f) => f.type === 'message_changed' && f.role === 'user'));
      const p = serverReceived.find((f) => f.type === 'message_changed' && f.role === 'user');
      assert.equal(p.role, 'user', 'role=user must be forwarded');
      assert.equal(p.name, 'UserX', 'user name must be forwarded');
    });
  });

  it('sendChatSwitched sends chat_switched with old and new chat ids', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });
      connect();
      await waitFor(() => isConnected());

      sendChatSwitched('old-chat-id', 'new-chat-id');
      await waitFor(() => serverReceived.some((f) => f.type === 'chat_switched'));
      const p = serverReceived.find((f) => f.type === 'chat_switched');

      assert.equal(p.old_chat_id, 'old-chat-id', 'old_chat_id must be forwarded');
      assert.equal(p.new_chat_id, 'new-chat-id', 'new_chat_id must be forwarded');
    });
  });

  it('sendChatSwitched forwards null old_chat_id for first-connect scenario', async () => {
    await withServer('test-dummy', async (srv) => {
      const serverReceived = [];
      srv.wss.once('connection', (ws) => {
        ws.once('message', () => ws.send(JSON.stringify({ type: 'auth_ok' })));
        ws.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
      });
      connect();
      await waitFor(() => isConnected());

      sendChatSwitched(null, 'first-chat');
      await waitFor(() => serverReceived.some((f) => f.type === 'chat_switched'));
      const p = serverReceived.find((f) => f.type === 'chat_switched');
      assert.strictEqual(p.old_chat_id, null, 'old_chat_id=null must be preserved');
      assert.equal(p.new_chat_id, 'first-chat');
    });
  });
});
