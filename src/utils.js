/**
 * CharacterBridge Extension - Shared Utilities
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
 * Shared utilities.
 */

/**
 * Sanitizes a string before it is interpolated into a slash command passed to
 * executeSlashCommandsWithOptions. SillyTavern's slash command runner supports
 * pipe chaining (|), so an unsanitized value like "Alice | /newchat" would
 * execute /newchat as a second command. Newlines carry the same risk. Length
 * is capped so an oversized string cannot be used to slow down the parser.
 *
 * Apply this to ALL user-supplied arguments before interpolating them into
 * slash command strings.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeSlashArg(value) {
  return String(value)
    .replace(/[|\n\r]/g, "") // strip pipe and newlines (command injection vectors)
    .trim()
    .slice(0, 200);
}

/**
 * Sanitizes a chat filename argument before passing it to openCharacterChat.
 * In addition to the standard slash-command sanitization, this strips path
 * traversal sequences (`..`, `/`, `\`) so a remote caller cannot navigate
 * outside SillyTavern's chat directory.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeChatArg(value) {
  return sanitizeSlashArg(value)
    .replace(/\.\./g, "")   // strip directory-traversal sequences
    .replace(/[/\\]/g, "")  // strip path separators
    .trim();
}

// For free-text fields like /note where newlines are valid content.
// Only strips the pipe character (ST slash command injection vector).
export function sanitizeNoteArg(value) {
  return String(value)
    .replace(/\|/g, "") // strip pipe (command injection vector)
    .trim()
    .slice(0, 4096);
}

/**
 * Returns the user-visible text of a chat message.
 *
 * SillyTavern's translation extension keeps the original message in `mes`
 * and stores the translated/displayed string in `extra.display_text`. When
 * present and non-empty, that is what the user actually sees in the ST UI,
 * so it is what we want to mirror to the bridge — otherwise the bridge
 * would display the untranslated source while ST shows the target language.
 *
 * Fallback chain:
 *   1. extra.display_text  — translation extension target (string, non-empty after trim)
 *   2. mes                 — original message text
 *   3. ''                  — last-resort empty string
 *
 * The returned string is *not* trimmed itself; whitespace/formatting at
 * either end is preserved so downstream consumers (PicExtractor, hashing,
 * roleplay-markdown) keep their byte-for-byte semantics.
 *
 * @param {{mes?: string|null, extra?: {display_text?: string|null}|null}|null|undefined} msg
 * @returns {string}
 */
export function getDisplayText(msg) {
  if (!msg) return '';
  const displayed = msg.extra?.display_text;
  if (typeof displayed === 'string' && displayed.trim().length > 0) {
    return displayed;
  }
  return msg.mes ?? '';
}
