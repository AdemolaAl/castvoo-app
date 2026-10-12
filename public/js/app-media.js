'use strict';
/*
 * app-media.js: voice notes and round videos (Oct 2026).
 *   openRecorder('voice' | 'round')  a sheet that records in the browser (MediaRecorder): hold-to-record (or tap to start /
 *                                    stop) with a timer and moving bars for voice; the front camera in a circle, up to 60
 *                                    seconds, for round videos. Playback, "Record again", "Use this". When the browser
 *                                    can't record (or permission is refused) it offers an upload instead.
 *                                    Resolves the uploaded media { id, kind, filename, size, url, duration_sec } or null.
 *   pickMedia({ photoOnly, box })    "What do you want to add?" (photo or video / voice note / round video), then the
 *                                    file picker or the recorder. Used by the bot and follow-up builders.
 *   voiceBubble(m), roundCircle(m)   previews (a voice message bubble with play, a round video circle).
 * Uploads go to /api/media?as=voice|video_note; the server converts them for Telegram (ffmpeg).
 */

const VOICE_ACCEPT = 'audio/ogg,audio/opus,audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/m4a,audio/aac,audio/wav,audio/x-wav,audio/webm,.ogg,.opus,.mp3,.m4a,.aac,.wav,.webm';
const ROUND_ACCEPT = 'video/mp4,video/quicktime,video/webm';
const VOICE_MAX_SEC = 300;
const ROUND_MAX_SEC = 60;
const MEDIA_WORD = { photo: 'Photo', video: 'Video', animation: 'GIF', voice: 'Voice note', video_note: 'Round video' };

function fmtDur(s) { s = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
/* 28 bars of a "waveform" that look the same for the same file (seeded by its id). */
function waveBars(seed, n = 28) {
  let x = (Number(String(seed || 7).replace(/\D/g, '').slice(-6)) || 7) * 9301 + 49297;
  let out = '';
  for (let i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; const h = 22 + Math.round((x / 233280) * 78); out += '<i style="height:' + h + '%"></i>'; }
  return out;
}
function voiceBubble(m, opts = {}) {
  const src = m.url || mediaUrl(m.id);
  return '<div class="au-vb' + (opts.small ? ' sm' : '') + '"><button type="button" class="au-vplay" data-vplay aria-label="Play the voice note"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></button>' +
    '<span class="au-wave" aria-hidden="true">' + waveBars(m.id) + '</span><small class="tnum">' + (m.duration_sec || m.duration ? fmtDur(m.duration_sec || m.duration) : '🎙️') + '</small><audio preload="none" src="' + esc(src) + '"></audio></div>';
}
function roundCircle(m, opts = {}) {
  const src = m.url || mediaUrl(m.id);
  return '<div class="au-rv' + (opts.small ? ' sm' : '') + '"><video src="' + esc(src) + '" muted autoplay loop playsinline preload="metadata"></video></div>';
}
/* Play / pause a voice preview (one at a time). */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-vplay]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const a = b.parentElement.querySelector('audio');
  if (!a) return;
  document.querySelectorAll('.au-vb audio').forEach((x) => { if (x !== a && !x.paused) { x.pause(); x.parentElement.classList.remove('play'); } });
  if (a.paused) {
    a.play().then(() => b.parentElement.classList.add('play')).catch(() => toast('This browser can\'t play the preview. It still plays in Telegram.', { kind: 'info' }));
    a.onended = () => b.parentElement.classList.remove('play');
  } else { a.pause(); b.parentElement.classList.remove('play'); }
}, true);

/* The best recording format this browser has (iPhone Safari: mp4; Chrome / Firefox: webm or ogg with Opus). */
function recMime(kind) {
  const list = kind === 'voice' ? ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'] : ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
  try { return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || ''; } catch (_) { return ''; }
}
const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

/* Upload a voice note or round video (a recording or a file) with progress in `bar`. */
async function uploadAs(kind, file, bar) {
  const as = kind === 'voice' ? 'voice' : 'video_note';
  const m = await uploadTo('/api/media?as=' + as, 'media', file, (p) => { if (bar) bar.style.width = Math.round(p * 92) + '%'; });
  if (bar) bar.style.width = '100%';
  return { id: m.id, kind: m.kind, filename: m.filename || file.name, size: m.size_bytes || file.size, duration_sec: m.duration_sec || null, url: URL.createObjectURL(file) };
}

function openRecorder(kind, opts = {}) {
  const voice = kind === 'voice';
  return new Promise((resolve) => {
    let done = false, stream = null, rec = null, chunks = [], blob = null, blobUrl = '', t0 = 0, timer = 0, raf = 0, ctx = null, downAt = 0, mode = '', busy = false;
    const st = { state: 'idle' };
    const cleanup = () => {
      clearInterval(timer); cancelAnimationFrame(raf);
      try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (_) { /* already stopped */ }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
    };
    const finish = (m) => { if (done) return; done = true; cleanup(); if (!m && blobUrl) URL.revokeObjectURL(blobUrl); resolve(m); };
    // (finish(m) runs before the sheet closes: closing it calls onClose, which would answer null first.)
    const can = canRecord();
    const body = voice
      ? '<div class="au-rec" data-st="idle"><div class="au-rec-stage"><span class="au-bars" aria-hidden="true">' + Array.from({ length: 24 }, () => '<i></i>').join('') + '</span><b class="au-rtime tnum">0:00</b></div>' +
        (can ? '<button type="button" class="au-mic" data-mic aria-label="Hold to record"><svg viewBox="0 0 24 24" width="30" height="30"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></button>' +
          '<p class="au-rtip" data-tip>Hold to record. Or tap once to start and tap again to stop.</p>' : '<p class="note2"><span>🎙️</span><span>This browser can\'t record here. Upload an audio file instead (MP3, M4A, OGG, WAV).</span></p>') +
        '<div class="au-play" data-play hidden></div>'
      : '<div class="au-rec au-round" data-st="idle"><div class="au-circle"><video data-cam playsinline muted autoplay></video><div class="au-cam-off" data-camoff>' + (can ? '<span>📷</span><small>Tap "Start the camera"</small>' : '<span>⭕</span><small>This browser can\'t record here. Upload a video instead.</small>') + '</div>' +
        '<svg class="au-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="47"/><circle class="p" cx="50" cy="50" r="47" pathLength="100" stroke-dasharray="0 100"/></svg></div>' +
        '<b class="au-rtime tnum">0:00 <small>/ 1:00</small></b>' +
        (can ? '<button type="button" class="btn b-blue full" data-cambtn>📷 Start the camera</button>' : '');
    const tail = '<div class="upb" data-upb hidden><i></i></div><p class="ferr" data-err hidden></p>' +
      '<div class="row2b" data-after hidden><button type="button" class="btn b-ghost" data-again>Record again</button><button type="button" class="btn b-blue" data-use>Use this</button></div>' +
      '<div class="au-rec-up"><button type="button" class="lnk" data-upload>' + (voice ? 'Upload an audio file instead' : 'Upload a video instead') + '</button><small class="hint">' + (voice ? 'MP3, M4A, OGG, WAV, AAC or WEBM, up to 20 MB.' : 'MP4, MOV or WEBM, up to 50 MB. We crop it to a circle and keep the first 60 seconds.') + '</small></div>' +
      (voice ? '' : '<p class="hint au-rnote">Round videos have no caption in Telegram. If your message has text or buttons, they arrive right after the video.</p>') +
      '<input type="file" hidden data-file accept="' + (voice ? VOICE_ACCEPT : ROUND_ACCEPT) + '"></div>';
    const h = sheet(voice ? 'Record a voice note' : 'Record a round video', '<span class="spk au-spk-c">' + (voice ? '🎙️' : '⭕') + '</span>', body + tail, { onClose: () => finish(null), sticky: true });
    const root = $('.au-rec', h);
    const err = (msg) => { const e = $('[data-err]', h); e.textContent = msg || ''; e.hidden = !msg; };
    const setState = (s) => { st.state = s; root.dataset.st = s; };
    const timeEl = $('.au-rtime', h);
    const maxSec = voice ? VOICE_MAX_SEC : ROUND_MAX_SEC;
    const showTime = (sec) => { timeEl.innerHTML = fmtDur(sec) + (voice ? '' : ' <small>/ 1:00</small>'); const p = $('.au-ring .p', h); if (p) p.setAttribute('stroke-dasharray', Math.min(100, (sec / maxSec) * 100).toFixed(1) + ' 100'); };

    const getStream = async () => {
      if (stream) return stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(voice ? { audio: { echoCancellation: true, noiseSuppression: true } } : { audio: true, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 }, aspectRatio: { ideal: 1 } } });
        return stream;
      } catch (e) {
        err(voice ? 'Castvoo can\'t use your microphone. Allow it in your browser\'s settings, or upload an audio file instead.' : 'Castvoo can\'t use your camera. Allow it in your browser\'s settings, or upload a video instead.');
        return null;
      }
    };
    /* Moving bars from the microphone level (or a gentle pulse when the browser has no audio analyser). */
    const animateBars = () => {
      const bars = $$('.au-bars i', h);
      let an = null, data = null;
      try { const AC = window.AudioContext || window.webkitAudioContext; ctx = new AC(); const src = ctx.createMediaStreamSource(stream); an = ctx.createAnalyser(); an.fftSize = 64; src.connect(an); data = new Uint8Array(an.frequencyBinCount); } catch (_) { an = null; }
      const step = () => {
        if (st.state !== 'rec') return;
        if (an) an.getByteFrequencyData(data);
        bars.forEach((b, i) => { const v = an ? data[(i + 2) % data.length] / 255 : 0.3 + 0.5 * Math.abs(Math.sin(Date.now() / 220 + i)); b.style.transform = 'scaleY(' + Math.max(0.12, Math.min(1, v * 1.25)).toFixed(2) + ')'; });
        raf = requestAnimationFrame(step);
      };
      step();
    };
    const start = async () => {
      if (busy || st.state === 'rec') return;
      busy = true; err('');
      const s = await getStream();
      busy = false;
      if (!s || done) return false;
      chunks = []; blob = null;
      const mime = recMime(kind);
      try { rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s); } catch (_) { err('Recording did not start in this browser. Upload a file instead.'); return false; }
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        blob = new Blob(chunks, { type: (rec.mimeType || mime || (voice ? 'audio/webm' : 'video/webm')).split(';')[0] });
        if (!blob.size) { setState('idle'); err('Nothing was recorded. Try again.'); return; }
        afterRecord();
      };
      rec.start(250);
      t0 = Date.now(); setState('rec'); showTime(0);
      timer = setInterval(() => { const sec = (Date.now() - t0) / 1000; showTime(sec); if (sec >= maxSec) stop(); }, 200);
      if (voice) animateBars();
      else { const b = $('[data-cambtn]', h); if (b) b.innerHTML = '■ Stop'; }
      return true;
    };
    const stop = () => {
      if (st.state !== 'rec' || !rec) return;
      clearInterval(timer); cancelAnimationFrame(raf);
      if ((Date.now() - t0) < 700) { // a slip of the finger
        rec.onstop = null; try { rec.stop(); } catch (_) { /* ignore */ }
        setState('idle'); showTime(0); err(voice ? 'Hold the button a little longer to record.' : ''); mode = '';
        const b = $('[data-cambtn]', h); if (b) b.innerHTML = '● Start recording';
        return;
      }
      setState('done');
      try { rec.stop(); } catch (_) { /* ignore */ }
      if (stream && voice) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    };
    const afterRecord = () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(blob);
      const sec = Math.round((Date.now() - t0) / 1000);
      if (voice) { const p = $('[data-play]', h); p.hidden = false; p.innerHTML = voiceBubble({ id: Date.now(), url: blobUrl, duration_sec: sec }); }
      else {
        if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
        const v = $('[data-cam]', h); v.srcObject = null; v.src = blobUrl; v.muted = false; v.loop = true; v.controls = false; v.classList.add('pb'); v.play().catch(() => {});
        const b = $('[data-cambtn]', h); if (b) b.hidden = true;
      }
      $('[data-after]', h).hidden = false;
      const tip = $('[data-tip]', h); if (tip) tip.textContent = 'Listen back. Happy with it? Tap "Use this".';
    };
    const send = async (file) => {
      err('');
      const bar = $('[data-upb]', h); bar.hidden = false;
      const use = $('[data-use]', h); if (use) btnBusy(use, true, 'Uploading…');
      try {
        const m = await uploadAs(kind, file, $('i', bar));
        finish(m); onModalClose = null; closeModal();
      } catch (e) { bar.hidden = true; if (use) btnBusy(use, false); err(e.message || 'Upload failed. Please try again.'); }
    };

    // Voice: hold to record (or tap to start, tap to stop).
    const mic = $('[data-mic]', h);
    if (mic) {
      mic.addEventListener('contextmenu', (e) => e.preventDefault());
      mic.addEventListener('pointerdown', async (e) => {
        e.preventDefault();
        if (st.state === 'rec') { if (mode === 'tap') { mode = ''; stop(); } return; }
        if (st.state === 'done') return;
        downAt = Date.now(); mode = 'hold';
        try { mic.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ }
        const ok = await start();
        // Released while the browser was still asking for permission: carry on as tap-to-stop.
        if (ok && mode === 'released') { mode = 'tap'; const tip = $('[data-tip]', h); if (tip) tip.textContent = 'Recording… tap the button again to stop.'; }
      });
      const up = () => {
        if (mode !== 'hold') return;
        if (st.state !== 'rec') { mode = 'released'; return; }
        if (Date.now() - downAt > 450) { mode = ''; stop(); } else { mode = 'tap'; const tip = $('[data-tip]', h); if (tip) tip.textContent = 'Recording… tap the button again to stop.'; }
      };
      mic.addEventListener('pointerup', up);
      mic.addEventListener('pointercancel', up);
    }
    // Round video: start the camera, then record / stop.
    const cam = $('[data-cambtn]', h);
    if (cam) cam.onclick = async () => {
      if (st.state === 'rec') { stop(); return; }
      if (!stream) {
        const s = await getStream(); if (!s) return;
        const v = $('[data-cam]', h); v.srcObject = s; v.muted = true; v.classList.remove('pb'); v.play().catch(() => {});
        $('[data-camoff]', h).hidden = true;
        cam.innerHTML = '● Start recording';
        return;
      }
      await start();
    };
    $('[data-again]', h).onclick = async () => {
      $('[data-after]', h).hidden = true; err(''); setState('idle'); showTime(0); blob = null;
      if (voice) { $('[data-play]', h).hidden = true; const tip = $('[data-tip]', h); if (tip) tip.textContent = 'Hold to record. Or tap once to start and tap again to stop.'; }
      else { const v = $('[data-cam]', h); v.pause(); v.removeAttribute('src'); v.load(); const b = $('[data-cambtn]', h); b.hidden = false; b.innerHTML = '📷 Start the camera'; $('[data-camoff]', h).hidden = false; }
    };
    $('[data-use]', h).onclick = () => {
      if (!blob) return;
      const ext = /mp4/.test(blob.type) ? (voice ? '.m4a' : '.mp4') : /ogg/.test(blob.type) ? '.ogg' : '.webm';
      send(new File([blob], (voice ? 'voice-note' : 'round-video') + ext, { type: blob.type || (voice ? 'audio/webm' : 'video/webm') }));
    };
    const fin = $('[data-file]', h);
    $('[data-upload]', h).onclick = () => fin.click();
    fin.onchange = () => {
      const f = fin.files[0]; fin.value = '';
      if (!f) return;
      if (voice && f.size > 20 * 1048576) { err('Voice notes can be up to 20 MB. This one is ' + fsize(f.size) + '.'); return; }
      if (!voice && f.size > 50 * 1048576) { err('Round videos can be up to 50 MB. This one is ' + fsize(f.size) + '.'); return; }
      if (!voice && !/^video\/(mp4|quicktime|webm)$/.test(f.type)) { err('Use an MP4, MOV or WEBM video.'); return; }
      send(f);
    };
    if (opts.upload) fin.click();
  });
}

/* "What do you want to add?" then the file picker or a recorder. Resolves the media or null. */
function pickMedia(opts = {}) {
  return new Promise((resolve) => {
    if (opts.photoOnly) { fileThenUpload(opts, 'image/jpeg,image/png,image/webp').then(resolve); return; }
    const h = sheet('Add to this message', '<span class="spk">📎</span>',
      '<div class="au-mpick"><button type="button" data-k="file"><span>🖼️</span><b>Photo or video</b><small>JPG, PNG, GIF, MP4 or MOV</small></button>' +
      '<button type="button" data-k="voice"><span>🎙️</span><b>Voice note</b><small>Record or upload audio</small></button>' +
      '<button type="button" data-k="round"><span>⭕</span><b>Round video</b><small>Record with your camera, up to 60 s</small></button></div>', { onClose: () => resolve(null) });
    $('.au-mpick', h).onclick = async (e) => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      onModalClose = null;
      if (b.dataset.k === 'file') { closeModal(); resolve(await fileThenUpload(opts)); return; }
      resolve(await openRecorder(b.dataset.k));
    };
  });
}
function fileThenUpload(opts, accept) {
  return new Promise((resolve) => {
    const fin = document.createElement('input'); fin.type = 'file'; fin.accept = accept || 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime';
    fin.onchange = async () => { const f = fin.files[0]; if (!f) { resolve(null); return; } resolve(await pickAndUpload(f, opts.box || null)); };
    fin.click();
  });
}
