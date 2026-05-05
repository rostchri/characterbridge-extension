/**
 * logger.js - SillyTavern Discord Connector: Logging
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Structured JSON logger: emits one JSON object per line to stderr so that
 * log-collectors such as Vector and VictoriaLogs can parse entries without
 * grok/regex heuristics.
 *
 * Line format (ndjson):
 *   {"ts":"<ISO-8601>","level":"<level>","msg":"<text>"}
 *
 * Set debug: true in config.js to enable verbose (level "debug") output.
 * The LOG_LEVEL environment variable overrides config.debug:
 *   LOG_LEVEL=debug  — enable debug output
 *   LOG_LEVEL=warn   — suppress log/info, show warn+error only
 *   LOG_LEVEL=error  — only errors
 */

"use strict";

const { config } = require("./config-loader");

// Numeric severity map — lower is noisier.
const SEVERITY = { debug: 10, log: 20, info: 20, warn: 30, error: 40 };

/** Effective minimum severity level derived from env + config. */
function _minSeverity() {
  const envLevel = (process.env.LOG_LEVEL || "").toLowerCase().trim();
  if (envLevel && SEVERITY[envLevel] !== undefined) {
    return SEVERITY[envLevel];
  }
  return config.debug ? SEVERITY.debug : SEVERITY.warn;
}

/**
 * Emits a structured JSON log line to stderr.
 *
 * @param {"debug"|"log"|"info"|"warn"|"error"} level
 * @param {...any} args  String message parts; objects are JSON-serialised inline.
 */
function log(level, ...args) {
  const effectiveLevel = SEVERITY[level] ?? SEVERITY.log;
  if (effectiveLevel < _minSeverity()) return;

  // Serialise each argument to a string, joining with a space — mirrors the
  // behaviour of console.log so callers need no changes.
  const msg = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level: level === "log" ? "info" : level,
    msg,
  });

  // All log output goes to stderr so it stays separate from any stdout data
  // and is picked up by Vector's file/stdin source without payload mixing.
  process.stderr.write(entry + "\n");
}

module.exports = { log };
