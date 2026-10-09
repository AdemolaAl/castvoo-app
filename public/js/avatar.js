'use strict';
/*
 * avatar.js: customer cartoon avatars ("Your avatar" in Settings → Profile), in the same flat style as the
 * support agents' faces (public/img/agents, scripts/agent-faces.js).
 *
 * One file for the browser AND the server:
 *   browser  <script defer src="/js/avatar.js">  → the global AV
 *   server   require('../../public/js/avatar.js') → the same object (routes/auth.js checks saved avatars with it)
 *
 *   AV.OPTIONS             every choice in the builder: { face: [[key, label], ...], ... }
 *   AV.clean(cfg, strict)  a complete, known-good config. strict: throws on any unknown key or value (the server);
 *                          not strict: unknown or missing values fall back to the defaults (drawing)
 *   AV.render(cfg, opts)   an <svg> string. opts: { size, label, live (blink + gentle bob), cls }
 *   AV.random()            a random, good-looking config
 *   AV.PRESETS             24 ready-made avatars
 *   AV.greetName(user)     nickname > first name > email prefix
 *
 * render() only ever draws values from the lists below (it runs clean() first), so a stored config can never put
 * markup into the page. Every id inside the SVG is unique per drawing, so many avatars can share a page.
 */
(function (root) {
  const INK = '#1B1530';
  const BLUE = '#2F6BFF';
  const GOLD = '#F2C14E';

  /* ---------- colour helpers ---------- */
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (a) => '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const dark = (c, t) => mix(c, '#000000', t);
  const light = (c, t) => mix(c, '#FFFFFF', t);
  const lum = (c) => { const [r, g, b] = hex(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

  /* ---------- the options (key, label, data) ---------- */
  const SKIN = [
    ['t1', 'Porcelain', '#F8DCC8', '#E3B79C'], ['t2', 'Fair', '#F2C7A2', '#D9A27C'], ['t3', 'Light', '#EDC3A0', '#D29D78'],
    ['t4', 'Warm', '#E2AD80', '#C38B5E'], ['t5', 'Honey', '#D49A63', '#B67B47'], ['t6', 'Tan', '#C88C5E', '#A86E44'],
    ['t7', 'Caramel', '#B87A50', '#995D37'], ['t8', 'Brown', '#8A5536', '#6C3E24'], ['t9', 'Deep', '#6F4127', '#52301A'],
    ['t10', 'Rich', '#4E2E1C', '#3A2012'],
  ];
  const HAIRC = [
    ['black', 'Black', '#17110E'], ['espresso', 'Dark brown', '#2E1D16'], ['brown', 'Brown', '#5A3824'], ['chestnut', 'Chestnut', '#7A4A2A'],
    ['auburn', 'Auburn', '#8A3B1E'], ['ginger', 'Ginger', '#C2602E'], ['blonde', 'Blonde', '#D9AE5F'], ['platinum', 'Platinum', '#E6DAC3'],
    ['grey', 'Grey', '#9A9AA3'], ['blue', 'Blue', '#2F6BFF'], ['violet', 'Violet', '#6E56CF'],
  ];
  const OUTC = [
    ['blue', 'Castvoo blue', '#2F6BFF'], ['navy', 'Navy', '#0B1640'], ['sky', 'Sky', '#6EA8FF'], ['white', 'White', '#F4F7FF'],
    ['black', 'Black', '#16171D'], ['green', 'Green', '#12B886'], ['red', 'Red', '#E5484D'], ['gold', 'Gold', '#F5B935'],
    ['purple', 'Purple', '#6E56CF'], ['grey', 'Grey', '#8C93A6'], ['coral', 'Coral', '#FF7A59'], ['olive', 'Olive', '#5F7A3A'],
  ];
  const BGS = [
    ['blue', 'Castvoo blue', 'g', '#EAF1FF', '#CFE0FF'], ['royal', 'Royal', 'g', '#6C95FF', '#1846DB'], ['night', 'Night', 'g', '#22357E', '#060C26'],
    ['sky', 'Sky', 'g', '#E2F4FF', '#A9DAFF'], ['white', 'White', 's', '#F4F7FF'], ['mint', 'Mint', 's', '#DDF7EC'], ['sand', 'Sand', 's', '#FCEFD9'],
    ['blush', 'Blush', 's', '#FDE7E7'], ['lilac', 'Lilac', 's', '#ECE8FF'], ['ink', 'Ink', 's', '#0B1640'],
    ['dots', 'Dots', 'p', '#5A8CFF', '#1846DB'], ['rings', 'Rings', 'p', '#EAF1FF', '#BCD3FF'], ['stripes', 'Stripes', 'p', '#2F6BFF', '#1D4FD8'], ['burst', 'Sunburst', 'p', '#FFE7A8', '#FFC94D'],
  ];
  const OPTIONS = {
    face: [['oval', 'Oval'], ['round', 'Round'], ['square', 'Square'], ['long', 'Long'], ['heart', 'Heart']],
    skin: SKIN.map((x) => [x[0], x[1]]),
    hair: [['none', 'Bald'], ['buzz', 'Buzz cut'], ['fade', 'High-top fade'], ['waves', 'Waves'], ['short', 'Short crop'], ['sidepart', 'Quiff'],
      ['curly', 'Curly'], ['afro', 'Afro'], ['locs', 'Locs'], ['braids', 'Braids'], ['bun', 'Top bun'], ['bob', 'Bob'], ['medium', 'Shoulder length'],
      ['long', 'Long waves'], ['ponytail', 'Ponytail'], ['hijab', 'Hijab'], ['headwrap', 'Headwrap'], ['cap', 'Cap']],
    hairColor: HAIRC.map((x) => [x[0], x[1]]),
    brows: [['natural', 'Natural'], ['thick', 'Thick'], ['arched', 'Arched'], ['flat', 'Straight'], ['raised', 'Curious']],
    eyes: [['round', 'Bright'], ['happy', 'Happy'], ['wink', 'Wink'], ['sleepy', 'Chill'], ['wide', 'Sparkle'], ['almond', 'Almond']],
    mouth: [['smile', 'Smile'], ['grin', 'Big smile'], ['soft', 'Soft smile'], ['smirk', 'Smirk'], ['cool', 'Cool'], ['laugh', 'Laugh']],
    facial: [['none', 'None'], ['stubble', 'Stubble'], ['beard', 'Beard'], ['full', 'Full beard'], ['goatee', 'Goatee'], ['moustache', 'Moustache']],
    glasses: [['none', 'None'], ['round', 'Round'], ['square', 'Square'], ['shades', 'Shades']],
    acc: [['earrings', 'Earrings'], ['headphones', 'Headphones'], ['chain', 'Chain']],
    outfit: [['tee', 'Tee'], ['hoodie', 'Hoodie'], ['suit', 'Suit'], ['jersey', 'Jersey'], ['kaftan', 'Kaftan'], ['jacket', 'Jacket'], ['turtleneck', 'Turtleneck']],
    outfitColor: OUTC.map((x) => [x[0], x[1]]),
    bg: BGS.map((x) => [x[0], x[1]]),
  };
  const DEFAULT = { v: 1, face: 'oval', skin: 't5', hair: 'short', hairColor: 'espresso', brows: 'natural', eyes: 'round', mouth: 'smile', facial: 'none', glasses: 'none', acc: [], outfit: 'tee', outfitColor: 'blue', bg: 'blue' };
  const KEYS = Object.keys(DEFAULT);
  const has = (k, v) => OPTIONS[k].some((o) => o[0] === v);

  /**
   * A complete config. strict (server): throws an Error with a friendly message on anything unknown.
   * Not strict (drawing): anything unknown or missing becomes the default.
   */
  function clean(cfg, strict) {
    const bad = (m) => { const e = new Error(m); e.code = 'avatar_invalid'; throw e; };
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { if (strict) bad('That avatar could not be read. Make it again.'); cfg = {}; }
    const out = { ...DEFAULT, acc: [] };
    for (const k of Object.keys(cfg)) {
      if (!KEYS.includes(k)) { if (strict) bad('That avatar has an unknown part. Make it again.'); continue; }
      const v = cfg[k];
      if (k === 'v') { if (v !== 1 && strict) bad('That avatar is from an old version. Make it again.'); continue; }
      if (k === 'acc') {
        if (!Array.isArray(v) || v.length > 3) { if (strict) bad('Pick up to 3 extras.'); continue; }
        const seen = [];
        for (const a of v) {
          if (typeof a !== 'string' || !has('acc', a)) { if (strict) bad('That avatar has an unknown extra. Make it again.'); continue; }
          if (!seen.includes(a)) seen.push(a);
        }
        out.acc = seen;
        continue;
      }
      if (typeof v !== 'string' || !has(k, v)) { if (strict) bad('That avatar has an option we don\'t know. Make it again.'); continue; }
      out[k] = v;
    }
    return out;
  }

  /* ---------- the parts ---------- */
  const HEADS = {
    oval: 'M41,58 C41,38 51,29 64,29 C77,29 87,38 87,58 C87,76 77,89 64,89 C51,89 41,76 41,58Z',
    round: 'M40,60 C40,39 50,29.4 64,29.4 C78,29.4 88,39 88,60 C88,77 78,88 64,88 C50,88 40,77 40,60Z',
    square: 'M41,56 C41,37 51,29 64,29 C77,29 87,37 87,56 L87,70 C87,80.4 77.6,88.6 64,88.6 C50.4,88.6 41,80.4 41,70Z',
    long: 'M42,57 C42,37 52,27.6 64,27.6 C76,27.6 86,37 86,57 C86,78 76,91 64,91 C52,91 42,78 42,57Z',
    heart: 'M40.4,56 C40.4,37 51,29 64,29 C77,29 87.6,37 87.6,56 C87.6,71 77,86.6 64,89.4 C51,86.6 40.4,71 40.4,56Z',
  };
  const SHOULDERS = 'M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z';

  function hairParts(o, u) {
    const c = o.hc, hi = lum(c) > 0.55 ? dark(c, 0.18) : light(c, 0.22), dk = dark(c, 0.12);
    const oc = o.oc;
    const strand = (d, w, op) => `<path d="${d}" stroke="${hi}" stroke-width="${w || 2}" fill="none" stroke-linecap="round" opacity="${op || 0.75}"/>`;
    const cap = `<path d="M41.2,54 C40,36 50,27.5 64,27.5 C78,27.5 88,36 86.8,54 C85.6,46 82,41.5 76,40 C70,38.6 58,38.6 52,40 C46,41.5 42.4,46 41.2,54Z" fill="${c}"/>`;
    const circ = (pts, r, fill) => pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`).join('');
    switch (o.hair) {
      case 'none': return { front: strand('M48,36 C54,31 62,30 68,30.6', 2.4, 0.35).replace(hi, light(o.skin, 0.35)) };
      case 'buzz': return { front: `<g opacity=".82">${cap}<path d="M41.2,54 C41,50 41.4,47 42.2,45 L44,58Z M86.8,54 C87,50 86.6,47 85.8,45 L84,58Z" fill="${c}" opacity=".6"/></g>` };
      case 'fade': return { front: `<path d="M42.4,50 C42,38 43.6,24.6 64,22.6 C84.4,24.6 86,38 85.6,50 C83.4,45 79.4,42.6 74,42 Q64,40 54,42 C48.6,42.6 44.6,45 42.4,50Z" fill="${c}"/><path d="M41.6,57 C41.2,52 41.6,48.6 42.6,46.4 L44.4,58Z M86.4,57 C86.8,52 86.4,48.6 85.4,46.4 L83.6,58Z" fill="${c}" opacity=".45"/>${strand('M50,28 C56,25 66,24.4 74,26.4', 1.8, 0.6)}` };
      case 'waves': return { front: `${cap.replace('M41.2,54 C40,36 50,27.5', 'M41.4,55 C40.6,37.4 50.6,28.6')}<g fill="none" stroke="${hi}" stroke-width="1.3" stroke-linecap="round" opacity=".8"><path d="M50,35.4 q4,-2.4 8,0 q4,2.4 8,0 q4,-2.4 8,0"/><path d="M46.6,40 q4,-2.4 8,0 q4,2.4 8,0 q4,-2.4 8,0 q4,2.4 8,0"/></g>` };
      case 'short': return { front: `<path d="M40,58 C37,37 48,25 64,25 C81,25 91,37 88,58 C87,50 85,45.6 82,43 C74,44.6 62,43 54,38.6 C50,42 46,44 43.6,47.6 C41.6,51 40.6,54 40,58Z" fill="${c}"/>${strand('M57,31.5 C63,29.6 70,30 75,32.4', 1.8, 0.7)}` };
      case 'sidepart': return { front: `<path d="M40.6,58 C38.4,40 46,27 60,24 C66,22.6 74,23 79,26.4 C86.6,31 90,42 87.4,58 C86.4,50 83.4,45 79,42.6 C72,42 62,40 56,36.4 C52,41 46,46 40.6,58Z" fill="${c}"/>${strand('M58,26.4 C66,24.6 75,26.4 80,31.6', 2, 0.8)}${strand('M60,31 C55,32.6 51,35 48,38.6', 1.6, 0.6)}` };
      case 'curly': {
        const back = [];
        for (let a = 150; a <= 390; a += 20) { const t = a * Math.PI / 180; back.push([+(64 + 27 * Math.cos(t)).toFixed(1), +(50 + 25 * Math.sin(t)).toFixed(1)]); }
        const fr = [[45, 44], [51, 38.5], [58, 35.5], [65, 34.6], [72, 35.8], [78.6, 39], [83.6, 44.4]];
        return {
          back: circ(back.filter(([, y]) => y < 66), 9, c) + `<path d="M37,62 C35,40 46,24 64,24 C82,24 93,40 91,62Z" fill="${c}"/>`,
          front: `<path d="M41.4,56 C40.6,40 50,30 64,30 C78,30 87.4,40 86.6,56 C84,48 79,44 72,43 C66,42.4 60,42.4 54,43 C48,44 44,48 41.4,56Z" fill="${c}"/>` + circ(fr, 5.6, c) + fr.map(([x, y]) => `<path d="M${x - 2.6},${y + 0.6} a3,3 0 0 1 4.4,-2.6" stroke="${hi}" stroke-width="1.2" fill="none" stroke-linecap="round" opacity=".8"/>`).join(''),
        };
      }
      case 'afro': {
        const dots = [[47, 33], [54, 27.6], [62, 25], [70, 25.4], [78, 29], [83, 35.6], [51, 35], [59, 31.6], [67, 30.6], [75, 33.4], [43.6, 41], [85, 42], [38.6, 50], [89.4, 50], [36, 58], [92, 58]];
        return {
          back: `<circle cx="64" cy="44" r="31" fill="${c}"/><circle cx="38" cy="56" r="14" fill="${c}"/><circle cx="90" cy="56" r="14" fill="${c}"/>`,
          front: `<path d="M40.4,57 C37,40 45,26 56,23.2 C61,21.8 67,21.8 72,23.2 C83,26 91,40 87.6,57 C86,48.6 82,43.6 76,42.2 C68,40.8 60,40.8 52,42.2 C46,43.6 42,48.6 40.4,57Z" fill="${c}"/>` + circ(dots, 1.25, hi),
        };
      }
      case 'locs': {
        const L = (x1, x2, y2) => `<path d="M${x1},52 C${x1 - 1},70 ${x2},84 ${x2},${y2}" stroke="${c}" stroke-width="5.6" fill="none" stroke-linecap="round"/><path d="M${x1},56 C${x1 - 1},72 ${x2},84 ${x2},${y2 - 3}" stroke="${hi}" stroke-width="1.2" stroke-dasharray="2 3" fill="none" stroke-linecap="round" opacity=".7"/>`;
        return {
          back: `<path d="M35,62 C33,38 46,24 64,24 C82,24 95,38 93,62 L92,70 L36,70Z" fill="${c}"/>` + L(35, 33, 104) + L(40, 38, 108) + L(88, 90, 108) + L(93, 95, 104),
          front: cap.replace(`fill="${c}"`, `fill="${c}"`) + L(39.6, 37.6, 94) + L(88.4, 90.4, 94) + `<g fill="none" stroke="${hi}" stroke-width="1.3" stroke-linecap="round" opacity=".7"><path d="M52,33 l-2,6 M60,30.6 l-1,6 M68,30.6 l1,6 M76,33 l2,6"/></g>`,
        };
      }
      case 'braids': return {
        back: `<path d="M33,60 C31,36 46,23 64,23 C82,23 97,36 95,60 L99,108 Q93,113 86,109 L42,109 Q35,113 29,108Z" fill="${c}"/><g fill="none" stroke="${hi}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="2.6 2.2" opacity=".95"><path d="M34,66 L33,106"/><path d="M38.5,70 L38,108"/><path d="M89.5,70 L90,108"/><path d="M94,66 L95,106"/></g>`,
        front: `<path d="M40,60 C38,40 49,27 64,27 C79,27 90,40 88,60 C86.4,50 82.4,44.4 76.6,41.6 C71.6,40.4 67,38.2 64,33.4 C61,38.2 56.4,40.4 51.4,41.6 C45.6,44.4 41.6,50 40,60Z" fill="${dk}"/><g fill="none" stroke="${hi}" stroke-width="1.4" stroke-linecap="round" opacity=".9"><path d="M62,31 C57,35 50,37.6 45,44"/><path d="M66,31 C71,35 78,37.6 83,44"/></g>`,
      };
      case 'bun': return {
        back: `<circle cx="64" cy="26.5" r="13.6" fill="${c}"/>${strand('M55,23 a9.6,9.6 0 0 1 9,-7', 2.2, 0.8)}`,
        front: `<path d="M41,56 C40,38 50,28.5 64,28.5 C78,28.5 88,38 87,56 C85,46 80,40.5 74,38.8 C68,37.4 60,37.4 54,38.8 C48,40.5 43,46 41,56Z" fill="${c}"/><rect x="52" y="30.4" width="24" height="4.4" rx="2.2" fill="${oc === '#F4F7FF' ? BLUE : oc}"/>`,
      };
      case 'bob': return {
        back: `<path d="M33,60 C31,36 46,22 64,22 C82,22 97,36 95,60 L96,84 Q92,90 86,88 L42,88 Q36,90 32,84Z" fill="${dk}"/>`,
        front: `<path d="M39,64 C36,40 47.6,26 64,26 C80.4,26 92,40 89,64 C88.6,56 87,50.6 84.6,47.4 C80,49 74,49.4 69,48.6 C62,47.6 54,47.4 47.4,49 C44,51.6 41,57 39,64Z" fill="${c}"/>${strand('M47,49 C50,42 56,38.6 62,38 M66,38.4 C72,39 79,42 84,47.4', 1.6, 0.7)}<path d="M38,64 L37.4,84 Q40,88 44,86 L43,66Z M90,64 L90.6,84 Q88,88 84,86 L85,66Z" fill="${c}"/>`,
      };
      case 'medium': return {
        back: `<path d="M35,62 C33,38 46,24 64,24 C82,24 95,38 93,62 L94,90 Q88,96 80,92 L48,92 Q40,96 34,90Z" fill="${dk}"/>`,
        front: `<path d="M39.5,62 C37,40 48,26.5 65,26.5 C81,26.5 91,38 89.5,62 C88,52 84,45 78,41.5 C70,46 57,49.6 47,49 C43.6,52 41.2,56.4 39.5,62Z" fill="${c}"/>${strand('M58,30 C66,29 77,31 82,38', 2, 0.7)}`,
      };
      case 'long': return {
        back: `<path d="M33,58 C30,32 46,21 64,21 C84,21 99,34 96,58 C99,66 94,72 97.6,80 C101,88 95,94 99,104 L29,104 C33,94 27,88 30.4,80 C34,72 29,66 33,58Z" fill="${dk}"/><g fill="none" stroke="${hi}" stroke-width="2" stroke-linecap="round" opacity=".6"><path d="M35,66 q-3,7 0,13 q3,6 0,12"/><path d="M93,66 q3,7 0,13 q-3,6 0,12"/></g>`,
        front: `<path d="M39,62 C36,38 48,25.5 64,25.5 C80,25.5 92,38 89,62 C88,52 85,46 80,42.6 C74,41 74,46 68,45 C62,44 60,38.6 52,40.6 C45,42.6 41,50 39,62Z" fill="${c}"/><g fill="none" stroke="${hi}" stroke-width="1.8" stroke-linecap="round" opacity=".75"><path d="M47,33 q4,-4 9,-3"/><path d="M71,31 q5,0 9,4"/></g>`,
      };
      case 'ponytail': return {
        back: `<path d="M36,60 C34,38 47,25 64,25 C81,25 94,38 92,60Z" fill="${dk}"/><path d="M86,50 C98,58 101,76 96,92 C94,99 90,103 87,100 C91,88 92,74 84,62Z" fill="${c}"/><path d="M89,64 C93,72 94,82 92,90" stroke="${hi}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".7"/>`,
        front: `<path d="M39.5,62 C37,40 48,26.5 65,26.5 C81,26.5 91,38 89.5,62 C88,52 84,45 78,41.5 C70,44 58,44 50,40.6 C45.4,46 41.6,52 39.5,62Z" fill="${c}"/><rect x="85" y="48" width="7" height="4" rx="2" transform="rotate(35 88.5 50)" fill="${oc === '#F4F7FF' ? BLUE : oc}"/>${strand('M56,30 C64,28 74,29.6 80,34', 2, 0.7)}`,
      };
      case 'hijab': {
        const h0 = dark(oc, 0.28), h1 = dark(oc, 0.1), h2 = oc, h3 = light(oc, 0.28);
        return {
          noEars: true, noNeck: true, noEarrings: true,
          back: `<path d="M31,64 C29,38 45,21 64,21 C83,21 99,38 97,64 C98,80 96,92 100,104 Q64,122 28,104 C32,92 30,80 31,64Z" fill="${h0}"/>`,
          over: `<path d="M8,134 C8,112 26,100 46,97 Q64,108 82,97 C102,100 120,112 120,134Z" fill="${h0}"/><path d="M46,97 Q64,112 82,97 Q78,110 64,114 Q50,110 46,97Z" fill="${h1}"/>`,
          front: `<path d="M64,25 C46,25 36,40 37.5,62 C38.5,82 49,95 64,97 C79,95 89.5,82 90.5,62 C92,40 82,25 64,25Z M64,30.5 C51,30.5 42.6,40 42.4,57 C42.2,75 51,88.6 64,89.6 C77,88.6 85.8,75 85.6,57 C85.4,40 77,30.5 64,30.5Z" fill="${h2}" fill-rule="evenodd"/><path d="M46,36 C52,30 60,28.6 66,28.8" stroke="${h3}" stroke-width="2" fill="none" stroke-linecap="round" opacity=".8"/>`,
        };
      }
      case 'headwrap': {
        const w0 = dark(oc, 0.15), w1 = oc, w2 = light(oc, 0.3);
        return {
          back: `<path d="M36,54 C28,34 40,12 62,11 C84,10 102,24 94,50 C90,40 80,36 64,36 C50,36 40,42 36,54Z" fill="${w0}"/><path d="M78,16 C90,8 104,12 104,22 C98,18 90,18 84,22Z" fill="${w1}"/>`,
          front: `<path d="M39.6,54 C38,34 50,20 66,20 C82,20 92,32 88.4,54 C84,44 76,40 64,40 C52,40 44,44 39.6,54Z" fill="${w1}"/><g fill="none" stroke="${w2}" stroke-width="1.8" stroke-linecap="round" opacity=".85"><path d="M44,44 C52,34 72,30 86,38"/><path d="M46,34 C56,26 72,24 82,28"/><path d="M58,22 C66,28 74,36 76,40"/></g><path d="M40,52 C48,44 80,44 88,52 C86,49 80,47 64,47 C48,47 42,49 40,52Z" fill="${w0}"/>`,
        };
      }
      case 'cap': {
        const k0 = oc === '#F4F7FF' ? BLUE : oc, k1 = dark(k0, 0.25), k2 = light(k0, 0.25);
        return {
          front: `<path d="M41.4,58 L42,48 L46,46 L46,60Z M86.6,58 L86,48 L82,46 L82,60Z" fill="${c}"/><path d="M40,50 C40,32 51,23.6 64,23.6 C77,23.6 88,32 88,50Z" fill="${k0}"/><path d="M64,23.6 L64,50 M52,26.6 C50,34 50,42 51,50 M76,26.6 C78,34 78,42 77,50" stroke="${k1}" stroke-width="1.1" fill="none" opacity=".55"/><circle cx="64" cy="24.4" r="2.1" fill="${k1}"/><path d="M36.6,51.4 Q64,42.6 91.4,51.4 Q93,56.4 87.4,55.8 Q64,49.6 40.6,55.8 Q35,56.4 36.6,51.4Z" fill="${k1}"/><path d="M47,33 C52,28.6 58,27 62,27" stroke="${k2}" stroke-width="2" fill="none" stroke-linecap="round" opacity=".8"/>`,
        };
      }
    }
    return {};
  }

  function outfitParts(o, u) {
    const c = o.oc, d1 = dark(c, 0.18), d2 = dark(c, 0.32), l1 = light(c, 0.45);
    const isLight = lum(c) > 0.7;
    const line = isLight ? '#C9D4EE' : d1;
    switch (o.outfit) {
      case 'tee': return { body: `<path d="${SHOULDERS}" fill="${c}"/>`, collar: `<path d="M52,97.4 Q64,106 76,97.4" stroke="${line}" stroke-width="2.6" fill="none" stroke-linecap="round"/>` };
      case 'hoodie': return {
        body: `<path d="${SHOULDERS}" fill="${c}"/><path d="M44,99 C50,106 57,108.6 64,108.6 C71,108.6 78,106 84,99 L80,97 C75,102 70,104 64,104 C58,104 53,102 48,97Z" fill="${isLight ? '#DCE3F2' : d1}"/>`,
        collar: `<path d="M58.6,107 L57.6,124 M69.4,107 L70.4,124" stroke="${isLight ? '#9AA7C4' : l1}" stroke-width="1.8" stroke-linecap="round"/><circle cx="57.6" cy="125" r="1.6" fill="${isLight ? '#9AA7C4' : l1}"/><circle cx="70.4" cy="125" r="1.6" fill="${isLight ? '#9AA7C4' : l1}"/>`,
      };
      case 'suit': {
        const tie = lum(c) < 0.25 ? BLUE : c === BLUE ? '#0B1640' : BLUE;
        return {
          body: `<path d="${SHOULDERS}" fill="${c}"/>`,
          collar: `<path d="M51,97 L64,118 L77,97Z" fill="#FFFFFF"/><path d="M54,96 L64,106 L59,109 L51,99Z M74,96 L64,106 L69,109 L77,99Z" fill="#F2F5FC"/><path d="M62.2,104.6 L65.8,104.6 L67,116 L64,120 L61,116Z" fill="${tie}"/><path d="M50,98 L61,121 L57,128 L44,103Z M78,98 L67,121 L71,128 L84,103Z" fill="${isLight ? '#DCE3F2' : d1}"/>`,
        };
      }
      case 'jersey': {
        const tr = isLight ? BLUE : '#FFFFFF';
        return {
          body: `<path d="${SHOULDERS}" fill="${c}"/><path d="M20,116 C26,108 34,103 44,100" stroke="${tr}" stroke-width="2.4" fill="none" opacity=".9"/><path d="M108,116 C102,108 94,103 84,100" stroke="${tr}" stroke-width="2.4" fill="none" opacity=".9"/>`,
          collar: `<path d="M53,96.6 L64,108 L75,96.6" stroke="${tr}" stroke-width="3.2" fill="none" stroke-linejoin="round"/><path d="M75,114 l6,0 l0,5 q-3,3 -6,0Z" fill="${tr}" opacity=".95"/><path d="M45,117 l3,0 M45,120.6 l3,0" stroke="${tr}" stroke-width="1.6" opacity=".7"/>`,
        };
      }
      case 'kaftan': {
        const emb = isLight ? BLUE : lum(c) > 0.55 ? '#0B1640' : GOLD;
        return {
          body: `<defs><pattern id="${u}-kp" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect x="3" y="3" width="3" height="3" fill="${emb}" opacity=".22"/></pattern><clipPath id="${u}-kc"><path d="${SHOULDERS}"/></clipPath></defs><path d="${SHOULDERS}" fill="${c}"/><rect x="0" y="96" width="128" height="40" fill="url(#${u}-kp)" clip-path="url(#${u}-kc)"/>`,
          collar: `<path d="M49,98 Q64,109 79,98" stroke="${emb}" stroke-width="2.8" fill="none"/><path d="M57.4,104.6 L57.4,128 Q64,131 70.6,128 L70.6,104.6" stroke="${emb}" stroke-width="2.2" fill="${c}" stroke-linejoin="round"/><path d="M60.4,108.4 l3.6,3 l3.6,-3 M60.4,114.4 l3.6,3 l3.6,-3 M60.4,120.4 l3.6,3 l3.6,-3" stroke="${emb}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`,
        };
      }
      case 'jacket': return {
        body: `<path d="${SHOULDERS}" fill="${c}"/><path d="M52,98 Q64,106 76,98 L76,132 L52,132Z" fill="#FFFFFF"/><path d="M50,98 L60,124 L52,132 L40,104Z M78,98 L68,124 L76,132 L88,104Z" fill="${isLight ? '#DCE3F2' : d1}"/><path d="M45,113 L52,111" stroke="${isLight ? '#9AA7C4' : l1}" stroke-width="1.4" stroke-linecap="round"/>`,
      };
      case 'turtleneck': return {
        body: `<path d="${SHOULDERS}" fill="${c}"/>`,
        collar: `<path d="M51.6,88 C58,91 70,91 76.4,88 L78,100 Q64,106.6 50,100Z" fill="${isLight ? '#E3E9F6' : d1}"/><path d="M51,94 Q64,98.4 77,94 M50.6,98.4 Q64,103.4 77.4,98.4" stroke="${isLight ? '#C9D4EE' : d2}" stroke-width="1.3" fill="none"/>`,
      };
    }
    return { body: `<path d="${SHOULDERS}" fill="${c}"/>` };
  }

  function eyesFor(o) {
    const ey = 62;
    const dot = (x, rx, ry) => `<ellipse cx="${x}" cy="${ey}" rx="${rx}" ry="${ry}" fill="${INK}"/><circle cx="${x + 0.9}" cy="${ey - 1.2}" r="0.95" fill="#fff"/>`;
    const arc = (x) => `<path d="M${x - 3.2},${ey + 0.8} Q${x},${ey - 3.6} ${x + 3.2},${ey + 0.8}" stroke="${INK}" stroke-width="2.3" fill="none" stroke-linecap="round"/>`;
    switch (o.eyes) {
      case 'happy': return arc(54.5) + arc(73.5);
      case 'wink': return dot(54.5, 2.7, 3.3) + arc(73.5);
      case 'sleepy': return [54.5, 73.5].map((x) => `<ellipse cx="${x}" cy="${ey + 0.6}" rx="2.8" ry="2.6" fill="${INK}"/><path d="M${x - 3.6},${ey - 0.4} Q${x},${ey - 4.4} ${x + 3.6},${ey - 0.4}Z" fill="${o.skin}"/><path d="M${x - 3.6},${ey - 0.2} L${x + 3.6},${ey - 0.2}" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>`).join('');
      case 'wide': return [54.5, 73.5].map((x) => `<ellipse cx="${x}" cy="${ey}" rx="3.2" ry="3.9" fill="${INK}"/><circle cx="${x + 1.1}" cy="${ey - 1.5}" r="1.25" fill="#fff"/><circle cx="${x - 1}" cy="${ey + 1.4}" r=".6" fill="#fff"/>`).join('');
      case 'almond': return dot(54.5, 2.8, 2.4) + dot(73.5, 2.8, 2.4) + `<path d="M50.6,${ey - 1.6} Q54.5,${ey - 4.4} 58.4,${ey - 1.6} M69.6,${ey - 1.6} Q73.5,${ey - 4.4} 77.4,${ey - 1.6}" stroke="${INK}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
    }
    return dot(54.5, 2.7, 3.3) + dot(73.5, 2.7, 3.3);
  }

  function browsFor(o) {
    const by = 54.5, c = o.bc;
    const p = (d, w) => `<path d="${d}" stroke="${c}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
    switch (o.brows) {
      case 'thick': return p(`M49.4,${by + 1.2} Q54.5,${by - 2.2} 59.6,${by + 0.2}`, 3.3) + p(`M68.4,${by + 0.2} Q73.5,${by - 2.2} 78.6,${by + 1.2}`, 3.3);
      case 'arched': return p(`M49.6,${by + 1} Q53,${by - 3.4} 59.4,${by - 0.4}`, 1.8) + p(`M68.6,${by - 0.4} Q75,${by - 3.4} 78.4,${by + 1}`, 1.8);
      case 'flat': return p(`M49.6,${by + 0.4} L59.4,${by - 0.2}`, 2.6) + p(`M68.6,${by - 0.2} L78.4,${by + 0.4}`, 2.6);
      case 'raised': return p(`M49.5,${by + 1.2} Q54.5,${by - 2} 59.5,${by + 0.4}`, 2.2) + p(`M68.5,${by - 1.6} Q73.5,${by - 5} 78.5,${by - 1.4}`, 2.2);
    }
    return p(`M49.5,${by + 1.2} Q54.5,${by - 2} 59.5,${by + 0.4}`, 2.2) + p(`M68.5,${by + 0.4} Q73.5,${by - 2} 78.5,${by + 1.2}`, 2.2);
  }

  function mouthFor(o) {
    switch (o.mouth) {
      case 'grin': return '<path d="M55.4,74.4 Q64,77.4 72.6,74.4 Q71.4,83.4 64,83.6 Q56.6,83.4 55.4,74.4Z" fill="#8E2F3A"/><path d="M56.4,74.9 Q64,77.6 71.6,74.9 L71.2,77.6 Q64,79.4 56.8,77.6Z" fill="#fff"/><path d="M59.6,81.6 Q64,79.6 68.4,81.6 Q64,83.6 59.6,81.6Z" fill="#E8737E"/>';
      case 'soft': return '<path d="M58.4,76 Q64,80.4 69.6,76" stroke="#7A2A33" stroke-width="2.3" fill="none" stroke-linecap="round"/>';
      case 'smirk': return '<path d="M58,77.8 Q64,79.6 70.4,74.8" stroke="#7A2A33" stroke-width="2.3" fill="none" stroke-linecap="round"/><path d="M70.4,74.8 l1.4,-0.6" stroke="#7A2A33" stroke-width="1.6" stroke-linecap="round" opacity=".6"/>';
      case 'cool': return '<path d="M58.6,77.2 Q64,78.6 69.4,76.6" stroke="#7A2A33" stroke-width="2.3" fill="none" stroke-linecap="round"/>';
      case 'laugh': return '<path d="M55.8,74 Q64,75.6 72.2,74 Q71.6,85.6 64,86 Q56.4,85.6 55.8,74Z" fill="#7E2532"/><path d="M57,74.4 Q64,75.8 71,74.4 L70.6,76.8 Q64,78.2 57.4,76.8Z" fill="#fff"/><path d="M59,83 Q64,79.4 69,83 Q64,86.4 59,83Z" fill="#EE7C88"/>';
    }
    return '<path d="M57.2,75.2 Q64,77.2 70.8,75.2 Q69.6,81.6 64,81.8 Q58.4,81.6 57.2,75.2Z" fill="#8E2F3A"/><path d="M58.4,75.6 Q64,77.2 69.6,75.6 L69.2,77.2 Q64,78.4 58.8,77.2Z" fill="#fff"/><path d="M60.4,80.4 Q64,79 67.6,80.4 Q64,81.9 60.4,80.4Z" fill="#E8737E" opacity=".9"/>';
  }

  function facialFor(o) {
    const c = o.fc;
    switch (o.facial) {
      case 'stubble': return `<path d="M43,64 C43.6,79 52,89.4 64,89.4 C76,89.4 84.4,79 85,64 C83.6,74 79,80.6 73,82.4 C70,84 67,84.6 64,84.6 C61,84.6 58,84 55,82.4 C49,80.6 44.4,74 43,64Z" fill="${c}" opacity=".3"/><path d="M57,73.6 Q64,71.6 71,73.6" stroke="${c}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".3"/>`;
      case 'beard': return `<path d="M42.6,63 C43,79 52,90 64,90 C76,90 85,79 85.4,63 C84.4,72 81,78 77,79 C73,83 69,84.6 64,84.6 C59,84.6 55,83 51,79 C47,78 43.6,72 42.6,63Z" fill="${c}" opacity=".82"/><path d="M57,73.4 Q64,71.4 71,73.4" stroke="${c}" stroke-width="1.9" fill="none" stroke-linecap="round" opacity=".85"/>`;
      case 'full': return `<path d="M42,62 C42,82 52,93 64,93 C76,93 86,82 86,62 C84,70 80,73 76,73 C72,78.6 68,80 64,80 C60,80 56,78.6 52,73 C48,73 44,70 42,62Z" fill="${c}"/><path d="M55,73.4 Q64,69.6 73,73.4 Q64,72.4 55,73.4Z" fill="${c}"/>`;
      case 'goatee': return `<path d="M56.6,73.8 Q64,70.4 71.4,73.8 Q64,72.6 56.6,73.8Z" fill="${c}"/><path d="M59.4,82.6 Q64,84.4 68.6,82.6 L67.6,88 Q64,89.6 60.4,88Z" fill="${c}"/>`;
      case 'moustache': return `<path d="M56,74.2 Q60,70.6 64,72.4 Q68,70.6 72,74.2 Q68,73 64,74 Q60,73 56,74.2Z" fill="${c}"/>`;
    }
    return '';
  }

  function glassesFor(o, u) {
    const ey = 62;
    switch (o.glasses) {
      case 'round': return `<g fill="none" stroke="#B88A22" stroke-width="1.9"><circle cx="54.5" cy="${ey}" r="6.6"/><circle cx="73.5" cy="${ey}" r="6.6"/><path d="M61.1,${ey - 1} Q64,${ey - 3} 66.9,${ey - 1}"/><path d="M47.9,${ey - 1.6} L42,${ey - 3.4}M80.1,${ey - 1.6} L86,${ey - 3.4}"/></g>`;
      case 'square': return `<g fill="none" stroke="#0B1640" stroke-width="2.1"><rect x="46.6" y="${ey - 5.8}" width="15.2" height="11.6" rx="3.2"/><rect x="66.2" y="${ey - 5.8}" width="15.2" height="11.6" rx="3.2"/><path d="M61.8,${ey - 1.2} Q64,${ey - 3} 66.2,${ey - 1.2}"/><path d="M46.6,${ey - 2} L42,${ey - 3.4}M81.4,${ey - 2} L86,${ey - 3.4}"/></g>`;
      case 'shades': return `<defs><linearGradient id="${u}-sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26305C"/><stop offset="1" stop-color="#0B1022"/></linearGradient></defs><g stroke="#0B1022" stroke-width="1.6"><path d="M45.6,${ey - 5.4} L62.4,${ey - 5.4} L61.4,${ey + 2.4} Q60.6,${ey + 6.4} 54,${ey + 6.4} Q47.4,${ey + 6.4} 46.4,${ey + 2.4}Z" fill="url(#${u}-sh)"/><path d="M65.6,${ey - 5.4} L82.4,${ey - 5.4} L81.6,${ey + 2.4} Q80.6,${ey + 6.4} 74,${ey + 6.4} Q67.4,${ey + 6.4} 66.6,${ey + 2.4}Z" fill="url(#${u}-sh)"/><path d="M62.4,${ey - 4} Q64,${ey - 5.4} 65.6,${ey - 4}" fill="none"/><path d="M45.6,${ey - 4.6} L41.6,${ey - 5.6}M82.4,${ey - 4.6} L86.4,${ey - 5.6}" fill="none"/></g><path d="M49,${ey - 2.6} L52.4,${ey - 3.4} M69,${ey - 2.6} L72.4,${ey - 3.4}" stroke="#fff" stroke-width="1.5" opacity=".45" fill="none" stroke-linecap="round"/>`;
    }
    return '';
  }

  function bgFor(o, u) {
    const b = BGS.find((x) => x[0] === o.bg) || BGS[0];
    const [, , kind, c1, c2] = b;
    let defs = '', fill = '', over = '';
    if (kind === 's') fill = c1;
    else {
      defs += `<linearGradient id="${u}-bg" x1="0" y1="0" x2="${kind === 'p' ? 1 : 0}" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`;
      fill = `url(#${u}-bg)`;
    }
    if (o.bg === 'dots') { defs += `<pattern id="${u}-pt" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.6" fill="#fff" opacity=".28"/><circle cx="9" cy="9" r="1.6" fill="#fff" opacity=".16"/></pattern>`; over = `<rect width="128" height="128" fill="url(#${u}-pt)"/>`; }
    if (o.bg === 'rings') over = [56, 46, 36, 26].map((r, i) => `<circle cx="64" cy="58" r="${r}" fill="none" stroke="#fff" stroke-width="5" opacity="${0.5 - i * 0.08}"/>`).join('');
    if (o.bg === 'stripes') { defs += `<pattern id="${u}-pt" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="7" height="14" fill="#fff" opacity=".1"/></pattern>`; over = `<rect width="128" height="128" fill="url(#${u}-pt)"/>`; }
    if (o.bg === 'burst') over = Array.from({ length: 12 }, (_, i) => `<path d="M64,58 L${(64 + 120 * Math.cos((i * 30 - 4) * Math.PI / 180)).toFixed(1)},${(58 + 120 * Math.sin((i * 30 - 4) * Math.PI / 180)).toFixed(1)} L${(64 + 120 * Math.cos((i * 30 + 6) * Math.PI / 180)).toFixed(1)},${(58 + 120 * Math.sin((i * 30 + 6) * Math.PI / 180)).toFixed(1)}Z" fill="#fff" opacity=".22"/>`).join('');
    const ring = kind === 'g' && o.bg !== 'night' ? '<circle cx="64" cy="58" r="50" fill="#fff" opacity=".24"/>' : kind === 'g' ? '<circle cx="64" cy="58" r="50" fill="#fff" opacity=".07"/>' : '';
    return { defs, base: `<rect width="128" height="128" fill="${fill}"/>` + over + ring };
  }

  let uidN = 0;
  /** The avatar as an <svg> string. opts: { size: 40, label: 'Your avatar', live: false, cls: '' } */
  function render(cfg, opts) {
    opts = opts || {};
    const o = clean(cfg, false);
    const u = 'av' + (++uidN).toString(36);
    const sk = SKIN.find((x) => x[0] === o.skin) || SKIN[4];
    o.skin = sk[2]; o.shade = sk[3];
    o.hc = (HAIRC.find((x) => x[0] === o.hairColor) || HAIRC[1])[2];
    o.oc = (OUTC.find((x) => x[0] === o.outfitColor) || OUTC[0])[2];
    o.bc = lum(o.hc) > 0.5 ? dark(o.hc, 0.35) : o.hair === 'none' || o.hair === 'hijab' || o.hair === 'headwrap' || o.hair === 'cap' ? dark(o.hc, 0.05) : dark(o.hc, 0.1);
    o.fc = o.hair === 'none' || o.hair === 'hijab' || o.hair === 'headwrap' ? dark(o.hc, 0.05) : o.hc;
    const H = hairParts(o, u), O = outfitParts(o, u), B = bgFor(o, u);
    const head = HEADS[o.face] || HEADS.oval;
    const s = o.skin, sh = o.shade;
    const big = ['afro', 'headwrap', 'curly', 'locs', 'fade', 'bun'].includes(o.hair);
    const p = [];
    p.push(B.base);
    p.push(`<g class="av-fig"><g transform="translate(64 124) scale(1.12) translate(-64 -124)">`);
    if (H.back) p.push(H.back);
    p.push(O.body || '');
    if (!H.noNeck) p.push(`<path d="M54,76 L54,98 Q64,106 74,98 L74,76Z" fill="${s}"/><path d="M54,84 Q64,92 74,84 L74,78 L54,78Z" fill="${sh}" opacity=".55"/>`);
    if (O.collar) p.push(O.collar);
    if (H.over) p.push(H.over);
    if (o.acc.includes('chain') && o.hair !== 'hijab') p.push(`<path d="M54.6,97.6 Q64,111 73.4,97.6" stroke="${GOLD}" stroke-width="1.7" fill="none" stroke-dasharray="1.8 1.1"/><circle cx="64" cy="106.6" r="2.6" fill="${GOLD}"/><circle cx="63.2" cy="105.8" r=".8" fill="#fff" opacity=".7"/>`);
    if (!H.noEars) p.push(`<ellipse cx="40.5" cy="63" rx="5" ry="6.6" fill="${s}"/><ellipse cx="87.5" cy="63" rx="5" ry="6.6" fill="${s}"/><path d="M39.5,60 q2.4,3 0,6.5" stroke="${sh}" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M88.5,60 q-2.4,3 0,6.5" stroke="${sh}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`);
    if (o.acc.includes('earrings') && !H.noEarrings) p.push(`<circle cx="40.5" cy="73" r="3.3" fill="none" stroke="${GOLD}" stroke-width="1.6"/><circle cx="87.5" cy="73" r="3.3" fill="none" stroke="${GOLD}" stroke-width="1.6"/>`);
    p.push(`<defs><clipPath id="${u}-hd"><path d="${head}"/></clipPath></defs><path d="${head}" fill="${s}"/><g clip-path="url(#${u}-hd)"><path d="${head}" fill="${sh}" opacity=".35"/><path d="${head}" fill="${s}" transform="translate(0 -4.6)"/></g>`);
    p.push(facialFor(o));
    p.push(`<ellipse cx="50.5" cy="71" rx="4.6" ry="2.8" fill="#F07A7A" opacity="${lum(s) < 0.4 ? 0.12 : 0.22}"/><ellipse cx="77.5" cy="71" rx="4.6" ry="2.8" fill="#F07A7A" opacity="${lum(s) < 0.4 ? 0.12 : 0.22}"/>`);
    p.push(`<g class="av-eyes">${eyesFor(o)}</g>`);
    p.push(browsFor(o));
    p.push(`<path d="M64,64 C63.4,67 62.2,69 61.6,70.2 Q63.4,71.6 66.4,70.6" stroke="${sh}" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    p.push(mouthFor(o));
    if (H.front) p.push(H.front);
    p.push(glassesFor(o, u));
    if (o.acc.includes('headphones')) {
      const top = big ? 10 : 22;
      p.push(`<path d="M37.6,62 C34,${top} 94,${top} 90.4,62" stroke="#0B1640" stroke-width="4.6" fill="none" stroke-linecap="round"/><path d="M38.8,58 C37,${top + 6} 91,${top + 6} 89.2,58" stroke="#3A4A80" stroke-width="1.2" fill="none" opacity=".6"/><rect x="31.6" y="55" width="10" height="18" rx="4.6" fill="#0B1640"/><rect x="86.4" y="55" width="10" height="18" rx="4.6" fill="#0B1640"/><rect x="33.6" y="58" width="3" height="12" rx="1.5" fill="${BLUE}"/><rect x="91.4" y="58" width="3" height="12" rx="1.5" fill="${BLUE}"/>`);
    }
    p.push('</g></g>');
    const size = Number(opts.size) || 40;
    const label = String(opts.label || 'Avatar').replace(/[&<>"']/g, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" class="avsvg${opts.live ? ' av-live' : ''}${opts.cls ? ' ' + String(opts.cls).replace(/[^\w -]/g, '') : ''}" role="img" aria-label="${label}"><defs>${B.defs}<clipPath id="${u}-c"><rect width="128" height="128" rx="64"/></clipPath></defs><g clip-path="url(#${u}-c)">${p.join('')}</g></svg>`;
  }

  /* ---------- random and presets ---------- */
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const keysOf = (k) => OPTIONS[k].map((x) => x[0]);
  function random() {
    const hair = pick(keysOf('hair'));
    const longish = ['braids', 'bun', 'bob', 'medium', 'long', 'ponytail', 'hijab', 'headwrap'].includes(hair);
    const r = Math.random();
    return clean({
      face: pick(keysOf('face')), skin: pick(keysOf('skin')), hair,
      hairColor: Math.random() < 0.8 ? pick(['black', 'espresso', 'brown', 'chestnut', 'auburn', 'blonde']) : pick(keysOf('hairColor')),
      brows: pick(keysOf('brows')), eyes: Math.random() < 0.5 ? 'round' : pick(keysOf('eyes')),
      mouth: pick(['smile', 'grin', 'soft', 'smile', 'smirk', 'cool', 'laugh']),
      facial: longish || r < 0.5 ? 'none' : pick(['stubble', 'beard', 'full', 'goatee', 'moustache']),
      glasses: Math.random() < 0.6 ? 'none' : pick(['round', 'square', 'shades']),
      acc: keysOf('acc').filter(() => Math.random() < 0.22),
      outfit: pick(keysOf('outfit')), outfitColor: pick(keysOf('outfitColor')),
      bg: Math.random() < 0.55 ? pick(['blue', 'royal', 'sky', 'rings', 'dots']) : pick(keysOf('bg')),
    });
  }
  const PR = (face, skin, hair, hairColor, brows, eyes, mouth, facial, glasses, acc, outfit, outfitColor, bg) => clean({ face, skin, hair, hairColor, brows, eyes, mouth, facial, glasses, acc, outfit, outfitColor, bg });
  const PRESETS = [
    PR('oval', 't8', 'fade', 'black', 'thick', 'round', 'grin', 'beard', 'none', ['chain'], 'hoodie', 'navy', 'royal'),
    PR('heart', 't9', 'braids', 'black', 'arched', 'round', 'smile', 'none', 'none', ['earrings'], 'tee', 'sky', 'blue'),
    PR('square', 't10', 'waves', 'black', 'natural', 'round', 'smirk', 'goatee', 'none', [], 'kaftan', 'white', 'sand'),
    PR('oval', 't2', 'medium', 'espresso', 'arched', 'round', 'smile', 'none', 'none', ['earrings'], 'turtleneck', 'navy', 'blue'),
    PR('round', 't9', 'afro', 'black', 'natural', 'happy', 'laugh', 'none', 'round', [], 'jersey', 'green', 'mint'),
    PR('oval', 't5', 'sidepart', 'brown', 'natural', 'round', 'cool', 'stubble', 'shades', [], 'jacket', 'navy', 'night'),
    PR('oval', 't6', 'hijab', 'black', 'arched', 'round', 'smile', 'none', 'none', [], 'tee', 'blue', 'rings'),
    PR('long', 't8', 'locs', 'black', 'thick', 'sleepy', 'soft', 'full', 'none', ['headphones'], 'hoodie', 'black', 'stripes'),
    PR('heart', 't3', 'bob', 'auburn', 'arched', 'wide', 'grin', 'none', 'none', [], 'tee', 'white', 'blush'),
    PR('square', 't4', 'short', 'black', 'flat', 'almond', 'smile', 'none', 'square', [], 'suit', 'navy', 'white'),
    PR('oval', 't10', 'headwrap', 'black', 'arched', 'round', 'grin', 'none', 'none', ['earrings'], 'kaftan', 'gold', 'burst'),
    PR('round', 't7', 'ponytail', 'black', 'natural', 'wink', 'smile', 'none', 'none', [], 'jacket', 'blue', 'sky'),
    PR('oval', 't1', 'long', 'blonde', 'arched', 'round', 'soft', 'none', 'none', ['earrings'], 'tee', 'coral', 'sand'),
    PR('square', 't8', 'none', 'black', 'thick', 'round', 'grin', 'full', 'none', [], 'suit', 'blue', 'royal'),
    PR('oval', 't9', 'bun', 'black', 'arched', 'happy', 'smile', 'none', 'none', ['earrings', 'chain'], 'turtleneck', 'purple', 'lilac'),
    PR('long', 't3', 'curly', 'chestnut', 'natural', 'round', 'smirk', 'none', 'round', [], 'jersey', 'red', 'white'),
    PR('oval', 't6', 'cap', 'black', 'natural', 'round', 'cool', 'stubble', 'none', ['chain'], 'hoodie', 'navy', 'dots'),
    PR('oval', 't7', 'medium', 'espresso', 'arched', 'almond', 'grin', 'none', 'square', [], 'suit', 'grey', 'blue'),
    PR('round', 't10', 'buzz', 'black', 'thick', 'round', 'laugh', 'moustache', 'none', [], 'jersey', 'gold', 'burst'),
    PR('heart', 't5', 'braids', 'violet', 'arched', 'wide', 'smile', 'none', 'none', ['headphones'], 'hoodie', 'purple', 'night'),
    PR('square', 't2', 'sidepart', 'ginger', 'natural', 'round', 'smile', 'beard', 'none', [], 'jacket', 'olive', 'mint'),
    PR('oval', 't8', 'long', 'black', 'arched', 'sleepy', 'smirk', 'none', 'shades', ['earrings'], 'tee', 'black', 'stripes'),
    PR('long', 't4', 'none', 'grey', 'natural', 'happy', 'soft', 'beard', 'round', [], 'kaftan', 'navy', 'rings'),
    PR('round', 't9', 'afro', 'espresso', 'natural', 'round', 'grin', 'none', 'none', ['earrings', 'headphones'], 'tee', 'blue', 'dots'),
  ];

  /** The name for greetings: nickname > first name > email prefix (never the whole email). */
  function greetName(user) {
    const u = user || {};
    const nick = String(u.nickname || '').trim();
    if (nick) return nick;
    const first = String(u.name || '').trim().split(/\s+/)[0] || '';
    if (first) return first;
    return String(u.email || '').split('@')[0] || '';
  }

  const AV = { OPTIONS, DEFAULT, KEYS, clean, render, random, PRESETS, greetName, NICK_MAX: 24 };
  if (typeof module !== 'undefined' && module.exports) module.exports = AV;
  else root.AV = AV;
}(typeof window !== 'undefined' ? window : this));
