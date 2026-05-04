/**
 * image-relay-viewer-mode.test.js
 *
 * Regression: ST "Use Image Viewer in Replace Mode" rendert generierte
 * Bilder NICHT in .mes_text sondern in einer Geschwister-Container-Div
 * .mes_media_wrapper. extractImageSrcsFromMesText muss beide Pfade walken,
 * damit der Bridge die URLs auch im Image-Viewer-Modus findet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractImageSrcsFromMesText } from '../image-relay.js';

// ---------------------------------------------------------------------------
// Mini-DOM-Stub: nur was extractImageSrcsFromMesText braucht
// ---------------------------------------------------------------------------

function makeImg(src) {
  return {
    tagName: 'IMG',
    getAttribute: (a) => (a === 'src' ? src : null),
  };
}

/**
 * Baut einen .mes_block mit .mes_text und optionalem .mes_media_wrapper.
 * Liefert das mes_text-Element zurueck (so wie der Observer es uebergeben bekommt).
 */
function makeMesBlock({ inlineImgSrcs = [], mediaImgSrcs = null } = {}) {
  const inlineImgs = inlineImgSrcs.map(makeImg);
  const mediaImgs = mediaImgSrcs?.map(makeImg) ?? [];

  const mesText = {
    tagName: 'DIV',
    className: 'mes_text',
    querySelectorAll: (sel) => (sel === 'img' ? inlineImgs : []),
    parentElement: null, // gleich gesetzt
  };

  const mediaWrapper = mediaImgSrcs
    ? {
        tagName: 'DIV',
        className: 'mes_media_wrapper',
        querySelectorAll: (sel) => (sel === 'img' ? mediaImgs : []),
      }
    : null;

  const mesBlock = {
    tagName: 'DIV',
    className: 'mes_block',
    children: mediaWrapper ? [mesText, mediaWrapper] : [mesText],
    querySelector: (sel) => {
      // Nur :scope > .mes_media_wrapper wird tatsaechlich gerufen.
      if (sel === ':scope > .mes_media_wrapper') return mediaWrapper;
      return null;
    },
  };

  mesText.parentElement = mesBlock;
  return mesText;
}

// ---------------------------------------------------------------------------

describe('extractImageSrcsFromMesText — Image-Viewer-Mode', () => {
  it('Inline-only: nur <img> in .mes_text → bisheriges Verhalten', () => {
    const mesText = makeMesBlock({
      inlineImgSrcs: ['/user/images/inline.png'],
    });

    const srcs = extractImageSrcsFromMesText(mesText);
    assert.deepEqual(srcs, ['/user/images/inline.png']);
  });

  it('Image-Viewer-Mode: Bild in .mes_media_wrapper Sibling → wird mitgefunden', () => {
    const mesText = makeMesBlock({
      inlineImgSrcs: [],
      mediaImgSrcs: ['/user/images/Seraphina/viewer-mode.jpg'],
    });

    const srcs = extractImageSrcsFromMesText(mesText);
    assert.deepEqual(srcs, ['/user/images/Seraphina/viewer-mode.jpg']);
  });

  it('Mix: Inline + Wrapper → beide Quellen, Inline zuerst', () => {
    const mesText = makeMesBlock({
      inlineImgSrcs: ['/user/images/inline.png'],
      mediaImgSrcs: ['/user/images/wrapper.jpg'],
    });

    const srcs = extractImageSrcsFromMesText(mesText);
    assert.deepEqual(srcs, [
      '/user/images/inline.png',
      '/user/images/wrapper.jpg',
    ]);
  });

  it('Wrapper mit mehreren Bildern (Use Multiple Image Viewers): alle gefunden', () => {
    const mesText = makeMesBlock({
      inlineImgSrcs: [],
      mediaImgSrcs: ['/a.jpg', '/b.jpg', '/c.jpg'],
    });

    const srcs = extractImageSrcsFromMesText(mesText);
    assert.deepEqual(srcs, ['/a.jpg', '/b.jpg', '/c.jpg']);
  });

  it('Kein parentElement: nur Inline-Imgs (defensive Path)', () => {
    const mesText = {
      tagName: 'DIV',
      querySelectorAll: (sel) => (sel === 'img' ? [makeImg('/x.png')] : []),
      parentElement: null,
    };

    const srcs = extractImageSrcsFromMesText(mesText);
    assert.deepEqual(srcs, ['/x.png']);
  });

  it('Null mesTextEl → leeres Array', () => {
    assert.deepEqual(extractImageSrcsFromMesText(null), []);
  });
});
