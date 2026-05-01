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
 * Resolves the thinking/reasoning content and optional duration for a chat message.
 *
 * Fallback chain for thinking text (first non-empty string wins):
 *  1. `splitThinking(mes)` — leading `<think>...</think>` tag in the message text.
 *  2. `extra.reasoning`         — SillyTavern stores reasoning tokens here for some APIs
 *                                  (e.g. Anthropic extended thinking, OpenAI o-series).
 *  3. `extra.reasoning_content` — alternative key used by other ST API backends.
 *
 * Duration resolution (durationMs):
 *  - `extra.reasoning_duration_ms` — already in milliseconds, used directly.
 *  - `extra.reasoning_duration`    — SillyTavern stores this in seconds (same unit as
 *                                    `generation_time` / `time_to_first_token`); multiplied
 *                                    by 1000 to produce milliseconds.
 *  - When the `<think>` tag path was taken (splitThinking result), durationMs is always
 *    null — wall-clock time is not available for inline reasoning tags.
 *  - Falls back to null when no duration field is present.
 *
 * @param {string|null|undefined} mes   - The raw message text (chat[i].mes).
 * @param {object|null|undefined} extra - The message's extra object (chat[i].extra).
 * @returns {{ thinking: string|null, visible: string, durationMs: number|null }}
 */
export function resolveThinking(mes, extra) {
  const split = splitThinking(mes);
  if (split.thinking !== null) {
    // <think> tag path: duration not available from inline tag
    return { thinking: split.thinking, visible: split.visible, durationMs: null };
  }

  const fallback =
    (typeof extra?.reasoning === 'string' && extra.reasoning.trim()) ||
    (typeof extra?.reasoning_content === 'string' && extra.reasoning_content.trim()) ||
    null;

  // Duration: prefer explicit _ms field, otherwise convert seconds → ms.
  let durationMs = null;
  if (typeof extra?.reasoning_duration_ms === 'number' && isFinite(extra.reasoning_duration_ms)) {
    durationMs = extra.reasoning_duration_ms;
  } else if (typeof extra?.reasoning_duration === 'number' && isFinite(extra.reasoning_duration)) {
    durationMs = extra.reasoning_duration * 1000;
  }

  return { thinking: fallback || null, visible: split.visible, durationMs };
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
