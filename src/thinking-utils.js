/**
 * thinking-utils.js — Pure helper functions for reasoning/thinking content.
 *
 * Extracted into a separate module so they can be unit-tested without
 * pulling in SillyTavern's browser-only dependencies.
 *
 * No side effects, no imports.
 */

/**
 * Splits a raw AI message into a visible part and an optional thinking block.
 * Matches only a leading `<think>...</think>` tag.
 *
 * @param {string|null|undefined} raw - The raw message text from ST.
 * @returns {{ thinking: string|null, visible: string }}
 */
export function splitThinking(raw) {
  const m = /^<think>([\s\S]*?)<\/think>\s*/.exec(raw || '');
  if (!m) return { thinking: null, visible: raw || '' };
  return { thinking: m[1].trim(), visible: raw.slice(m[0].length) };
}

/**
 * Resolves the thinking/reasoning content for a chat message.
 *
 * Fallback chain (first non-empty string wins):
 *  1. `splitThinking(mes)` — leading `<think>...</think>` tag in the message text.
 *  2. `extra.reasoning`         — SillyTavern stores reasoning tokens here for some APIs
 *                                  (e.g. Anthropic extended thinking, OpenAI o-series).
 *  3. `extra.reasoning_content` — alternative key used by other ST API backends.
 *
 * @param {string|null|undefined} mes   - The raw message text (chat[i].mes).
 * @param {object|null|undefined} extra - The message's extra object (chat[i].extra).
 * @returns {{ thinking: string|null, visible: string }}
 */
export function resolveThinking(mes, extra) {
  const split = splitThinking(mes);
  if (split.thinking !== null) return split;

  const fallback =
    (typeof extra?.reasoning === 'string' && extra.reasoning.trim()) ||
    (typeof extra?.reasoning_content === 'string' && extra.reasoning_content.trim()) ||
    null;

  return { thinking: fallback || null, visible: split.visible };
}

/**
 * Strips a still-open or already-closed `<think>...</think>` prefix from
 * cumulative streaming text so live token chunks never expose thinking content.
 *
 * Rules:
 *  - No `<think>` tag present   → return text as-is.
 *  - `<think>` open, not closed → thinking still running; return ''.
 *  - `<think>...</think>` done  → return everything after `</think>`.
 *
 * @param {string} text - Cumulative text from STREAM_TOKEN_RECEIVED.
 * @returns {string}
 */
export function stripThinkingPrefix(text) {
  const open = text.indexOf('<think>');
  if (open === -1) return text;
  const close = text.indexOf('</think>');
  if (close === -1) return '';  // thinking still running
  return text.slice(close + '</think>'.length).trimStart();
}
