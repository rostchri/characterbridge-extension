/**
 * CharacterBridge Extension - External-Character (Phase 2: Mit-Spieler-Modus)
 *
 * Phase 2 erlaubt einem Claude-Code-Agent, eine ST-Char-Card "auszuleihen":
 * Der Agent generiert seine Replies WEITER selbst (nicht ST), aber sie werden
 * als ST-Bubbles unter dieser Char-Card im Group-Chat angezeigt — dadurch
 * sieht jede andere ST-Persona den Claude-Beitrag als regulaere
 * Group-Member-Nachricht und kann darauf reagieren.
 *
 * Strategie:
 *   1. ST-Group-Chat MUSS aktiv sein (Solo-Mode unzulaessig).
 *   2. Char-Card wird via /memberadd dem Group hinzugefuegt — sofern noch nicht
 *      Member.
 *   3. Char-Card wird via /member-disable stumm geschaltet, sodass ST
 *      diesen Member NIEMALS automatisch generiert. Der Claude-Agent ist die
 *      einzige Schreibinstanz.
 *   4. Bei {type:"external_character_message"} wird der Text als nicht-
 *      generative Nachricht in ST.chat[] eingefuegt und persistiert.
 *   5. Direkt danach wird ein synthetischer message:stream_end emittiert,
 *      damit der Chatroom-Controller die Turn-Completion-Pipeline regulaer
 *      durchlaeuft (TTS, Expression-Update, Avatar-Lookup) und der naechste
 *      Group-Member wieder durch ST gepickt werden kann.
 *
 * Echo-Vermeidung:
 *   Die Bubble traegt external_origin: true im Metadata-Block. Der Chatroom-
 *   Controller blockt diese Bubble vom Re-Broadcast an den urspruenglichen
 *   Claude-Agent (sonst Echo).
 *
 * Test-Strategie:
 *   Pure Helpers (build*) sind ohne ST-Globals testbar. Die Top-Level-Handler
 *   verbinden sie nur mit eventSource/saveChat/slash-commands.
 */

import {
  eventSource,
  event_types,
  saveChatConditional,
  addOneMessage,
} from '../../../../../script.js';
import { executeSlashCommandsWithOptions } from '../../../../../scripts/slash-commands.js';
import { send } from './chatroom-client.js';
import { sanitizeSlashArg } from './utils.js';

const EXTERNAL_STREAM_PREFIX = 'ext-';

export function newExternalStreamId() {
  return `${EXTERNAL_STREAM_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Pure Builders — ohne ST-Globals, einfach testbar
// ---------------------------------------------------------------------------

export function buildListStCharactersResponse(ctx, ref) {
  const characters = (ctx.characters || []).map((c, idx) => ({
    id: String(c.avatar ?? idx),
    name: c.name ?? '',
    avatar: c.avatar ?? null,
    description: c.description ?? '',
    scenario: c.scenario ?? '',
    personality: c.personality ?? '',
    first_mes: c.first_mes ?? '',
  }));
  return {
    type: 'list_st_characters_response',
    ref: ref ?? null,
    characters,
  };
}

/**
 * Validiert Setup-Voraussetzungen. Liefert {ok:true,...} oder
 * {ok:false, reason}. KEINE Slash-Command-Ausfuehrung — die liegt im
 * Handler.
 */
export function validateSetupExternalCharacter(ctx, charName) {
  const trimmed = (charName ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'missing_char_name' };
  if (!ctx.groupId) return { ok: false, reason: 'not_in_group_chat' };

  const group = (ctx.groups || []).find((g) => g.id === ctx.groupId);
  if (!group) return { ok: false, reason: 'group_not_found' };

  const character = (ctx.characters || []).find(
    (c) => (c.name ?? '').trim() === trimmed,
  );
  if (!character) return { ok: false, reason: 'character_not_found' };

  const isMember = (group.members || []).some(
    (m) => m === character.avatar || m === character.name,
  );

  return {
    ok: true,
    character,
    group,
    isMember,
    avatarUrl: character.avatar ? `/characters/${character.avatar}` : null,
  };
}

/**
 * Setup-Result-Packet (vereinheitlicht ok+error, Spec Backend packet_router).
 * Felder: ok, session_id, char_name, group_chat_id, group_id, description,
 * rp_hint, warnings[], error.
 */
export function buildSetupResultOk({ ref, sessionId, charName, groupId, groupChatId, character, rpHint, warnings = [] }) {
  return {
    type: 'setup_external_character_result',
    ref: ref ?? null,
    ok: true,
    session_id: sessionId ?? '',
    char_name: charName,
    group_id: groupId,
    group_chat_id: groupChatId ?? '',
    description: character?.description ?? '',
    rp_hint: rpHint ?? '',
    warnings,
    error: null,
  };
}

export function buildSetupResultError({ ref, sessionId, charName, error }) {
  return {
    type: 'setup_external_character_result',
    ref: ref ?? null,
    ok: false,
    session_id: sessionId ?? '',
    char_name: charName ?? '',
    group_id: null,
    group_chat_id: '',
    description: '',
    rp_hint: '',
    warnings: [],
    error: error ?? 'unknown',
  };
}

/**
 * Baut das chat[]-Message-Objekt fuer eine externe Bubble.
 * is_user:false, is_system:false → wird wie eine echte Group-Member-Antwort
 * behandelt; andere Member koennen darauf reagieren.
 * extra.external_origin markiert das fuer den Chatroom-Controller, sodass
 * der Echo-Blocker die Bubble nicht erneut an den Claude-Agent zurueckspielt.
 */
export function buildExternalChatMessage(charName, text, streamId, avatarUrl) {
  return {
    name: charName,
    is_user: false,
    is_system: false,
    send_date: new Date().toISOString(),
    mes: text,
    force_avatar: avatarUrl,
    original_avatar: avatarUrl,
    extra: {
      external_origin: true,
      external_stream_id: streamId,
      gen_id: streamId,
    },
  };
}

export function buildSynthStreamEnd(charName, text, streamId) {
  return {
    type: 'stream_end',
    stream_id: streamId,
    final_text: text,
    char_name: charName,
    external_origin: true,
  };
}

// ---------------------------------------------------------------------------
// Handlers (IO + Side-Effects)
// ---------------------------------------------------------------------------

export function handleListStCharacters(packet) {
  const ctx = SillyTavern.getContext();
  send(buildListStCharactersResponse(ctx, packet.ref));
}

export async function handleSetupExternalCharacter(packet) {
  const charName = (packet.char_name ?? '').trim();
  const sessionId = packet.session_id ?? '';
  const ref = packet.ref ?? null;
  const rpHint = packet.rp_hint ?? '';

  const ctx = SillyTavern.getContext();
  const v = validateSetupExternalCharacter(ctx, charName);

  if (!v.ok) {
    send(buildSetupResultError({ ref, sessionId, charName, error: v.reason }));
    return;
  }

  const safeName = sanitizeSlashArg(charName);

  try {
    if (!v.isMember) {
      await executeSlashCommandsWithOptions(`/member-add ${safeName}`);
    }
    await executeSlashCommandsWithOptions(`/member-disable ${safeName}`);
    send(
      buildSetupResultOk({
        ref,
        sessionId,
        charName,
        groupId: ctx.groupId,
        groupChatId: ctx.chatId ?? '',
        character: v.character,
        rpHint,
      }),
    );
  } catch (err) {
    console.error('[CharacterBridge/external] setup failed:', err);
    send(
      buildSetupResultError({
        ref,
        sessionId,
        charName,
        error: `slash_command_failed:${err?.message ?? 'unknown'}`,
      }),
    );
  }
}

export async function handleExternalCharacterMessage(packet) {
  const charName = (packet.char_name ?? '').trim();
  const text = packet.text ?? '';
  const streamId = packet.stream_id ?? newExternalStreamId();

  if (!charName) {
    console.warn('[CharacterBridge/external] missing char_name');
    return;
  }

  const ctx = SillyTavern.getContext();
  if (!ctx.groupId) {
    console.warn('[CharacterBridge/external] not in group chat — drop');
    return;
  }

  const character = (ctx.characters || []).find(
    (c) => (c.name ?? '').trim() === charName,
  );
  if (!character) {
    console.warn(`[CharacterBridge/external] unknown char_name: ${charName}`);
    return;
  }

  const avatarUrl = character.avatar ? `/characters/${character.avatar}` : null;
  const message = buildExternalChatMessage(charName, text, streamId, avatarUrl);

  try {
    // ST-Pattern aus group-chats.js (~Z.299): chat.push → MESSAGE_RECEIVED →
    // addOneMessage → CHARACTER_MESSAGE_RENDERED → saveChatConditional.
    // KRITISCH: addOneMessage rendered die Bubble in den DOM. Ohne das ist
    // die Message nur in chat[] und unsichtbar in der UI.
    ctx.chat.push(message);
    const idx = ctx.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, idx);
    addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, idx);
    await saveChatConditional();
  } catch (err) {
    console.error('[CharacterBridge/external] failed to inject message:', err);
    return;
  }

  send(buildSynthStreamEnd(charName, text, streamId));
}

// move_out_of_st ist rein backend-seitig — der Chatroom-Controller updated
// AgentBridgeState ohne die Bridge zu involvieren. cb-fork muss daher kein
// Packet handhaben. Sollte das spaeter aenderungen (z.B. /groupmember-enable
// beim Move-Out), kann hier ein Handler nachgereicht werden.
