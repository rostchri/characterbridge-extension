/**
 * websocket.js - SillyTavern Connector: WebSocket Server
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Hosts the SillyTavern extension WebSocket endpoint and fans outbound packets
 * to any enabled frontend plugins using frontend-manager.js.
 */

'use strict';

const WebSocket = require('ws');
const { log } = require('./logger');
const { config, wssPort } = require('./config-loader');
const { streamSessions } = require('./streaming');
const { createPluginLoader } = require('./plugin-loader');
const {
  fanout,
  addRoute,
  clearRoutes,
  resolveConversationId,
  getRoutes,
  getFrontend,
  parseRoute,
  getRegisteredPlatforms,
} = require('./frontend-manager');
const {
  setBridgeActivity,
  getPendingAutocompletes,
  getAutocompleteDebouncers,
} = require('./discord');
const { handleBridgePacket } = require('./websocket-router');
const { loadLocale, makeTranslator } = require('./i18n');
const {
  load: loadPersonaMap,
  getPersonaForUser,
  setPersonaForUser,
  setDefaultPersonaName,
  getDefaultPersonaName,
  setCrossRelayEnabled,
  isCrossRelayEnabled,
} = require('./persona-map');
const {
  load: loadLangMap,
  getLangForUser,
  setLangForUser,
} = require('./lang-map');
const { AVAILABLE_LANGUAGES, findLanguage } = require('./locales-manifest');

const version = require('./package.json').version;
const width = 70;

const canColor = process.stdout.isTTY && process.env.TERM !== 'dumb';

const purple = canColor ? '[38;5;93m' : '';
const gold = canColor ? '[38;5;220m' : '';
const reset = canColor ? '[0m' : '';

const title = ` SILLYTAVERN DISCORD CONNECTOR - v${version}`;
const credit = ` Developed by Senjin the Dragon https://github.com/senjinthedragon`;
const support = ` Please support my work: https://github.com/sponsors/senjinthedragon`;
const btc = ` Bitcoin: bc1qjsaqw6rjcmhv6ywv2a97wfd4zxnae3ncrn8mf9`;

console.log(`
${purple}╔${'═'.repeat(width)}╗
║${gold}${title.padEnd(width)}${purple}║
║${gold}${credit.padEnd(width)}${purple}║
║${gold}${support.padEnd(width)}${purple}║
║${gold}${btc.padEnd(width)}${purple}║
╚${'═'.repeat(width)}╝${reset}
`);

loadPersonaMap();
loadLangMap();
loadLocale(config.userLocale || null);

let sillyTavernClient = null;
const pendingImageMessages = {};
const cancelledImageRequests = new Set();
const timedOutImageRequests = new Set();
const streamHandled = new Set();
const streamReceived = new Set();

function getSillyTavernClient() {
  return sillyTavernClient;
}

function sendToSillyTavern(payload) {
  if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN)
    return;
  sillyTavernClient.send(JSON.stringify(payload));
}

function dispatchCommand(platform, chatId, command, args, userId) {
  const conversationId = resolveConversationId(platform, chatId);
  addRoute(conversationId, platform, chatId);
  const userLocale = getLangForUser(platform, userId) || null;

  if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
    handleOfflineCommand(
      platform,
      chatId,
      conversationId,
      command,
      args,
      userId,
      userLocale,
    );
    return;
  }

  sendToSillyTavern({
    type: 'execute_command',
    command,
    args,
    chatId: conversationId,
    userId,
    platform,
    ...(userLocale ? { userLocale } : {}),
  });
}

async function handleOfflineCommand(
  platform,
  chatId,
  conversationId,
  command,
  args,
  userId,
  userLocale,
) {
  const tl = makeTranslator(userLocale);

  if (command === 'sthelp') {
    const sections = [
      tl('help.title'),
      tl('help.offlineNote'),
      tl('help.offlineInfo'),
      tl('help.lang'),
      tl('help.footer'),
    ];
    await fanout(conversationId, 'sendText', sections.join('\n\n'));
    return;
  }

  if (command === 'status') {
    const registeredPlatforms = getRegisteredPlatforms();
    const platformList =
      registeredPlatforms.size > 0
        ? [...registeredPlatforms].join(', ')
        : 'none';
    const lines = [
      tl('status.title'),
      tl('status.connection', { value: tl('status.offline') }),
      tl('status.plugins', { value: platformList }),
      tl('status.stOffline'),
    ];
    await fanout(conversationId, 'sendText', lines.join('\n'));
    return;
  }

  if (command === 'setlang') {
    const input = (args?.[0] || '').trim();
    if (!input || input === 'clear') {
      setLangForUser(platform, userId, null);
      await fanout(conversationId, 'sendText', tl('setlang.reset'));
      return;
    }
    const match = findLanguage(input);
    if (match) {
      setLangForUser(platform, userId, match.code);
      const tAfter = makeTranslator(match.code);
      await fanout(
        conversationId,
        'sendText',
        tAfter('setlang.success', { name: match.nativeName, code: match.code }),
      );
    } else {
      await fanout(
        conversationId,
        'sendText',
        tl('setlang.unknown', { input }),
      );
    }
    return;
  }

  await fanout(conversationId, 'sendText', tl('cmd.stOffline'));
}

const pluginLoader = createPluginLoader({
  onUserMessage(platform, chatId, text, userId = '') {
    const conversationId = resolveConversationId(platform, chatId);
    addRoute(conversationId, platform, chatId);
    const mappedPersona = getPersonaForUser(platform, userId);
    const userLocale = getLangForUser(platform, userId) || null;
    sendToSillyTavern({
      type: 'user_message',
      text,
      chatId: conversationId,
      userId,
      platform,
      ...(mappedPersona ? { mappedPersona } : {}),
      ...(userLocale ? { userLocale } : {}),
    });

    // Cross-relay the user's message to all other platforms in the same
    // conversation so every connected client stays in sync.
    if (!isCrossRelayEnabled()) return;
    const originKey = `${platform}:${chatId}`;
    const senderLabel =
      mappedPersona || getDefaultPersonaName() || `[${platform}]`;
    const relayText = `${senderLabel}: ${text}`;
    for (const route of getRoutes(conversationId)) {
      if (route === originKey) continue;
      const { platform: targetPlatform, nativeChatId: targetChatId } =
        parseRoute(route);
      const frontend = getFrontend(targetPlatform);
      if (!frontend?.sendText) continue;
      frontend.sendText(targetChatId, relayText).catch((err) => {
        log('warn', `[Bridge] Cross-relay to ${route} failed: ${err.message}`);
      });
    }
  },
  onCommand(platform, chatId, command, args, userId = '') {
    dispatchCommand(platform, chatId, command, args, userId);
  },
});

pluginLoader.start().catch((err) => {
  log('error', `[Plugins] Failed to start plugin: ${err.message}`);
});

// ---------------------------------------------------------------------------
// Optional shared-secret for first-frame authentication.
// Set WS_SECRET in the environment (or config.wssSecret) to require every new
// connection to send { type: "auth", secret: "<value>" } as its very first
// message.  When WS_SECRET is empty/absent the bridge accepts all local
// connections (127.0.0.1 bind already restricts network exposure).
// ---------------------------------------------------------------------------
const WS_SECRET = process.env.WS_SECRET || config.wssSecret || '';

const wss = new WebSocket.Server({
  host: '127.0.0.1',
  port: wssPort,
  maxPayload: 50 * 1024 * 1024,
});
log('log', `[Bridge] WebSocket server listening on 127.0.0.1:${wssPort}`);

wss.on('connection', (ws) => {
  // ------------------------------------------------------------------
  // First-frame authentication guard.
  //
  // When WS_SECRET is configured, the very first message must be a JSON
  // object of the form { type: "auth", secret: "<WS_SECRET>" }.  Any
  // other first message or a missing/wrong secret closes the socket
  // immediately with code 4401 (Unauthorized).  Subsequent messages are
  // handled normally after a successful auth handshake.
  // ------------------------------------------------------------------
  if (WS_SECRET) {
    let authenticated = false;

    const authHandler = (raw) => {
      let frame;
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch (_) {
        ws.close(4401, 'Unauthorized: invalid JSON in auth frame');
        return;
      }

      if (frame?.type !== 'auth' || frame?.secret !== WS_SECRET) {
        log('warn', '[Bridge] WS connection rejected: wrong or missing auth secret');
        ws.close(4401, 'Unauthorized');
        return;
      }

      authenticated = true;
      ws.removeListener('message', authHandler);
      log('log', '[Bridge] WS connection authenticated');
      // Proceed with normal connection setup.
      acceptConnection(ws);
    };

    ws.on('message', authHandler);

    // Reject if no auth frame arrives within 5 seconds.
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        log('warn', '[Bridge] WS connection timed out waiting for auth frame');
        ws.close(4401, 'Unauthorized: auth timeout');
      }
    }, 5_000);

    ws.on('close', () => clearTimeout(authTimeout));
    return;
  }

  // No secret configured — accept immediately.
  acceptConnection(ws);
});

/**
 * Completes a WebSocket connection after authentication (or when no auth is
 * required).  Registers all message / close handlers and sends bridge_config.
 *
 * @param {import('ws').WebSocket} ws
 */
function acceptConnection(ws) {
  if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
    log(
      'warn',
      '[Bridge] New SillyTavern connection received while one is already active - closing previous.',
    );
    sillyTavernClient.close(1008, 'Replaced by new connection');
  }
  sillyTavernClient = ws;
  log('log', '[Bridge] SillyTavern connected');

  // Build plugin status map for all known platforms. Only platforms that
  // successfully registered via registerFrontend() are marked "active".
  // Others show as "not_loaded" so the extension can tease pro platforms
  // to free version users.
  const KNOWN_PLATFORMS = ['discord', 'telegram', 'signal'];
  const registeredPlatforms = getRegisteredPlatforms();
  const pluginStatus = Object.fromEntries(
    KNOWN_PLATFORMS.map((p) => [
      p,
      registeredPlatforms.has(p) ? 'active' : 'not_loaded',
    ]),
  );

  ws.send(
    JSON.stringify({
      type: 'bridge_config',
      timezone: config.timezone || null,
      locale: config.locale || null,
      userLocale: config.userLocale || null,
      availableLanguages: AVAILABLE_LANGUAGES,
      plugins: pluginStatus,
      imagePlaceholderTimeoutMs: config.imagePlaceholderTimeoutMs,
    }),
  );

  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(
        typeof message === 'string' ? message : message.toString('utf8'),
      );
    } catch (err) {
      log('warn', `[Bridge] Dropping invalid JSON packet: ${err.message}`);
      return;
    }

    await handleBridgePacket(data, {
      ws,
      fanout,
      getRoutes,
      getFrontend,
      parseRoute,
      streamHandled,
      streamReceived,
      pendingImageMessages,
      cancelledImageRequests,
      timedOutImageRequests,
      setBridgeActivity,
      getPendingAutocompletes,
      setPersonaForUser,
      setLangForUser,
      setCurrentPersonaName: setDefaultPersonaName,
      setCrossRelayEnabled,
      log,
    });
  });

  ws.on('close', () => {
    sillyTavernClient = null;
    setDefaultPersonaName(null);
    setCrossRelayEnabled(true);
    clearRoutes();
    setBridgeActivity(null);

    for (const key of Object.keys(streamSessions)) {
      delete streamSessions[key];
    }
    streamHandled.clear();
    streamReceived.clear();

    for (const key of Object.keys(pendingImageMessages)) {
      delete pendingImageMessages[key];
    }
    cancelledImageRequests.clear();
    timedOutImageRequests.clear();

    const autocompleteDebouncers = getAutocompleteDebouncers();
    for (const [key, debouncer] of Object.entries(autocompleteDebouncers)) {
      clearTimeout(debouncer.timer);
      delete autocompleteDebouncers[key];
      debouncer.interaction.respond([]).catch(() => {});
    }

    const pendingAutocompletes = getPendingAutocompletes();
    for (const [requestId, pending] of Object.entries(pendingAutocompletes)) {
      clearTimeout(pending.timeout);
      delete pendingAutocompletes[requestId];
      pending.interaction.respond([]).catch(() => {});
    }
  });
}

/**
 * Closes the WebSocket server and invokes `callback` when all connections
 * have been terminated.  Used by the graceful-shutdown handler in server.js.
 *
 * @param {() => void} [callback]
 */
function closeServer(callback) {
  wss.close(callback);
}

module.exports = { getSillyTavernClient, dispatchCommand, closeServer };
