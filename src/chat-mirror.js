/**
 * CharacterBridge Extension - Chat Mirror (Hash Polling)
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
 * Chat Mirror: polls the last 3 ST messages every 3 s and forwards any
 * content changes to the Chatroom backend via sendMessageChanged().
 *
 * Rationale:
 *   Other ST extensions (e.g. memory, worldbook injectors, image generators)
 *   may edit messages after they were generated.  Polling lets us detect
 *   these edits without patching every extension that touches chat[].
 *
 * Hash implementation:
 *   We use SubtleCrypto (SHA-1) when available (browser/secure context) and
 *   fall back to a simple 32-bit djb2 polynomial hash for Node test environments
 *   where SubtleCrypto is not available.  Both produce a deterministic hex
 *   string for the same input; only the length differs (40 vs 8 characters).
 *
 * ST Events handled for immediate recheck (no wait for next 3 s tick):
 *   MESSAGE_RECEIVED, MESSAGE_EDITED, MESSAGE_DELETED
 */

import { eventSource, event_types } from '../../../../../script.js';
import { sharedState } from './state.js';
import { sendMessageChanged } from './chatroom-client.js';
import { computeHash } from './hash-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000;
const TAIL_LENGTH = 3;

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof setInterval>|null} */
let _pollTimer = null;

/**
 * Last-known hashes per message index.
 * Key: message index (number), Value: hash string.
 *
 * @type {Map<number, string>}
 */
const _lastHashes = new Map();

// ---------------------------------------------------------------------------
// Core recheck logic
// ---------------------------------------------------------------------------

/**
 * Reads the last TAIL_LENGTH messages from ctx.chat, computes their hashes,
 * and fires sendMessageChanged for every entry that differs from the last
 * known hash (or is new).
 *
 * Safe to call at any time; silently skipped when no chat is loaded.
 */
async function _recheckTail() {
  let ctx;
  try {
    ctx = SillyTavern.getContext();
  } catch (_) {
    return;
  }

  const chat = ctx.chat;
  if (!Array.isArray(chat) || chat.length === 0) return;

  const chatId = sharedState.lastActiveChatId;
  const startIdx = Math.max(0, chat.length - TAIL_LENGTH);

  for (let i = startIdx; i < chat.length; i++) {
    const msg = chat[i];
    if (!msg) continue;

    const content = msg.mes ?? '';
    const hash = await computeHash(content);
    const prevHash = _lastHashes.get(i);

    if (hash !== prevHash) {
      _lastHashes.set(i, hash);
      try {
        sendMessageChanged(
          chatId,
          i,
          content,
          hash,
          msg.is_user ? 'user' : 'assistant',
          msg.name ?? '',
        );
      } catch (err) {
        console.warn('[CharacterBridge/chat-mirror] sendMessageChanged failed:', err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Immediate-recheck handlers
// ---------------------------------------------------------------------------

function _onMessageEvent() {
  _recheckTail().catch((err) =>
    console.warn('[CharacterBridge/chat-mirror] recheck error:', err),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the 3 s hash-polling interval and registers ST event listeners for
 * immediate rechecks on MESSAGE_RECEIVED, MESSAGE_EDITED, MESSAGE_DELETED.
 *
 * Idempotent: calling again while already running is a no-op.
 */
export function setupHashPolling() {
  if (_pollTimer) return;

  _pollTimer = setInterval(
    () => _recheckTail().catch((err) =>
      console.warn('[CharacterBridge/chat-mirror] poll error:', err),
    ),
    POLL_INTERVAL_MS,
  );

  const evRecv = event_types.MESSAGE_RECEIVED ?? 'message_received';
  const evEdit = event_types.MESSAGE_EDITED   ?? 'message_edited';
  const evDel  = event_types.MESSAGE_DELETED  ?? 'message_deleted';

  eventSource.on(evRecv, _onMessageEvent);
  eventSource.on(evEdit, _onMessageEvent);
  eventSource.on(evDel,  _onMessageEvent);
}

/**
 * Stops hash polling and removes ST event listeners.
 * Safe to call when not running (idempotent).
 */
export function stopHashPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }

  try {
    const evRecv = event_types.MESSAGE_RECEIVED ?? 'message_received';
    const evEdit = event_types.MESSAGE_EDITED   ?? 'message_edited';
    const evDel  = event_types.MESSAGE_DELETED  ?? 'message_deleted';

    eventSource.removeListener(evRecv, _onMessageEvent);
    eventSource.removeListener(evEdit, _onMessageEvent);
    eventSource.removeListener(evDel,  _onMessageEvent);
  } catch (_) {}
}

/**
 * Resets the internal hash cache.
 * Call when a chat switch occurs so stale hashes from the previous chat
 * do not suppress change notifications in the new chat.
 */
export function resetHashCache() {
  _lastHashes.clear();
}

// ---------------------------------------------------------------------------
// Test/internal accessors
// ---------------------------------------------------------------------------

/** @returns {boolean} */
export function _isPolling() { return _pollTimer !== null; }

/** @returns {Map<number, string>} */
export function _getLastHashes() { return _lastHashes; }

/** Exposed for tests that need to invoke the recheck logic directly. */
export { _recheckTail };
