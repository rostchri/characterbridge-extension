/**
 * CharacterBridge Extension - Expression Relay
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
 * Expression relay.
 *
 * SillyTavern exposes the current expression in #expression-image. We observe
 * that element and forward updates to the CharacterBridge, including the
 * expression name (emotion) and optionally the expression image as base64.
 */

import { sendExpressionWithContext } from "./chatroom-client.js";
import { getSettings } from "./settings.js";
import { sharedState } from "./state.js";
import { resolveImagePayload } from "./image-relay.js";

// ---------------------------------------------------------------------------
// Expression cache
// ---------------------------------------------------------------------------

/** @type {Map<string, {ownerName: string, expression: string, image: object|null, updatedAt: number}>} */
const expressionCache = new Map();

export function clearExpressionCache() {
  expressionCache.clear();
}

export function getExpressionCacheSize() {
  return expressionCache.size;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Wait this long after the last DOM change before sending an update, so rapid
// sprite swaps (e.g. during a group turn) don't flood the bridge.
const EXPRESSION_DEBOUNCE_MS = 250;
export const EXPRESSION_MODE_VALUES = new Set(["off", "status", "full"]);

let lastExpressionSignature = "";
let expressionObserver = null;
let expressionDebounceTimer = null;

export function resetExpressionSignature() {
  lastExpressionSignature = "";
}

function normalizeExpressionOwnerName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function cacheExpressionSnapshot(snapshot) {
  if (!snapshot?.ownerName) return;
  const key = normalizeExpressionOwnerName(snapshot.ownerName);
  if (!key) return;
  expressionCache.set(key, {
    ownerName: snapshot.ownerName,
    expression: snapshot.expression,
    image: snapshot.image || null,
    updatedAt: Date.now(),
  });
}

export function getCachedExpressionSnapshot(name) {
  const key = normalizeExpressionOwnerName(name);
  if (!key) return null;
  return expressionCache.get(key) || null;
}

function parseExpressionFromElement(imgEl) {
  if (!imgEl) return null;

  const explicit =
    imgEl.getAttribute("data-expression") || imgEl.getAttribute("title") || "";
  if (explicit.trim()) return explicit.trim().toLowerCase();

  const src = imgEl.getAttribute("src") || "";
  const base = src.split("?")[0].split("/").pop() || "";
  const name = base
    .replace(/\.[a-z0-9]+$/i, "")
    .trim()
    .toLowerCase();

  // ST sometimes points to /img/default-expressions/null.png when no
  // expression is active; treat that as neutral for activity display.
  if (!name || name === "null") return "neutral";
  return name;
}

function buildExpressionImageUrl(imgEl) {
  if (!imgEl) return null;
  const src = imgEl.getAttribute("src");
  if (!src) return null;
  return resolveImagePayload(src);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the current expression block from the DOM and returns expression +
 * optional image URL.
 *
 * @param {boolean} includeImage
 * @returns {{expression: string, image: string|null, ownerName: string|null}|null}
 */
export function getCurrentExpressionSnapshot(includeImage = false) {
  const imgEl = document.getElementById("expression-image");
  if (!imgEl) return null;

  const expression = parseExpressionFromElement(imgEl);
  if (!expression) return null;

  const image = includeImage ? buildExpressionImageUrl(imgEl) : null;
  const ownerName =
    imgEl.getAttribute("data-sprite-folder-name")?.trim() || null;
  const snapshot = { expression, image, ownerName };
  cacheExpressionSnapshot(snapshot);
  return snapshot;
}

export function sendExpressionUpdate(chatIdHint = null) {
  const settings = getSettings();
  if (settings.expressionMode === "off") return;

  const snapshot = getCurrentExpressionSnapshot(
    settings.expressionMode === "full",
  );
  if (!snapshot) return;
  const { expression, image, ownerName } = snapshot;

  const imgEl = document.getElementById("expression-image");
  const src = imgEl.getAttribute("src") || "";
  const signature = `${expression}|${src}`;
  if (signature === lastExpressionSignature) return;
  lastExpressionSignature = signature;

  const chatId = chatIdHint || sharedState.lastActiveChatId || null;

  sendExpressionWithContext(ownerName || null, expression, image, chatId);
}

export function scheduleExpressionUpdate(chatIdHint = null) {
  if (expressionDebounceTimer) clearTimeout(expressionDebounceTimer);
  expressionDebounceTimer = setTimeout(() => {
    try {
      sendExpressionUpdate(chatIdHint);
    } catch (err) {
      console.warn("[CharacterBridge] Failed to send expression update:", err);
    }
  }, EXPRESSION_DEBOUNCE_MS);
}

export function setupExpressionObserver() {
  if (expressionObserver) return;

  // Prefer narrow selectors; never fall back to document.body (subtree:true on
  // body observes the entire DOM and causes excessive MutationObserver callbacks).
  // If no suitable element is found yet, skip observation entirely — the next
  // polling tick will retry via scheduleExpressionUpdate.
  const target =
    document.getElementById("expression-wrapper") ||
    document.getElementById("expression-image");
  if (!target) return;

  expressionObserver = new MutationObserver(() => {
    scheduleExpressionUpdate();
  });

  expressionObserver.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-expression", "title"],
  });

  // Push initial state when connected and observer starts.
  scheduleExpressionUpdate();
}
