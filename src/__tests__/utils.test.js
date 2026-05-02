/**
 * utils.test.js — Unit tests for src/utils.js
 *
 * Tests:
 *   - sanitizeSlashArg: existing command-injection sanitization
 *   - sanitizeChatArg: path-traversal prevention (#1811)
 *
 * Run from repo root:
 *   node --test src/__tests__/utils.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSlashArg, sanitizeChatArg, getDisplayText } from '../utils.js';

// ---------------------------------------------------------------------------

describe('sanitizeSlashArg', () => {

  it('strips pipe characters', () => {
    assert.equal(sanitizeSlashArg('Alice | /newchat'), 'Alice  /newchat');
  });

  it('strips newline characters', () => {
    assert.equal(sanitizeSlashArg('Alice\n/newchat'), 'Alice/newchat');
    assert.equal(sanitizeSlashArg('Alice\r/newchat'), 'Alice/newchat');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(sanitizeSlashArg('  Alice  '), 'Alice');
  });

  it('caps length at 200 characters', () => {
    const long = 'a'.repeat(300);
    assert.equal(sanitizeSlashArg(long).length, 200);
  });

  it('coerces non-string input', () => {
    assert.equal(sanitizeSlashArg(42), '42');
    assert.equal(sanitizeSlashArg(null), 'null');
  });

  it('returns empty string for empty input', () => {
    assert.equal(sanitizeSlashArg(''), '');
  });
});

// ---------------------------------------------------------------------------

describe('sanitizeChatArg — path traversal prevention (#1811)', () => {

  it('strips double-dot sequences', () => {
    assert.equal(sanitizeChatArg('../secret'), 'secret');
    assert.equal(sanitizeChatArg('../../etc/passwd'), 'etcpasswd');
    assert.equal(sanitizeChatArg('foo/../../bar'), 'foobar');
  });

  it('strips forward slashes', () => {
    assert.equal(sanitizeChatArg('chats/mysession'), 'chatsmysession');
    assert.equal(sanitizeChatArg('/absolute/path'), 'absolutepath');
  });

  it('strips backslashes', () => {
    assert.equal(sanitizeChatArg('..\\windows\\system32'), 'windowssystem32');
    assert.equal(sanitizeChatArg('chat\\file'), 'chatfile');
  });

  it('strips combined traversal sequences', () => {
    assert.equal(sanitizeChatArg('..\\..\\secret'), 'secret');
  });

  it('preserves a clean filename', () => {
    assert.equal(sanitizeChatArg('Aria_2024-01-01'), 'Aria_2024-01-01');
  });

  it('preserves filename with spaces (common in chat names)', () => {
    assert.equal(sanitizeChatArg('My Chat Session'), 'My Chat Session');
  });

  it('also strips pipe and newline (inherits sanitizeSlashArg)', () => {
    assert.equal(sanitizeChatArg('chat|/newchat'), 'chat/newchat'.replace(/\//g, ''));
  });

  it('caps length at 200 characters', () => {
    const long = 'a'.repeat(300);
    assert.equal(sanitizeChatArg(long).length, 200);
  });

  it('returns empty string for a path-only input', () => {
    assert.equal(sanitizeChatArg('../../'), '');
    assert.equal(sanitizeChatArg('/'), '');
    assert.equal(sanitizeChatArg('\\'), '');
  });
});

// ---------------------------------------------------------------------------

describe('getDisplayText', () => {

  it('returns extra.display_text when present and non-empty', () => {
    const msg = { mes: 'Hello', extra: { display_text: 'Hallo' } };
    assert.equal(getDisplayText(msg), 'Hallo');
  });

  it('falls back to mes when display_text is missing', () => {
    const msg = { mes: 'Hello', extra: {} };
    assert.equal(getDisplayText(msg), 'Hello');
  });

  it('falls back to mes when extra is missing entirely', () => {
    const msg = { mes: 'Hello' };
    assert.equal(getDisplayText(msg), 'Hello');
  });

  it('falls back to mes when display_text is empty string', () => {
    const msg = { mes: 'Hello', extra: { display_text: '' } };
    assert.equal(getDisplayText(msg), 'Hello');
  });

  it('falls back to mes when display_text is whitespace only', () => {
    const msg = { mes: 'Hello', extra: { display_text: '   \n  ' } };
    assert.equal(getDisplayText(msg), 'Hello');
  });

  it('falls back to mes when display_text is non-string', () => {
    const msg = { mes: 'Hello', extra: { display_text: 42 } };
    assert.equal(getDisplayText(msg), 'Hello');
    const msg2 = { mes: 'Hello', extra: { display_text: null } };
    assert.equal(getDisplayText(msg2), 'Hello');
  });

  it('returns empty string for null/undefined msg', () => {
    assert.equal(getDisplayText(null), '');
    assert.equal(getDisplayText(undefined), '');
  });

  it('returns empty string when both mes and display_text are missing', () => {
    assert.equal(getDisplayText({}), '');
  });

  it('preserves whitespace and formatting (no trim on output)', () => {
    const msg = { mes: 'a', extra: { display_text: '  Hallo Welt  \n' } };
    assert.equal(getDisplayText(msg), '  Hallo Welt  \n');
  });

  it('display_text wins even when shorter than mes', () => {
    const msg = { mes: 'Long original english text', extra: { display_text: 'Kurz' } };
    assert.equal(getDisplayText(msg), 'Kurz');
  });
});
