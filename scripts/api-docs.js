'use strict';
/* Writes docs/API.md from the real routes, so it is never out of date:  node scripts/api-docs.js */
process.env.APP_SECRET = process.env.APP_SECRET || 'x'.repeat(40);
const fs = require('node:fs');
const path = require('node:path');
const { buildRouter } = require('../server/app');
const r = buildRouter();
const groups = {};
for (const rt of r.routes) {
  const g = rt.pattern.startsWith('/api/admin') ? 'Admin (team only)' : rt.pattern.startsWith('/api/voosquare') ? 'VooSquare (server to server)'
    : rt.pattern.startsWith('/api/') ? 'App and website' : rt.pattern.startsWith('/tg/') || rt.pattern.startsWith('/pay/') ? 'Webhooks' : 'Pages';
  const o = rt.opts || {};
  const who = o.staff ? `staff: \`${o.staff}\`` : o.auth === 'workspace' ? 'logged in + workspace' : o.auth === 'user' ? 'logged in' : rt.pattern.startsWith('/api/voosquare') ? 'Bearer VOO_API_KEY (or VOO_SERVICE_KEY)' : rt.pattern.startsWith('/tg/') ? 'Telegram secret header' : rt.pattern.startsWith('/pay/') && rt.method === 'POST' ? 'provider signature' : 'anyone';
  (groups[g] = groups[g] || []).push(`| ${rt.method} | \`${rt.pattern}\` | ${who}${o.rate ? ` · max ${o.rate[0]} per ${o.rate[1]}s per IP` : ''} |`);
}
let md = `# API reference\n\nGenerated from the code by \`node scripts/api-docs.js\` (${r.routes.length} routes).\n\n`
  + 'Rules: JSON in and out. Every non-GET request from the browser must send the header `x-cv: 1`. '
  + 'A user in several workspaces sends `x-ws: <workspace id>`. Errors look like `{"error": "Friendly message", "code": "machine_code"}`.\n'
  + 'Each route has a comment above it in `server/routes/` explaining its input and output.\n\n';
for (const [g, rows] of Object.entries(groups)) md += `## ${g}\n\n| Method | Path | Who can call it |\n|---|---|---|\n${rows.join('\n')}\n\n`;
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'API.md'), md);
console.log('docs/API.md written:', r.routes.length, 'routes');
