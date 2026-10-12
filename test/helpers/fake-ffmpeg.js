#!/usr/bin/env node
'use strict';
/*
 * A stand-in for ffmpeg in tests (FFMPEG_PATH points here; services/media-convert.js runs .js files with Node).
 *   fake-ffmpeg -version            → prints a version line
 *   fake-ffmpeg ... -i IN ... OUT   → copies IN to OUT (the last argument), prints a "Duration:" line like ffmpeg
 * FAKE_FFMPEG_FAIL=1 makes every conversion fail (exit 1), like a broken file. FAKE_FFMPEG_SLEEP_MS makes each
 * conversion take that long (a busy server). Each call is appended to
 * FAKE_FFMPEG_LOG (when set) as one JSON line, so tests can check the arguments.
 */
const fs = require('node:fs');

const args = process.argv.slice(2);
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + '\n');
if (args[0] === '-version') { process.stdout.write('ffmpeg version 6.1-fake Copyright (c) the tests\n'); process.exit(0); }
const i = args.indexOf('-i');
if (i < 0 || !args[i + 1]) { process.stderr.write('No input\n'); process.exit(1); }
if (process.env.FAKE_FFMPEG_FAIL === '1' || fs.existsSync(args[i + 1] + '.fail')) { process.stderr.write('Invalid data found when processing input\n'); process.exit(1); }
if (Number(process.env.FAKE_FFMPEG_SLEEP_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_FFMPEG_SLEEP_MS));
fs.copyFileSync(args[i + 1], args[args.length - 1]);
process.stderr.write('Input #0, from \'in\':\n  Duration: 00:00:07.40, start: 0.000000, bitrate: 64 kb/s\n');
process.exit(0);
