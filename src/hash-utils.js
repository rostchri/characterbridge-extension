/**
 * CharacterBridge Extension - Hash Utilities
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
 * Computes a hex hash of the given string content.
 *
 * Uses SubtleCrypto SHA-1 when available (browser / secure context).
 * Falls back to a djb2-based 32-bit hash for non-browser environments (tests,
 * Node.js without SubtleCrypto).
 *
 * The function is always async so callers do not need to branch on the
 * availability of SubtleCrypto.
 *
 * @param {string} content
 * @returns {Promise<string>} Hex-encoded hash string
 */
export async function computeHash(content) {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle?.digest === 'function'
  ) {
    const enc = new TextEncoder().encode(content);
    const buf = await globalThis.crypto.subtle.digest('SHA-1', enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // djb2 polyfill — deterministic, collision-resistant enough for change detection
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = (((h << 5) + h) ^ content.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
