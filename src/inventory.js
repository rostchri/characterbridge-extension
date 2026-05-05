/**
 * CharacterBridge Extension - Character Inventory
 * Based on SillyTavern-Discord-Connector by senjinthedragon (AGPL-3.0)
 *
 * Collects all bots (characters) and personas from SillyTavern
 * and sends them as character_inventory / inventory_update packets
 * to the CharacterBridge middleware.
 *
 * Avatar transport: absolute URLs only — no base64 inline transfer.
 * The Chatroom UI loads avatars directly from the ST origin via <img src>.
 * Both domains share an Authelia SSO session, so no CORS headers are needed
 * for img-tag requests.
 *
 * URL schema:
 *   - Characters : /thumbnail?type=avatar&file=<avatar-filename>
 *   - Personas   : /thumbnail?type=avatar&file=<persona-id>
 */

import { sendInventoryUpdate } from "./chatroom-client.js";

// ---------------------------------------------------------------------------
// Avatar URL construction
// ---------------------------------------------------------------------------

/**
 * Builds an absolute avatar URL for a SillyTavern character.
 * ST serves character thumbnails via /thumbnail?type=avatar&file=<filename>.
 *
 * @param {string|null} avatarFilename  The `avatar` field from a ST character object.
 * @returns {string|null}
 */
function buildCharacterAvatarUrl(avatarFilename) {
  if (!avatarFilename) return null;
  const base = window.location.origin;
  return `${base}/thumbnail?type=avatar&file=${encodeURIComponent(avatarFilename)}`;
}

/**
 * Builds an absolute avatar URL for a SillyTavern persona.
 * ST serves persona thumbnails via /thumbnail?type=persona&file=<persona-id>.
 *
 * @param {string|null} personaId  The persona key from powerUserSettings.personas.
 * @returns {string|null}
 */
function buildPersonaAvatarUrl(personaId) {
  if (!personaId) return null;
  const base = window.location.origin;
  return `${base}/thumbnail?type=persona&file=${encodeURIComponent(personaId)}`;
}

// ---------------------------------------------------------------------------
// Inventory collection
// ---------------------------------------------------------------------------

/**
 * Collects the full character inventory from SillyTavern's context.
 * Returns bots (AI characters), personas (user identities), and metadata
 * about the active chat state.
 *
 * Avatar fields carry absolute URLs; no image data is fetched or transferred.
 * The Chatroom UI loads avatars directly via <img src="...">.
 *
 * @returns {{bots: Array, personas: Array, metadata: object}}
 */
export function collectInventory() {
  const ctx = SillyTavern.getContext();
  const characters = ctx.characters || [];
  const powerUser = ctx.powerUserSettings || {};

  // Collect bots (AI characters)
  const bots = characters
    .filter((c) => c.name?.trim())
    .map((c) => {
      const description = c.description || "";
      return {
        name: c.name,
        avatar_url: buildCharacterAvatarUrl(c.avatar),
        description: description.length > 500 ? description.slice(0, 500) : description,
      };
    });

  // Collect personas (user identities)
  const personaMap = powerUser.personas || {};
  const personaDescriptions = powerUser.persona_descriptions || {};
  const personas = Object.entries(personaMap)
    .filter(([, name]) => name?.trim())
    .map(([id, name]) => ({
      id,
      name,
      avatar_url: buildPersonaAvatarUrl(id),
      description: personaDescriptions[id]?.description || "",
    }));

  // Metadata about active state
  const activeGroup = ctx.groupId
    ? (ctx.groups || []).find((g) => g.id === ctx.groupId)
    : null;

  const groupMembers = activeGroup
    ? (activeGroup.members || [])
        .map((id) => characters.find((ch) => ch.id === id)?.name?.trim())
        .filter(Boolean)
    : [];

  const activeCharName =
    ctx.characterId !== undefined
      ? characters[ctx.characterId]?.name || null
      : null;

  const metadata = {
    activeCharacter: activeCharName,
    activeGroup: activeGroup?.name || null,
    groupMembers,
    activeChat: ctx.chatId || null,
  };

  return { bots, personas, metadata };
}

// ---------------------------------------------------------------------------
// Inventory watcher (polling-based change detection)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10_000; // 10 seconds

let _watcherTimer = null;
let _lastFingerprint = "";

/**
 * Computes a lightweight fingerprint of the character/persona state
 * so we can detect changes without deep-comparing full objects.
 */
function computeFingerprint() {
  try {
    const ctx = SillyTavern.getContext();
    const charNames = (ctx.characters || [])
      .map((c) => c.name || "")
      .sort()
      .join("|");
    const personaNames = Object.values(
      ctx.powerUserSettings?.personas || {},
    )
      .sort()
      .join("|");
    const activeChar =
      ctx.characterId !== undefined
        ? ctx.characters?.[ctx.characterId]?.name || ""
        : "";
    const activeGroup = ctx.groupId || "";
    return `${charNames}::${personaNames}::${activeChar}::${activeGroup}`;
  } catch {
    return "";
  }
}

/**
 * Starts a polling watcher that detects changes in the character/persona
 * roster and sends inventory_update packets when changes are detected.
 *
 * @param {((inventory: {bots: Array, personas: Array, metadata: object}) => void) | null} [onUpdate]
 *   Optional callback invoked with the new inventory whenever a change is
 *   detected.  When provided, this callback is responsible for sending the
 *   packet (DI pattern — caller decides the transport).  When omitted, the
 *   watcher falls back to calling sendInventoryUpdate() directly so callers
 *   that do not inject a callback still work without modification.
 */
export function startInventoryWatcher(onUpdate = null) {
  stopInventoryWatcher();
  _lastFingerprint = computeFingerprint();

  _watcherTimer = setInterval(() => {
    const newFingerprint = computeFingerprint();
    if (newFingerprint !== _lastFingerprint) {
      _lastFingerprint = newFingerprint;
      try {
        const inventory = collectInventory();
        if (typeof onUpdate === 'function') {
          onUpdate(inventory);
        } else {
          sendInventoryUpdate(inventory);
        }
      } catch (err) {
        console.warn("[CharacterBridge] Inventory watcher update failed:", err);
      }
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stops the inventory watcher.
 */
export function stopInventoryWatcher() {
  if (_watcherTimer) {
    clearInterval(_watcherTimer);
    _watcherTimer = null;
  }
}
