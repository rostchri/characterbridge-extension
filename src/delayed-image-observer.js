/**
 * CharacterBridge Extension - Delayed Image Observer
 *
 * SillyTavern image-auto-generation extensions insert <img> elements into the
 * last AI .mes_text AFTER generation ends (DOM mutation). This module watches
 * that container via MutationObserver and forwards newly inserted images to the
 * bridge so they are not lost.
 *
 * Lifecycle per AI reply:
 *   startDelayedImageObserver(mesTextEl, chatId, charName)
 *     → observes childList + subtree + attribute changes on src
 *     → on mutation: diff against already-sent srcs, send only new ones
 *     → auto-disconnects after OBSERVER_TIMEOUT_MS (60 s)
 *     → disconnects immediately when stopDelayedImageObserver() is called
 *       (triggered by next user turn via MESSAGE_SENT)
 *
 * Only one observer per AI-message-index is allowed. Starting a new one
 * disconnects the previous one.
 */

import { collectImages, sendCollectedImages } from './image-relay.js';

// ---------------------------------------------------------------------------
// Module-scoped state (no globals — one active observer at a time)
// ---------------------------------------------------------------------------

/** @type {{ observer: MutationObserver, timer: ReturnType<typeof setTimeout> }|null} */
let _active = null;

// Image-Generation kann je nach Provider und Modell mehrere Minuten
// dauern (custom-civitai mit hoher CFG, lokale SD ohne GPU-Boost, etc.).
// Defensiver Sicherheits-Cap statt enger Timeout — der Observer wird
// ohnehin beim naechsten User-Turn (MESSAGE_SENT) sauber disconnected.
const OBSERVER_TIMEOUT_MS = 600_000; // 10min

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts a MutationObserver on `mesTextEl` to catch images inserted after
 * stream_end (e.g. by auto-generation extensions).
 *
 * Any previously active observer is disconnected first (replaces on new reply).
 * The observer stops after 60 seconds or when {@link stopDelayedImageObserver}
 * is called.
 *
 * @param {Element} mesTextEl - The .mes_text element of the finished AI message.
 * @param {string}  chatId    - Forwarded to sendCollectedImages.
 * @param {string|null} charName - Character name for the send_images packet.
 * @param {Set<string>} [alreadySent] - Srcs already sent at stream_end (dedup).
 */
export function startDelayedImageObserver(mesTextEl, chatId, charName, alreadySent = new Set()) {
  if (!mesTextEl) {
    console.debug('[CharacterBridge:img-observer] start skipped — no element');
    return;
  }

  // Disconnect any existing observer before starting a fresh one.
  stopDelayedImageObserver();

  const sentSrcs = new Set(alreadySent);

  console.debug('[CharacterBridge:img-observer] start', {
    targetTag: mesTextEl.tagName,
    targetClass: mesTextEl.getAttribute?.('class'),
    chatId,
    charName,
    alreadySentCount: sentSrcs.size,
  });

  const observer = new MutationObserver((mutations) => {
    console.debug('[CharacterBridge:img-observer] mutations', {
      count: mutations.length,
      types: mutations.map((m) => m.type),
      addedNodeTags: mutations.flatMap((m) =>
        Array.from(m.addedNodes ?? []).map(
          (n) => `${n.tagName}.${n.getAttribute?.('class') ?? ''}`,
        ),
      ),
    });
    const newSrcs = _collectNewSrcs(mutations, sentSrcs);
    if (!newSrcs.length) {
      console.debug('[CharacterBridge:img-observer] no new srcs in mutation');
      return;
    }

    console.debug('[CharacterBridge:img-observer] sending new srcs', newSrcs);
    newSrcs.forEach((src) => sentSrcs.add(src));

    // Fire-and-forget — failures are logged inside sendCollectedImages / image-relay.
    _sendNewImages(chatId, charName, newSrcs);
  });

  observer.observe(mesTextEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  const timer = setTimeout(() => {
    _disconnect();
  }, OBSERVER_TIMEOUT_MS);

  _active = { observer, timer };
}

/**
 * Disconnects the active observer immediately (e.g. on next user turn).
 * Safe to call even when no observer is active.
 */
export function stopDelayedImageObserver() {
  if (_active) {
    _disconnect();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Disconnects and clears the active observer + timer.
 */
function _disconnect() {
  if (!_active) return;
  const { observer, timer } = _active;
  _active = null;
  clearTimeout(timer);
  observer.disconnect();
}

/**
 * Scans a MutationRecord list for new <img> src values not yet in sentSrcs.
 *
 * Covers two cases:
 *   1. childList: new nodes were added — walk all imgs in addedNodes subtrees.
 *   2. attributes on img: src attribute changed on an already-present img.
 *
 * @param {MutationRecord[]} mutations
 * @param {Set<string>} sentSrcs - Already-sent srcs (read-only here).
 * @returns {string[]}
 */
function _collectNewSrcs(mutations, sentSrcs) {
  const candidates = new Set();

  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // The node itself might be an img.
        if (node.tagName === 'IMG') {
          const src = node.getAttribute('src');
          if (src) candidates.add(src);
        }
        // Or it might contain imgs.
        for (const img of node.querySelectorAll('img')) {
          const src = img.getAttribute('src');
          if (src) candidates.add(src);
        }
      }
    } else if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG') {
      const src = mutation.target.getAttribute('src');
      if (src) candidates.add(src);
    }
  }

  return Array.from(candidates).filter((src) => !sentSrcs.has(src));
}

/**
 * Resolves and sends a list of new image srcs to the bridge.
 *
 * @param {string}      chatId
 * @param {string|null} charName
 * @param {string[]}    srcs
 */
async function _sendNewImages(chatId, charName, srcs) {
  try {
    const images = await collectImages(srcs);
    if (images.length > 0) {
      sendCollectedImages(chatId, images, null, charName);
    }
  } catch (err) {
    console.warn('[CharacterBridge] delayed image send failed:', err);
  }
}
