'use strict';
/*
 * site-story.js: the "Automate your Telegram" story on the home page (section #story in index.html).
 *   ART.tired   the worn-out seller at 3am, copying the same message to everyone
 *   ART.chill   the same seller with Castvoo: feet up, juice, laptop doing the work
 *   storyChat() the little chat that plays like a video when it scrolls into view
 * Styles: "Story" block near the end of css/castvoo.css. Change the chat lines in STORY_CHAT below.
 * Uses mojiParts() and P from core.js, so the people match the rest of the site.
 */

/* ---------- Scene 1: without Castvoo ---------- */
ART.tired = function () {
  const o = P.emeka;
  const ink = '#0B1430';
  return '<svg class="stsv" viewBox="0 0 400 300" role="img" aria-label="A tired seller at 3am, sending the same message by hand">' +
    '<defs><linearGradient id="stN" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0D1640"/><stop offset="1" stop-color="#1B2860"/></linearGradient>' +
    '<radialGradient id="stGl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#8FD0FF" stop-opacity=".38"/><stop offset="1" stop-color="#8FD0FF" stop-opacity="0"/></radialGradient></defs>' +
    '<rect width="400" height="300" fill="url(#stN)"/>' +
    // window with moon and stars
    '<g><rect x="26" y="26" width="104" height="84" rx="10" fill="#0A1233" stroke="#2A3878" stroke-width="3"/><path d="M78 26v84M26 68h104" stroke="#2A3878" stroke-width="3"/>' +
    '<circle cx="106" cy="46" r="10" fill="#FFE8A3"/><circle cx="101" cy="42" r="9" fill="#0A1233"/>' +
    [[44, 40], [60, 54], [48, 88], [100, 92], [116, 80]].map((p, i) => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="1.5" fill="#fff" style="animation:tw ' + (2 + i % 3) + 's ease-in-out infinite ' + i * 0.4 + 's"/>').join('') + '</g>' +
    // wall clock: 3:12
    '<g transform="translate(338 58)"><circle r="26" fill="#F5F7FC"/><circle r="26" fill="none" stroke="#2A3878" stroke-width="4"/>' +
    [0, 90, 180, 270].map((a) => '<path d="M0 -21v4" stroke="' + ink + '" stroke-width="2.4" stroke-linecap="round" transform="rotate(' + a + ')"/>').join('') +
    '<path d="M0 0V-12" stroke="' + ink + '" stroke-width="3.4" stroke-linecap="round" transform="rotate(96)"/><path d="M0 0V-18" stroke="' + ink + '" stroke-width="2.4" stroke-linecap="round" transform="rotate(72)"/>' +
    '<g class="st-sec"><path d="M0 3V-19" stroke="#E5484D" stroke-width="1.4" stroke-linecap="round"/></g><circle r="2.6" fill="' + ink + '"/></g>' +
    // screen glow on the face
    '<ellipse cx="200" cy="130" rx="110" ry="90" fill="url(#stGl)" class="st-flick"/>' +
    // the person, slumped and nodding off
    '<g class="st-nod">' +
    '<path d="M138 236C138 184 164 156 200 156s62 28 62 80z" fill="' + o.shirt + '"/><path d="M186 158q14 14 28 0" stroke="#237A35" stroke-width="3" fill="none"/>' +
    '<g transform="translate(140 46)">' + mojiParts(o, { tired: 1 }) +
    '<path d="M44 34l-6-10M58 30l1-11M72 33l7-9" stroke="' + o.hair + '" stroke-width="3.4" stroke-linecap="round"/>' +
    '<path d="M93 52q4 7 0 11q-4-4 0-11z" fill="#8FD0FF" class="st-drop"/></g></g>' +
    // desk
    '<rect x="20" y="232" width="360" height="14" rx="7" fill="#2A3878"/><rect x="34" y="246" width="332" height="54" fill="#1A2763"/>' +
    // laptop, seen from behind
    '<path d="M150 170h100a6 6 0 0 1 6 6v56H144v-56a6 6 0 0 1 6-6z" fill="#C9D3EA"/><path d="M150 172h100a4 4 0 0 1 4 4v54H146v-54a4 4 0 0 1 4-4z" fill="#DCE4F7"/>' +
    '<use href="#i-tg" x="186" y="188" width="28" height="28"/>' +
    // hands typing
    '<g class="st-type"><ellipse cx="146" cy="230" rx="11" ry="8" fill="' + o.skin + '"/></g><g class="st-type st-type2"><ellipse cx="254" cy="230" rx="11" ry="8" fill="' + o.skin + '"/></g>' +
    // three coffee cups (one knocked over)
    '<g transform="translate(56 204)"><rect width="20" height="26" rx="5" fill="#F5F7FC"/><path d="M20 7q8 0 8 7t-8 7" stroke="#F5F7FC" stroke-width="3.4" fill="none"/></g>' +
    '<g transform="translate(86 210)"><rect width="18" height="22" rx="5" fill="#E5E9F2"/></g>' +
    '<g transform="translate(108 222) rotate(-90)"><rect width="10" height="22" rx="4" fill="#C9D3EA"/></g><ellipse cx="128" cy="232" rx="12" ry="2.6" fill="#6B4A2E" opacity=".7"/>' +
    // phone buzzing with unread messages
    '<g transform="translate(300 196)"><g class="st-buzz"><rect width="26" height="40" rx="6" fill="' + ink + '"/><rect x="3" y="5" width="20" height="30" rx="3" fill="#29A9EB"/>' +
    '<rect x="12" y="-8" width="26" height="15" rx="7.5" fill="#E5484D"/><text x="25" y="3" text-anchor="middle" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="9.5" fill="#fff">99+</text></g>' +
    '<path d="M-6 8q-4 12 0 24M34 8q4 12 0 24" stroke="#8FD0FF" stroke-width="2" fill="none" stroke-linecap="round" class="st-buzzl"/></g>' +
    '</svg>';
};

/* ---------- Scene 2: with Castvoo ---------- */
ART.chill = function () {
  const o = P.emeka;
  const ink = '#0B1430';
  // The sip: the glass rises to the straw and back, every 5 seconds (SVG animation, synced by keyTimes).
  const T = 'dur="5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.3;0.48;0.62;1" keySplines=".4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1"';
  const up = (rest, sip) => 'values="' + rest + ';' + rest + ';' + sip + ';' + sip + ';' + rest + '"';
  return '<svg class="stsv" viewBox="0 0 400 300" role="img" aria-label="The same seller relaxing with a juice while Castvoo sends his messages">' +
    '<defs><linearGradient id="stD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D9E8FF"/><stop offset="1" stop-color="#F4F8FF"/></linearGradient>' +
    '<linearGradient id="stJ" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC24A"/><stop offset="1" stop-color="#FF9A1F"/></linearGradient>' +
    '<clipPath id="stGlass"><path d="M-12 -18h24l-3 34h-18z"/></clipPath></defs>' +
    '<rect width="400" height="300" fill="url(#stD)"/>' +
    // sun
    '<g transform="translate(336 56)"><g class="st-rays">' + Array.from({ length: 10 }, (_, i) => '<path d="M0 -34v-9" stroke="#FFC24A" stroke-width="4" stroke-linecap="round" transform="rotate(' + i * 36 + ')"/>').join('') + '</g><circle r="24" fill="#FFD25E"/><circle r="24" fill="#FFC24A" opacity=".5" class="st-sunp"/></g>' +
    // plant
    '<g transform="translate(40 168)"><g style="animation:sway 5s ease-in-out infinite;transform-origin:26px 60px"><path d="M26 60C8 44 4 18 12 6c14 12 18 34 14 54z" fill="#33C08A"/><path d="M26 60c12-22 32-30 42-24-6 16-22 26-42 24z" fill="#26A776"/><path d="M26 60C18 38 28 18 38 12c6 16-2 36-12 48z" fill="#4FD39E"/></g><path d="M8 58h36l-5 46H13z" fill="#F0B27A"/><rect x="5" y="54" width="42" height="9" rx="4" fill="#E79B5C"/></g>' +
    // floor
    '<rect x="0" y="270" width="400" height="30" fill="#E6EEFC"/>' +
    // armchair back
    '<path d="M122 236V138c0-26 20-42 46-42h64c26 0 46 16 46 42v98z" fill="#2F6BFF"/><path d="M134 236V142c0-20 14-32 34-32h64c20 0 34 12 34 32v94z" fill="#4C80FF"/>' +
    // person (body + head with headphones, eyes closed, smiling)
    '<g class="st-breathe">' +
    '<path d="M146 246C146 192 170 164 200 164s54 28 54 82z" fill="' + o.shirt + '"/><path d="M188 166q12 12 24 0" stroke="#237A35" stroke-width="3" fill="none"/>' +
    '<g class="st-head"><g transform="translate(140 52)">' + mojiParts(o, { bliss: 1, phones: 1 }) + '</g></g></g>' +
    // music notes from the headphones
    '<g font-family="Plus Jakarta Sans,sans-serif" font-weight="800" fill="#2F6BFF"><text x="246" y="96" class="st-note">♪</text><text x="252" y="88" class="st-note st-note2" font-size="18">♫</text><text x="134" y="96" class="st-note st-note3" font-size="15">♪</text></g>' +
    // seat and armrests
    '<rect x="112" y="232" width="176" height="30" rx="12" fill="#1F55E8"/><rect x="104" y="196" width="34" height="62" rx="14" fill="#3A73FF"/><rect x="262" y="196" width="34" height="62" rx="14" fill="#3A73FF"/>' +
    '<path d="M126 262v16M274 262v16" stroke="#1638B8" stroke-width="7" stroke-linecap="round"/>' +
    // legs: left down, right crossed over and bobbing
    '<path d="M182 246c-4 12-6 22-6 30" stroke="#1B2547" stroke-width="20" stroke-linecap="round" fill="none"/><ellipse cx="172" cy="282" rx="14" ry="6" fill="' + ink + '"/>' +
    '<g class="st-foot"><path d="M196 244c18 0 34 4 44 12" stroke="#25305A" stroke-width="20" stroke-linecap="round" fill="none"/><path d="M240 256l18 18" stroke="#25305A" stroke-width="18" stroke-linecap="round"/><ellipse cx="266" cy="280" rx="15" ry="7" fill="' + ink + '" transform="rotate(30 266 280)"/></g>' +
    // left arm resting on the armrest
    '<path d="M160 184c-16 14-24 28-22 40" stroke="' + o.shirt + '" stroke-width="16" stroke-linecap="round" fill="none"/><circle cx="138" cy="226" r="8" fill="' + o.skin + '"/>' +
    // right arm + juice (moves together)
    '<path stroke="' + o.shirt + '" stroke-width="16" stroke-linecap="round" fill="none" d="M240 182L252 214"><animate attributeName="d" ' + T + ' ' + up('M240 182L252 214', 'M240 182L254 206') + '/></path>' +
    '<path stroke="' + o.skin + '" stroke-width="13" stroke-linecap="round" fill="none" d="M252 214L232 200"><animate attributeName="d" ' + T + ' ' + up('M252 214L232 200', 'M254 206L222 172') + '/></path>' +
    '<g transform="translate(228 190)"><animateTransform attributeName="transform" type="translate" ' + T + ' ' + up('228 190', '218 162') + '/>' +
    '<path d="M3 -16l-12 -26" stroke="#E5484D" stroke-width="3.2" stroke-linecap="round"/><path d="M3 -16l-12 -26" stroke="#fff" stroke-width="3.2" stroke-dasharray="3 4" stroke-linecap="round"/>' +
    '<path d="M-12 -18h24l-3 34h-18z" fill="#fff" opacity=".55"/>' +
    '<g clip-path="url(#stGlass)"><rect x="-14" y="-10" width="28" height="30" fill="url(#stJ)"><animate attributeName="y" values="-10;-10;-10;-6;-6;-2;-2;-10" keyTimes="0;0.3;0.55;0.6;0.7;0.75;0.95;1" dur="15s" repeatCount="indefinite"/></rect></g>' +
    '<path d="M-12 -18h24l-3 34h-18z" fill="none" stroke="#fff" stroke-width="2"/>' +
    '<g transform="translate(11 -18)"><circle r="7" fill="#FF9A1F"/><circle r="5" fill="#FFD27A"/><path d="M0 -5v10M-5 0h10" stroke="#FF9A1F" stroke-width="1"/></g>' +
    '<ellipse cx="-2" cy="2" rx="8" ry="7" fill="' + o.skin + '"/></g>' +
    // side table + laptop running Castvoo
    '<rect x="300" y="226" width="80" height="10" rx="5" fill="#C9D3EA"/><rect x="336" y="236" width="8" height="40" rx="3" fill="#B9C5E3"/><rect x="320" y="272" width="40" height="6" rx="3" fill="#B9C5E3"/>' +
    '<path d="M306 224h68l6 4h-80z" fill="#9AA8CB"/>' +
    '<rect x="308" y="166" width="64" height="58" rx="6" fill="' + ink + '"/><rect x="312" y="170" width="56" height="50" rx="3" fill="#F5F7FC"/>' +
    '<use href="#logo" x="315" y="173" width="9" height="9"/><rect x="327" y="175" width="22" height="4" rx="2" fill="#C9D3EA"/>' +
    [0, 1, 2].map((i) => '<g class="st-row st-row' + i + '"><circle cx="319" cy="' + (190 + i * 9) + '" r="3" fill="#0E9F6E"/><path d="M317.6 ' + (190 + i * 9) + 'l1 1 2-2.2" stroke="#fff" stroke-width="1.1" fill="none"/><rect x="325" y="' + (188.5 + i * 9) + '" width="' + (32 - i * 6) + '" height="3" rx="1.5" fill="#B9C5E3"/></g>').join('') +
    '<rect x="315" y="214" width="50" height="3" rx="1.5" fill="#E5E9F2"/><rect x="315" y="214" width="50" height="3" rx="1.5" fill="#2F6BFF" class="st-prog"/>' +
    '</svg>';
};
// Reduced motion: freeze the SVG animations of both scenes.
ART.chillInit = ART.tiredInit = function (el) {
  if (!RM) return;
  const s = el.querySelector('svg'); if (s && s.pauseAnimations) s.pauseAnimations();
};

/* ---------- The chat that plays like a video ---------- */
const STORY_CHAT = [
  { who: 'them', text: 'I see you\'ve been flexing 😎 but your Telegram is so active. You\'ve got an assistant?' },
  { who: 'me', text: 'No, I didn\'t employ anyone 😌' },
  { who: 'me', text: 'It\'s Castvoo.', card: true },
  { who: 'them', text: 'Wait… send me the link 🙏🏾' },
];

function storyChat(root) {
  const box = root.querySelector('[data-chat-body]');
  const bar = root.querySelector('[data-chat-bar] i');
  const btn = root.querySelector('[data-chat-play]');
  const time = root.querySelector('[data-chat-time]');
  const status = root.querySelector('[data-chat-status]');
  if (!box || box.dataset.ok) return;
  box.dataset.ok = '1';
  const fmtT = (ms) => '0:' + String(Math.floor(ms / 1000)).padStart(2, '0');
  const bubble = (m) => '<div class="cm ' + m.who + '"><p>' + esc(m.text) + '</p>' +
    (m.card ? '<a class="cm-card" href="#signup" tabindex="-1"><span class="lg"><svg width="26" height="26"><use href="#logo"/></svg></span><span><b>Castvoo</b><small>Telegram on autopilot · castvoo.com</small></span></a>' : '') +
    '<small class="cm-t">' + (m.who === 'me' ? '11:02 <span class="ck">✓✓</span>' : '11:01') + '</small></div>';
  const typing = (who) => '<div class="cm ' + who + ' cm-typ" aria-hidden="true"><span></span><span></span><span></span></div>';

  // Timeline: [time ms, action]
  const steps = [];
  let t = 400;
  STORY_CHAT.forEach((m, i) => {
    steps.push([t, 'type', m.who]); t += i === 2 ? 700 : 1500;
    steps.push([t, 'msg', i]); t += 1300;
  });
  const total = t + 2600;
  let start = 0, offset = 0, playing = false, raf = 0, shown = -1, typingWho = null;

  function render(ms) {
    let lastMsg = -1, ty = null;
    for (const s of steps) { if (s[0] > ms) break; if (s[1] === 'msg') { lastMsg = s[2]; ty = null; } else ty = s[2]; }
    if (lastMsg !== shown || ty !== typingWho) {
      box.innerHTML = STORY_CHAT.slice(0, lastMsg + 1).map(bubble).join('') + (ty ? typing(ty) : '');
      const last = box.lastElementChild; if (last && (lastMsg !== shown || ty)) last.classList.add('in');
      status.textContent = ty === 'them' ? 'typing…' : 'online';
      shown = lastMsg; typingWho = ty;
      box.scrollTop = box.scrollHeight;
    }
    bar.style.width = Math.min(100, ms / total * 100) + '%';
    time.textContent = fmtT(Math.min(ms, total));
  }
  function frame(now) {
    const ms = offset + (now - start);
    if (ms >= total) { offset = 0; start = now; shown = -2; render(0); raf = requestAnimationFrame(frame); return; } // loop
    render(ms);
    raf = requestAnimationFrame(frame);
  }
  function play() { if (playing) return; playing = true; start = performance.now(); raf = requestAnimationFrame(frame); btn.classList.add('on'); btn.setAttribute('aria-label', 'Pause the chat'); }
  function pause() { if (!playing) return; playing = false; offset += performance.now() - start; cancelAnimationFrame(raf); btn.classList.remove('on'); btn.setAttribute('aria-label', 'Play the chat'); }
  btn.onclick = () => { if (playing) { pause(); root.dataset.user = 'paused'; } else { root.dataset.user = ''; play(); } };

  if (RM || !('IntersectionObserver' in window)) { render(total - 1); btn.hidden = !!RM; return; }
  render(0);
  new IntersectionObserver((es) => {
    for (const e of es) { if (e.isIntersecting && root.dataset.user !== 'paused') play(); else if (!e.isIntersecting) pause(); }
  }, { threshold: 0.45 }).observe(root);
}

/* Laptop counter in the relaxed scene and the slow "forwarding" bar in the tired one. */
function storyCounters(root) {
  const sent = root.querySelector('[data-st-sent]');
  const fwd = root.querySelector('[data-st-fwd]');
  if (!sent || sent.dataset.ok) return;
  sent.dataset.ok = '1';
  let n = 0, f = 214;
  const tick = () => {
    if (document.hidden || (typeof siteOn === 'function' && !siteOn())) return;
    n = n >= 1240 ? 0 : Math.min(1240, n + 37 + Math.floor(Math.random() * 20));
    sent.textContent = fmt(n);
    f = f >= 260 ? 214 : f + 1;
    fwd.textContent = f + ' / 1,240';
    fwd.parentElement.style.setProperty('--p', (f / 1240 * 100).toFixed(1) + '%');
  };
  if (RM) { sent.textContent = '1,240'; return; }
  tick(); setInterval(tick, 380);
}

function initStory() {
  const root = document.getElementById('story');
  if (!root) return;
  paintArt(root);
  const chat = root.querySelector('[data-chat]');
  if (chat) storyChat(chat);
  storyCounters(root);
}
document.addEventListener('DOMContentLoaded', initStory);
