/**
 * thinking-split.test.js — Unit tests for splitThinking, stripThinkingPrefix
 * and resolveThinking (#1820)
 *
 * Tests cover:
 *  - splitThinking: no tag, leading tag, tag with newlines, tag mid-text
 *  - stripThinkingPrefix: still-open tag, closed tag, no tag
 *  - resolveThinking: <think> tag wins, extra.reasoning fallback,
 *    extra.reasoning_content fallback, null when nothing present
 *
 * Run:
 *   cd /tmp/cb-fork/src && node --test __tests__/thinking-split.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitThinking, stripThinkingPrefix, resolveThinking } from '../thinking-utils.js';

// ---------------------------------------------------------------------------
// splitThinking
// ---------------------------------------------------------------------------

describe('splitThinking', () => {

  it('returns thinking=null and original text when no <think> tag present', () => {
    const result = splitThinking('Hello world');
    assert.equal(result.thinking, null);
    assert.equal(result.visible, 'Hello world');
  });

  it('returns thinking=null for empty string', () => {
    const result = splitThinking('');
    assert.equal(result.thinking, null);
    assert.equal(result.visible, '');
  });

  it('returns thinking=null for null/undefined input', () => {
    const result = splitThinking(null);
    assert.equal(result.thinking, null);
    assert.equal(result.visible, '');
  });

  it('extracts leading <think>...</think> into thinking field', () => {
    const result = splitThinking('<think>I need to think</think>The answer is 42.');
    assert.equal(result.thinking, 'I need to think');
    assert.equal(result.visible, 'The answer is 42.');
  });

  it('trims whitespace from thinking content', () => {
    const result = splitThinking('<think>  plan here  </think>Response text');
    assert.equal(result.thinking, 'plan here');
  });

  it('handles thinking block with newlines inside', () => {
    const raw = '<think>\nLine one\nLine two\n</think>Visible text here';
    const result = splitThinking(raw);
    assert.equal(result.thinking, 'Line one\nLine two');
    assert.equal(result.visible, 'Visible text here');
  });

  it('strips leading whitespace/newlines between </think> and visible text', () => {
    const result = splitThinking('<think>thought</think>\n\nActual response');
    assert.equal(result.visible, 'Actual response');
  });

  it('returns empty visible when entire text is just the think block', () => {
    const result = splitThinking('<think>just thinking</think>');
    assert.equal(result.thinking, 'just thinking');
    assert.equal(result.visible, '');
  });

  it('does NOT extract <think> tag that is not at the start of text', () => {
    // A <think> tag in the middle of text is not a reasoning block — leave as-is
    const raw = 'Some text <think>mid-think</think> more text';
    const result = splitThinking(raw);
    assert.equal(result.thinking, null);
    assert.equal(result.visible, raw);
  });

  it('handles multiple sentences in visible part', () => {
    const result = splitThinking('<think>plan</think>First sentence. Second sentence.');
    assert.equal(result.thinking, 'plan');
    assert.equal(result.visible, 'First sentence. Second sentence.');
  });

  it('handles empty think block', () => {
    const result = splitThinking('<think></think>Response');
    assert.equal(result.thinking, '');
    assert.equal(result.visible, 'Response');
  });
});

// ---------------------------------------------------------------------------
// stripThinkingPrefix
// ---------------------------------------------------------------------------

describe('stripThinkingPrefix', () => {

  it('returns original text unchanged when no <think> tag present', () => {
    assert.equal(stripThinkingPrefix('Hello world'), 'Hello world');
  });

  it('returns empty string while <think> is open (no closing tag yet)', () => {
    assert.equal(stripThinkingPrefix('<think>still thinking'), '');
    assert.equal(stripThinkingPrefix('<think>'), '');
  });

  it('returns text after </think> once tag is closed', () => {
    assert.equal(
      stripThinkingPrefix('<think>done thinking</think>Visible'),
      'Visible',
    );
  });

  it('trims leading whitespace after closed </think>', () => {
    assert.equal(
      stripThinkingPrefix('<think>x</think>   trimmed'),
      'trimmed',
    );
  });

  it('returns empty string when think block closed but no text follows', () => {
    assert.equal(stripThinkingPrefix('<think>only thinking</think>'), '');
  });

  it('handles partially received think content correctly', () => {
    // Simulates incremental token arrival
    assert.equal(stripThinkingPrefix('<think>a'), '');
    assert.equal(stripThinkingPrefix('<think>ab'), '');
    assert.equal(stripThinkingPrefix('<think>abc</think>'), '');
    assert.equal(stripThinkingPrefix('<think>abc</think>text'), 'text');
  });

  it('does not affect text with no leading think tag', () => {
    const text = 'Normal response without thinking';
    assert.equal(stripThinkingPrefix(text), text);
  });

  it('handles think block with newlines in streaming context', () => {
    const partial = '<think>\nplanning\n more planning\n</think>\nHello';
    assert.equal(stripThinkingPrefix(partial), 'Hello');
  });
});

// ---------------------------------------------------------------------------
// resolveThinking (#1820)
// ---------------------------------------------------------------------------

describe('resolveThinking (#1820)', () => {

  it('uses <think> tag when present — splitThinking result wins', () => {
    const result = resolveThinking('<think>model reasoning</think>Answer here.', {});
    assert.equal(result.thinking, 'model reasoning');
    assert.equal(result.visible, 'Answer here.');
  });

  it('falls back to extra.reasoning when no <think> tag present', () => {
    const result = resolveThinking('Answer without tag', { reasoning: 'hidden reasoning' });
    assert.equal(result.thinking, 'hidden reasoning');
    assert.equal(result.visible, 'Answer without tag');
  });

  it('falls back to extra.reasoning_content when extra.reasoning is absent', () => {
    const result = resolveThinking('Visible reply', { reasoning_content: 'content-key reasoning' });
    assert.equal(result.thinking, 'content-key reasoning');
    assert.equal(result.visible, 'Visible reply');
  });

  it('returns thinking=null when no <think> tag and no extra reasoning keys', () => {
    const result = resolveThinking('Plain message', {});
    assert.equal(result.thinking, null);
    assert.equal(result.visible, 'Plain message');
  });

  it('returns thinking=null when extra is null', () => {
    const result = resolveThinking('Plain message', null);
    assert.equal(result.thinking, null);
    assert.equal(result.visible, 'Plain message');
  });

  it('returns thinking=null when extra is undefined', () => {
    const result = resolveThinking('Plain message', undefined);
    assert.equal(result.thinking, null);
    assert.equal(result.visible, 'Plain message');
  });

  it('prefers <think> tag over extra.reasoning when both are present', () => {
    const result = resolveThinking(
      '<think>tag reasoning</think>Visible',
      { reasoning: 'extra reasoning' },
    );
    assert.equal(result.thinking, 'tag reasoning');
    assert.equal(result.visible, 'Visible');
  });

  it('prefers extra.reasoning over extra.reasoning_content when both present', () => {
    const result = resolveThinking('Message', {
      reasoning: 'primary',
      reasoning_content: 'secondary',
    });
    assert.equal(result.thinking, 'primary');
  });

  it('treats empty-string extra.reasoning as absent and tries reasoning_content', () => {
    const result = resolveThinking('Message', {
      reasoning: '',
      reasoning_content: 'fallback content',
    });
    assert.equal(result.thinking, 'fallback content');
  });

  it('treats whitespace-only extra.reasoning as absent', () => {
    const result = resolveThinking('Message', { reasoning: '   ' });
    assert.equal(result.thinking, null);
  });

  it('handles null mes gracefully', () => {
    const result = resolveThinking(null, { reasoning: 'extra' });
    assert.equal(result.thinking, 'extra');
    assert.equal(result.visible, '');
  });
});
