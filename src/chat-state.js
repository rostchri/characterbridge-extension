/**
 * CharacterBridge Extension - Chat State Relay
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
 * Chat State Relay: sends a `chat_state` packet to Chatroom whenever the
 * active character or chat changes inside SillyTavern.
 *
 * Packet shape:
 *   {
 *     type:             "chat_state",
 *     character_id:     number | null,   // ST this_chid index
 *     character_name:   string | null,
 *     character_avatar: string | null,   // stable avatar file id
 *     chat_file:        string | null,   // chat file name without .jsonl
 *     group_id:         string | null,   // selected_group id
 *   }
 *
 * Triggers:
 *   - event_types.CHAT_CHANGED  — fires when the chat file changes
 *   - event_types.CHARACTER_SELECTED — fires when a character is selected
 *   - event_types.GROUP_CHAT_CREATED — fires when a group chat starts
 *   - Heartbeat fallback: setInterval every 30 s in case an event is missing
 *
 * All three ST event names are guarded with a string fallback so the module
 * continues to work on ST builds that do not export that particular constant.
 */

import { eventSource, event_types } from '../../../../../script.js';
import { sendChatStatePacket, sendChatSwitched } from './chatroom-client.js';
import { resetHashCache } from './chat-mirror.js';

// ---------------------------------------------------------------------------
// ST event name constants (with fallbacks for older builds)
// ---------------------------------------------------------------------------

const EV_CHAT_CHANGED =
  event_types.CHAT_CHANGED ?? 'chat_changed';

const EV_CHARACTER_SELECTED =
  event_types.CHARACTER_SELECTED ?? 'character_selected';

const EV_GROUP_CHAT_CREATED =
  event_types.GROUP_CHAT_CREATED ?? 'group_chat_created';

const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof setInterval>|null} */
let _heartbeatTimer = null;

/**
 * The chat_id that was active before the most recent CHAT_CHANGED event.
 * Used to populate old_chat_id in sendChatSwitched().
 *
 * @type {string|null}
 */
let _prevChatId = null;

// ---------------------------------------------------------------------------
// sendChatState
// ---------------------------------------------------------------------------

/**
 * Reads the current chat/character context from ST and sends a `chat_state`
 * packet to the Chatroom backend.
 *
 * Also updates `_prevChatId` so that a subsequent `onChatChanged` call can
 * report the correct old chat_id even on ST builds that do not pass the
 * newChatId parameter to the CHAT_CHANGED event handler.
 *
 * Safe to call at any time; silently dropped by chatroom-client.send() when
 * the socket is not authenticated.
 */
export function sendChatState() {
  try {
    const ctx = SillyTavern.getContext();
    const id = ctx.characterId;
    const char = id !== undefined ? ctx.characters?.[id] : undefined;

    // Aktive Persona aus ST: powerUserSettings.user_avatar ist die ID/Filename,
    // powerUserSettings.personas[id] ist der Display-Name. Fallback: name1 (ST's
    // current user-name). Damit kann das Chatroom-Backend MemberState fuer
    // joinende User vorbelegen — kein manueller Persona-Pick noetig.
    const powerUser = ctx.powerUserSettings || {};
    const userAvatarId = powerUser.user_avatar;
    const personaName =
      (userAvatarId && powerUser.personas?.[userAvatarId]) ??
      ctx.name1 ??
      null;

    const payload = {
      character_id: id !== undefined ? id : null,
      character_name: char?.name ?? null,
      character_avatar: char?.avatar ?? null,
      chat_file: char?.chat ?? null,
      group_id: ctx.groupId ?? null,
      active_persona_name: personaName,
    };

    sendChatStatePacket(payload);

    // Track the current chat so that onChatChanged() has the correct
    // old_chat_id available regardless of whether ST passes newChatId.
    _prevChatId = payload.chat_file;
  } catch (err) {
    console.warn('[CharacterBridge/chat-state] sendChatState failed:', err);
  }
}

/**
 * Handles a CHAT_CHANGED event: sends a chat_switched notification and then
 * the standard chat_state update.  Also resets the hash cache so stale hashes
 * from the previous chat do not suppress change notifications in the new chat.
 *
 * @param {string|null} [newChatId]  Passed by some ST builds; derived from
 *   context when absent.
 */
export function onChatChanged(newChatId) {
  try {
    const ctx = SillyTavern.getContext();
    const char = ctx.characterId !== undefined ? ctx.characters?.[ctx.characterId] : undefined;
    const resolvedNewId = newChatId ?? char?.chat ?? null;

    sendChatSwitched(_prevChatId, resolvedNewId);
    _prevChatId = resolvedNewId;

    // Clear stale hashes from the previous chat
    resetHashCache();
  } catch (err) {
    console.warn('[CharacterBridge/chat-state] onChatChanged (switch) failed:', err);
  }

  // Always follow up with a full chat_state packet
  sendChatState();
}

// ---------------------------------------------------------------------------
// setupChatStateRelay / stopChatStateRelay
// ---------------------------------------------------------------------------

/**
 * Registers ST event listeners that trigger chat_state packets, and starts a
 * 30 s fallback heartbeat.
 *
 * Note: call stopChatStateRelay() before calling this again to avoid
 * registering duplicate event listeners.
 */
export function setupChatStateRelay() {
  // CHAT_CHANGED uses onChatChanged so we can emit chat_switched + reset hashes
  eventSource.on(EV_CHAT_CHANGED, onChatChanged);
  eventSource.on(EV_CHARACTER_SELECTED, sendChatState);
  eventSource.on(EV_GROUP_CHAT_CREATED, sendChatState);

  if (!_heartbeatTimer) {
    _heartbeatTimer = setInterval(sendChatState, HEARTBEAT_INTERVAL_MS);
  }
}

/**
 * Removes all chat-state event listeners and clears the heartbeat timer.
 *
 * Unregisters:
 *   - CHAT_CHANGED    → onChatChanged
 *   - CHARACTER_SELECTED → sendChatState
 *   - GROUP_CHAT_CREATED → sendChatState
 *   - 30 s setInterval heartbeat
 *
 * Must be called in the disconnect path (index.js Disconnect-Button) and
 * before calling setupChatStateRelay() again on reconnect to prevent
 * duplicate listener registrations.
 *
 * Safe to call when no relay is active (idempotent).
 */
export function stopChatStateRelay() {
  try {
    eventSource.removeListener(EV_CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(EV_CHARACTER_SELECTED, sendChatState);
    eventSource.removeListener(EV_GROUP_CHAT_CREATED, sendChatState);
  } catch (_) {}

  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}
