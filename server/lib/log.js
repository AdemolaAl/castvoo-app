'use strict';
/* One-line JSON logs. Railway shows them in the Deploy Logs tab. */
function out(level, msg, data) {
  const line = { t: new Date().toISOString(), level, msg };
  if (data) {
    for (const [k, v] of Object.entries(data)) line[k] = v instanceof Error ? { message: v.message, code: v.code, stack: v.stack && v.stack.split('\n').slice(0, 4).join(' | ') } : v;
  }
  const s = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(s + '\n'); else if (!process.env.QUIET_LOGS) process.stdout.write(s + '\n');
}
module.exports = {
  info: (m, d) => out('info', m, d),
  warn: (m, d) => out('warn', m, d),
  error: (m, d) => out('error', m, d),
};
