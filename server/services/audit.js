'use strict';
/* Every admin change is written here. Admin → Audit log shows it. */
const db = require('../db');
async function audit(ctx, action, target = '', data = {}) {
  await db.query('insert into audit_log(actor_user_id, action, target, data, ip) values ($1,$2,$3,$4,$5)',
    [ctx && ctx.user ? ctx.user.id : null, action, String(target), JSON.stringify(data || {}), ctx ? ctx.ip : null]);
}
module.exports = { audit };
