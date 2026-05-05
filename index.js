/**
 * CharacterBridge Extension for SillyTavern
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
 *
 * Runs inside SillyTavern as a third-party extension. Connects directly to the
 * Chatroom backend (Variante 3 — no separate middleware) over WebSocket.
 *
 * Streaming:
 *   Each character turn gets a unique streamId at GENERATION_STARTED.
 *   STREAM_TOKEN_RECEIVED forwards cumulative text to Chatroom.
 *   GENERATION_ENDED sends stream_end with charName and finalText.
 *   Group chats include the character name; solo chats do not.
 *
 * Image relay:
 *   Local ST images (thumbnails, generated art, avatars) are fetched here in
 *   the browser — where same-origin access is always available — and sent as
 *   base64 inline data.
 *
 * Character inventory:
 *   On connect, the full character inventory (bots + personas) is sent to
 *   Chatroom. A polling watcher detects roster changes and sends incremental
 *   inventory_update packets.
 *
 * Expression relay:
 *   Watches #expression-image in the ST DOM and forwards expression updates
 *   to Chatroom, including the expression name and optionally the expression
 *   image as base64.
 *
 * Authentication:
 *   See src/chatroom-client.js — first-frame auth packet strategy.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  connect,
  disconnect,
  onMessage,
  sendInventory,
  sendInventoryUpdate,
  isConnected,
} from './src/chatroom-client.js';
import { setupHashPolling, stopHashPolling } from './src/chat-mirror.js';
import { MODULE_NAME, getSettings, updateStatus } from './src/settings.js';
import { sharedState } from './src/state.js';
import {
  resetExpressionSignature,
  setupExpressionObserver,
  stopExpressionObserver,
  scheduleExpressionUpdate,
} from './src/expression-relay.js';
import {
  handleUserMessage,
  handleExecuteCommand,
} from './src/commands.js';
import {
  collectInventory,
  startInventoryWatcher,
  stopInventoryWatcher,
} from './src/inventory.js';
import { saveResumeState, tryResume } from './src/auto-resume.js';
import { setupChatStateRelay, stopChatStateRelay } from './src/chat-state.js';
import { eventSource, event_types } from '../../../../script.js';

// ---------------------------------------------------------------------------
// APP_READY: try to restore character+chat saved before last reload
// ---------------------------------------------------------------------------

// String fallback covers older ST versions that do not export APP_READY.
const APP_READY_EVENT = event_types.APP_READY ?? 'app_ready';
eventSource.on(APP_READY_EVENT, tryResume);

// ---------------------------------------------------------------------------
// Inbound packet router
// ---------------------------------------------------------------------------

const VALID_EXPRESSION_MODES = ['off', 'status', 'full'];

onMessage(async (packet) => {
  try {
    switch (packet.type) {
      case 'user_message':
        await handleUserMessage(packet);
        break;

      case 'command':
        // Chatroom sends {"type":"command","cmd":"...","args":[...]}
        await handleExecuteCommand({ command: packet.cmd, args: packet.args ?? [], chatId: packet.chatId });
        break;

      case 'execute_command':
        // Legacy packet name — kept for compatibility during transition
        await handleExecuteCommand(packet);
        break;

      case 'config_update':
        if (packet.settings) {
          const settings = getSettings();
          if (
            packet.settings.expressionMode &&
            VALID_EXPRESSION_MODES.includes(packet.settings.expressionMode)
          ) {
            settings.expressionMode = packet.settings.expressionMode;
            resetExpressionSignature();
            scheduleExpressionUpdate(sharedState.lastActiveChatId);
          } else if (packet.settings.expressionMode) {
            console.warn('[CharacterBridge] Invalid expressionMode rejected:', packet.settings.expressionMode);
          }
          SillyTavern.getContext().saveSettingsDebounced();
        }
        break;

      case 'system_command':
        if (packet.command === 'reload_ui_only')
          setTimeout(() => window.location.reload(), 500);
        break;

      default:
        // Unknown packet types are silently ignored
        break;
    }
  } catch (err) {
    console.error('[CharacterBridge] Packet handling error:', err);
  }
});

// ---------------------------------------------------------------------------
// Post-authentication setup  (called once per successful connect)
// ---------------------------------------------------------------------------

/**
 * Called by chatroom-client after auth_ok. Sends inventory and starts watcher.
 * We hook into onMessage for "auth_ok" to avoid tight coupling, but chatroom-
 * client already fires the status update and heartbeat. Here we only need the
 * application-level setup that belongs to the extension, not the transport.
 */
onMessage(async (packet) => {
  // "connected" is a synthetic packet emitted by chatroom-client after auth_ok
  // to let the extension layer react without importing internal hooks.
  // See chatroom-client.js — _onAuthenticated() dispatches this packet.
  if (packet.type !== '_connected') return;

  resetExpressionSignature();
  setupExpressionObserver();
  scheduleExpressionUpdate(sharedState.lastActiveChatId);

  try {
    const inventory = collectInventory();
    sendInventory(inventory);
  } catch (err) {
    console.warn('[CharacterBridge] Failed to send initial inventory:', err);
  }

  startInventoryWatcher((inventoryPayload) => sendInventoryUpdate(inventoryPayload));

  // Start relaying chat-state changes to Chatroom (stops + restarts on
  // each reconnect to avoid duplicate listeners across reconnect cycles).
  stopChatStateRelay();
  setupChatStateRelay();

  // Start hash-polling for source-of-truth change detection (stops + restarts
  // on each reconnect to avoid duplicate intervals across reconnect cycles).
  stopHashPolling();
  setupHashPolling();
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

jQuery(async () => {
  try {
    const settingsHtml = await $.get(
      `/scripts/extensions/third-party/${MODULE_NAME}/settings.html`,
    );
    const $settings = $(settingsHtml);
    $('#extensions_settings').append($settings);

    const settings = getSettings();

    // ---- Chatroom section --------------------------------------------------
    $('#chatroom_url').val(settings.chatroomUrl ?? '');
    $('#chatroom_shared_secret').val(settings.chatroomSharedSecret ?? '');
    $('#chatroom_room_id').val(settings.chatroomRoomId ?? '');
    $('#chatroom_auto_connect').prop('checked', settings.chatroomAutoConnect ?? true);

    $('#chatroom_url').on('input', () => {
      getSettings().chatroomUrl = $('#chatroom_url').val();
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $('#chatroom_shared_secret').on('input', () => {
      getSettings().chatroomSharedSecret = $('#chatroom_shared_secret').val();
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $('#chatroom_room_id').on('input', () => {
      getSettings().chatroomRoomId = $('#chatroom_room_id').val();
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $('#chatroom_auto_connect').on('change', () => {
      getSettings().chatroomAutoConnect = $('#chatroom_auto_connect').prop('checked');
      SillyTavern.getContext().saveSettingsDebounced();
    });

    $('#chatroom_connect_button').on('click', () => {
      stopInventoryWatcher();
      connect();
    });

    $('#chatroom_disconnect_button').on('click', () => {
      stopInventoryWatcher();
      stopHashPolling();
      stopChatStateRelay();
      stopExpressionObserver();
      disconnect();
    });

    $('#chatroom_test_button').on('click', async () => {
      const url = $('#chatroom_url').val()?.trim();
      if (!url) {
        updateStatus('Enter a URL first', 'red');
        return;
      }
      updateStatus('Testing…', 'orange');
      try {
        const testWs = new WebSocket(url);
        const timer = setTimeout(() => {
          testWs.close();
          updateStatus('Timeout — server not reachable', 'red');
        }, 5000);
        testWs.onopen = () => {
          clearTimeout(timer);
          testWs.close();
          updateStatus('Reachable (TCP open)', 'green');
        };
        testWs.onerror = () => {
          clearTimeout(timer);
          updateStatus('Connection refused', 'red');
        };
      } catch (err) {
        updateStatus(`Error: ${err.message}`, 'red');
      }
    });

    // Expression mode (verbleibt aus Mood & Expressions Sektion)
    $('#discord_expression_mode').val(settings.expressionMode);
    $('#discord_expression_mode').on('change', () => {
      getSettings().expressionMode = $('#discord_expression_mode').val();
      resetExpressionSignature();
      SillyTavern.getContext().saveSettingsDebounced();
      scheduleExpressionUpdate(sharedState.lastActiveChatId);
    });

    // -----------------------------------------------------------------------
    // Global tooltip for .dc-info elements
    // -----------------------------------------------------------------------
    const $tip = $('<div id="dc-tooltip"></div>').appendTo('body');
    let tipTarget = null;

    function showTip(el) {
      const text = el.getAttribute('data-tooltip');
      if (!text) return;
      tipTarget = el;
      $tip.text(text);

      const r = el.getBoundingClientRect();
      const tipW = 240;
      let left = r.left + r.width / 2 - tipW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));

      $tip.css({ left: left + 'px', top: '', bottom: '' });

      $tip.addClass('dc-tooltip-visible');
      const tipH = $tip.outerHeight();
      $tip.removeClass('dc-tooltip-visible');

      if (r.top - tipH - 10 >= 8) {
        $tip.css({ top: r.top - tipH - 10 + 'px' });
      } else {
        $tip.css({ top: r.bottom + 8 + 'px' });
      }

      $tip.addClass('dc-tooltip-visible');
    }

    function hideTip() {
      tipTarget = null;
      $tip.removeClass('dc-tooltip-visible');
    }

    $(document).on('mouseenter', '.dc-info', function () { showTip(this); });
    $(document).on('mouseleave', '.dc-info', hideTip);
    $(document).on('focus', '.dc-info', function () { showTip(this); });
    $(document).on('blur', '.dc-info', hideTip);
    $(document).on('touchstart', '.dc-info', function (e) {
      e.preventDefault();
      if (tipTarget === this) { hideTip(); } else { showTip(this); }
    });
    $(document).on('touchstart', function (e) {
      if (tipTarget && !$(e.target).closest('.dc-info').length) hideTip();
    });

    if (settings.chatroomAutoConnect && settings.chatroomUrl) connect();
  } catch (error) {
    console.error('[CharacterBridge] Failed to load settings UI:', error);
  }
});
