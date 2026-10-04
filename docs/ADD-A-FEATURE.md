# Adding a feature, step by step

Worked example: **"Notes on subscribers"**: let customers write a private note on a subscriber.
Follow the same 7 steps for any feature.

## 1. Database: a new migration
`server/migrations/003_subscriber_notes.sql`
```sql
alter table subscribers add column note text not null default '';
```
It runs automatically the next time the server starts (locally and on Railway).

## 2. A feature switch (so admin can turn it off)
`server/features.js`, add one line to the list:
```js
{ key: 'notes', group: 'Sending', name: 'Subscriber notes', about: 'Private notes on subscribers.', default: true },
```
It now appears in Admin → Features.

## 3. The API route
`server/routes/subscribers.js`, inside `module.exports = (r) => { ... }`:
```js
r.post('/api/subscribers/:id/note', async (ctx) => {
  await settings.requireFeature('notes');                       // respects the switch
  const note = str(ctx.body.note, 'Note', { max: 500 });        // validates, friendly error
  const row = await db.one(`update subscribers s set note = $3
      from connections c where c.id = s.connection_id and c.workspace_id = $1 and s.id = $2
      returning s.id`, [ctx.workspace.id, int(ctx.params.id, 'Subscriber'), note]);  // only this workspace!
  if (!row) throw notFound('That subscriber');
  return { ok: true };
}, { auth: 'workspace' });
```
(Add `const settings = require('../services/settings');` and `notFound` to the imports at the top if missing.)

## 4. Return it in the list
In the same file, add `s.note` to the `select` of `GET /api/subscribers`.

## 5. The dashboard
In `public/js/app-people.js` (the Subscribers page), show `s.note` under the name and add a small
"Add note" button that calls:
```js
await POST('/api/subscribers/' + id + '/note', { note });
toast('Note saved');
```
Hide the button when `!CFG.features.notes`.

## 6. A test
`test/e2e/subscribers-notes.test.js`. Copy the top of another e2e test file (startApp, loginByEmail), then:
```js
it('saves a note, only in my own workspace', async () => {
  const c = await app.loginByEmail('notes@example.com');
  const bot = await app.connectBot(c);
  await app.start(bot.connId, 5001);
  const sub = await app.db.one('select id from subscribers where tg_user_id = 5001');
  assert.equal((await c.post(`/api/subscribers/${sub.id}/note`, { note: 'VIP' })).status, 200);
  const other = await app.loginByEmail('other@example.com');
  assert.equal((await other.post(`/api/subscribers/${sub.id}/note`, { note: 'x' })).status, 404);
});
```

## 7. Check and ship
```bash
npm run check && npm test
git commit -am "Subscriber notes" && git push      # Railway deploys it
```
If the feature changes what Castvoo promises, update `docs/PRODUCT-FACTS.md`, the FAQ
(Admin → Website text) and Cas's knowledge (Admin → Cas knowledge) so everything agrees.
