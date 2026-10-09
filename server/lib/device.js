'use strict';
/*
 * A short, human name for the device behind a user agent: "iPhone · Safari", "Windows · Chrome", "Android · Telegram".
 * Good enough to recognise your own phone in Settings → Security, and to notice a login from somewhere new.
 * key: "os|browser" in lower case ("iphone|safari"), the device part of the new-login check (services/security.js).
 */

function os(ua) {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Windows Phone/.test(ua)) return 'Windows Phone';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'Mac';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return '';
}

function browser(ua) {
  // In-app browsers first: they also say "Safari" or "Chrome".
  if (/Telegram/i.test(ua)) return 'Telegram';
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return 'Facebook';
  if (/Instagram/.test(ua)) return 'Instagram';
  if (/WhatsApp/i.test(ua)) return 'WhatsApp';
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera|OPiOS/.test(ua)) return 'Opera';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/YaBrowser/.test(ua)) return 'Yandex';
  if (/UCBrowser/.test(ua)) return 'UC Browser';
  if (/Firefox|FxiOS/.test(ua)) return 'Firefox';
  if (/CriOS|Chrome|Chromium/.test(ua)) return 'Chrome';
  if (/Safari/.test(ua) && /Version\//.test(ua)) return 'Safari';
  if (/Mobile\//.test(ua) && /AppleWebKit/.test(ua)) return 'Safari';
  return '';
}

/** { os, browser, label, key } for a user agent string. Unknown parts read "Unknown device" / "Browser". */
function parse(uaRaw) {
  const ua = String(uaRaw || '').slice(0, 400);
  const o = os(ua), b = browser(ua);
  const label = o && b ? `${o} · ${b}` : o || b || 'Unknown device';
  return { os: o || 'Unknown', browser: b || 'Browser', label, key: `${(o || 'unknown').toLowerCase()}|${(b || 'browser').toLowerCase()}`, mobile: /iPhone|iPad|Android|Mobile/.test(ua) };
}

module.exports = { parse };
