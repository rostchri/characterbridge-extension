/**
 * CharacterBridge Extension - Chatroom WebSocket Client
 * Based on SillyTavern-Discord-Connector by senjinthedragon (AGPL-3.0)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Direct WebSocket client to the Chatroom backend (Variante 3).
 *
 * Authentication strategy:
 *   The Browser WebSocket API does not support custom HTTP headers during the
 *   handshake (no Authorization header possible). Two alternatives exist:
 *
 *   Option A: Query-param  ?token=<secret>  — visible in server logs and
 *             browser network inspector.
 *   Option B: First-frame auth packet — secret travels inside the encrypted
 *             WebSocket payload, never in the URL or HTTP headers.
 *
 *   This implementation uses Option B (first-frame auth packet):
 *     {"type":"auth","secret":"<shared_secret>"}
 *   The server must respond with {"type":"auth_ok"} or {"type":"auth_failed"}.
 *   All subsequent frames are considered authenticated.
 *
 * TODO(elixir-counterpart): The Elixir LiveView / Phoenix Channel endpoint at
 *   `wss://<host>/api/sillytavern/connect` MUST implement the same handshake:
 *   1. Accept WS upgrade unconditionally (no secret in URL).
 *   2. Wait for the first frame.
 *   3. Parse {"type":"auth","secret":"..."}, compare with configured secret.
 *   4. Reply {"type":"auth_ok"} on success, {"type":"auth_failed","reason":"..."}
 *      on failure, then close the socket.
 *   5. All frames before auth_ok MUST be silently discarded.
 *   See: https://github.com/rostchri/chatroom — Phase Elixir, Sprint auth-ws
 *
 * Reconnect strategy: exponential backoff 5 s → 10 s → 20 s → 40 s → 60 s cap.
 * Heartbeat: ping every 30 s; if no pong arrives within 90 s → force reconnect.
 */

import { getSettings, updateStatus } from './settings.js';
import { chatroomConnectionState } from './state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/** @type {WebSocket|null} */
let _ws = null;

let _authenticated = false;
let _shouldReconnect = false;
let _reconnectTimer = null;
let _reconnectDelay = BACKOFF_INITIAL_MS;
let _heartbeatTimer = null;
let _pongDeadlineTimer = null;
let _lastPongAt = 0;

/** @type {Array<function(object):void>} */
const _messageHandlers = [];

// ---------------------------------------------------------------------------
// Message handler registry
// ---------------------------------------------------------------------------

/**
 * Registers a handler function that will be called for every authenticated
 * inbound packet. Multiple handlers can be registered; all receive the packet.
 *
 * @param {function(object):void} fn
 */
export function onMessage(fn) {
  _messageHandlers.push(fn);
}

function _dispatch(packet) {
  for (const fn of _messageHandlers) {
    try {
      fn(packet);
    } catch (err) {
      console.warn('[CharacterBridge/chatroom] message handler threw:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _resetPongDeadline() {
  if (_pongDeadlineTimer) clearTimeout(_pongDeadlineTimer);
  _lastPongAt = Date.now();
  _pongDeadlineTimer = setTimeout(() => {
    const age = Date.now() - _lastPongAt;
    if (age >= HEARTBEAT_TIMEOUT_MS) {
      console.warn('[CharacterBridge/chatroom] Pong timeout — reconnecting');
      _forceReconnect();
    }
  }, HEARTBEAT_TIMEOUT_MS);
}

function _stopTimers() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  if (_pongDeadlineTimer) { clearTimeout(_pongDeadlineTimer); _pongDeadlineTimer = null; }
}

function _forceReconnect() {
  if (_ws) {
    _ws.onclose = null; // prevent double-reconnect
    _ws.onerror = null;
    try { _ws.close(); } catch (_) {}
    _ws = null;
  }
  _stopTimers();
  _authenticated = false;
  _updateState(false, null);
  _scheduleReconnect();
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  if (!_shouldReconnect) return;
  _updateState(false, null);
  updateStatus('Reconnecting…', 'orange');
  // Double the delay BEFORE waiting so that rapid consecutive failures
  // produce a monotonically increasing backoff sequence.
  _reconnectDelay = Math.min(_reconnectDelay * 2, BACKOFF_MAX_MS);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, _reconnectDelay);
}

function _updateState(isConnected, lastError) {
  chatroomConnectionState.isConnected = isConnected;
  chatroomConnectionState.lastError = lastError;
}

// ---------------------------------------------------------------------------
// Connect / Disconnect
// ---------------------------------------------------------------------------

/**
 * Opens a WebSocket connection to the Chatroom backend.
 * Safe to call when already connected (no-op in that case).
 */
export function connect() {
  if (
    _ws &&
    (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)
  ) return;

  const settings = getSettings();
  const url = settings.chatroomUrl;
  if (!url) {
    updateStatus('Chatroom URL not set', 'red');
    _updateState(false, 'URL not configured');
    return;
  }

  _shouldReconnect = true;
  _authenticated = false;
  updateStatus('Connecting…', 'orange');

  try {
    _ws = new WebSocket(url);
  } catch (err) {
    console.error('[CharacterBridge/chatroom] WebSocket constructor failed:', err);
    updateStatus('Connect error', 'red');
    _updateState(false, err.message);
    _scheduleReconnect();
    return;
  }

  _ws.onopen = () => {
    console.log('[CharacterBridge/chatroom] Socket open — sending auth frame');
    updateStatus('Authenticating…', 'orange');
    // Reset backoff on successful TCP connect
    _reconnectDelay = BACKOFF_INITIAL_MS;
    _resetPongDeadline();

    const secret = settings.chatroomSharedSecret;
    const roomId = settings.chatroomRoomId;
    if (secret && roomId) {
      _rawSend({ type: 'auth', secret, room_id: roomId });
    } else {
      console.error('[CharacterBridge/chatroom] Both chatroomSharedSecret and chatroomRoomId must be set.');
      updateStatus('Config incomplete', 'red');
      _ws.close(4000, 'Missing room_id or secret');
    }
  };

  _ws.onmessage = (event) => {
    let packet;
    try {
      packet = JSON.parse(event.data);
    } catch (err) {
      console.warn('[CharacterBridge/chatroom] Invalid JSON frame ignored:', err);
      return;
    }

    // Pong resets the heartbeat deadline regardless of auth state
    if (packet.type === 'pong' || packet.type === 'ping') {
      _resetPongDeadline();
      // Respond to server-initiated pings
      if (packet.type === 'ping') _rawSend({ type: 'pong' });
      return;
    }

    if (!_authenticated) {
      if (packet.type === 'auth_ok') {
        _authenticated = true;
        _onAuthenticated();
        return;
      }
      if (packet.type === 'auth_failed') {
        console.error('[CharacterBridge/chatroom] Auth failed:', packet.reason ?? 'unknown');
        updateStatus('Auth failed', 'red');
        _updateState(false, `Auth failed: ${packet.reason ?? 'unknown'}`);
        _shouldReconnect = false; // wrong secret — don't spam
        if (_ws) _ws.close();
        return;
      }
      console.warn('[CharacterBridge/chatroom] Pre-auth frame ignored:', packet.type);
      return;
    }

    _dispatch(packet);
  };

  // Capture the socket this handler belongs to. If the global _ws gets
  // replaced by a newer connect() before this onclose fires, we must NOT
  // clobber the new socket or trigger a reconnect cascade.
  const _thisWs = _ws;
  _ws.onclose = (event) => {
    console.log('[CharacterBridge/chatroom] Socket closed', event.code, event.reason);
    if (_ws !== _thisWs) {
      // A newer connect() has replaced us — leave the current state alone.
      return;
    }
    _ws = null;
    _authenticated = false;
    _stopTimers();
    _updateState(false, null);
    updateStatus('Disconnected', 'red');
    _scheduleReconnect();
  };

  _ws.onerror = (err) => {
    console.error('[CharacterBridge/chatroom] WebSocket error:', err);
    updateStatus('Error', 'red');
    _updateState(false, 'WebSocket error');
  };
}

/**
 * Cleanly disconnects and suppresses automatic reconnection.
 */
export function disconnect() {
  _shouldReconnect = false;
  _stopTimers();
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) {
    _ws.close();
    _ws = null;
  }
  _authenticated = false;
  _updateState(false, null);
  updateStatus('Disconnected', 'red');
}

// ---------------------------------------------------------------------------
// Post-authentication setup
// ---------------------------------------------------------------------------

function _onAuthenticated() {
  console.log('[CharacterBridge/chatroom] Authenticated — ready');
  _updateState(true, null);
  updateStatus('Connected', 'green');
  _resetPongDeadline();

  // Periodic ping
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(() => {
    send({ type: 'ping' });
  }, HEARTBEAT_INTERVAL_MS);

  // Notify application layer (index.js) that the connection is ready.
  // Using a synthetic packet avoids exposing internal lifecycle hooks.
  _dispatch({ type: '_connected' });
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

/**
 * Sends a JSON frame unconditionally (bypasses auth check).
 * Only for auth and pong frames.
 *
 * @param {object} payload
 */
function _rawSend(payload) {
  if (_ws?.readyState !== WebSocket.OPEN) return;
  try {
    _ws.send(JSON.stringify(payload));
  } catch (err) {
    console.warn('[CharacterBridge/chatroom] _rawSend failed:', err);
  }
}

/**
 * Sends a JSON packet to the Chatroom backend.
 * Silently dropped if not connected and authenticated.
 *
 * @param {object} payload
 */
export function send(payload) {
  if (!_authenticated || _ws?.readyState !== WebSocket.OPEN) return;
  try {
    _ws.send(JSON.stringify(payload));
  } catch (err) {
    console.warn('[CharacterBridge/chatroom] send failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Typed packet senders (Spec: Issue #866 Spec-Update 7)
// ---------------------------------------------------------------------------

/**
 * Sends a non-streaming AI reply to Chatroom.
 *
 * @param {string} text
 * @param {string|null} charName
 * @param {string|null} [chatId]
 */
export function sendUserMessageReply(text, charName, chatId) {
  send({ type: 'ai_reply', text, char_name: charName ?? null, chat_id: chatId ?? null });
}

/**
 * Sends one streaming token chunk.
 *
 * @param {string} streamId
 * @param {string} delta  Cumulative text so far
 * @param {string|null} charName
 */
export function sendStreamChunk(streamId, delta, charName) {
  send({ type: 'stream_chunk', stream_id: streamId, delta, char_name: charName ?? null });
}

/**
 * Signals the end of a streaming turn.
 * finalText MUST be preserved as null when the AI produced no text — do NOT
 * silently coerce to "".
 *
 * @param {string} streamId
 * @param {string|null} finalText
 * @param {string|null} charName
 */
export function sendStreamEnd(streamId, finalText, charName) {
  // Intentionally NOT coercing null to "". The spec requires null to be
  // forwarded so the Chatroom backend can distinguish "no text" from "empty".
  send({ type: 'stream_end', stream_id: streamId, final_text: finalText, char_name: charName ?? null });
}

/**
 * Sends an expression/emotion update with optional image URL.
 *
 * @param {string|null} charName
 * @param {string} emotion
 * @param {string|null} imageUrl  Absolute URL of the expression image, or null.
 */
export function sendExpression(charName, emotion, imageUrl) {
  send({ type: 'expression_update', char_name: charName ?? null, emotion, image_url: imageUrl ?? null });
}

/**
 * Sends an expression/emotion update including chat context.
 * Uses strictly snake_case field names per protocol spec.
 *
 * @param {string|null} charName
 * @param {string} emotion
 * @param {string|null} imageUrl  Absolute URL of the expression image, or null.
 * @param {string|null} [chatId]
 */
export function sendExpressionWithContext(charName, emotion, imageUrl, chatId) {
  send({
    type: 'expression_update',
    char_name: charName ?? null,
    emotion,
    image_url: imageUrl ?? null,
    chat_id: chatId ?? null,
  });
}

/**
 * Sends a character avatar update.
 *
 * @param {string|null} charName
 * @param {string|null} imageUrl  Absolute URL of the avatar image, or null.
 */
export function sendAvatar(charName, imageUrl) {
  send({ type: 'avatar_update', char_name: charName ?? null, image_url: imageUrl ?? null });
}

/**
 * Resolves the active AI character from the bots array and metadata.
 * Returns the bot whose name matches metadata.activeCharacter, or bots[0]
 * as fallback, or null if no bots exist.
 *
 * @param {Array<{name: string, avatar_url: string|null, description: string}>} bots
 * @param {{activeCharacter?: string|null}} metadata
 * @returns {{name: string, avatar_url: string|null, description: string}|null}
 */
function resolveActiveCharacter(bots, metadata) {
  const list = bots ?? [];
  if (list.length === 0) return null;
  if (metadata?.activeCharacter) {
    const found = list.find((b) => b.name === metadata.activeCharacter);
    if (found) return found;
  }
  return list[0];
}

/**
 * Sends the full character inventory on connect or when explicitly requested.
 * Spec field names: ai_character (singular Object) / personas / metadata.
 *
 * ai_character is the *active* AI character as a single Object, not an array.
 * Falls back to bots[0] when no active character is set.
 *
 * @param {{bots: Array, personas: Array, metadata: object}} inventory
 */
export function sendInventory(inventory) {
  const { bots, personas, metadata } = inventory;
  send({
    type: 'character_inventory',
    ai_character: resolveActiveCharacter(bots, metadata),
    personas: personas ?? [],
    metadata: metadata ?? {},
  });
}

/**
 * Sends an incremental inventory update when the roster changes.
 *
 * ai_character is the *active* AI character as a single Object, not an array.
 * Falls back to bots[0] when no active character is set.
 *
 * @param {{bots: Array, personas: Array, metadata: object}} inventory
 */
export function sendInventoryUpdate(inventory) {
  const { bots, personas, metadata } = inventory;
  send({
    type: 'inventory_update',
    ai_character: resolveActiveCharacter(bots, metadata),
    personas: personas ?? [],
    metadata: metadata ?? {},
  });
}

/**
 * Sends a typing indicator.
 *
 * @param {string|null} charName
 * @param {boolean} active
 * @param {string|null} [chatId]
 */
export function sendTypingAction(charName, active, chatId) {
  send({ type: 'typing_action', char_name: charName ?? null, active: Boolean(active), chat_id: chatId ?? null });
}

/**
 * Sends one streaming thinking delta to Chatroom.
 * Used for live thinking-block streaming so the Chatroom user sees reasoning
 * as it arrives rather than waiting for stream_end.
 *
 * @param {string} streamId
 * @param {string} delta  New thinking characters since the last call.
 * @param {string|null} charName
 * @param {string|null} chatId
 */
export function sendStreamThinkingWithContext(streamId, delta, charName, chatId) {
  send({
    type: 'stream_thinking',
    stream_id: streamId,
    delta,
    char_name: charName ?? null,
    chat_id: chatId ?? null,
    source: 'ai',
  });
}

/**
 * Sends one streaming token chunk including chat context.
 *
 * @param {string} streamId
 * @param {string} delta
 * @param {string|null} charName
 * @param {string|null} chatId
 */
export function sendStreamChunkWithContext(streamId, delta, charName, chatId) {
  send({
    type: 'stream_chunk',
    stream_id: streamId,
    delta,
    char_name: charName ?? null,
    chat_id: chatId ?? null,
  });
}

/**
 * Signals the end of a streaming turn, including optional thinking content
 * and any VisualBeat prompts extracted from the AI reply.
 * finalText MUST be preserved as null when the AI produced no text.
 *
 * @param {string} streamId
 * @param {string|null} finalText
 * @param {string|null} charName
 * @param {string|null} chatId
 * @param {string|null} [thinking]
 * @param {number|null} [thinkingDurationMs]  Duration of the reasoning phase in milliseconds, or null.
 * @param {string[]}    [visualBeats]         Extracted <pic prompt="..."> strings, or empty array.
 */
export function sendStreamEndWithContext(streamId, finalText, charName, chatId, thinking, thinkingDurationMs, visualBeats) {
  send({
    type: 'stream_end',
    stream_id: streamId,
    final_text: finalText,
    char_name: charName ?? null,
    chat_id: chatId ?? null,
    thinking: thinking ?? null,
    thinking_duration_ms: thinkingDurationMs ?? null,
    visual_beats: visualBeats ?? [],
  });
}

/**
 * Sends a multi-message AI reply (e.g. after a group turn).
 * Each message object may contain a `thinking_duration_ms` field (number|null)
 * and a `visual_beats` field (string[]).
 *
 * @param {Array<{name: string, text: string, thinking: string|null, thinking_duration_ms: number|null, charName: string|null, visual_beats?: string[]}>} messages
 * @param {string|null} charName  Active character at the time of reply.
 * @param {string|null} chatId
 */
export function sendAiReply(messages, charName, chatId) {
  send({
    type: 'ai_reply',
    messages,
    char_name: charName ?? null,
    chat_id: chatId ?? null,
  });
}

/**
 * Sends an error message back to the Chatroom backend.
 *
 * @param {string} text
 * @param {string|null} chatId
 */
export function sendErrorMessage(text, chatId) {
  send({ type: 'error_message', text, chat_id: chatId ?? null });
}

/**
 * Sends a chat_history_response packet to the Chatroom backend.
 * Used by the plugin to fulfill a chat_history_request from Chatroom.
 *
 * @param {string} chatId
 * @param {Array<{idx: number, role: 'user'|'assistant', content: string, name: string, hash: string, extra: object}>} messages
 * @param {boolean} complete  true when the full (or filtered) list has been sent
 */
export function sendChatHistoryResponse(chatId, messages, complete) {
  send({
    type: 'chat_history_response',
    chat_id: chatId,
    messages,
    complete,
  });
}

/**
 * Notifies Chatroom that a message was changed (edit, regen, or external update).
 *
 * @param {string} chatId
 * @param {number} idx       Index into the ST chat array
 * @param {string} content   New message content (mes field)
 * @param {string} hash      SHA-1 hex of content
 * @param {string} role      'user' | 'assistant'
 * @param {string} name      Speaker name
 * @param {object|null} extra ST extra field (api, model, send_date, media, ...)
 * @param {string|null} [sendDate] ST msg.send_date (top-level field)
 */
export function sendMessageChanged(chatId, idx, content, hash, role, name, extra, sendDate) {
  send({
    type: 'message_changed',
    chat_id: chatId,
    idx,
    content,
    hash,
    role,
    name,
    extra: extra ?? null,
    send_date: sendDate ?? null,
  });
}

/**
 * Notifies Chatroom that the user switched to a different chat.
 *
 * @param {string|null} oldChatId
 * @param {string|null} newChatId
 */
export function sendChatSwitched(oldChatId, newChatId) {
  send({
    type: 'chat_switched',
    old_chat_id: oldChatId,
    new_chat_id: newChatId,
  });
}

/**
 * Sends a chat_state packet reflecting the currently active character and chat.
 *
 * @param {{
 *   character_id:     number|null,
 *   character_name:   string|null,
 *   character_avatar: string|null,
 *   chat_file:        string|null,
 *   group_id:         string|null,
 * }} payload
 */
export function sendChatStatePacket(payload) {
  send({
    type: 'chat_state',
    character_id: payload.character_id ?? null,
    character_name: payload.character_name ?? null,
    character_avatar: payload.character_avatar ?? null,
    chat_file: payload.chat_file ?? null,
    group_id: payload.group_id ?? null,
    active_persona_name: payload.active_persona_name ?? null,
  });
}

// ---------------------------------------------------------------------------
// Connection state accessor
// ---------------------------------------------------------------------------

/**
 * Returns true when the socket is open and authenticated.
 *
 * @returns {boolean}
 */
export function isConnected() {
  return _authenticated && _ws?.readyState === WebSocket.OPEN;
}

// ---------------------------------------------------------------------------
// Test/internal accessors (not part of public API, used by tests only)
// ---------------------------------------------------------------------------

export function _getSocket() { return _ws; }
export function _isAuthenticated() { return _authenticated; }
export function _getReconnectDelay() { return _reconnectDelay; }

/**
 * Resets all module-private state to its initial values.
 * ONLY call from tests — never from production code.
 */
export function _resetForTest() {
  if (_ws) { try { _ws.close(); } catch (_) {} _ws = null; }
  _stopTimers();
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _authenticated = false;
  _shouldReconnect = false;
  _reconnectDelay = BACKOFF_INITIAL_MS;
  _lastPongAt = 0;
  chatroomConnectionState.isConnected = false;
  chatroomConnectionState.lastError = null;
  // Clear message handlers registered in tests to avoid cross-test pollution
  _messageHandlers.length = 0;
}
