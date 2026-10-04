'use strict';
/*
 * app-people.js: Subscribers, Audiences and Clicks pages.
 * API: GET /api/subscribers (+ /tag, /export.csv), GET/POST/DELETE /api/segments (+ /preview), GET /api/links
 */

const SUBS = { f: { connection: '', status: '', source: '', tag: '', q: '' }, page: 1, sel: new Set(), hints: null };
const ST_SUB = { active: ['Active', 'p-ok'], blocked: ['Blocked the bot', 'p-bad'], stopped: ['Opted out', 'p-warn'], joinreq: ['Asked to join', 'p-tg'] };
const subPill = (s) => { const x = ST_SUB[s] || [s, 'p-grey']; return '<span class="pill ' + x[1] + '">' + x[0] + '</span>'; };
async function segHints() { if (!SUBS.hints) { try { SUBS.hints = await GET('/api/segments'); } catch (_) { SUBS.hints = { sources: [], tags: [], langs: [], segments: [], fields: {} }; } } return SUBS.hints; }
function firstBot() { return APP.state.connections.find((c) => c.kind === 'bot' && c.status === 'active'); }

PAGES.subscribers = {
  title: 'Subscribers', sub: 'Everyone you can reach on Telegram',
  async render(el, q, alive) {
    el.innerHTML = '<div class="dg">' + '<div class="c3">' + skel(1, 96) + '</div>'.repeat(1) + '<div class="c3">' + skel(1, 96) + '</div><div class="c3">' + skel(1, 96) + '</div><div class="c3">' + skel(1, 96) + '</div></div>' + skel(1, 320);
    const bots = APP.state.connections.filter((c) => c.kind === 'bot');
    if (q.tag) SUBS.f.tag = q.tag;
    const load = async () => {
      const p = new URLSearchParams({ page: SUBS.page });
      Object.entries(SUBS.f).forEach(([k, v]) => { if (v) p.set(k, v); });
      return GET('/api/subscribers?' + p.toString());
    };
    let d = await load();
    if (!alive()) return;
    const bot = firstBot();
    const shell = () => {
      const c = d.counts;
      el.innerHTML = '<div class="dg">' +
        '<div class="box kpi c3"><small>Can get your bot messages</small><b class="tnum" data-count="' + c.active + '">0</b></div>' +
        '<div class="box kpi c3"><small>Joined in the last 7 days</small><b class="tnum" data-count="' + c.new_7d + '">0</b></div>' +
        '<div class="box kpi c3"><small>Opted out</small><b class="tnum" data-count="' + c.stopped + '">0</b></div>' +
        '<div class="box kpi c3"><small>Blocked the bot (removed)</small><b class="tnum" data-count="' + c.blocked + '">0</b></div></div>' +
        (d.channels.length ? '<div class="box"><div class="bh"><h3>Channels and groups</h3><span class="hint">Telegram shares how many people are in a channel or group, not who they are.</span></div><div class="conns">' + d.channels.map((x) => '<div class="cnc">' + kIcon(x.kind) + '<span><b>' + esc(connName(x)) + '</b><small>' + (x.member_count != null ? fmt(x.member_count) + ' ' + KIND[x.kind].w : 'Count not known yet') + '</small></span></div>').join('') + '</div></div>' : '') +
        '<div class="box"><div class="bh"><h3>Bot subscribers</h3><div class="bhr">' + (isOwner() && d.total ? '<a class="btn b-ghost xs" href="/api/subscribers/export.csv?ws=' + encodeURIComponent(APP.state.workspace.id) + '" download>' + icon('down') + 'Export CSV</a>' : '') + '</div></div>' +
        '<div class="filters"><label class="search">' + icon('search') + '<input id="sQ" placeholder="Search name or @username" value="' + esc(SUBS.f.q) + '" aria-label="Search subscribers"></label>' +
        (bots.length > 1 ? '<select class="inp sm" id="sC" aria-label="Bot"><option value="">All bots</option>' + bots.map((b) => '<option value="' + b.id + '"' + (String(b.id) === SUBS.f.connection ? ' selected' : '') + '>@' + esc(b.username) + '</option>').join('') + '</select>' : '') +
        '<select class="inp sm" id="sS" aria-label="Status"><option value="">Any status</option>' + Object.entries(ST_SUB).map(([k, v]) => '<option value="' + k + '"' + (k === SUBS.f.status ? ' selected' : '') + '>' + v[0] + '</option>').join('') + '</select>' +
        '<input class="inp sm" id="sSrc" list="dlSrc" placeholder="Start link" value="' + esc(SUBS.f.source) + '" aria-label="Came from start link"><datalist id="dlSrc"></datalist>' +
        '<input class="inp sm" id="sTag" list="dlTag" placeholder="Tag" value="' + esc(SUBS.f.tag) + '" aria-label="Tag"><datalist id="dlTag"></datalist></div>' +
        '<div class="selbar" id="sBar" hidden><b id="sN"></b>' + (canSend() ? '<button type="button" class="btn b-blue xs" id="sTagA">' + icon('plus') + 'Add a tag</button><button type="button" class="btn b-ghost xs" id="sTagR">Remove a tag</button>' : '<small class="muted">Only people who can send can change tags.</small>') + '<button type="button" class="btn b-ghost xs" id="sClr">Clear</button></div>' +
        '<div id="sT"></div></div>';
      $$('[data-count]', el).forEach((b) => countTo(b, +b.dataset.count, 800));
      segHints().then((h) => { if (!alive()) return; $('#dlSrc').innerHTML = (h.sources || []).map((x) => '<option value="' + esc(x.source) + '">').join(''); $('#dlTag').innerHTML = (h.tags || []).map((x) => '<option value="' + esc(x.tag) + '">').join(''); });
      let tq = 0;
      const refilter = () => { clearTimeout(tq); tq = setTimeout(async () => { SUBS.page = 1; SUBS.sel.clear(); try { d = await load(); if (alive()) table(); } catch (e) { apiErr(e); } }, 300); };
      $('#sQ').oninput = (e) => { SUBS.f.q = e.target.value.trim(); refilter(); };
      ['sC', 'sS'].forEach((id) => { const x = $('#' + id); if (x) x.onchange = (e) => { SUBS.f[id === 'sC' ? 'connection' : 'status'] = e.target.value; refilter(); }; });
      $('#sSrc').onchange = (e) => { SUBS.f.source = e.target.value.trim(); refilter(); };
      $('#sTag').onchange = (e) => { SUBS.f.tag = e.target.value.trim(); refilter(); };
      $('#sClr').onclick = () => { SUBS.sel.clear(); table(); };
      if ($('#sTagA')) { $('#sTagA').onclick = () => tagSheet(false); $('#sTagR').onclick = () => tagSheet(true); }
      table();
    };
    const table = () => {
      const rows = d.subscribers;
      const filtered = Object.values(SUBS.f).some(Boolean);
      const box = $('#sT');
      if (!rows.length) {
        box.innerHTML = filtered ? emptyBox({ plain: 1, emoji: '🔍', title: 'Nobody matches', text: 'Try a different search or clear the filters.' })
          : emptyBox({ plain: 1, cas: 'wave', size: 80, title: 'No subscribers yet', text: bot ? 'Share <b>t.me/' + esc(bot.username) + '</b> to get your first one. Everyone who taps Start appears here.' : 'Connect a bot. Everyone who starts it appears here.', action: bot ? '<button type="button" class="btn b-blue sm" data-copy="https://t.me/' + esc(bot.username) + '" data-msg="Bot link copied">' + icon('copy') + 'Copy bot link</button>' : '<button type="button" class="btn b-blue sm" data-connect="bot">Connect a bot</button>' });
      } else {
        const all = rows.every((r) => SUBS.sel.has(r.id));
        box.innerHTML = '<div class="tw"><table class="tbl rsp sel"><thead><tr><th class="cbx"><input type="checkbox" id="sAll" aria-label="Select all on this page"' + (all ? ' checked' : '') + '></th><th>Name</th><th>Bot</th><th>Came from</th><th>Tags</th><th>Joined</th><th>Clicks</th><th>Status</th></tr></thead><tbody>' +
          rows.map((r) => '<tr' + (SUBS.sel.has(r.id) ? ' class="on"' : '') + '>' + td('', '<label class="who2"><input type="checkbox" data-sid="' + r.id + '"' + (SUBS.sel.has(r.id) ? ' checked' : '') + ' aria-label="Select ' + esc(r.first_name || 'subscriber') + '">' + ava(r.first_name || r.username || '?', 36) + '<span><b>' + esc(r.first_name || 'No name') + '</b><small>' + (r.username ? '@' + esc(r.username) : '') + (r.lang ? ' · ' + esc(r.lang.toUpperCase()) : '') + '</small></span></label>', 'first') +
            td('Bot', '@' + esc(r.bot)) + td('Came from', r.source ? '<span class="pill p-grey">' + esc(r.source) + '</span>' : '<span class="muted">Direct</span>') +
            td('Tags', (r.tags || []).map((t) => '<span class="pill p-blue">' + esc(t) + '</span>').join(' ') || '<span class="muted">—</span>') +
            td('Joined', '<span title="' + esc(fmtDate(r.joined_at)) + '">' + ago(r.joined_at) + '</span>') + td('Clicks', '<span class="tnum">' + fmt(r.clicks) + '</span>') + td('Status', subPill(r.status)) + '</tr>').join('') + '</tbody></table></div>' +
          '<div class="pager"><span class="muted">' + fmt(d.total) + ' ' + (d.total === 1 ? 'subscriber' : 'subscribers') + ' · page ' + d.page + ' of ' + d.pages + '</span><span><button type="button" class="btn b-ghost xs" data-pg="-1"' + (d.page <= 1 ? ' disabled' : '') + '>Previous</button><button type="button" class="btn b-ghost xs" data-pg="1"' + (d.page >= d.pages ? ' disabled' : '') + '>Next</button></span></div>';
      }
      const bar = $('#sBar'); bar.hidden = !SUBS.sel.size; $('#sN').textContent = plural(SUBS.sel.size, 'selected', 'selected');
      box.onchange = (e) => {
        const t = e.target;
        if (t.id === 'sAll') { rows.forEach((r) => (t.checked ? SUBS.sel.add(r.id) : SUBS.sel.delete(r.id))); table(); return; }
        if (t.dataset.sid) { const id = +t.dataset.sid; t.checked ? SUBS.sel.add(id) : SUBS.sel.delete(id); t.closest('tr').classList.toggle('on', t.checked); bar.hidden = !SUBS.sel.size; $('#sN').textContent = plural(SUBS.sel.size, 'selected', 'selected'); }
      };
      box.onclick = async (e) => { const b = e.target.closest('[data-pg]'); if (!b || b.disabled) return; SUBS.page += +b.dataset.pg; try { d = await load(); if (alive()) { table(); $('#sT').scrollIntoView({ block: 'start', behavior: 'smooth' }); } } catch (ex) { apiErr(ex); } };
    };
    const tagSheet = (remove) => {
      const h = sheet(remove ? 'Remove a tag' : 'Add a tag', '<span class="spk">' + icon('plus') + '</span>', '<p class="muted" style="font-size:14px">' + plural(SUBS.sel.size, 'person', 'people') + ' selected.' + (remove ? '' : ' Adding a tag can start an auto follow-up that uses this tag.') + '</p><div class="field"><label for="tgI">Tag</label><input class="inp" id="tgI" list="dlTag2" maxlength="40" placeholder="for example buyer"><datalist id="dlTag2">' + ((SUBS.hints && SUBS.hints.tags) || []).map((x) => '<option value="' + esc(x.tag) + '">').join('') + '</datalist><span class="hint">Letters, numbers, _ and -.</span></div><p class="ferr" id="tgE" hidden></p><button type="button" class="btn b-blue full" id="tgGo">' + (remove ? 'Remove tag' : 'Add tag') + '</button>');
      $('#tgGo', h).onclick = async (e) => {
        const tag = $('#tgI', h).value.trim().toLowerCase();
        if (!/^[a-z0-9_-]{1,40}$/.test(tag)) { $('#tgE', h).textContent = 'Use only letters, numbers, _ and -.'; $('#tgE', h).hidden = false; return; }
        btnBusy(e.currentTarget, true, 'Saving…');
        try { const r = await POST('/api/subscribers/tag', { tag, ids: [...SUBS.sel], remove }); closeModal(); toast((remove ? 'Tag removed from ' : 'Tag added to ') + plural(r.updated, 'person', 'people') + '.'); SUBS.sel.clear(); SUBS.hints = null; d = await load(); if (alive()) table(); }
        catch (ex) { btnBusy(e.currentTarget, false); $('#tgE', h).textContent = ex.message; $('#tgE', h).hidden = false; }
      };
      setTimeout(() => { const i = $('#tgI'); if (i) i.focus(); }, 60);
    };
    shell();
  },
};

/* ---------- Audiences ---------- */
let SEGR = [];
PAGES.audiences = {
  title: 'Audiences', sub: 'Groups of people to target',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 240) + '<div class="segs">' + skel(3, 160) + '</div>';
    const d = await GET('/api/segments');
    if (!alive()) return;
    SUBS.hints = d;
    const bots = APP.state.connections.filter((c) => c.kind === 'bot');
    const fields = d.fields || {};
    const fkeys = Object.keys(fields);
    const sugg = { source: (d.sources || []).map((x) => x.source), tag: (d.tags || []).map((x) => x.tag), lang: (d.langs || []).map((x) => x.lang) };
    if (!SEGR.length) SEGR = [{ field: 'joined_days', value: 7 }];
    const off = CFG.features.segments === false;
    el.innerHTML = '<div class="note2"><span>ℹ️</span><span><b>Audiences are for people who started your bots.</b> A channel or group post always reaches everyone in it, because Telegram doesn\'t let bots pick people there.</span></div>' +
      (!bots.length ? emptyBox({ cas: 'wave', title: 'Connect a bot to use audiences', text: 'Once people start your bot, you can group them by where they came from, tags, language and clicks.', action: '<button type="button" class="btn b-blue" data-connect="bot">' + icon('plus') + 'Connect a bot</button>' }) :
        (off ? '' : '<div class="box"><div class="bh"><h3>New audience</h3><span class="pill p-blue">Live count</span></div>' +
        '<div class="field"><label for="sgName">Name</label><input class="inp" id="sgName" maxlength="60" placeholder="for example New this week"></div>' +
        '<div class="field"><label>People who match all of these</label><div id="rules" class="rulesl"></div><button type="button" class="btn b-ghost xs" id="addR" style="align-self:flex-start">' + icon('plus') + 'Add a rule</button></div>' +
        '<p class="ferr" id="sgErr" hidden></p>' +
        '<div class="segfoot"><div class="est"><div><b class="tnum" id="estN">…</b><br><small class="muted" style="font-weight:700">people match right now</small></div></div><button type="button" class="btn b-blue sm" id="saveS">' + icon('check') + 'Save audience</button></div></div>')) +
      '<div class="bh" style="margin-top:4px"><h3 style="font-size:18px">Your audiences</h3><span class="hint">Everyone: ' + plural(d.everyone, 'active subscriber') + '</span></div>' +
      (d.segments.length ? '<div class="segs">' + d.segments.map((s) => '<div class="box sg"><div class="bh"><b class="ell">' + esc(s.name) + '</b><button type="button" class="x" data-sdel="' + s.id + '" aria-label="Delete ' + esc(s.name) + '"><svg width="15" height="15"><use href="#i-trash"/></svg></button></div><div class="cnt tnum">' + fmt(s.count) + '</div><div class="prog2"><i style="width:' + (d.everyone ? Math.min(100, s.count / d.everyone * 100) : 0) + '%"></i></div><div class="rules">' + (s.describe || []).map((r) => '<span class="pill p-grey">' + esc(r) + '</span>').join('') + '</div><button type="button" class="btn b-ghost xs" data-sgo="' + s.id + '" style="align-self:flex-start">' + icon('send') + 'Message them</button></div>').join('') + '</div>'
        : emptyBox({ emoji: '🎯', title: 'No audiences yet', text: 'Make one above, like "joined this week" or "came from my TikTok ad". Then pick it when you send a message.' }));
    if (bots.length && !off) {
      let pt = 0;
      const count = () => { clearTimeout(pt); pt = setTimeout(async () => { const n = $('#estN'); if (!n) return; try { const r = await POST('/api/segments/preview', { rules: SEGR.filter(ruleOk) }); if (alive()) countTo($('#estN'), r.count, 500); } catch (e) { if (alive()) $('#estN').textContent = '—'; } }, 300); };
      const ruleOk = (r) => fields[r.field] && (fields[r.field].type === 'number' ? Number(r.value) >= 1 && Number(r.value) <= 365 : String(r.value || '').trim());
      const draw = () => {
        $('#rules').innerHTML = SEGR.map((r, i) => { const f = fields[r.field] || {}; const list = sugg[r.field] || []; return '<div class="rule"><select data-rf="' + i + '" aria-label="Rule">' + fkeys.map((k) => '<option value="' + k + '"' + (k === r.field ? ' selected' : '') + '>' + esc(fields[k].label) + '</option>').join('') + '</select>' + (f.type === 'number' ? '<input class="inp" type="number" min="1" max="365" data-rv="' + i + '" value="' + esc(r.value) + '" aria-label="Days">' : '<input class="inp" data-rv="' + i + '" value="' + esc(r.value) + '" list="dl' + i + '" placeholder="' + (r.field === 'lang' ? 'for example fr' : r.field === 'source' ? 'start link name' : 'tag') + '" aria-label="Value"><datalist id="dl' + i + '">' + list.map((x) => '<option value="' + esc(x) + '">').join('') + '</datalist>') + '<button type="button" class="x" data-rx="' + i + '" aria-label="Remove rule">×</button></div>'; }).join('') || '<p class="hint">No rules: everyone who started your bots.</p>';
        $('#addR').hidden = SEGR.length >= 6;
        count();
      };
      $('#rules').onchange = (e) => { const t = e.target; if (t.dataset.rf != null) { const k = t.value; SEGR[t.dataset.rf] = { field: k, value: fields[k].type === 'number' ? 7 : '' }; draw(); } };
      $('#rules').oninput = (e) => { const t = e.target; if (t.dataset.rv != null) { SEGR[t.dataset.rv].value = fields[SEGR[t.dataset.rv].field].type === 'number' ? parseInt(t.value, 10) || '' : t.value; count(); } };
      $('#rules').onclick = (e) => { const x = e.target.closest('[data-rx]'); if (x) { SEGR.splice(+x.dataset.rx, 1); draw(); } };
      $('#addR').onclick = () => { const used = SEGR.map((r) => r.field); const k = fkeys.find((x) => !used.includes(x)) || fkeys[0]; SEGR.push({ field: k, value: fields[k].type === 'number' ? 7 : '' }); draw(); };
      $('#saveS').onclick = async (e) => {
        const name = $('#sgName').value.trim(), err = $('#sgErr');
        err.hidden = true;
        if (!name) { err.textContent = 'Give the audience a name.'; err.hidden = false; $('#sgName').focus(); return; }
        const bad = SEGR.find((r) => !ruleOk(r));
        if (bad) { err.textContent = fields[bad.field].type === 'number' ? 'Days must be between 1 and 365.' : 'Fill in "' + fields[bad.field].label + '".'; err.hidden = false; return; }
        btnBusy(e.currentTarget, true, 'Saving…');
        try { await POST('/api/segments', { name, rules: SEGR }); SEGR = []; toast('Audience saved.'); renderPage('audiences', {}); } catch (ex) { btnBusy(e.currentTarget, false); err.textContent = ex.message; err.hidden = false; }
      };
      draw();
    }
    el.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-sdel]');
      if (del) { if (!(await confirmBox('Delete this audience?', 'Messages already sent are not affected.', 'Delete', true))) return; try { await api('DELETE', '/api/segments/' + del.dataset.sdel); toast('Deleted.'); renderPage('audiences', {}); } catch (ex) { apiErr(ex); } return; }
      const go = e.target.closest('[data-sgo]');
      if (go) { const b = firstBot(); if (b && !APP.state.connections.some((c) => c.id === COMP.conn && c.kind === 'bot')) COMP.conn = b.id; COMP.seg = go.dataset.sgo; appGo('broadcast'); }
    });
  },
};

/* ---------- Clicks ---------- */
PAGES.clicks = {
  title: 'Clicks', sub: 'Who tapped your buttons',
  async render(el, q, alive) {
    el.innerHTML = skel(1, 260) + skel(1, 300);
    const d = await GET('/api/links');
    if (!alive()) return;
    const total = (d.daily || []).reduce((a, x) => a + x.n, 0);
    const links = d.links || [];
    if (!links.length) {
      el.innerHTML = emptyBox({ cas: 'wave', title: 'No tracked links yet', text: 'Add a button to a message or a follow-up. Every button gets its own tracked link, and its clicks show up here.', action: '<button type="button" class="btn b-blue" data-go="broadcast">' + icon('send') + 'Send a message with a button</button>' });
      return;
    }
    el.innerHTML = '<div class="dg"><div class="box kpi c4"><small>Clicks · 14 days</small><b class="tnum" data-count="' + total + '">0</b></div><div class="box kpi c4"><small>Tracked links</small><b class="tnum" data-count="' + links.length + '">0</b></div><div class="box kpi c4"><small>Clicks on all links, ever</small><b class="tnum" data-count="' + links.reduce((a, l) => a + l.clicks, 0) + '">0</b></div>' +
      '<div class="box c8"><div class="bh"><h3>Clicks per day</h3><span class="hint">Last 14 days</span></div><div id="clCh" class="chartw"></div></div>' +
      '<div class="box c4"><div class="bh"><h3>Latest clicks</h3></div><div class="feed">' + ((d.recent || []).length ? d.recent.map((r) => '<div class="fi">' + ava(r.first_name || r.username || '?', 36) + '<p><b>' + esc(r.first_name || 'Someone') + '</b>' + (r.username ? ' <span class="muted">@' + esc(r.username) + '</span>' : '') + ' tapped "' + esc(r.label) + '"<small>' + ago(r.created_at) + '</small></p></div>').join('') : '<p class="muted" style="font-size:14px">Names show for bot subscribers. Channel and group clicks are counted without names.</p>') + '</div></div></div>' +
      '<div class="box"><div class="bh"><h3>Tracked links</h3><span class="hint">Every Telegram button gets one automatically.</span></div><div class="tw"><table class="tbl rsp"><thead><tr><th>Button</th><th>From</th><th>Short link</th><th>Clicks</th><th>People</th><th></th></tr></thead><tbody>' +
      links.map((l) => '<tr>' + td('', '<b>' + esc(l.label) + '</b><small class="ell" style="max-width:260px">' + esc(l.url) + '</small>', 'first') + td('From', '<span class="pill ' + (l.source_kind === 'broadcast' ? 'p-blue' : 'p-ok') + '">' + (l.source_kind === 'broadcast' ? 'Message' : 'Follow-up') + '</span> ' + esc(l.source_title || '')) + td('Short link', '<span class="mono" style="font-size:12.5px">' + esc(l.short) + '</span>') + td('Clicks', '<b class="tnum">' + fmt(l.clicks) + '</b>') + td('People', '<span class="tnum">' + fmt(l.people) + '</span>') + td('', '<button type="button" class="btn b-ghost xs" data-copy="https://' + esc(l.short) + '" data-msg="Link copied">' + icon('copy') + 'Copy</button>') + '</tr>').join('') + '</tbody></table></div><p class="hint">"People" counts bot subscribers who clicked. Clicks from channels and groups are counted, but Telegram doesn\'t tell us who made them.</p></div>';
    $$('[data-count]', el).forEach((b) => countTo(b, +b.dataset.count, 800));
    lineChart($('#clCh'), (d.daily || []).map((x) => dayLabel(x.day)), (d.daily || []).map((x) => x.n), null, { label: 'Clicks per day', id: 'cl' });
  },
};
