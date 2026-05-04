/**
 * CharacterBridge Extension - Command Handlers
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
 * WebSocket message handlers:
 *   handleUserMessage   - injects a user message into ST, streams the AI reply back
 *   handleExecuteCommand - runs slash commands (switchchar, newchat, etc.)
 *
 * Streaming:
 *   Each character turn gets a unique streamId at GENERATION_STARTED.
 *   STREAM_TOKEN_RECEIVED forwards cumulative text to the bridge for throttled
 *   display. GENERATION_ENDED sends stream_end with the final text and charName.
 *   Group chats include the character name; solo chats do not.
 */

import {
  eventSource,
  event_types,
  sendMessageAsUser,
  doNewChat,
  selectCharacterById,
  openCharacterChat,
  getPastCharacterChats,
  Generate,
  setExternalAbortController,
  deleteLastMessage,
} from "../../../../../script.js";

import { saveResumeState } from './auto-resume.js';

import { executeSlashCommandsWithOptions } from "../../../../../scripts/slash-commands.js";

import { sharedState } from './state.js';
import {
  sendTypingAction,
  sendStreamChunkWithContext,
  sendStreamThinkingWithContext,
  sendStreamEndWithContext,
  sendAiReply,
  sendUserMessageReply,
  sendErrorMessage,
  sendChatHistoryResponse,
} from './chatroom-client.js';
import { sanitizeSlashArg, sanitizeChatArg, getDisplayText } from './utils.js';
import { computeHash } from './hash-utils.js';
import { sendLastMessageImages, extractImageSrcsFromMesText } from './image-relay.js';
import {
  startDelayedImageObserver,
  stopDelayedImageObserver,
} from './delayed-image-observer.js';
import {
  resetExpressionSignature,
  scheduleExpressionUpdate,
  clearExpressionCache,
} from './expression-relay.js';
import { resolveThinking, stripThinkingPrefix } from './thinking-utils.js';
import { extractAndStripVisualBeats } from './visual-beats.js';

// String fallbacks cover older ST versions that don't export these event types.
const GROUP_WRAPPER_FINISHED =
  event_types.GROUP_WRAPPER_FINISHED ?? 'group_wrapper_finished';

// STREAM_REASONING_DONE fires after the reasoning phase ends, BEFORE the first
// visible token. Signature: (reasoningText, durationMs, messageId, state).
// Edge-case: if a model emits BOTH extra.reasoning (via this event) AND an
// inline <think>...</think> tag, the UI will receive two separate thinking
// payloads. The `thinkingClosed = true` guard below prevents the inline-tag
// path from re-sending the same content in the same stream, but if they differ
// (e.g. summarised vs. raw) the bridge forwards both. Downstream consumers
// should de-duplicate by stream_id if needed.
const STREAM_REASONING_DONE =
  event_types.STREAM_REASONING_DONE ?? 'stream_reasoning_done';

// Cap incoming `data.text` payloads from the server before forwarding them to
// `sendMessageAsUser`. Generous enough that legitimate roleplay messages
// (long-form prose, multi-paragraph) are not truncated, but bounded so a
// compromised server cannot push multi-megabyte payloads into the chat.
const MAX_USER_MESSAGE_LENGTH = 16384;

// ---------------------------------------------------------------------------
// Helper: get active character name
// ---------------------------------------------------------------------------

function getActiveCharName() {
  const ctx = SillyTavern.getContext();
  if (ctx.groupId) {
    return ctx.name2 || null;
  }
  if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
    return ctx.characters[ctx.characterId].name || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// handleUserMessage
// ---------------------------------------------------------------------------

/**
 * Handles user_message: injects the text into ST, hooks generation lifecycle
 * events to stream tokens to the bridge, and sends the final reply.
 *
 * All event listeners are registered here and removed in every exit path
 * (normal completion, user stop, error) to prevent leaks across sessions.
 *
 * CharacterBridge protocol additions:
 * - stream_chunk includes charName
 * - stream_end includes charName and finalText
 * - ai_reply includes charName
 * - Supports persona field for user identity switching
 */
export async function handleUserMessage(data) {
  sharedState.lastActiveChatId = data.chatId || sharedState.lastActiveChatId;

  // Auto-switch persona if provided in the message
  if (data.persona) {
    try {
      await executeSlashCommandsWithOptions(
        `/persona-set ${sanitizeSlashArg(data.persona)}`,
      );
    } catch (err) {
      console.warn(
        `[CharacterBridge] Failed to switch persona to "${data.persona}":`,
        err,
      );
    }
  }

  const messageState = {
    chatId: data.chatId,
    isStreaming: false,
    streamedAny: false,
  };

  sendTypingAction(getActiveCharName(), true, messageState.chatId);

  const userText =
    typeof data.text === 'string'
      ? data.text.slice(0, MAX_USER_MESSAGE_LENGTH)
      : String(data.text ?? '').slice(0, MAX_USER_MESSAGE_LENGTH);
  await sendMessageAsUser(userText);

  let currentStreamId = null;
  let currentCharacterName = null;
  // Tracks the number of visible characters already sent so we can derive
  // true per-chunk deltas without an O(n) startsWith comparison.
  // Reset to 0 on every GENERATION_STARTED.
  let lastSentLength = 0;
  // Thinking-stream tracking: how many chars of the thinking block were already
  // forwarded as stream_thinking deltas, and whether </think> was seen.
  let thinkingSentLength = 0;
  let thinkingClosed = false;
  // Live-Reasoning-Polling: tracks how many chars of chat[i].extra.reasoning
  // have already been forwarded so we only send deltas, not the full text.
  // Reset to '' on every GENERATION_STARTED.
  let lastReasoningSent = '';

  const streamCallback = (cumulativeText) => {
    if (!currentStreamId) return;

    // Live-Reasoning-Polling: ST aktualisiert chat[lastIdx].extra.reasoning pro
    // Streaming-Tick. Solange thinking nicht abgeschlossen ist, lesen wir den
    // aktuellen Wert und senden nur den neu hinzugekommenen Anteil als Delta.
    // Dies ermoeglicht Live-Thinking in der UI schon waehrend des Streamings,
    // statt erst nach STREAM_REASONING_DONE den kompletten Text zu senden.
    if (!thinkingClosed) {
      try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (chat && chat.length > 0) {
          const lastIdx = chat.length - 1;
          const reasoningNow = chat[lastIdx]?.extra?.reasoning ?? '';
          if (reasoningNow.length > lastReasoningSent.length) {
            const newReasoning = reasoningNow.slice(lastReasoningSent.length);
            if (newReasoning) {
              sendStreamThinkingWithContext(
                currentStreamId,
                newReasoning,
                currentCharacterName || getActiveCharName(),
                messageState.chatId,
              );
              lastReasoningSent = reasoningNow;
              console.debug('[CharacterBridge:reasoning_live]', {
                streamId: currentStreamId,
                ts: Date.now(),
                deltaLen: newReasoning.length,
                totalLen: reasoningNow.length,
              });
            }
          } else if (reasoningNow.length < lastReasoningSent.length) {
            // Defensiver Reset: reasoning wurde rueckwaerts gezaehlt (unwahrscheinlich,
            // z.B. wenn ST intern die Nachricht neu aufbaut). Cursor zuruecksetzen
            // damit wir nicht ein veraltetes Offset im Text halten.
            lastReasoningSent = reasoningNow;
          }
        }
      } catch (err) {
        console.warn('[CharacterBridge] live-reasoning poll fehlgeschlagen:', err);
      }
    }

    // Determine whether we are currently inside an open <think> block.
    // Tolerate optional leading whitespace before <think>.
    const openIdx = cumulativeText.search(/^\s*<think>/);
    const inThinkingMode = openIdx !== -1 && !thinkingClosed;

    let newPart = '';

    if (inThinkingMode) {
      // Locate the actual start of content (after "<think>")
      const tagEnd = cumulativeText.indexOf('<think>') + '<think>'.length;
      const closeIdx = cumulativeText.indexOf('</think>');

      if (closeIdx !== -1) {
        // Thinking block is complete — send remaining delta then switch to visible mode.
        const fullThinking = cumulativeText.slice(tagEnd, closeIdx);
        const thinkingDelta = fullThinking.slice(thinkingSentLength);
        if (thinkingDelta) {
          sendStreamThinkingWithContext(
            currentStreamId,
            thinkingDelta,
            currentCharacterName || getActiveCharName(),
            messageState.chatId,
          );
          thinkingSentLength = fullThinking.length;
        }
        thinkingClosed = true;

        // Continue with the visible text after </think>
        const postThink = cumulativeText.slice(closeIdx + '</think>'.length).trimStart();
        const newVisible = postThink.length >= lastSentLength
          ? postThink.slice(lastSentLength)
          : postThink;
        if (newVisible) {
          newPart = newVisible;
          lastSentLength = postThink.length;
        }
      } else {
        // Thinking block still open — forward incremental thinking delta only.
        const partialThinking = cumulativeText.slice(tagEnd);
        const thinkingDelta = partialThinking.slice(thinkingSentLength);
        if (thinkingDelta) {
          sendStreamThinkingWithContext(
            currentStreamId,
            thinkingDelta,
            currentCharacterName || getActiveCharName(),
            messageState.chatId,
          );
          thinkingSentLength = partialThinking.length;
        }
        // No visible chunk this tick while thinking is still open.
        console.debug('[CharacterBridge:stream]', {
          streamId: currentStreamId,
          ts: Date.now(),
          thinkingMode: true,
          cumulativeLen: cumulativeText.length,
          newPartLen: thinkingDelta.length,
          preview: thinkingDelta.slice(0, 60),
        });
        messageState.isStreaming = true;
        return;
      }
    } else {
      // Standard path: no active thinking block.
      const visibleText = stripThinkingPrefix(cumulativeText);
      const delta = visibleText.length >= lastSentLength
        ? visibleText.slice(lastSentLength)
        : visibleText;  // fallback: unexpected regression, emit as-is
      newPart = delta;
      if (newPart) lastSentLength = visibleText.length;
    }

    console.debug('[CharacterBridge:stream]', {
      streamId: currentStreamId,
      ts: Date.now(),
      thinkingMode: !thinkingClosed && cumulativeText.search(/^\s*<think>/) !== -1,
      cumulativeLen: cumulativeText.length,
      newPartLen: newPart.length,
      preview: newPart.slice(0, 60),
    });

    if (!newPart) return;  // skip empty deltas
    messageState.isStreaming = true;
    messageState.streamedAny = true;
    sendStreamChunkWithContext(
      currentStreamId,
      newPart,
      currentCharacterName || getActiveCharName(),
      messageState.chatId,
    );
  };
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

  // Fires when the model's reasoning phase ends (before the first visible
  // token). Marks thinkingClosed so the inline <think>-tag path does not
  // send the same content a second time.
  //
  // Live-Reasoning-Dedup: wenn das Live-Polling in streamCallback den
  // vollstaendigen Text bereits gesendet hat (lastReasoningSent.length ===
  // reasoningText.length), wird hier kein zweites Send ausgefuehrt. Nur der
  // noch fehlende Rest-Anteil (falls vorhanden) wird nachgesendet.
  const reasoningDoneCallback = (reasoningText, durationMs) => {
    if (!currentStreamId || !reasoningText) return;
    console.debug('[CharacterBridge:reasoning_done]', {
      streamId: currentStreamId,
      ts: Date.now(),
      len: reasoningText.length,
      alreadySentLen: lastReasoningSent.length,
      durationMs,
    });
    // Sende nur den noch nicht per Live-Polling gesendeten Rest-Anteil.
    // Wurde der gesamte Text bereits live gesendet, wird kein weiteres Packet
    // gesendet (verhindert Doppel-Thinking in der UI).
    const remainder = reasoningText.length > lastReasoningSent.length
      ? reasoningText.slice(lastReasoningSent.length)
      : '';
    if (remainder) {
      sendStreamThinkingWithContext(
        currentStreamId,
        remainder,
        currentCharacterName || getActiveCharName(),
        messageState.chatId,
      );
      lastReasoningSent = reasoningText;
    }
    // Prevent the inline <think>-tag path from sending the same content again.
    thinkingClosed = true;
  };
  eventSource.on(STREAM_REASONING_DONE, reasoningDoneCallback);

  const flushStreamEnd = () => {
    if (messageState.isStreaming && currentStreamId) {
      const isGroup = !!SillyTavern.getContext().groupId;
      const charName = currentCharacterName || getActiveCharName();

      // Read chat[i].mes rather than relying on streaming pendingText.
      // ST applies sentence-completion trimming to mes after generation ends.
      let finalText = null;
      let thinkingText = null;
      let thinkingDurationMs = null;
      try {
        const { chat } = SillyTavern.getContext();
        if (chat?.length) {
          for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_user) break;
            if (
              !isGroup ||
              !currentCharacterName ||
              msg.name === currentCharacterName
            ) {
              // ST-Translate-Extension: extra.display_text bevorzugen wenn vorhanden,
              // sonst Fallback auf raw msg.mes.
              const displayed = getDisplayText(msg);
              if (displayed.trim()) {
                const split = resolveThinking(displayed.trim(), msg.extra);
                thinkingText = split.thinking;
                thinkingDurationMs = split.durationMs;
                finalText = split.visible;
                break;
              }
            }
          }
        }
      } catch (err) {
        console.warn(
          '[CharacterBridge] Could not read final text from chat array:',
          err,
        );
      }

      // Extract VisualBeat tags from the final visible text before sending.
      // The clean text (without pic-tags) becomes the wire finalText;
      // the extracted prompt strings travel as a separate visual_beats array.
      const { cleanText: cleanFinalText, beats: visualBeats } =
        extractAndStripVisualBeats(finalText ?? '');
      const wireFinalText = finalText !== null ? cleanFinalText : null;

      sendStreamEndWithContext(
        currentStreamId,
        wireFinalText,
        charName,
        messageState.chatId,
        thinkingText,
        thinkingDurationMs,
        visualBeats,
      );
    }
    messageState.isStreaming = false;
    currentStreamId = null;
  };

  // Collects all consecutive AI messages since the last user turn and sends
  // them as a single ai_reply payload. Also forwards any embedded images.
  const collectAndSendReplies = () => {
    if (!messageState.chatId) return;
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length < 2) return;

    const aiMessages = [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const msg = chat[i];
      if (msg.is_user) break;
      // ST-Translate-Extension: extra.display_text bevorzugen wenn vorhanden.
      const displayed = getDisplayText(msg);
      if (displayed.trim()) {
        const split = resolveThinking(displayed.trim(), msg.extra);
        const { cleanText, beats } = extractAndStripVisualBeats(split.visible);
        aiMessages.unshift({
          name: msg.name || '',
          text: cleanText,
          thinking: split.thinking,
          thinking_duration_ms: split.durationMs,
          charName: msg.name || getActiveCharName(),
          visual_beats: beats,
        });
      }
    }

    // Wenn schon gestreamt wurde, hat das Backend stream_end + Mirror schon
    // alles dargestellt. Ein zusaetzliches ai_reply wuerde im Chatroom-UI
    // eine Doppel-Bubble verursachen (eine vom Stream, eine vom ai_reply).
    if (messageState.streamedAny) {
      // Bilder werden weiter unten ueber send_images verschickt.
    } else if (aiMessages.length > 0) {
      sendAiReply(aiMessages, getActiveCharName(), messageState.chatId);
    } else {
      sendErrorMessage('No response generated.', messageState.chatId);
    }

    // Forward images from the last AI message (post-generation art, etc.).
    // After the initial send, start a MutationObserver on the .mes_block so
    // images inserted later — either inline into .mes_text OR into a sibling
    // .mes_media_wrapper (ST "Use Image Viewer in Replace Mode") — are caught.
    const lastMesContext = (() => {
      try {
        const messages = document.querySelectorAll('#chat .mes');
        if (!messages.length) return null;
        const last = messages[messages.length - 1];
        if (last.getAttribute('is_user') === 'true') return null;
        const mesText = last.querySelector('.mes_text') || null;
        // Observe the parent .mes_block (or .mes if no block wrapper) so
        // mutations in the sibling .mes_media_wrapper are also detected.
        const observerRoot = mesText?.parentElement ?? mesText;
        return { mesText, observerRoot };
      } catch {
        return null;
      }
    })();
    const lastMesEl = lastMesContext?.mesText ?? null;
    const observerRoot = lastMesContext?.observerRoot ?? null;

    // Collect srcs already in DOM right now so the observer only sends new ones.
    const alreadySentSrcs = new Set(extractImageSrcsFromMesText(lastMesEl));

    sendLastMessageImages(messageState.chatId).catch((err) =>
      console.warn('[CharacterBridge] sendLastMessageImages failed:', err),
    );

    // Resolve character name once for the observer packet.
    const obsCharName = getActiveCharName();
    startDelayedImageObserver(
      observerRoot,
      messageState.chatId,
      obsCharName,
      alreadySentSrcs,
    );
  };

  // Assigns a new streamId at the start of each character turn.
  // The chatId prefix exists to make streamIds debuggable across logs; if
  // messageState.chatId is undefined (e.g. ST mid-model-switch race), fall
  // back to the live context's chat id, then to a stable literal — never
  // emit `undefined-...` because the UI's bubble-reuse logic treats that as
  // a polling-bubble candidate and may swallow a finalized greeting.
  const onGenerationStarted = () => {
    const ctx = SillyTavern.getContext();
    const chatIdSafe =
      messageState.chatId ??
      (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null) ??
      ctx.chat_metadata?.chat_id ??
      ctx.chat_metadata?.chatId ??
      'nochat';
    currentStreamId = `${chatIdSafe}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    currentCharacterName = ctx.groupId ? ctx.name2 || null : null;
    lastSentLength = 0;       // reset visible-delta baseline for each new stream
    thinkingSentLength = 0;   // reset thinking-delta baseline
    thinkingClosed = false;   // reset thinking-block state
    lastReasoningSent = '';   // reset live-reasoning-polling baseline
  };
  eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

  const removeAllListeners = () => {
    eventSource.removeListener(
      event_types.STREAM_TOKEN_RECEIVED,
      streamCallback,
    );
    eventSource.removeListener(STREAM_REASONING_DONE, reasoningDoneCallback);
    eventSource.removeListener(
      event_types.GENERATION_STARTED,
      onGenerationStarted,
    );
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.removeListener(GROUP_WRAPPER_FINISHED, onGroupFinished);
    eventSource.removeListener(
      event_types.GENERATION_STOPPED,
      onGenerationStopped,
    );
    // Stop any pending delayed-image observer when the session ends or a new
    // user turn starts (MESSAGE_SENT triggers removeAllListeners indirectly via
    // the next handleUserMessage call which calls stopDelayedImageObserver()).
    stopDelayedImageObserver();
  };

  // Fires once per character turn. Closes their stream.
  // In solo chat also triggers the final ai_reply.
  const onGenerationEnded = () => {
    flushStreamEnd();
    if (!SillyTavern.getContext().groupId) {
      removeAllListeners();
      collectAndSendReplies();
    }
  };
  eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

  // Fires once after all group members have finished generating.
  const onGroupFinished = () => {
    removeAllListeners();
    collectAndSendReplies();
  };
  eventSource.on(GROUP_WRAPPER_FINISHED, onGroupFinished);

  // User aborted - clean up without sending a reply.
  // Self-removing wrapper: behaves like once() but is registered via on() so
  // that removeListener() in removeAllListeners() reliably finds the handler.
  const onGenerationStopped = () => {
    eventSource.removeListener(event_types.GENERATION_STOPPED, onGenerationStopped);
    removeAllListeners();
    flushStreamEnd();
  };
  eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

  try {
    const abortController = new AbortController();
    setExternalAbortController(abortController);
    await Generate("normal", { signal: abortController.signal });
  } catch (error) {
    console.error("[CharacterBridge] Generation error:", error);
    await deleteLastMessage();
    sendErrorMessage(`Generation failed: ${error.message || 'Unknown'}`, messageState.chatId);
    removeAllListeners();
    flushStreamEnd();
  }
}

// ---------------------------------------------------------------------------
// handleExecuteCommand
// ---------------------------------------------------------------------------

/**
 * Handles execute_command: runs the requested command against SillyTavern's
 * APIs and sends an ai_reply with the result text.
 *
 * Stripped down from the Discord version: no Discord-specific commands
 * (image generation, personas saving to Discord, /sd, etc.)
 * Keeps: newchat, switchchar, switchgroup, listchars, listgroups, listchats,
 *        switchchat, continue, persona
 */
export async function handleExecuteCommand(data) {
  sharedState.lastActiveChatId = data.chatId || sharedState.lastActiveChatId;
  sendTypingAction(getActiveCharName(), true, data.chatId);

  let replyText = null;
  const context = SillyTavern.getContext();

  try {
    switch (data.command) {
      case "newchat":
        await doNewChat({ deleteCurrentChat: false });
        clearExpressionCache();
        replyText = "New chat started.";
        break;

      case "listchars": {
        const characters = context.characters.filter((c) => c.name?.trim());
        replyText =
          characters.length === 0
            ? "No characters available."
            : "Characters:\n" +
              characters.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
        break;
      }

      case "switchchar": {
        if (!data.args?.length) {
          replyText = "Usage: switchchar <name>";
          break;
        }
        const targetName = data.args.join(" ");
        const target = context.characters.find((c) => c.name === targetName);
        if (target) {
          await selectCharacterById(context.characters.indexOf(target));
          replyText = `Switched to ${targetName}.`;
        } else {
          replyText = `Character "${targetName}" not found.`;
        }
        break;
      }

      case "listgroups": {
        const allGroups = context.groups || [];
        replyText =
          allGroups.length === 0
            ? "No groups available."
            : "Groups:\n" +
              allGroups.map((g, i) => `${i + 1}. ${g.name}`).join("\n");
        break;
      }

      case "switchgroup": {
        if (!data.args?.length) {
          replyText = "Usage: switchgroup <name>";
          break;
        }
        const targetName = data.args.join(" ");
        const target = (context.groups || []).find(
          (g) => g.name === targetName,
        );
        if (target) {
          await executeSlashCommandsWithOptions(
            `/go ${sanitizeSlashArg(target.name)}`,
          );
          replyText = `Switched to group "${targetName}".`;
        } else {
          replyText = `Group "${targetName}" not found.`;
        }
        break;
      }

      case "listchats": {
        if (context.characterId === undefined) {
          replyText = "No character selected.";
          break;
        }
        const chatFiles = await getPastCharacterChats(context.characterId);
        replyText =
          chatFiles.length === 0
            ? "No chats available."
            : "Chats:\n" +
              chatFiles
                .map(
                  (c, i) =>
                    `${i + 1}. ${c.file_name.replace(".jsonl", "")}`,
                )
                .join("\n");
        break;
      }

      case "switchchat": {
        if (!data.args?.length) {
          replyText = "Usage: switchchat <name>";
          break;
        }
        const targetChatFile = sanitizeChatArg(data.args.join(" "));
        if (!targetChatFile) {
          replyText = "Invalid chat name.";
          break;
        }
        try {
          await openCharacterChat(targetChatFile);
          replyText = `Switched to chat "${targetChatFile}".`;
        } catch {
          replyText = `Failed to switch to chat "${targetChatFile}".`;
        }
        break;
      }

      case "continue": {
        try {
          executeSlashCommandsWithOptions("/continue").catch(() => {});
        } catch (_) {}
        break;
      }

      case "persona": {
        const personaName = sanitizeSlashArg(data.args?.[0] ?? "");
        if (!personaName) {
          replyText = "Usage: persona <name>";
          break;
        }
        await executeSlashCommandsWithOptions(`/persona-set ${personaName}`);
        replyText = `Switched to persona "${personaName}".`;
        break;
      }

      case "chat_history_request": {
        const sinceRaw = data.args?.[0];
        const sinceIndex = sinceRaw !== undefined && sinceRaw !== null
          ? parseInt(sinceRaw, 10)
          : null;
        const hasSince = sinceIndex !== null && !Number.isNaN(sinceIndex);

        const chatArr = SillyTavern.getContext().chat ?? [];

        // Collect the slice of messages to process, then hash all in parallel
        // instead of sequentially to avoid O(n) awaits on large chats.
        const slice = chatArr
          .map((msg, i) => ({ msg, i }))
          .filter(({ msg, i }) => msg && (!hasSince || i >= sinceIndex));

        const messages = await Promise.all(slice.map(async ({ msg, i }) => {
          // ST-Translate-Extension: extra.display_text bevorzugen wenn vorhanden,
          // sonst Fallback auf raw msg.mes. So wird der vom User gesehene Text
          // gespiegelt — nicht die englische Originalversion.
          const content = getDisplayText(msg);
          const hash = await computeHash(content);
          return {
            idx: i,
            role: msg.is_user ? 'user' : 'assistant',
            content,
            name: msg.name ?? '',
            hash,
            extra: msg.extra ?? null,
            send_date: msg.send_date ?? null,
          };
        }));

        // chat_id Fallback: data.chatId fehlt typischerweise weil das Server-
        // command-Packet kein chatId-Feld hat. Nutze stattdessen ST's eigene
        // getCurrentChatId() um den aktiven Chat zu identifizieren.
        const ctx = SillyTavern.getContext();
        const chatId = data.chatId
          ?? ctx.getCurrentChatId?.()
          ?? ctx.chat_metadata?.chat_id
          ?? null;

        sendChatHistoryResponse(chatId, messages, true);
        // KEINE replyText-Bubble — User wollte das nur als console.debug.
        console.debug('[CharacterBridge] chat_history_request: sent', messages.length, 'messages chatId=', chatId);
        replyText = '';
        break;
      }

      case "reload": {
        // Sicherstellen dass der aktuelle Chat-State persistiert ist bevor reload
        try {
          if (typeof context.saveChat === 'function') {
            await context.saveChat();
          }
          if (typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
          }
        } catch (err) {
          console.warn('[CharacterBridge] saveChat/saveSettings vor reload fehlgeschlagen:', err);
        }
        // Aktiven Character+Chat in localStorage sichern damit tryResume() nach
        // dem Reload den Zustand wiederherstellen kann.
        saveResumeState();
        console.debug('[CharacterBridge] reload command received — saving state and reloading');
        // kein replyText — replyText bleibt der initialisierte Default-Wert
        // Kurzer Delay damit der reply-Frame noch raus geht
        setTimeout(() => {
          try {
            window.location.reload();
          } catch (err) {
            console.error('[CharacterBridge] window.location.reload fehlgeschlagen:', err);
          }
        }, 200);
        break;
      }

      default:
        replyText = `Unknown command: ${data.command}`;
    }
  } catch (error) {
    console.error("[CharacterBridge] Command error:", error);
    const msg =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    replyText = `Command error: ${msg}`;
  }

  if (replyText) {
    sendUserMessageReply(replyText, getActiveCharName(), data.chatId);
  }
}
