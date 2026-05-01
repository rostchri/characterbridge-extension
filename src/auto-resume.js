/**
 * CharacterBridge Extension - Auto-Resume after Reload
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
 * Auto-Resume: persists active character + chat to localStorage before a
 * page reload, and restores the state on APP_READY.
 *
 * Storage key: 'cb-extension:resume'
 * Payload:
 *   { avatar: string, chat: string, timestamp: number }
 *
 * On restore, characters are matched by avatar (stable file-system id) rather
 * than by the volatile numeric characterId index.
 */

import { selectCharacterById, openCharacterChat } from '../../../../../script.js';

const STORAGE_KEY = 'cb-extension:resume';
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// saveResumeState
// ---------------------------------------------------------------------------

/**
 * Reads the currently active character + chat from the ST context and
 * persists the relevant identifiers to localStorage so they can be restored
 * after a page reload.
 *
 * Called synchronously before `window.location.reload()`.  The function is
 * intentionally non-async: localStorage writes are synchronous and must
 * complete before the navigation begins.
 *
 * When no character is selected (neutral/no-char chat) avatar and chat are
 * stored as null so tryResume() can skip the restore gracefully.
 */
export function saveResumeState() {
  try {
    const ctx = SillyTavern.getContext();
    const id = ctx.characterId;
    const char = id !== undefined ? ctx.characters?.[id] : undefined;

    const payload = {
      avatar: char?.avatar ?? null,
      chat: char?.chat ?? null,
      timestamp: Date.now(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[CharacterBridge/auto-resume] saveResumeState failed:', err);
  }
}

// ---------------------------------------------------------------------------
// tryResume
// ---------------------------------------------------------------------------

/**
 * Attempts to restore the character + chat that were active before the last
 * page reload.
 *
 * Called on APP_READY.  If no saved state exists, or the state is older than
 * MAX_AGE_MS, or the saved avatar cannot be found in the current character
 * roster, the function returns without making any ST API calls.
 *
 * The storage key is always cleared on entry to prevent stale state from
 * persisting across multiple reloads.
 *
 * @returns {Promise<void>}
 */
export async function tryResume() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[CharacterBridge/auto-resume] localStorage read failed:', err);
    return;
  }

  // Always clear regardless of whether we restore — prevents stale replays.
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}

  if (!raw) return;

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch (err) {
    console.warn('[CharacterBridge/auto-resume] Corrupt resume state ignored:', err);
    return;
  }

  // Reject entries older than MAX_AGE_MS — the user has not just reloaded.
  const age = Date.now() - (saved.timestamp ?? 0);
  if (age > MAX_AGE_MS) return;

  // Nothing meaningful to restore when no avatar was saved.
  if (!saved.avatar) return;

  try {
    const ctx = SillyTavern.getContext();
    const idx = ctx.characters?.findIndex((c) => c.avatar === saved.avatar) ?? -1;
    if (idx === -1) {
      console.warn('[CharacterBridge/auto-resume] Saved character not found in roster, skipping restore');
      return;
    }

    await selectCharacterById(idx);

    if (saved.chat) {
      await openCharacterChat(saved.chat);
    }
  } catch (err) {
    console.warn('[CharacterBridge/auto-resume] Resume restore failed:', err);
  }
}
