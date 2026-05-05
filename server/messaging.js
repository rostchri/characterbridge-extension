/**
 * messaging.js - SillyTavern Discord Connector: Message and Image Delivery
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Handles posting content to Discord channels:
 *   - sendLong splits text that exceeds Discord's 2000-character limit,
 *     preferring paragraph then word boundaries.
 *   - sendImagesToChannel accepts a mixed array of image descriptors produced
 *     by the browser extension and uploads them as Discord attachments.
 *
 * Image descriptors come in two forms:
 *   { type: "inline", data, mimeType, filename }  - base64 data already fetched
 *     by the extension inside the browser (local ST resources, avatars, etc.).
 *     Decoded here and uploaded without any outbound HTTP request.
 *   { type: "url", url }  - a publicly reachable external URL fetched directly
 *     by this server.
 *
 * Images are sent in batches of up to 10 (Discord's per-message limit).
 * Oversized images are scaled down by processImageForDiscord before upload.
 */

"use strict";

const https = require("https");
const http = require("http");
const dns = require("dns");
const net = require("net");
const path = require("path");
const { AttachmentBuilder } = require("discord.js");
const { Jimp } = require("jimp");
const { log } = require("./logger");

// ---------------------------------------------------------------------------
// Discord platform limits (#1934)
// ---------------------------------------------------------------------------

/** Maximum characters per Discord message (API hard limit). */
const DISCORD_MESSAGE_MAX_CHARS = 2000;

/** Split threshold for sendLong: leave 100 chars of margin below the API limit. */
const DISCORD_SPLIT_THRESHOLD = 1900;

/** Discord's advertised file upload limit per message (8 MB). */
const DISCORD_UPLOAD_LIMIT_BYTES = 8 * 1024 * 1024;

/** Conservative upload target (7.8 MB) to stay safely below the hard limit. */
const DISCORD_UPLOAD_TARGET_BYTES = 7.8 * 1024 * 1024;

/** Maximum image width when resizing an oversized attachment (pixels). */
const DISCORD_IMAGE_MAX_WIDTH = 2048;

/** Maximum number of file attachments per Discord message. */
const DISCORD_ATTACHMENTS_PER_MESSAGE = 10;

// ---------------------------------------------------------------------------
// SSRF protection (#1939)
// ---------------------------------------------------------------------------

/**
 * Returns true if the given IP address belongs to a private, loopback,
 * link-local, or other non-routable range that must not be reachable via
 * an externally triggered fetch.
 *
 * Covers:
 *   - IPv4 loopback:       127.0.0.0/8
 *   - IPv4 private:        10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - IPv4 link-local:     169.254.0.0/16
 *   - IPv4 CGNAT:          100.64.0.0/10
 *   - IPv4 broadcast:      255.255.255.255
 *   - IPv6 loopback:       ::1
 *   - IPv6 link-local:     fe80::/10
 *   - IPv6 unique-local:   fc00::/7
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (!ip) return true; // treat unresolvable as blocked

  // IPv6 loopback
  if (ip === "::1") return true;

  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7)
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;  // link-local fe80–febf
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;  // unique-local fc00–fdff

  if (!net.isIPv4(ip)) return false; // non-matching IPv6 — allow

  const parts = ip.split(".").map(Number);
  const [a, b] = parts;

  if (a === 127) return true;                           // loopback
  if (a === 10) return true;                            // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;              // 192.168.0.0/16
  if (a === 169 && b === 254) return true;              // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64.0.0/10
  if (a === 255 && ip === "255.255.255.255") return true;

  return false;
}

/**
 * Resolves the hostname in `url` via DNS and rejects with an error if the
 * resolved IP falls within a private/non-routable range (SSRF guard).
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
function assertNotPrivateHost(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`SSRF guard: invalid URL "${url}"`));
      return;
    }

    const hostname = parsed.hostname;

    // Reject bare IP addresses that are private without a DNS lookup.
    if (net.isIP(hostname)) {
      if (isPrivateIp(hostname)) {
        reject(new Error(`SSRF guard: direct IP "${hostname}" is a private address`));
      } else {
        resolve();
      }
      return;
    }

    dns.lookup(hostname, { family: 4 }, (err, address) => {
      if (err) {
        // DNS failure — refuse rather than allow (fail-closed).
        reject(new Error(`SSRF guard: DNS lookup failed for "${hostname}": ${err.message}`));
        return;
      }
      if (isPrivateIp(address)) {
        reject(new Error(`SSRF guard: "${hostname}" resolves to private IP "${address}"`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Splits text exceeding Discord's 2000-char limit across multiple messages,
 * preferring paragraph then word boundaries.
 *
 * @param {import("discord.js").TextChannel} channel
 * @param {string} text
 */
async function sendLong(channel, text) {
  const MAX = DISCORD_SPLIT_THRESHOLD;
  let remaining = text;
  let lastMessage = null;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      lastMessage = await channel.send(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX);
    if (splitAt <= 0) splitAt = MAX;
    await channel.send(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  return lastMessage;
}

/**
 * Scales down images that exceed Discord's 8 MB upload limit.
 * Resizes to max 2048 px wide and re-encodes as JPEG at 80% quality.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>}
 */
async function processImageForDiscord(buffer) {
  if (buffer.length <= DISCORD_UPLOAD_TARGET_BYTES) return buffer;

  log(
    "log",
    `[Images] Optimising oversized image (${(buffer.length / 1024 / 1024).toFixed(2)} MB)...`,
  );

  try {
    const image = await Jimp.read(buffer);
    if (image.bitmap.width > DISCORD_IMAGE_MAX_WIDTH) image.resize({ w: DISCORD_IMAGE_MAX_WIDTH });
    const optimized = await image.getBuffer("image/jpeg", { quality: 80 });
    log(
      "log",
      `[Images] Optimised to ${(optimized.length / 1024).toFixed(0)} KB`,
    );
    return optimized;
  } catch (err) {
    log("error", "[Images] Failed to optimise image:", err);
    return buffer;
  }
}

/**
 * Fetches a remote image URL into a Buffer. Follows up to 5 redirects.
 * Times out after 15 seconds. Performs SSRF protection by resolving the
 * hostname and rejecting private/non-routable IPs (#1939).
 *
 * @param {string} url
 * @param {number} [redirectsLeft=5]
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function fetchImageBuffer(url, redirectsLeft = 5) {
  await assertNotPrivateHost(url);
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    lib
      .get(url, { timeout: 15000 }, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          resolve(fetchImageBuffer(next, redirectsLeft - 1));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const contentType = res.headers["content-type"] || "image/png";
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ buffer: Buffer.concat(chunks), contentType }),
        );
        res.on("error", reject);
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error(`Timeout fetching ${url}`)));
  });
}

/**
 * Derives a safe filename from a URL. Falls back to "image.png".
 *
 * @param {string} url
 * @param {string} [contentType]
 * @returns {string}
 */
function imageFilename(url, contentType) {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    if (base && /\.[a-z]{2,5}$/i.test(base)) return base;
  } catch {
    /* ignore */
  }
  const ext = (contentType || "").includes("jpeg")
    ? "jpg"
    : (contentType || "").includes("gif")
      ? "gif"
      : (contentType || "").includes("webp")
        ? "webp"
        : "png";
  return `image.${ext}`;
}

/**
 * Posts images to a Discord channel. Accepts the mixed descriptor array
 * produced by the extension. Failures on individual images are logged and
 * skipped rather than aborting the batch.
 *
 * @param {import("discord.js").TextChannel} channel
 * @param {Array} images
 * @param {string|null} [caption]
 */
async function sendImagesToChannel(channel, images, caption) {
  if (!images?.length) return;

  const attachments = (
    await Promise.all(
      images.map(async (img) => {
        try {
          let buffer, filename;
          if (img.type === "inline") {
            buffer = Buffer.from(img.data, "base64");
            filename = img.filename || "image.png";
          } else if (img.type === "url") {
            const { buffer: fetched, contentType } = await fetchImageBuffer(
              img.url,
            );
            buffer = fetched;
            filename = imageFilename(img.url, contentType);
          } else {
            log("warn", `[Images] Unknown descriptor type: ${img.type}`);
            return null;
          }

          const safeBuffer = await processImageForDiscord(buffer);
          const finalFilename =
            safeBuffer.length !== buffer.length
              ? filename.replace(/\.[^/.]+$/, "") + ".jpg"
              : filename;

          return new AttachmentBuilder(safeBuffer, { name: finalFilename });
        } catch (err) {
          const label = img.type === "url" ? img.url : img.filename || "inline";
          log("warn", `[Images] Failed to process "${label}": ${err.message}`);
          return null;
        }
      }),
    )
  ).filter(Boolean);

  if (attachments.length === 0) {
    log("warn", "[Images] All images failed to process; nothing sent.");
    return;
  }

  const BATCH = DISCORD_ATTACHMENTS_PER_MESSAGE;
  for (let i = 0; i < attachments.length; i += BATCH) {
    const batch = attachments.slice(i, i + BATCH);
    const payload = { files: batch };
    if (i === 0 && caption) payload.content = caption;
    await channel.send(payload);
  }
}

module.exports = { sendLong, sendImagesToChannel };
