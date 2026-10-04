'use strict';
/*
 * Auto follow-ups. When something happens (bot start, start tag, join request, tag),
 * start() puts the subscriber into every matching active sequence. The drip worker
 * then queues each step when it is due.
 */

const db = require('../db');
const settings = require('./settings');

/** Put a subscriber into matching sequences. trigger: 'start' | 'start_tag' | 'tag' (join requests are handled in bot-updates). */
async function start(sub, connectionId, trigger, value) {
  if (!(await settings.feature('drips'))) return 0;
  const seqs = await db.many(`select q.id, (select min(position) from sequence_steps s where s.sequence_id = q.id) as first,
      (select delay_minutes from sequence_steps s where s.sequence_id = q.id order by position limit 1) as delay
    from sequences q where q.connection_id = $1 and q.active and q.trigger_type = $2
      and (q.trigger_value is null or q.trigger_value = '' or q.trigger_value = $3 or ($2 = 'tag' and lower(q.trigger_value) = lower($3)))`,
  [connectionId, trigger, value || '']);
  let n = 0;
  for (const s of seqs) {
    if (!s.first) continue;
    const r = await db.query(`insert into sequence_runs(sequence_id, subscriber_id, next_position, due_at) values ($1,$2,$3, now() + make_interval(mins => $4))
      on conflict (sequence_id, subscriber_id) do nothing`, [s.id, sub.id, s.first, s.delay || 0]);
    n += r.rowCount;
  }
  return n;
}

async function stopFor(subscriberId) {
  await db.query("update sequence_runs set status = 'stopped' where subscriber_id = $1 and status = 'active'", [subscriberId]);
}

module.exports = { start, stopFor };
