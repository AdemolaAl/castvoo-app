'use strict';
/*
 * Generates the support-agent face SVGs (flat illustration, head & shoulders, 128x128, ids prefixed with the key).
 *   node scripts/agent-faces.js            writes public/img/agents/<key>.svg
 *   node scripts/agent-faces.js /tmp/out   writes somewhere else (to compare before replacing)
 * After adding a face here, add its key to FACES in server/services/support-ai.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.argv[2] || path.join(__dirname, '..', 'public', 'img', 'agents');
fs.mkdirSync(OUT, { recursive: true });

const INK = '#1B1530';

function face(o) {
  const id = o.key;
  const s = o.skin, sh = o.shade;
  const parts = [];
  const defs = [];
  defs.push(`<linearGradient id="${id}-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${o.bg[0]}"/><stop offset="1" stop-color="${o.bg[1]}"/></linearGradient>`);
  defs.push(`<clipPath id="${id}-c"><circle cx="64" cy="64" r="64"/></clipPath>`);
  parts.push(`<circle cx="64" cy="64" r="64" fill="url(#${id}-bg)"/>`);
  parts.push(`<g clip-path="url(#${id}-c)">`);
  // soft decorative ring
  parts.push(`<circle cx="64" cy="58" r="50" fill="#fff" opacity=".28"/>`);
  parts.push(`<g transform="translate(64 124) scale(${o.scale || 1.12}) translate(-64 -124)">`);
  if (o.hairBack) parts.push(o.hairBack);
  // shoulders / clothing
  parts.push(o.body || `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="${o.top}"/>`);
  // neck
  if (!o.noNeck) {
    parts.push(`<path d="M54,76 L54,98 Q64,106 74,98 L74,76Z" fill="${s}"/>`);
    parts.push(`<path d="M54,84 Q64,92 74,84 L74,78 L54,78Z" fill="${sh}" opacity=".55"/>`);
  }
  if (o.collar) parts.push(o.collar);
  // ears
  if (!o.noEars) {
    parts.push(`<ellipse cx="40.5" cy="63" rx="5" ry="6.6" fill="${s}"/><ellipse cx="87.5" cy="63" rx="5" ry="6.6" fill="${s}"/>`);
    parts.push(`<path d="M39.5,60 q2.4,3 0,6.5" stroke="${sh}" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M88.5,60 q-2.4,3 0,6.5" stroke="${sh}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`);
  }
  if (o.earrings) parts.push(o.earrings);
  // head
  const head = o.headPath || 'M41,58 C41,38 51,29 64,29 C77,29 87,38 87,58 C87,76 77,89 64,89 C51,89 41,76 41,58Z';
  parts.push(`<path d="${head}" fill="${s}"/>`);
  // jaw shade
  parts.push(`<path d="M44,70 C48,82 56,89 64,89 C72,89 80,82 84,70 C80,80 72,85 64,85 C56,85 48,80 44,70Z" fill="${sh}" opacity=".35"/>`);
  if (o.beard) parts.push(o.beard);
  // cheeks
  parts.push(`<ellipse cx="50.5" cy="71" rx="4.6" ry="2.8" fill="${o.blush || '#F07A7A'}" opacity="${o.blushOp ?? 0.22}"/><ellipse cx="77.5" cy="71" rx="4.6" ry="2.8" fill="${o.blush || '#F07A7A'}" opacity="${o.blushOp ?? 0.22}"/>`);
  // eyes
  const ey = o.eyeY || 62;
  const eye = (x) => `<ellipse cx="${x}" cy="${ey}" rx="2.7" ry="${o.eyeRy || 3.3}" fill="${INK}"/><circle cx="${x + 0.9}" cy="${ey - 1.2}" r="0.95" fill="#fff"/>`;
  parts.push(eye(54.5) + eye(73.5));
  if (o.lashes) parts.push(`<path d="M51.2,59.6 l-1.8,-1.2 M76.8,59.6 l1.8,-1.2" stroke="${INK}" stroke-width="1.3" stroke-linecap="round"/>`);
  // brows
  const by = ey - 7.5;
  const bc = o.brow || INK;
  parts.push(`<path d="M49.5,${by + 1.2} Q54.5,${by - 2} 59.5,${by + 0.4}" stroke="${bc}" stroke-width="${o.browW || 2.2}" fill="none" stroke-linecap="round"/><path d="M68.5,${by + 0.4} Q73.5,${by - 2} 78.5,${by + 1.2}" stroke="${bc}" stroke-width="${o.browW || 2.2}" fill="none" stroke-linecap="round"/>`);
  // nose
  parts.push(`<path d="M64,64 C63.4,67 62.2,69 61.6,70.2 Q63.4,71.6 66.4,70.6" stroke="${sh}" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
  // mouth: gentle open smile
  if (!o.beardHidesMouth) {
    parts.push(`<path d="M57.2,75.2 Q64,77.2 70.8,75.2 Q69.6,81.6 64,81.8 Q58.4,81.6 57.2,75.2Z" fill="#8E2F3A"/>`);
    parts.push(`<path d="M58.4,75.6 Q64,77.2 69.6,75.6 L69.2,77.2 Q64,78.4 58.8,77.2Z" fill="#fff"/>`);
    parts.push(`<path d="M60.4,80.4 Q64,79 67.6,80.4 Q64,81.9 60.4,80.4Z" fill="#E8737E" opacity=".9"/>`);
  } else parts.push(o.mouth);
  if (o.hairFront) parts.push(o.hairFront);
  if (o.glasses) parts.push(`<g fill="none" stroke="${o.glasses}" stroke-width="2"><rect x="46.6" y="${ey - 5.8}" width="15.2" height="11.6" rx="4.6"/><rect x="66.2" y="${ey - 5.8}" width="15.2" height="11.6" rx="4.6"/><path d="M61.8,${ey - 1.2} Q64,${ey - 3} 66.2,${ey - 1.2}"/><path d="M46.6,${ey - 2} L42,${ey - 3.4}M81.4,${ey - 2} L86,${ey - 3.4}"/></g>`);
  if (o.extra) parts.push(o.extra);
  parts.push('</g></g>');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="${o.label}"><defs>${defs.join('')}</defs>${parts.join('')}</svg>\n`;
}

const BLUE = '#2F6BFF', BLUE_D = '#1D4FD8', BLUE_L = '#8FB0FF', NAVY = '#0B1640', NAVY2 = '#060C26', WHITE = '#FFFFFF';

const FACES = [
  {
    key: 'mia', label: 'Mia', gender: 'f', bg: ['#EAF1FF', '#CFE0FF'],
    skin: '#F2C7A2', shade: '#D9A27C', brow: '#3A2418', lashes: true,
    hairBack: `<path d="M35,62 C33,38 46,24 64,24 C82,24 95,38 93,62 L94,90 Q88,96 80,92 L48,92 Q40,96 34,90Z" fill="#2E1D16"/>`,
    hairFront: `<path d="M39.5,62 C37,40 48,26.5 65,26.5 C81,26.5 91,38 89.5,62 C88,52 84,45 78,41.5 C70,46 57,49.6 47,49 C43.6,52 41.2,56.4 39.5,62Z" fill="#3A251B"/><path d="M58,30 C66,29 77,31 82,38" stroke="#6B4630" stroke-width="2" fill="none" stroke-linecap="round" opacity=".7"/>`,
    top: BLUE, collar: `<path d="M50,98 L64,110 L78,98 L72,96 L64,103 L56,96Z" fill="${WHITE}"/>`,
    earrings: `<circle cx="40.5" cy="71.5" r="1.8" fill="#FFD27A"/><circle cx="87.5" cy="71.5" r="1.8" fill="#FFD27A"/>`,
  },
  {
    key: 'daniel', label: 'Daniel', gender: 'm', bg: ['#E6EEFF', '#C9DAFF'],
    skin: '#8A5536', shade: '#6C3E24', brow: '#160E0B', blushOp: 0.12, browW: 2.6,
    hairFront: `<path d="M41.2,54 C40,36 50,27.5 64,27.5 C78,27.5 88,36 86.8,54 C85.6,46 82,41.5 76,40 C70,38.6 58,38.6 52,40 C46,41.5 42.4,46 41.2,54Z" fill="#17100D"/><path d="M41.2,54 C41,50 41.4,47 42.2,45 L44,58Z M86.8,54 C87,50 86.6,47 85.8,45 L84,58Z" fill="#17100D" opacity=".55"/>`,
    beard: `<path d="M42.6,63 C43,79 52,90 64,90 C76,90 85,79 85.4,63 C84.4,72 81,78 77,79 C73,83 69,84.6 64,84.6 C59,84.6 55,83 51,79 C47,78 43.6,72 42.6,63Z" fill="#1D130F" opacity=".7"/><path d="M57,73.4 Q64,71.4 71,73.4" stroke="#1D130F" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".75"/>`,
    top: NAVY, collar: `<path d="M51,97.5 Q64,108 77,97.5 L74,96 Q64,103 54,96Z" fill="${BLUE}"/>`,
  },
  {
    key: 'amara', label: 'Amara', gender: 'f', scale: 1.08, bg: ['#EEF3FF', '#D3E2FF'],
    skin: '#7B4A2D', shade: '#5E341C', brow: '#140D0A', lashes: true, blushOp: 0.14,
    hairBack: `<circle cx="64" cy="27.5" r="13.6" fill="#1C130F"/><path d="M55,24 a9.6,9.6 0 0 1 9,-7" stroke="#3A2A22" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    hairFront: `<path d="M41,56 C40,38 50,28.5 64,28.5 C78,28.5 88,38 87,56 C85,46 80,40.5 74,38.8 C68,37.4 60,37.4 54,38.8 C48,40.5 43,46 41,56Z" fill="#1C130F"/><rect x="51" y="31" width="26" height="4.6" rx="2.3" fill="${BLUE}"/>`,
    earrings: `<circle cx="40.5" cy="73" r="3.4" fill="none" stroke="#FFC857" stroke-width="1.6"/><circle cx="87.5" cy="73" r="3.4" fill="none" stroke="#FFC857" stroke-width="1.6"/>`,
    top: WHITE, body: `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="${BLUE}"/><path d="M48,98 L80,98 L74,132 L54,132Z" fill="${WHITE}"/>`,
  },
  {
    key: 'leo', label: 'Leo', gender: 'm', bg: ['#E9F0FF', '#CDDDFF'],
    skin: '#D49A63', shade: '#B67B47', brow: '#3D2716', glasses: '#0B1640',
    hairFront: `<path d="M40.5,58 C38,38 49,25.5 64,25.5 C80,25.5 90.5,37 87.5,58 C86,50 83,45 78,42.4 C77,46 72,47 69,44.6 C66,47.6 60,48 57.4,44.6 C54,47.6 49,46.6 48,43.4 C44.4,46 42,51 40.5,58Z" fill="#4A2F1C"/><path d="M52,31 C57,28.4 64,28 70,29.6 M72,32 C77,33 81,36 83,40" stroke="#7A5232" stroke-width="2" fill="none" stroke-linecap="round" opacity=".75"/>`,
    top: BLUE_L, body: `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="${NAVY}"/><path d="M50,98 L64,113 L78,98 L80,132 L48,132Z" fill="#DCE7FF"/>`,
    collar: `<path d="M53,96 L64,108 L58,110 L50,99Z M75,96 L64,108 L70,110 L78,99Z" fill="#FFFFFF"/>`,
  },
  {
    key: 'aisha', label: 'Aisha', gender: 'f', noEars: true, noNeck: true, bg: ['#EDF2FF', '#D0DFFF'],
    skin: '#C88C5E', shade: '#A86E44', brow: '#2A1A12', lashes: true,
    hairBack: `<path d="M31,64 C29,38 45,21 64,21 C83,21 99,38 97,64 C98,80 96,92 100,104 Q64,122 28,104 C32,92 30,80 31,64Z" fill="#1E3A8A"/>`,
    body: `<path d="M8,134 C8,112 26,100 46,97 Q64,108 82,97 C102,100 120,112 120,134Z" fill="#1E3A8A"/><path d="M46,97 Q64,112 82,97 Q78,110 64,114 Q50,110 46,97Z" fill="#284AA8"/>`,
    hairFront: `<path d="M64,25 C46,25 36,40 37.5,62 C38.5,82 49,95 64,97 C79,95 89.5,82 90.5,62 C92,40 82,25 64,25Z M64,30.5 C51,30.5 42.6,40 42.4,57 C42.2,75 51,88.6 64,89.6 C77,88.6 85.8,75 85.6,57 C85.4,40 77,30.5 64,30.5Z" fill="#2F57CF" fill-rule="evenodd"/><path d="M46,36 C52,30 60,28.6 66,28.8" stroke="#5B7FE6" stroke-width="2" fill="none" stroke-linecap="round" opacity=".8"/>`,
    top: '#1E3A8A',
  },
  {
    key: 'kenji', label: 'Kenji', gender: 'm', bg: ['#E8EFFF', '#CADBFF'],
    skin: '#F3D1AE', shade: '#D9AE86', brow: '#16151B', eyeRy: 2.6,
    hairFront: `<path d="M40,58 C37,37 48,25 64,25 C81,25 91,37 88,58 C87,50 85,45.6 82,43 C74,44.6 62,43 54,38.6 C50,42 46,44 43.6,47.6 C41.6,51 40.6,54 40,58Z" fill="#14151B"/><path d="M57,31.5 C63,29.6 70,30 75,32.4" stroke="#3E414F" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".7"/>`,
    top: NAVY2, body: `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="${NAVY2}"/><path d="M47,98 Q64,116 81,98" stroke="${BLUE}" stroke-width="4" fill="none"/><path d="M58,108 L58,122 M70,108 L70,122" stroke="#C9D8FF" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  {
    key: 'sofia', label: 'Sofia', gender: 'f', bg: ['#ECF2FF', '#D2E1FF'],
    skin: '#E2AD80', shade: '#C38B5E', brow: '#3A2014', lashes: true,
    hairBack: `<path d="M33,58 C30,32 46,21 64,21 C84,21 99,34 96,58 C99,66 94,72 97.6,80 C101,88 95,94 99,104 L29,104 C33,94 27,88 30.4,80 C34,72 29,66 33,58Z" fill="#3A2216"/><g fill="none" stroke="#5A3626" stroke-width="2" stroke-linecap="round" opacity=".8"><path d="M35,66 q-3,7 0,13 q3,6 0,12"/><path d="M93,66 q3,7 0,13 q-3,6 0,12"/></g>`,
    hairFront: `<path d="M39,62 C36,38 48,25.5 64,25.5 C80,25.5 92,38 89,62 C88,52 85,46 80,42.6 C74,41 74,46 68,45 C62,44 60,38.6 52,40.6 C45,42.6 41,50 39,62Z" fill="#4B2C1D"/><g fill="none" stroke="#6E4630" stroke-width="1.8" stroke-linecap="round" opacity=".75"><path d="M47,33 q4,-4 9,-3"/><path d="M71,31 q5,0 9,4"/></g>`,
    top: WHITE, body: `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="${WHITE}"/><path d="M40,100 C36,112 36,124 38,132 L28,132 C26,118 28,108 40,100Z M88,100 C92,112 92,124 90,132 L100,132 C102,118 100,108 88,100Z" fill="${BLUE}"/>`,
    earrings: `<circle cx="40.5" cy="71.5" r="1.8" fill="#FFD27A"/><circle cx="87.5" cy="71.5" r="1.8" fill="#FFD27A"/>`,
  },
  {
    key: 'tunde', label: 'Tunde', gender: 'm', bg: ['#E7EEFF', '#C8D9FF'],
    skin: '#5E3822', shade: '#462713', brow: '#0F0907', blushOp: 0.1, browW: 2.6,
    headPath: 'M41,58 C41,37 51,28 64,28 C77,28 87,37 87,58 C87,76 77,89 64,89 C51,89 41,76 41,58Z',
    hairFront: `<path d="M48,36 C54,31 62,30 68,30.6" stroke="#7A4D33" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".6"/>`,
    beard: `<path d="M42,62 C42,82 52,93 64,93 C76,93 86,82 86,62 C84,70 80,73 76,73 C72,78.6 68,80 64,80 C60,80 56,78.6 52,73 C48,73 44,70 42,62Z" fill="#120B08"/><path d="M55,73.4 Q64,69.6 73,73.4 Q64,72.4 55,73.4Z" fill="#120B08"/>`,
    top: BLUE, collar: `<path d="M50,97 L58,108 L64,100 L70,108 L78,97 L74,95 L64,101 L54,95Z" fill="${WHITE}"/><circle cx="64" cy="112" r="1.3" fill="${WHITE}"/><circle cx="64" cy="119" r="1.3" fill="${WHITE}"/>`,
  },
  {
    key: 'zara', label: 'Zara', gender: 'f', bg: ['#EBF1FF', '#CEDEFF'],
    skin: '#6F4127', shade: '#52301A', brow: '#130C09', lashes: true, blushOp: 0.14,
    hairBack: `<path d="M33,60 C31,36 46,23 64,23 C82,23 97,36 95,60 L99,108 Q93,113 86,109 L42,109 Q35,113 29,108Z" fill="#1A120E"/><g fill="none" stroke="#3B2A21" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="2.6 2.2" opacity=".95"><path d="M34,66 L33,106"/><path d="M38.5,70 L38,108"/><path d="M89.5,70 L90,108"/><path d="M94,66 L95,106"/></g>`,
    hairFront: `<path d="M40,60 C38,40 49,27 64,27 C79,27 90,40 88,60 C86.4,50 82.4,44.4 76.6,41.6 C71.6,40.4 67,38.2 64,33.4 C61,38.2 56.4,40.4 51.4,41.6 C45.6,44.4 41.6,50 40,60Z" fill="#20160F"/><g fill="none" stroke="#3E2C22" stroke-width="1.4" stroke-linecap="round" opacity=".9"><path d="M62,31 C57,35 50,37.6 45,44"/><path d="M66,31 C71,35 78,37.6 83,44"/></g>`,
    earrings: `<circle cx="40.5" cy="71.6" r="2" fill="#FFD27A"/><circle cx="87.5" cy="71.6" r="2" fill="#FFD27A"/>`,
    top: '#5B8DEF', collar: `<path d="M52,97.4 Q64,106 76,97.4" stroke="#FFFFFF" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="64" cy="105.4" r="2.2" fill="#FFD27A"/>`,
  },
  {
    key: 'marcus', label: 'Marcus', gender: 'm', bg: ['#E6EEFF', '#C8D9FF'],
    skin: '#6A3F26', shade: '#4F2C18', brow: '#120B08', blushOp: 0.1, browW: 2.6,
    hairFront: `<path d="M42.4,50 C42,38 43.6,24.6 64,22.6 C84.4,24.6 86,38 85.6,50 C83.4,45 79.4,42.6 74,42 Q64,40 54,42 C48.6,42.6 44.6,45 42.4,50Z" fill="#15100D"/><path d="M45,30 C52,25 76,25 83,30 L84,34 C76,30 52,30 44,34Z" fill="#241A15" opacity=".6"/><path d="M41.6,57 C41.2,52 41.6,48.6 42.6,46.4 L44.4,58Z M86.4,57 C86.8,52 86.4,48.6 85.4,46.4 L83.6,58Z" fill="#15100D" opacity=".45"/><path d="M50,28 C56,25 66,24.4 74,26.4" stroke="#3A2A22" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".7"/>`,
    beard: `<path d="M43,64 C43.6,79 52,89.4 64,89.4 C76,89.4 84.4,79 85,64 C83.6,74 79,80.6 73,82.4 C70,84 67,84.6 64,84.6 C61,84.6 58,84 55,82.4 C49,80.6 44.4,74 43,64Z" fill="#1A110C" opacity=".38"/>`,
    top: NAVY, body: `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="${NAVY}"/><path d="M44,99 C50,106 57,108.6 64,108.6 C71,108.6 78,106 84,99 L80,97 C75,102 70,104 64,104 C58,104 53,102 48,97Z" fill="#1A2A66"/><path d="M58.6,107 L57.6,124 M69.4,107 L70.4,124" stroke="#DCE7FF" stroke-width="1.8" stroke-linecap="round"/><circle cx="57.6" cy="125" r="1.6" fill="#DCE7FF"/><circle cx="70.4" cy="125" r="1.6" fill="#DCE7FF"/>`,
  },
  {
    key: 'nadia', label: 'Nadia', gender: 'f', bg: ['#EDF2FF', '#D1E0FF'],
    skin: '#D8A27A', shade: '#BA8058', brow: '#2A1710', lashes: true,
    hairBack: `<path d="M33,60 C30,34 46,22 64,22 C83,22 98,34 95,60 C97,72 93,82 97,94 C99,100 97,106 92,108 L36,108 C31,104 30,98 32,90 C34,80 31,70 33,60Z" fill="#24140D"/><g fill="none" stroke="#3F2519" stroke-width="1.8" stroke-linecap="round" opacity=".85"><path d="M36,70 q-3,8 0,15 q3,7 -1,14"/><path d="M92,70 q3,8 0,15 q-3,7 1,14"/></g>`,
    hairFront: `<path d="M39.6,64 C36.6,40 48,26 63,26 C80,26 91.6,38 88.6,62 C87.6,52 85,46.6 81,43.6 C73,46 61.4,44 54.6,38.6 C51,45 45.4,52 39.6,64Z" fill="#2E1A11"/><path d="M56,31 C64,28.4 75,30 82,36.6" stroke="#5A3626" stroke-width="2" fill="none" stroke-linecap="round" opacity=".75"/>`,
    earrings: `<circle cx="40.5" cy="71.6" r="2.1" fill="#FFFFFF" stroke="#E4E9F5" stroke-width=".6"/><circle cx="87.5" cy="71.6" r="2.1" fill="#FFFFFF" stroke="#E4E9F5" stroke-width=".6"/>`,
    top: BLUE_D, collar: `<path d="M51,97 L64,104 L77,97 L74,95.4 L64,100.4 L54,95.4Z" fill="${WHITE}"/><path d="M64,104 L64,132" stroke="#1A43B8" stroke-width="1.4"/>`,
  },
  {
    key: 'emeka', label: 'Emeka', gender: 'm', bg: ['#E7EEFF', '#C9DAFF'],
    skin: '#4E2E1C', shade: '#3A2012', brow: '#0E0806', blushOp: 0.08, browW: 2.6,
    hairFront: `<path d="M41.4,55 C40.6,37.4 50.6,28.6 64,28.6 C77.4,28.6 87.4,37.4 86.6,55 C85.6,47 82.4,42.4 77,41 C70,39.4 58,39.4 51,41 C45.6,42.4 42.4,47 41.4,55Z" fill="#120C09"/><g fill="none" stroke="#3B2A22" stroke-width="1.3" stroke-linecap="round" opacity=".8"><path d="M50,36 q4,-2.4 8,0 q4,2.4 8,0 q4,-2.4 8,0"/><path d="M46.6,40.4 q4,-2.4 8,0 q4,2.4 8,0 q4,-2.4 8,0 q4,2.4 8,0"/></g>`,
    beard: `<path d="M56.6,73.8 Q64,70.4 71.4,73.8 Q64,72.6 56.6,73.8Z" fill="#0F0906"/><path d="M59.4,82.6 Q64,84.4 68.6,82.6 L67.6,87.4 Q64,89 60.4,87.4Z" fill="#0F0906" opacity=".9"/>`,
    top: WHITE, body: `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="#F7F9FF"/><path d="M49,98 Q64,109 79,98" stroke="${BLUE}" stroke-width="2.8" fill="none"/><path d="M57.4,104.6 L57.4,128 Q64,131 70.6,128 L70.6,104.6" stroke="${BLUE}" stroke-width="2.2" fill="none" stroke-linejoin="round"/><path d="M60.4,108 l3.6,3 l3.6,-3 M60.4,114 l3.6,3 l3.6,-3 M60.4,120 l3.6,3 l3.6,-3" stroke="#6E9BFF" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M40,106 Q44,104 48,106 M80,106 Q84,104 88,106" stroke="#B9CCFF" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  },
  {
    key: 'lucas', label: 'Lucas', gender: 'm', bg: ['#E9F0FF', '#CBDCFF'],
    skin: '#EDC3A0', shade: '#D29D78', brow: '#4A2E1A',
    hairFront: `<path d="M40.6,58 C38.4,40 46,27 60,24 C66,22.6 74,23 79,26.4 C86.6,31 90,42 87.4,58 C86.4,50 83.4,45 79,42.6 C72,42 62,40 56,36.4 C52,41 46,46 40.6,58Z" fill="#6B4429"/><path d="M58,26.4 C66,24.6 75,26.4 80,31.6" stroke="#946240" stroke-width="2" fill="none" stroke-linecap="round" opacity=".8"/><path d="M60,31 C55,32.6 51,35 48,38.6" stroke="#946240" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".6"/>`,
    beard: `<path d="M43,64 C43.6,79 52,89.4 64,89.4 C76,89.4 84.4,79 85,64 C83.6,74 79,80.6 73,82.4 C70,84 67,84.6 64,84.6 C61,84.6 58,84 55,82.4 C49,80.6 44.4,74 43,64Z" fill="#7A5236" opacity=".32"/>`,
    top: '#3B5A8C', body: `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="#3B5A8C"/><path d="M52,98 Q64,106 76,98 L76,132 L52,132Z" fill="${WHITE}"/><path d="M50,98 L60,124 L52,132 L40,104Z M78,98 L68,124 L76,132 L88,104Z" fill="#2E4A78"/><path d="M45,113 L52,111" stroke="#9DB4DA" stroke-width="1.4" stroke-linecap="round"/>`,
  },
  {
    key: 'priya', label: 'Priya', gender: 'f', bg: ['#ECF2FF', '#D0DFFF'],
    skin: '#B87A50', shade: '#995D37', brow: '#1E120C', lashes: true, blushOp: 0.16,
    hairBack: `<path d="M35,60 C33,37 47,24 64,24 C81,24 95,37 93,60 L92,78 L36,78Z" fill="#17100C"/><path d="M84,74 C92,80 94,92 90,102 C88,108 90,114 88,120" stroke="#17100C" stroke-width="8" fill="none" stroke-linecap="round"/><g fill="none" stroke="#3A2A22" stroke-width="1.3" stroke-linecap="round" opacity=".9"><path d="M86,82 l4,3 M88,90 l4,2 M88,98 l4,2 M87,106 l4,2 M86,114 l4,2"/></g>`,
    hairFront: `<path d="M39.6,62 C37.6,40 48.4,27 64,27 C79.6,27 90.4,40 88.4,62 C87,52 83.4,45.4 78,42.4 C72.6,40.4 67.4,38 64.4,33.6 C60.6,39.4 52,42.6 46.6,45.6 C43,49.4 40.8,55 39.6,62Z" fill="#1E140E"/><path d="M62,31 C56,34 50,37 46,42" stroke="#3E2C22" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".85"/>`,
    earrings: `<circle cx="40.5" cy="71.6" r="1.9" fill="#FFD27A"/><circle cx="87.5" cy="71.6" r="1.9" fill="#FFD27A"/>`,
    extra: `<circle cx="67.6" cy="69.6" r="1.05" fill="#FFE19A"/>`,
    top: '#6E7CF5', collar: `<path d="M50,98 C55,104 60,106 64,106 C68,106 73,104 78,98 L74,96.6 C70,100.6 67,101.6 64,101.6 C61,101.6 58,100.6 54,96.6Z" fill="#FFD27A" opacity=".9"/>`,
  },
  {
    key: 'kofi', label: 'Kofi', gender: 'm', bg: ['#E8EFFF', '#CADBFF'],
    skin: '#5A351F', shade: '#43250F', brow: '#0F0907', blushOp: 0.1, browW: 2.6, glasses: '#C99A2E',
    hairBack: `<path d="M36.4,60 C31,40 41,18.6 64,18.6 C87,18.6 97,40 91.6,60 C90,52 86,46 80,43 L48,43 C42,46 38,52 36.4,60Z" fill="#140D0A"/>`,
    hairFront: `<path d="M40.4,57 C37,40 45,26 56,23.2 C61,21.8 67,21.8 72,23.2 C83,26 91,40 87.6,57 C86,48.6 82,43.6 76,42.2 C68,40.8 60,40.8 52,42.2 C46,43.6 42,48.6 40.4,57Z" fill="#1A120E"/><g fill="#33251E" opacity=".9"><circle cx="47" cy="33" r="1.3"/><circle cx="54" cy="27.6" r="1.3"/><circle cx="62" cy="25" r="1.3"/><circle cx="70" cy="25.4" r="1.3"/><circle cx="78" cy="29" r="1.3"/><circle cx="83" cy="35.6" r="1.2"/><circle cx="51" cy="35" r="1.2"/><circle cx="59" cy="31.6" r="1.2"/><circle cx="67" cy="30.6" r="1.2"/><circle cx="75" cy="33.4" r="1.2"/><circle cx="43.6" cy="41" r="1.1"/><circle cx="85" cy="42" r="1.1"/><circle cx="38.6" cy="50" r="1.1"/><circle cx="89.4" cy="50" r="1.1"/></g>`,
    top: NAVY, body: `<path d="M12,132 C12,112 28,101 50,98 L78,98 C100,101 116,112 116,132Z" fill="${NAVY}"/><path d="M48.6,97.4 L56,110 L64,102 L72,110 L79.4,97.4 L75,96 L64,104.4 L53,96Z" fill="#F4F7FF"/><g><rect x="52" y="112" width="5" height="4" fill="#F5B935"/><rect x="57" y="112" width="5" height="4" fill="#2F6BFF"/><rect x="62" y="112" width="5" height="4" fill="#33C08A"/><rect x="67" y="112" width="5" height="4" fill="#F5B935"/><rect x="72" y="112" width="4" height="4" fill="#2F6BFF"/></g>`,
  },
  {
    key: 'elena', label: 'Elena', gender: 'f', bg: ['#EEF3FF', '#D3E2FF'],
    skin: '#F6D5BF', shade: '#E0B193', brow: '#6E3018', lashes: true, blushOp: 0.26,
    hairBack: `<path d="M33,60 C31,36 46,22 64,22 C82,22 97,36 95,60 L96,84 Q92,90 86,88 L42,88 Q36,90 32,84Z" fill="#8A3B1E"/>`,
    hairFront: `<path d="M39,64 C36,40 47.6,26 64,26 C80.4,26 92,40 89,64 C88.6,56 87,50.6 84.6,47.4 C80,49 74,49.4 69,48.6 C62,47.6 54,47.4 47.4,49 C44,51.6 41,57 39,64Z" fill="#9B4524"/><path d="M47,49 C50,42 56,38.6 62,38 M66,38.4 C72,39 79,42 84,47.4" stroke="#B85E36" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".7"/><path d="M38,64 L37.4,84 Q40,88 44,86 L43,66Z M90,64 L90.6,84 Q88,88 84,86 L85,66Z" fill="#9B4524"/>`,
    extra: `<g fill="#C9825C" opacity=".55"><circle cx="49" cy="67.6" r=".85"/><circle cx="52" cy="69" r=".85"/><circle cx="50" cy="70.6" r=".75"/><circle cx="76" cy="69" r=".85"/><circle cx="79" cy="67.6" r=".85"/><circle cx="78" cy="70.6" r=".75"/></g>`,
    top: NAVY, collar: `<path d="M51.6,88 C58,91 70,91 76.4,88 L78,100 Q64,106.6 50,100Z" fill="#16245C"/><path d="M51,94 Q64,98.4 77,94 M50.6,98.4 Q64,103.4 77.4,98.4" stroke="#2A3C86" stroke-width="1.3" fill="none"/>`,
  },
];

const out = [];
for (const f of FACES) {
  fs.writeFileSync(path.join(OUT, f.key + '.svg'), face(f));
  out.push({ key: f.key, label: f.label, gender: f.gender });
}
console.log('wrote', out.length, 'faces to', OUT);
