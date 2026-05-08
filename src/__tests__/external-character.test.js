/**
 * external-character.test.js — Unit tests fuer src/external_character.js
 *
 * Testet die pure builders (validate / build* helpers), die ohne ST-Globals
 * und ohne Module-Mocks auskommen — Node-18-kompatibel.
 *
 * Run from repo root:
 *   node --test src/__tests__/external-character.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stubs fuer parent script.js / slash-commands.js / chatroom-client.js
// werden vom externen_character-Modul geladen — wir registrieren sie via
// loader-tricks NICHT, sondern testen ausschliesslich die pure helpers.
// Daher umgehen wir den default Top-Level-Import. Stattdessen importieren
// wir die getesteten Funktionen via dynamic import + import map shim
// nicht — sondern wir lesen das File direkt und testen die builder-Funktionen
// ueber einen lokalen Re-Export-Trick:
//
// Da das module einen Top-Level `import` aus '../../../../../script.js'
// hat, das es in einer reinen Test-Umgebung nicht gibt, koennen wir nicht
// einfach importieren. Loesung: wir kopieren die builder-Funktionen
// inline in den Test (Black-Box-Test der Public-API-Shape, parallel
// gepflegt zum Modul). Das ist konsistent mit streaming-pipeline.test.js.

// ---------------------------------------------------------------------------
// Inline-Spiegel der pure builders aus external_character.js
// (muessen mit dem Modul synchron bleiben — bei Aenderung beide Stellen
// anpassen)
// ---------------------------------------------------------------------------

const EXTERNAL_STREAM_PREFIX = 'ext-';

function newExternalStreamId() {
  return `${EXTERNAL_STREAM_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildListStCharactersResponse(ctx, requestId) {
  const characters = (ctx.characters || []).map((c, idx) => ({
    id: String(c.avatar ?? idx),
    name: c.name ?? '',
    avatar: c.avatar ?? null,
    description: c.description ?? '',
    scenario: c.scenario ?? '',
    personality: c.personality ?? '',
    first_mes: c.first_mes ?? '',
  }));
  return {
    type: 'list_st_characters_response',
    request_id: requestId ?? null,
    characters,
  };
}

function validateSetupExternalCharacter(ctx, charName) {
  const trimmed = (charName ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'missing_char_name' };
  if (!ctx.groupId) return { ok: false, reason: 'not_in_group_chat' };
  const group = (ctx.groups || []).find((g) => g.id === ctx.groupId);
  if (!group) return { ok: false, reason: 'group_not_found' };
  const character = (ctx.characters || []).find(
    (c) => (c.name ?? '').trim() === trimmed,
  );
  if (!character) return { ok: false, reason: 'character_not_found' };
  const isMember = (group.members || []).some(
    (m) => m === character.avatar || m === character.name,
  );
  return {
    ok: true,
    character,
    group,
    isMember,
    avatarUrl: character.avatar ? `/characters/${character.avatar}` : null,
  };
}

function buildSetupOk(charName, groupId, character, requestId) {
  return {
    type: 'setup_external_character_ok',
    request_id: requestId ?? null,
    char_name: charName,
    group_id: groupId,
    character: {
      avatar: character.avatar ?? null,
      avatar_url: character.avatar ? `/characters/${character.avatar}` : null,
      description: character.description ?? '',
      scenario: character.scenario ?? '',
      personality: character.personality ?? '',
      first_mes: character.first_mes ?? '',
    },
  };
}

function buildSetupError(reason, requestId) {
  return {
    type: 'setup_external_character_error',
    request_id: requestId ?? null,
    reason,
  };
}

function buildExternalChatMessage(charName, text, streamId, avatarUrl) {
  return {
    name: charName,
    is_user: false,
    is_system: false,
    send_date: new Date().toISOString(),
    mes: text,
    force_avatar: avatarUrl,
    original_avatar: avatarUrl,
    extra: {
      external_origin: true,
      external_stream_id: streamId,
      gen_id: streamId,
    },
  };
}

function buildSynthStreamEnd(charName, text, streamId) {
  return {
    type: 'stream_end',
    stream_id: streamId,
    final_text: text,
    char_name: charName,
    external_origin: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildListStCharactersResponse', () => {
  it('shapes characters and passes request_id through', () => {
    const ctx = {
      characters: [
        {
          name: 'Alice',
          avatar: 'alice.png',
          description: 'Brave knight',
          scenario: 'Castle',
          personality: 'Honourable',
          first_mes: 'Hi!',
        },
        { name: 'Bob', avatar: 'bob.png' },
      ],
    };

    const reply = buildListStCharactersResponse(ctx, 'req-1');

    assert.equal(reply.type, 'list_st_characters_response');
    assert.equal(reply.request_id, 'req-1');
    assert.equal(reply.characters.length, 2);
    assert.equal(reply.characters[0].name, 'Alice');
    assert.equal(reply.characters[0].id, 'alice.png');
    assert.equal(reply.characters[0].description, 'Brave knight');
    assert.equal(reply.characters[1].description, '');
    assert.equal(reply.characters[1].first_mes, '');
  });

  it('handles empty characters list', () => {
    const reply = buildListStCharactersResponse({ characters: [] }, null);
    assert.equal(reply.characters.length, 0);
    assert.equal(reply.request_id, null);
  });

  it('falls back to index when avatar missing', () => {
    const reply = buildListStCharactersResponse(
      { characters: [{ name: 'NoAvatar' }] },
      null,
    );
    assert.equal(reply.characters[0].id, '0');
    assert.equal(reply.characters[0].avatar, null);
  });
});

describe('validateSetupExternalCharacter', () => {
  it('rejects missing char_name', () => {
    const v = validateSetupExternalCharacter({ groupId: 'g1' }, '');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing_char_name');
  });

  it('rejects when not in group chat', () => {
    const v = validateSetupExternalCharacter({ groupId: null }, 'Alice');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not_in_group_chat');
  });

  it('rejects when group not in groups list', () => {
    const v = validateSetupExternalCharacter(
      { groupId: 'gx', groups: [{ id: 'g1' }] },
      'Alice',
    );
    assert.equal(v.reason, 'group_not_found');
  });

  it('rejects when character not found', () => {
    const v = validateSetupExternalCharacter(
      { groupId: 'g1', groups: [{ id: 'g1', members: [] }], characters: [{ name: 'Bob' }] },
      'Alice',
    );
    assert.equal(v.reason, 'character_not_found');
  });

  it('returns isMember=false when char not yet in group', () => {
    const v = validateSetupExternalCharacter(
      {
        groupId: 'g1',
        groups: [{ id: 'g1', members: [] }],
        characters: [{ name: 'Alice', avatar: 'alice.png' }],
      },
      'Alice',
    );
    assert.equal(v.ok, true);
    assert.equal(v.isMember, false);
    assert.equal(v.avatarUrl, '/characters/alice.png');
  });

  it('returns isMember=true when avatar already in group.members', () => {
    const v = validateSetupExternalCharacter(
      {
        groupId: 'g1',
        groups: [{ id: 'g1', members: ['alice.png'] }],
        characters: [{ name: 'Alice', avatar: 'alice.png' }],
      },
      'Alice',
    );
    assert.equal(v.isMember, true);
  });

  it('treats whitespace-only char_name as missing', () => {
    const v = validateSetupExternalCharacter({ groupId: 'g1' }, '   ');
    assert.equal(v.reason, 'missing_char_name');
  });
});

describe('buildSetupOk', () => {
  it('builds full ok packet with avatar_url', () => {
    const ok = buildSetupOk(
      'Alice',
      'g1',
      { avatar: 'alice.png', description: 'd', scenario: 's', personality: 'p', first_mes: 'f' },
      'req-1',
    );
    assert.equal(ok.type, 'setup_external_character_ok');
    assert.equal(ok.request_id, 'req-1');
    assert.equal(ok.char_name, 'Alice');
    assert.equal(ok.group_id, 'g1');
    assert.equal(ok.character.avatar_url, '/characters/alice.png');
    assert.equal(ok.character.description, 'd');
  });

  it('handles char without avatar', () => {
    const ok = buildSetupOk('NoAv', 'g1', {}, null);
    assert.equal(ok.character.avatar, null);
    assert.equal(ok.character.avatar_url, null);
    assert.equal(ok.character.description, '');
  });
});

describe('buildSetupError', () => {
  it('preserves request_id and reason', () => {
    const err = buildSetupError('not_in_group_chat', 'r1');
    assert.equal(err.type, 'setup_external_character_error');
    assert.equal(err.reason, 'not_in_group_chat');
    assert.equal(err.request_id, 'r1');
  });
});

describe('buildExternalChatMessage', () => {
  it('builds non-user, non-system message with external_origin marker', () => {
    const m = buildExternalChatMessage('Alice', 'Hello', 'ext-1', '/characters/alice.png');
    assert.equal(m.name, 'Alice');
    assert.equal(m.is_user, false);
    assert.equal(m.is_system, false);
    assert.equal(m.mes, 'Hello');
    assert.equal(m.force_avatar, '/characters/alice.png');
    assert.equal(m.original_avatar, '/characters/alice.png');
    assert.equal(m.extra.external_origin, true);
    assert.equal(m.extra.external_stream_id, 'ext-1');
    assert.equal(m.extra.gen_id, 'ext-1');
    assert.match(m.send_date, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('handles null avatar gracefully', () => {
    const m = buildExternalChatMessage('Bob', 'Hi', 'ext-2', null);
    assert.equal(m.force_avatar, null);
    assert.equal(m.original_avatar, null);
  });
});

describe('buildSynthStreamEnd', () => {
  it('builds stream_end with external_origin flag', () => {
    const e = buildSynthStreamEnd('Alice', 'final text', 'ext-1');
    assert.equal(e.type, 'stream_end');
    assert.equal(e.stream_id, 'ext-1');
    assert.equal(e.final_text, 'final text');
    assert.equal(e.char_name, 'Alice');
    assert.equal(e.external_origin, true);
  });
});

describe('newExternalStreamId', () => {
  it('produces ext-prefixed unique id', () => {
    const a = newExternalStreamId();
    const b = newExternalStreamId();
    assert.match(a, /^ext-\d+-[a-z0-9]+$/);
    assert.notEqual(a, b);
  });
});
