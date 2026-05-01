/**
 * visual-beats.js — Extract and strip <pic prompt="..."> tags from AI messages.
 *
 * SillyTavern models can embed VisualBeat tags in their responses:
 *   <pic prompt="{'perspective': 'first person', 'subject': '...', ...}">
 *
 * These tags:
 *  - MUST NOT appear in the visible chat bubble
 *  - MUST NOT be forwarded to the TTS engine
 *  - MUST be transmitted separately as `visual_beats[]` in wire packets
 *
 * The prompt value is treated as an opaque raw string — no JSON parsing.
 *
 * Tag format accepted:
 *   <pic prompt="double-quoted value">
 *   <pic prompt='single-quoted value'>
 *   Arbitrary whitespace before the closing >
 *
 * Limitation: prompt values that themselves contain an unescaped closing
 * `">` (double-quote style) or `'>` (single-quote style) sequence will
 * cause early termination of the match. In practice SillyTavern-generated
 * prompts are JSON-like objects where the closing `}` precedes the quote,
 * so this limitation does not affect real-world payloads.
 *
 * No side effects, no imports.
 */

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

// Two alternates, one per quote style, so inner quotes of the opposite kind
// are captured without issue (e.g. single-quoted attr containing double quotes).
//
// Group 2: content inside double-quoted prompt=""
// Group 3: content inside single-quoted prompt=''
//
// The \s* before > tolerates trailing whitespace inside the tag.
const PIC_TAG_RE = /<pic\s+prompt=(?:"([^"]*)"|'([^']*)')\s*>/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts all `<pic prompt="...">` VisualBeat tags from `text`.
 *
 * Returns:
 *  - `cleanText`: original text with all pic-tags removed and consecutive
 *    blank lines collapsed to a single blank line (≥3 newlines → 2 newlines).
 *  - `beats`: array of raw prompt strings in document order.
 *
 * When no pic-tags are present the original `text` is returned unchanged
 * (same reference) and `beats` is an empty array.
 *
 * @param {string} text
 * @returns {{ cleanText: string, beats: string[] }}
 */
export function extractAndStripVisualBeats(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { cleanText: text ?? '', beats: [] };
  }

  const beats = [];
  let hasMatch = false;

  // Reset lastIndex before exec loop (re-use of module-level regex is safe
  // here because we always reset before the loop).
  PIC_TAG_RE.lastIndex = 0;

  const cleanText = text.replace(PIC_TAG_RE, (_match, dq, sq) => {
    hasMatch = true;
    // dq is defined for double-quoted attr, sq for single-quoted attr.
    beats.push(dq !== undefined ? dq : sq);
    return '';
  });

  if (!hasMatch) {
    return { cleanText: text, beats: [] };
  }

  // Normalise whitespace: collapse runs of 3+ newlines to 2 (one blank line).
  const normalised = cleanText.replace(/\n{3,}/g, '\n\n');

  return { cleanText: normalised, beats };
}
