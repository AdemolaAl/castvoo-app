'use strict';
/*
 * Voice notes and round videos (Oct 2026): converting uploads with ffmpeg so Telegram accepts them.
 *   voice       → OGG/Opus, 48 kHz mono, 48 kbit/s (Telegram's sendVoice shows it as a voice message with a waveform)
 *   video_note  → square crop, 384–640 px, H.264 Main + AAC, at most 60 seconds, faststart (sendVideoNote: a round video)
 *
 * ffmpeg comes from FFMPEG_PATH (a path, or a .js script for tests) or `ffmpeg` on the PATH. detect() runs once at
 * start (server/index.js) and again lazily. Without ffmpeg, files that are already right are still accepted (an OGG voice
 * note; a square H.264 MP4 of 60 seconds or less); anything else gets a friendly error and a log line, and Admin →
 * System shows that conversion is not set up. docs/DEPLOY-NOTES-OCT-2026.md has the Railway step.
 */

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const db = require('../db');
const config = require('../config');
const log = require('../lib/log');

const NOT_SET_UP = 'Voice/round video conversion isn\'t set up on this server yet.';
const ROUND = { min: 384, max: 640, seconds: 60 };
/** Voice notes are cut at 60 minutes (about 22 MB as OGG/Opus 48 kbit/s; Telegram takes voice files up to 50 MB from bots). */
const VOICE = { seconds: 3600 };
/** Conversions waiting for one of the 2 slots: more than this answers "busy, try again" instead of piling up uploads. */
const MAX_WAITING = 8;
/*
 * Input hardening (every conversion): ffmpeg guesses the format from the file's content, not its type, so a crafted
 * "MP3" (an ID3 tag followed by an ffconcat or playlist text) could make it open OTHER files or URLs. Only plain files
 * are opened (protocol_whitelist) and only the audio/video containers we accept (format_whitelist); frames larger than
 * 4096 × 4096 are refused (max_pixels) so a tiny file can't ask for gigabytes of memory.
 */
const SAFE_IN = (formats) => ['-protocol_whitelist', 'file', '-format_whitelist', formats, '-max_pixels', String(4096 * 4096)];
const VOICE_FORMATS = 'ogg,mp3,mov,matroska,wav,aac';
const ROUND_FORMATS = 'mov,matroska';

let state = null; // { ok, version, path, checked_at }
let running = 0;
const waiting = [];

/** Run ffmpeg (or the test stand-in: a .js file runs with Node). */
function run(args, { timeout = 120000 } = {}) {
  const bin = config.ffmpegPath || 'ffmpeg';
  const [file, argv] = /\.js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  return new Promise((resolve, reject) => {
    execFile(file, argv, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); return; }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Is ffmpeg there? Cached; detect({ force: true }) checks again. Never throws. */
async function detect({ force = false } = {}) {
  if (state && !force) return state;
  try {
    const r = await run(['-version'], { timeout: 8000 });
    const version = ((r.stdout || r.stderr).split('\n')[0] || 'ffmpeg').trim().slice(0, 120);
    state = { ok: true, version, path: config.ffmpegPath || 'ffmpeg', checked_at: new Date() };
  } catch (e) {
    state = { ok: false, version: null, path: config.ffmpegPath || 'ffmpeg', checked_at: new Date(), error: String(e.code || e.message || e).slice(0, 200) };
  }
  if (!state.ok) log.warn('ffmpeg not found: voice notes and round videos are only accepted when already in the right format', { path: state.path, err: state.error });
  return state;
}
const status = () => state;

/** At most 2 conversions at a time, so a few big uploads can't take the whole server. */
async function slot(fn) {
  if (running >= 2) {
    if (waiting.length >= MAX_WAITING) {
      const { httpError } = require('../lib/util');
      throw httpError(503, 'Many recordings are being converted right now. Please try again in a minute.', 'conversion_busy');
    }
    await new Promise((r) => waiting.push(r));
  }
  running++;
  try { return await fn(); } finally { running--; const next = waiting.shift(); if (next) next(); }
}

/** "Duration: 00:00:12.34" in ffmpeg's output → seconds (or null). */
function durationOf(text) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text || ''));
  return m ? Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
}

const voiceArgs = (input, output) => ['-hide_banner', '-nostats', '-y', ...SAFE_IN(VOICE_FORMATS), '-i', input, '-t', String(VOICE.seconds), '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip', '-f', 'ogg', output];
const roundArgs = (input, output) => {
  // Square crop from the middle, then 384–640 px (even), H.264 Main 3.1 that every phone plays, AAC mono, faststart.
  const side = `trunc(max(${ROUND.min}\\,min(${ROUND.max}\\,min(iw\\,ih)))/2)*2`;
  return ['-hide_banner', '-nostats', '-y', ...SAFE_IN(ROUND_FORMATS), '-i', input, '-t', String(ROUND.seconds), '-sn', '-dn', '-map_metadata', '-1',
    '-vf', `crop='min(iw,ih)':'min(iw,ih)',scale='${side}':'${side}',setsar=1`,
    '-c:v', 'libx264', '-profile:v', 'main', '-level:v', '3.1', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', '-f', 'mp4', output];
};

/*
 * Small MP4 reader (no ffmpeg needed): the video track's width and height (tkhd), the length (mvhd) and whether the
 * video is H.264. Used to accept a round video that is already right when ffmpeg is missing.
 */
function mp4Info(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const out = { width: 0, height: 0, seconds: null, avc: buf.indexOf('avc1', 0, 'latin1') > 0 || buf.indexOf('avcC', 0, 'latin1') > 0 };
  const walk = (start, end, depth) => {
    let i = start;
    while (i + 8 <= end && depth < 6) {
      let size = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      let head = 8;
      if (size === 1 && i + 16 <= end) { size = Number(buf.readBigUInt64BE(i + 8)); head = 16; } else if (size === 0) size = end - i;
      if (size < 8 || i + size > end) break;
      const body = i + head;
      if (['moov', 'trak', 'mdia'].includes(type)) walk(body, i + size, depth + 1);
      else if (type === 'mvhd' && body + 32 <= i + size) {
        const v = buf[body];
        const scale = v === 1 ? buf.readUInt32BE(body + 20) : buf.readUInt32BE(body + 12);
        const dur = v === 1 ? Number(buf.readBigUInt64BE(body + 24)) : buf.readUInt32BE(body + 16);
        if (scale) out.seconds = dur / scale;
      } else if (type === 'tkhd') {
        const v = buf[body];
        const at = body + (v === 1 ? 88 : 76);
        if (at + 8 <= i + size) {
          const w = buf.readUInt32BE(at) / 65536, h = buf.readUInt32BE(at + 4) / 65536;
          if (w && h && !out.width) { out.width = Math.round(w); out.height = Math.round(h); }
        }
      }
      i += size;
    }
  };
  walk(0, buf.length, 0);
  return out;
}

/** Is this upload usable as it is, without ffmpeg? */
function alreadyRight(kind, file, head) {
  if (kind === 'voice') return head.slice(0, 4).toString('latin1') === 'OggS';
  if (kind === 'video_note') {
    if (head.slice(4, 8).toString('latin1') !== 'ftyp') return false;
    const i = mp4Info(file);
    return !!(i && i.avc && i.width && i.width === i.height && i.width <= ROUND.max && (i.seconds == null || i.seconds <= ROUND.seconds + 0.5));
  }
  return true;
}

/** Remember a failed conversion (support tools and Admin → System show them). */
async function noteFailure(wsId, kind, reason) {
  await db.query('insert into media_conversions(workspace_id, kind, ok, error) values ($1,$2,false,$3)', [wsId, kind, String(reason || '').slice(0, 300)]).catch(() => {});
}

/**
 * Make an uploaded voice note or round video ready for Telegram. input: the saved upload; head: its first bytes.
 * Returns { path, mime, ext, size, duration_sec, converted }. Throws a friendly 422 (code conversion_unavailable or
 * conversion_failed). The caller deletes the input file when the path changed.
 */
async function prepare(kind, input, head, wsId) {
  const { httpError } = require('../lib/util');
  const st = await detect();
  const ext = kind === 'voice' ? '.ogg' : '.mp4';
  const mime = kind === 'voice' ? 'audio/ogg' : 'video/mp4';
  if (!st.ok) {
    if (alreadyRight(kind, input, head)) {
      const size = (await fs.promises.stat(input)).size;
      const info = kind === 'video_note' ? mp4Info(input) : null;
      return { path: input, mime, ext, size, duration_sec: info && info.seconds != null ? Math.round(info.seconds) : null, converted: false };
    }
    log.warn('voice/round upload refused: ffmpeg is not set up', { kind, workspace: wsId });
    await noteFailure(wsId, kind, 'ffmpeg not set up');
    const hint = kind === 'voice' ? ' Upload an OGG (Opus) voice file for now.' : ' Upload a square MP4 (H.264, 60 seconds or less) for now.';
    throw httpError(422, NOT_SET_UP + hint, 'conversion_unavailable');
  }
  const output = input.replace(/\.[a-z0-9]+$/i, '') + '.out' + ext;
  try {
    const r = await slot(() => run(kind === 'voice' ? voiceArgs(input, output) : roundArgs(input, output)));
    const size = (await fs.promises.stat(output)).size;
    if (!size) throw new Error('empty output');
    let seconds = durationOf(r.stderr);
    if (seconds != null) seconds = Math.min(kind === 'video_note' ? ROUND.seconds : VOICE.seconds, seconds);
    return { path: output, mime, ext, size, duration_sec: seconds, converted: true };
  } catch (e) {
    await fs.promises.unlink(output).catch(() => {});
    if (e.code === 'conversion_busy') throw e;
    const why = String(e.stderr || e.message || e).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
    log.warn('voice/round conversion failed', { kind, workspace: wsId, err: why });
    await noteFailure(wsId, kind, why || 'conversion failed');
    throw httpError(422, kind === 'voice' ? 'We couldn\'t turn that recording into a voice note. Try recording again, or use an MP3, M4A, OGG or WAV file.' : 'We couldn\'t turn that video into a round video. Try recording again, or use a short MP4 or MOV.', 'conversion_failed');
  }
}

module.exports = { detect, status, prepare, mp4Info, alreadyRight, durationOf, voiceArgs, roundArgs, NOT_SET_UP, ROUND, VOICE, MAX_WAITING };
