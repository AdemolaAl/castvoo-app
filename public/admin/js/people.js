'use strict';
/* Castvoo Admin — Overview, Users, Support. */
(() => {
  const { html, raw, icon, $, $$, on, put, num, usd, usdc, date, dt, ago, isoDay, initials, plural, get, post, act, dialog, confirm, can, toast } = CV;

  /* =================== OVERVIEW =================== */
  CV.page('overview', {
    intro: 'A quick look at how Castvoo is doing. Numbers update every time you open this page.',
    async render() {
      const o = await get('/api/admin/overview');
      CV.refreshCounts(o);
      const kpi = (label, value, sub, ic, c, href) => html`<${raw(href ? 'a' : 'div')} class="kpi"${href ? html` href="${href}"` : ''}>
        <div class="kh"><small>${label}</small><span class="ki" style="--c:${c}">${icon(ic)}</span></div><b class="tnum">${value}</b>${sub ? html`<span class="sub">${sub}</span>` : ''}</${raw(href ? 'a' : 'div')}>`;
      const signups = CV.dayPoints(o.series.signups, 'n');
      const revenue = CV.dayPoints(o.series.revenue, 'usd');
      const sum = (a) => a.reduce((s, p) => s + p.value, 0);
      const notConnected = Object.entries(o.integrations).filter(([k, v]) => !v && CV.INTEG[k] && k !== 'voosquare_api');
      const attn = [];
      if (o.money.crypto_to_check && can('payments.view')) attn.push({ ic: 'card', cls: 'warn', t: `${plural(o.money.crypto_to_check, 'manual payment')} to check`, s: 'Look up the transaction or your account, then approve or reject.', href: '#payments?check=1' });
      if (o.money.withdrawals_waiting && can('payments.view')) attn.push({ ic: 'out', cls: 'warn', t: `${plural(o.money.withdrawals_waiting, 'withdrawal')} waiting (${usd(o.money.withdrawals_total)})`, s: 'Send the crypto, then mark them paid.', href: '#withdrawals' });
      if (o.support.unread && can('support.view')) attn.push({ ic: 'chat', cls: 'warn', t: `${plural(o.support.unread, 'unread support message')}`, s: 'Customers are waiting for an answer.', href: '#support' });
      if (o.sending.failed_24h > 0) attn.push({ ic: 'warn', cls: 'bad', t: `${plural(o.sending.failed_24h, 'message')} failed in the last 24 hours`, s: 'See the top reasons in System.', href: can('system.view') ? '#system' : null });
      if ((o.stale_rates || []).length && can('users.view')) attn.push({ ic: 'globe', cls: 'warn', t: `Exchange rates not updated for a week: ${o.stale_rates.map((c) => c.currency).join(', ')}`, s: 'Check today\'s rate and save it in Countries & payments, so local prices stay fair.', href: '#countries' });
      for (const p of o.problems) attn.push({ ic: 'warn', cls: 'bad', t: p, s: 'Fix this in Railway → Variables.', href: '#settings' });
      if (notConnected.length) attn.push({ ic: 'plug', cls: '', t: `Not connected yet: ${notConnected.map(([k]) => CV.INTEG[k]).join(', ')}`, s: 'Open Settings & connections to see what to add.', href: '#settings' });
      const totalPlans = o.plans.reduce((s, p) => s + p.workspaces, 0);
      const page = html`
        <div class="kpis">
          ${kpi('Users', num(o.users.total), html`<span class="up">+${num(o.users.today)}</span> today · +${num(o.users.week)} this week`, 'users', '#29A9EB', '#users')}
          ${kpi('On free trial', num(o.workspaces.trials), 'Trying Castvoo now', 'clock', '#6366F1', '#users?status=trial')}
          ${kpi('Paying', num(o.workspaces.paying), `${num(o.workspaces.free || 0)} on Free · ${num(o.workspaces.cancelled)} cancelled`, 'check', '#0E9F6E', '#users?status=active')}
          ${kpi('Paused', num(o.workspaces.paused), 'Need a top-up to send', 'warn', '#F59E0B', '#users?status=paused')}
          ${kpi('Monthly income (MRR)', usd(o.money.mrr), 'From active plans', 'dash', '#2F6BFF')}
          ${kpi('Top-ups, 30 days', usd(o.money.topups_30d), 'Money added to wallets', 'wallet', '#14B8A6', can('payments.view') ? '#payments?status=paid' : null)}
          ${kpi('Messages sent, 24h', num(o.sending.sent_24h), `${num(o.sending.blocked_24h)} blocked the bot`, 'send', '#29A9EB')}
          ${kpi('Failed, 24h', num(o.sending.failed_24h), o.sending.failed_24h ? 'Check System for reasons' : 'All good', 'warn', o.sending.failed_24h ? '#E5484D' : '#94A3B8', can('system.view') ? '#system' : null)}
          ${kpi('Waiting to send', num(o.queue.queued), o.queue.oldest_due ? `Oldest due ${ago(o.queue.oldest_due)}` : 'Nothing late', 'list', '#64748B', can('system.view') ? '#system' : null)}
          ${kpi('Open support', num(o.support.open), `${num(o.support.unread)} unread`, 'chat', '#7B5CF5', can('support.view') ? '#support' : null)}
          ${kpi('Payouts waiting', usd(o.money.withdrawals_total), CV.plural(o.money.withdrawals_waiting, 'request'), 'out', '#14B8A6', can('payments.view') ? '#withdrawals' : null)}
          ${kpi('AI writes, 24h', num(o.ai.writes_24h), `${num(Number(o.ai.input_24h) + Number(o.ai.output_24h))} tokens`, 'spark', '#A855F7', '#ai')}
        </div>
        <div class="grid g2">
          <div class="card"><div class="ch"><h3>${icon('users')} New sign-ups</h3><div class="chart-total"><b>${num(sum(signups))}</b><span>last 30 days</span></div></div>${CV.barChart(signups, { name: 'Sign-ups' })}</div>
          <div class="card"><div class="ch"><h3>${icon('dash')} Plan revenue</h3><div class="chart-total"><b>${usd(sum(revenue))}</b><span>last 30 days</span></div></div>${CV.barChart(revenue, { fmt: (v) => usd(v), name: 'Plan revenue' })}</div>
        </div>
        <div class="grid g-side">
          <div class="card flat attn"><div class="ch" style="padding:16px 16px 6px"><h3>${icon('bell')} Needs attention</h3></div>
            ${attn.length ? html`<div class="list">${attn.map((a) => html`<${raw(a.href ? 'a' : 'div')} class="li"${a.href ? html` href="${a.href}"` : ''}><span class="ic ${a.cls}">${icon(a.ic)}</span><span class="tx"><b>${a.t}</b><small>${a.s}</small></span>${a.href ? icon('chev', 'chev') : ''}</${raw(a.href ? 'a' : 'div')}>`)}</div>`
              : CV.empty('check', 'All clear', 'Nothing needs you right now. Nice.')}
          </div>
          <div class="card"><div class="ch"><h3>${icon('tag')} Paying customers by plan</h3></div>
            ${o.plans.length ? html`<div class="plan-mini">${o.plans.sort((a, b) => b.workspaces - a.workspaces).map((p) => html`<div class="pr"><span style="min-width:110px">${CV.cap(p.plan)} <span class="mut small">${p.cycle === 'year' ? 'yearly' : 'monthly'}</span></span><span class="pb"><i style="width:${Math.round((p.workspaces / Math.max(1, totalPlans)) * 100)}%"></i></span><b class="tnum">${num(p.workspaces)}</b></div>`)}</div>`
              : CV.empty('tag', 'No paying customers yet', 'When someone pays for a plan, they show up here.')}
          </div>
        </div>`;
      return { html: page, mount: (el) => CV.mountCharts(el) };
    },
  });

  /* =================== USERS =================== */
  CV.page('users', {
    intro: () => (location.hash.match(/^#users\/\d+/) ? 'Everything about this person. Changes here apply straight away and are written to the audit log.' : 'Find any customer. Tap a person to see their plan, wallet, payments and messages.'),
    async render({ args, query }) {
      if (args[0]) return userDetail(Number(args[0]), args[1] || 'profile');
      const q = { q: query.get('q') || '', status: query.get('status') || '', plan: query.get('plan') || '', suspended: query.get('suspended') || '', staff: query.get('staff') || '', sort: query.get('sort') || '', page: query.get('page') || '1' };
      const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v));
      const [res, plans] = await Promise.all([get('/api/admin/users?' + params), CV.plans()]);
      const setQ = (patch) => { const n = { ...q, page: '1', ...patch }; const p = new URLSearchParams(Object.entries(n).filter(([, v]) => v)); if (n.page === '1') p.delete('page'); CV.go('users' + (String(p) ? '?' + p : '')); };
      const chip = (label, key, v) => html`<button class="chip${q[key] === v ? ' on' : ''}" data-set="${key}" data-v="${q[key] === v ? '' : v}">${label}</button>`;
      const rows = res.users.map((u) => html`<tr class="click" data-href="#users/${u.id}">
        <td class="main-cell" data-l="User"><div class="ucell"><span class="av">${initials(u.name, u.email)}</span><div style="min-width:0"><b>${u.name || u.email || ('@' + (u.tg_username || u.id))}</b><small>${u.email || (u.tg_username ? '@' + u.tg_username : 'No email')}</small></div></div></td>
        <td data-l="Plan">${u.plan_code ? html`<span class="row" style="gap:6px">${CV.cap(u.plan_code)} ${CV.planBadge(u.plan_status, u.plan_free)}</span>` : html`<span class="mut">—</span>`}</td>
        <td data-l="Total spent" class="num"><span class="money${u.spent ? '' : ' mut'}">${usd(u.spent)}</span></td>
        <td data-l="Wallet" class="num">${usd(u.wallet)}</td>
        <td data-l="Connections" class="num">${num(u.connections)}</td>
        <td data-l="Country">${u.country || '—'}</td>
        <td data-l="Joined" class="nowrap">${date(u.created_at)}</td>
        <td data-l="Status">${u.status === 'suspended' ? html`<span class="bd bad">Suspended</span>` : u.staff_role ? CV.roleBadge(u.staff_role) : html`<span class="bd ok">Active</span>`}</td>
      </tr>`);
      const page = html`
        <div class="card">
          <form class="row" id="uf">
            <div class="tsearch" style="width:auto;flex:1;min-width:200px;display:flex">${icon('search')}<input name="q" type="search" placeholder="Email, name, @username, referral code or workspace" value="${q.q}" aria-label="Search users"></div>
            <select class="in" name="status" style="width:auto" aria-label="Plan status"><option value="">Any status</option>${['trial', 'active', 'free', 'paused', 'cancelled'].map((s) => html`<option value="${s}" ${q.status === s ? raw('selected') : ''}>${{ trial: 'Free trial', active: 'Paying', free: 'Free plan', paused: 'Paused', cancelled: 'Cancelled' }[s]}</option>`)}</select>
            <select class="in" name="plan" style="width:auto" aria-label="Plan"><option value="">Any plan</option>${plans.map((p) => html`<option value="${p.code}" ${q.plan === p.code ? raw('selected') : ''}>${p.name}</option>`)}</select>
            <select class="in" name="sort" style="width:auto" aria-label="Sort"><option value="">Newest first</option><option value="spent" ${q.sort === 'spent' ? raw('selected') : ''}>Top spenders</option></select>
            <button class="btn sec" type="submit">Search</button>
          </form>
          <div class="chips">${chip('Suspended only', 'suspended', '1')}${chip('Team members', 'staff', '1')}${(q.q || q.status || q.plan || q.suspended || q.staff || q.sort) ? html`<button class="chip" data-clear>${icon('x')} Clear filters</button>` : ''}</div>
        </div>
        <div class="card flat">
          <div class="ch" style="padding:14px 16px"><h3>${icon('users')} ${plural(res.total, 'person', 'people')}</h3></div>
          ${res.users.length ? html`<div class="tw"><table class="tbl"><thead><tr><th>User</th><th>Plan</th><th class="num" title="Money they paid us, minus refunds">Total spent</th><th class="num">Wallet</th><th class="num">Connections</th><th>Country</th><th>Joined</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>${CV.pager(res.page, res.pages, res.total)}`
            : CV.empty('search', 'No one found', 'Try a shorter search, or clear the filters.')}
        </div>`;
      return {
        html: page,
        mount(el) {
          const f = $('#uf', el);
          f.addEventListener('submit', (e) => { e.preventDefault(); setQ({ q: f.q.value.trim(), status: f.status.value, plan: f.plan.value, sort: f.sort.value }); });
          f.status.addEventListener('change', () => f.requestSubmit());
          f.sort.addEventListener('change', () => f.requestSubmit());
          f.plan.addEventListener('change', () => f.requestSubmit());
          on(el, 'click', '[data-set]', (e, t) => setQ({ [t.dataset.set]: t.dataset.v }));
          on(el, 'click', '[data-clear]', () => CV.go('users'));
          on(el, 'click', 'tr[data-href]', (e, t) => { CV.go(t.dataset.href.slice(1)); });
          on(el, 'click', '[data-page]', (e, t) => setQ({ page: t.dataset.page }));
        },
      };
    },
  });

  const TABS = [['profile', 'Profile'], ['workspaces', 'Workspaces'], ['connections', 'Connections'], ['payments', 'Payments'], ['wallet', 'Wallet history'], ['support', 'Support'], ['referrals', 'Referrals'], ['links', 'Links']];

  async function userDetail(id, tab) {
    const [d, plans] = await Promise.all([get('/api/admin/users/' + id), CV.plans()]);
    const u = d.user;
    const planBy = Object.fromEntries(plans.map((p) => [p.code, p]));
    const name = u.name || u.email || (u.tg_username ? '@' + u.tg_username : 'User ' + u.id);
    const counts = { workspaces: d.workspaces.length, connections: d.connections.length, payments: d.payments.length, wallet: d.wallet_tx.length, support: d.threads.length, referrals: d.referred_count, links: (d.links || []).length };
    const canEdit = can('users.edit');
    const head = html`<div class="card"><div class="uhead">
      <a class="ib" href="#users" aria-label="Back to users">${icon('back')}</a>
      <span class="av">${initials(u.name, u.email)}</span>
      <div style="min-width:0"><h2>${name}</h2><div class="meta">
        ${u.status === 'suspended' ? html`<span class="bd bad">Suspended</span>` : html`<span class="bd ok">Active</span>`}
        ${u.staff_role ? CV.roleBadge(u.staff_role) : ''}
        ${d.workspaces[0] ? CV.planBadge(d.workspaces[0].plan_status, d.workspaces[0].plan_free) : ''}
        <span class="bd">Joined ${date(u.created_at)}</span></div></div>
      <div class="acts">
        ${canEdit ? (u.status === 'suspended'
          ? html`<button class="btn ok sm" data-act="unsuspend">${icon('check')} Unsuspend</button>`
          : html`<button class="btn danger sec sm" data-act="suspend">${icon('lock')} Suspend</button>`) : ''}
        ${u.email ? html`<a class="btn sec sm" href="mailto:${u.email}">${icon('mail')} Email</a>` : ''}
      </div></div>
      ${d.money ? html`<div class="spend">
        <div><small>Total spent</small><b>${usd(d.money.spent)}</b><span>${d.money.payments ? `${plural(d.money.payments, 'payment')} · last ${date(d.money.last_paid)}` : 'No payments yet'}</span></div>
        <div><small>Paid in</small><b>${usd(d.money.paid)}</b><span>${d.money.first_paid ? 'since ' + date(d.money.first_paid) : 'Top-ups confirmed'}</span></div>
        <div><small>Spent on plans</small><b>${usd(d.money.plans)}</b><span>${d.money.plans > d.money.plans_cash ? usd(d.money.plans - d.money.plans_cash) + ' of it bonus' : 'From their wallet'}</span></div>
        <div><small>Refunded</small><b>${usd(d.money.refunded)}</b><span>Sent back by the team</span></div>
        <div><small>In wallet now</small><b>${usd(d.money.wallet)}</b><span>Cash and bonus</span></div>
      </div>` : ''}
      <div class="tabs" role="tablist">${TABS.map(([k, l]) => html`<a class="tab${tab === k ? ' on' : ''}" role="tab" href="#users/${id}/${k}">${l}${counts[k] !== undefined && k !== 'profile' ? html`<span class="n">${counts[k]}</span>` : ''}</a>`)}</div>
    </div>`;

    let body;
    if (tab === 'workspaces') {
      body = d.workspaces.length ? d.workspaces.map((w, i) => {
        const p = planBy[w.plan_code] || {};
        const use = i === 0 ? d.usage : null;
        const meter = (label, used, limit) => { const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0; return html`<div class="meter"><div class="mt">${label}<span>${num(used)} of ${num(limit)}</span></div><div class="bar"><i class="${pct >= 90 ? 'hi' : ''}" style="width:${pct}%"></i></div></div>`; };
        return html`<div class="card">
          <div class="ch"><h3>${icon('home')} ${w.name}</h3><div class="acts">${CV.planBadge(w.plan_status, w.plan_free)}<span class="bd blue">${p.name || w.plan_code}</span><span class="bd">${w.role === 'owner' ? 'Owner' : 'Member: ' + w.role}</span></div></div>
          <div class="grid g2">
            <dl class="kv">
              <dt>Plan</dt><dd>${p.name || w.plan_code} · ${w.billing_cycle === 'year' ? 'yearly' : 'monthly'}</dd>
              <dt>Status</dt><dd>${CV.planBadge(w.plan_status, w.plan_free)}${w.cancel_at_period_end ? html` <span class="bd warn">Cancels at period end</span>` : ''}</dd>
              <dt>Trial ends</dt><dd>${w.trial_ends_at ? html`${date(w.trial_ends_at)} <span class="mut small">(${ago(w.trial_ends_at)})</span>` : '—'}</dd>
              <dt>Paid until</dt><dd>${w.period_end ? html`${date(w.period_end)} <span class="mut small">(${ago(w.period_end)})</span>` : '—'}</dd>
              <dt>Wallet</dt><dd><span class="money">${usdc(w.wallet_cents, { cents: true })}</span> cash + <span class="money">${usdc(w.bonus_cents, { cents: true })}</span> bonus</dd>
              <dt>AI writes used</dt><dd>${num(w.ai_used)} since ${date(w.ai_period_start)}</dd>
              <dt>Time zone</dt><dd>${w.timezone}</dd>
              <dt>Workspace ID</dt><dd class="mono">${w.id}</dd>
            </dl>
            <div class="stack">${use ? html`${meter('Connections', use.connections, p.connections || 0)}${meter('Subscribers', use.subscribers, p.subscribers || 0)}${meter('AI writes', use.ai_used, p.ai_writes || 0)}${meter('Team seats', use.seats, p.seats || 0)}` : html`<p class="mut small">Usage is shown for the first workspace only.</p>`}</div>
          </div>
          <div class="row">
            ${canEdit ? html`<button class="btn sm" data-ws-plan="${w.id}">${icon('edit')} Change plan or dates</button>` : ''}
            ${canEdit && w.plan_status === 'trial' ? html`<button class="btn sec sm" data-ws-extend="${w.id}">${icon('clock')} Extend trial 7 days</button>` : ''}
            ${canEdit ? html`<button class="btn sec sm" data-ws-ai="${w.id}">${icon('spark')} Reset AI writes</button>` : ''}
            ${can('wallet.adjust') ? html`<button class="btn sec sm" data-ws-wallet="${w.id}">${icon('wallet')} Wallet correction or refund</button>` : ''}
          </div>
        </div>`;
      }) : html`<div class="card">${CV.empty('home', 'No workspace', 'This person is not part of any workspace.')}</div>`;
    } else if (tab === 'connections') {
      body = html`<div class="card flat">${d.connections.length ? html`<div class="tw"><table class="tbl"><thead><tr><th>Name</th><th>Type</th><th class="num">Members</th><th>Status</th><th>Added</th></tr></thead><tbody>${d.connections.map((c) => html`<tr>
        <td class="main-cell" data-l="Name"><div style="min-width:0"><b>${c.title || c.username || 'Untitled'}</b>${c.username ? html`<div class="mut small">@${c.username}</div>` : ''}${c.last_error ? html`<div class="small" style="color:var(--bad)">${c.last_error}</div>` : ''}</div></td>
        <td data-l="Type">${CV.cap(c.kind)}</td><td data-l="Members" class="num">${num(c.member_count)}</td>
        <td data-l="Status">${c.status === 'active' ? html`<span class="bd ok">Working</span>` : c.status === 'error' ? html`<span class="bd bad">Broken</span>` : html`<span class="bd">${c.status}</span>`}</td>
        <td data-l="Added">${date(c.created_at)}</td></tr>`)}</tbody></table></div>` : CV.empty('plug', 'No connections yet', 'This person has not connected a bot, channel or group.')}</div>`;
    } else if (tab === 'payments') {
      body = html`<div class="card flat">${d.payments.length ? html`<div class="tw"><table class="tbl"><thead><tr><th>Payment</th><th class="num">Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${d.payments.map((p) => html`<tr${can('payments.view') ? html` class="click" data-href="#payments?q=${p.reference}"` : ''}>
        <td class="main-cell" data-l="Payment"><div style="min-width:0"><b>${providerName(p.provider, p.coin, p.method_label)}</b><div class="mut small mono break">${p.reference}</div>${p.reason ? html`<div class="small" style="color:var(--bad)">${p.reason}</div>` : ''}</div></td>
        <td data-l="Amount" class="num"><span class="money">${usdc(p.amount_cents)}</span>${Number(p.bonus_cents) ? html`<div class="small mut">+${usdc(p.bonus_cents)} bonus</div>` : ''}</td>
        <td data-l="Status">${CV.payBadge(p.status)}</td><td data-l="Date" class="nowrap">${dt(p.created_at)}</td></tr>`)}</tbody></table></div>` : CV.empty('card', 'No payments yet', 'Top-ups this person makes will show here.')}</div>`;
    } else if (tab === 'wallet') {
      const KIND = { topup: 'Top-up', bonus: 'Bonus', plan: 'Plan payment', refund: 'Refund', referral_credit: 'Referral credit', adjustment: 'Correction by team' };
      body = html`<div class="card flat">${d.wallet_tx.length ? html`<div class="tw"><table class="tbl"><thead><tr><th>What</th><th class="num">Amount</th><th>Split</th><th>Date</th></tr></thead><tbody>${d.wallet_tx.map((t) => html`<tr>
        <td class="main-cell" data-l="What"><div style="min-width:0"><b>${KIND[t.kind] || t.kind}</b>${t.note ? html`<div class="mut small">${t.note}</div>` : ''}${t.method ? html`<div class="mut small">${t.method}</div>` : ''}</div></td>
        <td data-l="Amount" class="num"><span class="money ${Number(t.amount_cents) >= 0 ? 'pos' : 'neg'}">${Number(t.amount_cents) >= 0 ? '+' : ''}${usdc(t.amount_cents, { cents: true })}</span></td>
        <td data-l="Split" class="small mut">${Number(t.cash_cents) ? 'cash ' + usdc(t.cash_cents, { cents: true }) : ''}${Number(t.cash_cents) && Number(t.bonus_part_cents) ? ' · ' : ''}${Number(t.bonus_part_cents) ? 'bonus ' + usdc(t.bonus_part_cents, { cents: true }) : ''}</td>
        <td data-l="Date" class="nowrap">${dt(t.created_at)}</td></tr>`)}</tbody></table></div>` : CV.empty('wallet', 'No wallet activity', 'Top-ups, plan payments and corrections will show here.')}</div>`;
    } else if (tab === 'support') {
      body = html`<div class="card flat">${d.threads.length ? html`<div class="list">${d.threads.map((t) => html`<a class="li" href="${can('support.view') ? '#support/' + t.id : '#users/' + id + '/support'}"><span class="ic">${icon('chat')}</span><span class="tx"><b>${t.subject || 'Conversation #' + t.id}</b><small>Last message ${ago(t.last_message_at)}</small></span><span class="end">${statusBadge(t.status)}${icon('chev', 'chev')}</span></a>`)}</div>` : CV.empty('chat', 'No conversations', 'This person has not written to support.')}</div>`;
    } else if (tab === 'referrals') {
      const b = d.referral_balance || {};
      body = html`<div class="kpis">
          <div class="kpi"><small>People they referred</small><b>${num(d.referred_count)}</b></div>
          <div class="kpi"><small>Ready to use or withdraw</small><b>${usdc(b.available)}</b></div>
          <div class="kpi"><small>Still settling</small><b>${usdc(b.pending)}</b></div>
          <div class="kpi"><small>Earned in total</small><b>${usdc(b.earned)}</b></div>
          <div class="kpi"><small>Withdrawn</small><b>${usdc(b.withdrawn)}</b></div>
          <div class="kpi"><small>Used for plans</small><b>${usdc(b.used)}</b></div>
        </div>
        <div class="card"><dl class="kv"><dt>Referral link</dt><dd>${CV.copyField(location.origin + '/r/' + u.ref_code, 'Copy link')}</dd>
        <dt>Referred by</dt><dd>${d.referred_by ? html`<a href="#users/${d.referred_by.id}">${d.referred_by.name || d.referred_by.email}</a>` : 'Nobody (came on their own)'}</dd></dl></div>`;
    } else if (tab === 'links') {
      // SEC-7: tracked button links (castvoo.com/l/<code>). Staff can switch one off when it points at a bad page.
      const L = d.links || [];
      body = html`<div class="card flat">${L.length ? html`<div class="tw"><table class="tbl"><thead><tr><th>Link</th><th class="num">Clicks</th><th>Status</th><th>Made</th>${canEdit ? html`<th></th>` : ''}</tr></thead><tbody>${L.map((l) => html`<tr>
        <td class="main-cell" data-l="Link"><div style="min-width:0"><b>${l.label || 'Button link'}</b><div class="mut small mono break">/l/${l.code} → ${l.url}</div>${l.disabled_reason ? html`<div class="small" style="color:var(--bad)">Off: ${l.disabled_reason}</div>` : ''}</div></td>
        <td data-l="Clicks" class="num">${num(l.clicks)}</td>
        <td data-l="Status">${l.disabled_at ? html`<span class="bd bad">Switched off</span>` : html`<span class="bd ok">Working</span>`}</td>
        <td data-l="Made">${date(l.created_at)}</td>
        ${canEdit ? html`<td data-l="">${l.disabled_at
          ? html`<button class="btn sec sm" data-link-on="${l.code}">${icon('check')} Switch on</button>`
          : html`<button class="btn danger sec sm" data-link-off="${l.code}">${icon('lock')} Switch off</button>`}</td>` : ''}</tr>`)}</tbody></table></div>` : CV.empty('ext', 'No tracked links', 'Button links in this person\'s messages show here.')}</div>`;
    } else {
      body = html`<div class="card"><dl class="kv">
        <dt>Name</dt><dd>${u.name || '—'}</dd>
        <dt>Email</dt><dd>${u.email || '—'} ${u.email ? (u.email_verified ? html`<span class="bd ok">Verified</span>` : html`<span class="bd warn">Not verified</span>`) : ''}</dd>
        <dt>Telegram</dt><dd>${u.tg_username ? '@' + u.tg_username : u.tg_user_id ? 'Linked (ID ' + u.tg_user_id + ')' : 'Not linked'}</dd>
        <dt>VooSquare</dt><dd>${u.voo_id ? html`<span class="mono">${u.voo_id}</span>` : 'Not linked'}</dd>
        <dt>Country</dt><dd>${u.country || '—'}</dd>
        <dt>Referral code</dt><dd class="mono">${u.ref_code}</dd>
        <dt>Sales emails</dt><dd>${u.marketing_opt_out ? html`<span class="bd">Unsubscribed</span>` : html`<span class="bd ok">Subscribed</span>`}</dd>
        <dt>Joined</dt><dd>${dt(u.created_at)}</dd>
        <dt>Last login</dt><dd>${u.last_login_at ? ago(u.last_login_at) : 'Never'}</dd>
        <dt>User ID</dt><dd class="mono">${u.id}</dd>
      </dl></div>`;
    }

    return {
      html: html`${head}${body}`,
      mount(el) {
        on(el, 'click', 'tr[data-href]', (e, t) => CV.go(t.dataset.href.slice(1)));
        on(el, 'click', '[data-act=suspend]', async () => {
          await dialog({ title: `Suspend ${name}?`, text: 'They are logged out at once, and all their scheduled and queued messages are cancelled. You can unsuspend later.', danger: true, okText: 'Suspend', icon: 'lock',
            fields: [{ name: 'reason', label: 'Reason (for the audit log)', placeholder: 'e.g. spam reports from subscribers' }],
            onSubmit: async (v) => { await post(`/api/admin/users/${id}/status`, { status: 'suspended', reason: v.reason }); toast(`${name} is suspended.`); CV.reload(); } });
        });
        on(el, 'click', '[data-link-off]', async (e, t) => {
          const code = t.dataset.linkOff;
          if (t.dataset.asking) return; // one dialog per tap, even on a double tap
          t.dataset.asking = '1';
          try {
            await dialog({ title: 'Switch off this link?', text: `People who tap /l/${code} see a short notice instead of the page. You can switch it on again.`, danger: true, okText: 'Switch off', icon: 'lock',
              fields: [{ name: 'reason', label: 'Reason (for the audit log)', required: true, placeholder: 'e.g. points at a fake login page' }],
              onSubmit: async (v) => { await post(`/api/admin/links/${encodeURIComponent(code)}/disable`, { disabled: true, reason: v.reason }); toast('The link is switched off.'); CV.reload(); } });
          } finally { delete t.dataset.asking; }
        });
        on(el, 'click', '[data-link-on]', async (e, t) => {
          const code = t.dataset.linkOn;
          if (!(await confirm('Switch this link on again?', `/l/${code} will send people to its page again.`, { okText: 'Switch on', icon: 'check' }))) return;
          if (await act(t, () => post(`/api/admin/links/${encodeURIComponent(code)}/disable`, { disabled: false }), 'The link works again.')) CV.reload();
        });
        on(el, 'click', '[data-act=unsuspend]', async () => {
          if (!(await confirm(`Unsuspend ${name}?`, 'They can log in again. Messages that were cancelled stay cancelled.', { okText: 'Unsuspend', icon: 'check' }))) return;
          if (await act(null, () => post(`/api/admin/users/${id}/status`, { status: 'active' }), `${name} can log in again.`)) CV.reload();
        });
        on(el, 'click', '[data-ws-plan]', (e, t) => changePlan(d.workspaces.find((w) => String(w.id) === t.dataset.wsPlan), plans));
        on(el, 'click', '[data-ws-extend]', async (e, t) => {
          const w = d.workspaces.find((x) => String(x.id) === t.dataset.wsExtend);
          const from = Math.max(Date.now(), new Date(w.trial_ends_at || Date.now()).getTime());
          const to = new Date(from + 7 * 86400000);
          if (!(await confirm('Give 7 more trial days?', `The free trial will end on ${date(to)} instead of ${date(w.trial_ends_at)}.`, { okText: 'Extend trial', icon: 'clock' }))) return;
          if (await act(null, () => post(`/api/admin/workspaces/${w.id}/plan`, { trial_ends_at: to.toISOString(), note: 'Trial extended by 7 days' }), 'Trial extended by 7 days.')) CV.reload();
        });
        on(el, 'click', '[data-ws-ai]', async (e, t) => {
          if (!(await confirm('Reset AI writes to zero?', 'Cas will have the full monthly amount of AI writes again for this workspace.', { okText: 'Reset', icon: 'spark' }))) return;
          if (await act(null, () => post(`/api/admin/workspaces/${t.dataset.wsAi}/plan`, { reset_ai: true, note: 'AI writes reset' }), 'AI writes reset.')) CV.reload();
        });
        on(el, 'click', '[data-ws-wallet]', (e, t) => walletFix(Number(t.dataset.wsWallet)));
      },
    };
  }

  function changePlan(w, plans) {
    return dialog({
      title: 'Change plan or dates', text: `Workspace “${w.name}”. The customer sees the change right away.`, icon: 'edit', okText: 'Save changes',
      fields: [
        { name: 'plan_code', label: 'Plan', type: 'select', value: w.plan_code, options: plans.map((p) => ({ value: p.code, label: `${p.name} (${CV.usd(p.price_month)}/month)${p.active ? '' : ' · hidden'}` })) },
        { name: 'plan_status', label: 'Status', type: 'select', value: w.plan_status, options: [{ value: 'trial', label: 'Free trial' }, { value: 'active', label: 'Paying (active)' }, { value: 'paused', label: 'Paused' }, { value: 'cancelled', label: 'Cancelled' }] },
        { name: 'trial_ends_at', label: 'Trial ends on', type: 'date', value: isoDay(w.trial_ends_at), hint: 'Needed when the status is Free trial.' },
        { name: 'period_end', label: 'Paid until', type: 'date', value: isoDay(w.period_end), hint: 'Needed when the status is Paying.' },
        { name: 'reset_ai', label: 'Also reset AI writes to zero', type: 'checkbox' },
        { name: 'note', label: 'Note for the audit log', placeholder: 'e.g. Comped a month after an outage' },
      ],
      onSubmit: async (v) => {
        const body = { plan_code: v.plan_code, plan_status: v.plan_status, trial_ends_at: v.trial_ends_at ? new Date(v.trial_ends_at + 'T23:59:00').toISOString() : null, period_end: v.period_end ? new Date(v.period_end + 'T23:59:00').toISOString() : null, reset_ai: v.reset_ai, note: v.note };
        await post(`/api/admin/workspaces/${w.id}/plan`, body);
        toast('Plan updated.'); CV.reload();
      },
    });
  }

  function walletFix(wsId) {
    return dialog({
      title: 'Wallet correction or refund', text: 'Add money with a positive number, remove money with a minus sign (e.g. -20). Write why, so the team understands later.', icon: 'wallet', okText: 'Save',
      fields: [
        { name: 'amount', label: 'Amount in US dollars', type: 'number', step: '0.01', prefix: '$', required: true, placeholder: '20 or -20' },
        { name: 'kind', label: 'Which balance', type: 'select', value: 'cash', options: [{ value: 'cash', label: 'Cash (real money, can be refunded)' }, { value: 'bonus', label: 'Bonus (free credit, plans only)' }] },
        { name: 'reason', label: 'Reason', required: true, placeholder: 'e.g. Refunded $20 by bank transfer on 3 Oct' },
        { name: 'refund', label: 'This records a refund we already sent', type: 'checkbox', hint: 'Use a negative amount for refunds. Castvoo does not send the money for you. Referral earnings from this customer that have not settled yet are cancelled.' },
      ],
      onSubmit: async (v) => {
        const amount = Number(v.amount);
        if (!amount) throw new Error('Enter an amount that is not 0.');
        if (Math.abs(amount) >= 500 && !(await confirm(`Change the wallet by ${CV.usd(amount)}?`, 'This is a large amount. Please double-check.', { okText: 'Yes, save' }))) return false;
        const r = await post(`/api/admin/workspaces/${wsId}/wallet`, { amount, kind: v.kind, reason: v.reason, refund: v.refund });
        toast(r && r.referral_reversed ? `Wallet updated. ${CV.usd(r.referral_reversed)} of unsettled referral earnings cancelled.` : 'Wallet updated.'); CV.reload();
      },
    });
  }

  const providerName = (p, coin, label) => ({ paystack: 'Paystack', flutterwave: 'Flutterwave', gatevoo: 'Crypto (Gatevoo)', manual_crypto: (coin || 'Crypto') + ' (manual)', manual: (label || 'Own method') + ' (manual)' }[p] || p);
  CV.providerName = providerName;
  const statusBadge = (s) => html`<span class="bd ${s === 'open' ? 'warn' : s === 'pending' ? 'blue' : ''}">${{ open: 'Open', pending: 'Waiting on customer', closed: 'Closed' }[s] || s}</span>`;
  /* The AI support team on a conversation: answering, paused (handover, take over, a staff reply) or switched off. */
  const AI_PAUSE = { handoff: 'Handed to the team', takeover: 'Taken over', staff_reply: 'Paused after a staff reply' };
  const aiState = (t) => (!t.ai_enabled ? ['off', 'AI off', ''] : t.ai_paused ? ['paused', AI_PAUSE[t.ai_paused_reason] || 'AI paused', 'warn'] : ['on', 'AI answering', 'vio']);
  const QUEUE = { support: 'Support', finance: 'Finance', tech: 'Technical', privacy: 'Privacy' };
  CV.AI_REASON = { asked_for_human: 'Asked for a person', refund: 'Refund request', chargeback: 'Chargeback or dispute', legal: 'Legal question', data_deletion: 'Data deletion',
    ownership: 'Ownership or account access', account_closure: 'Close the account', manual_payment: 'Manual payment to confirm', frustrated: 'Customer is upset', not_confident: 'AI not sure',
    tool_error: 'Checks failed', not_fixed: 'Not fixed after several tries', ai_error: 'AI could not answer', daily_cap: 'Daily AI limit', allowance: 'Free plan AI chats used up', money_claim: 'Money question', other: 'Needs a person' };
  const prioBadge = (p) => (p === 'urgent' ? html`<span class="bd bad">Urgent</span>` : p === 'high' ? html`<span class="bd warn">High priority</span>` : '');
  const aiBadge = () => html`<span class="bd vio aib">${icon('spark')} AI</span>`;

  /* =================== SUPPORT =================== */
  CV.page('support', {
    intro: 'Replies sent here or from VooSquare go to the same conversation. The customer gets an email when you reply.',
    async render({ args, query }) {
      const filter = query.get('f') || 'open';
      const q = query.get('q') || '';
      const threadId = args[0] ? Number(args[0]) : null;
      const listUrl = () => '/api/admin/support?' + new URLSearchParams({ status: filter === 'mine' ? 'all' : filter, ...(filter === 'mine' ? { mine: '1' } : {}), ...(q ? { q } : {}) });
      const [list, th] = await Promise.all([get(listUrl()), threadId ? get('/api/admin/support/' + threadId) : null]);
      const canReply = can('support.reply');
      const keep = (extra = '') => { const p = new URLSearchParams(); if (filter !== 'open') p.set('f', filter); if (q) p.set('q', q); return String(p) ? '?' + p + extra : extra; };

      const listHtml = (l) => l.threads.length ? l.threads.map((t) => html`<a class="th${t.id === threadId ? ' on' : ''}${t.unread_staff ? ' unread' : ''}" href="#support/${t.id}${keep()}">
          <span class="av">${initials(t.user_name, t.user_email)}</span>
          <span class="tx"><span class="r1"><b>${t.user_name || t.user_email}</b><time>${ago(t.last_message_at)}</time></span>
          <p>${t.last_author === 'staff' ? 'Team: ' : t.last_author === 'ai' ? 'AI: ' : ''}${t.last_message || t.subject}</p>
          <span class="tags">${t.needs_human && t.status !== 'closed' ? html`<span class="bd bad"><span class="dot"></span>Needs human</span>` : ''}${statusBadge(t.status)}${prioBadge(t.priority)}${t.needs_human && t.queue !== 'support' ? html`<span class="bd blue">${QUEUE[t.queue] || t.queue}</span>` : ''}${!t.needs_human && t.ai_enabled && !t.ai_paused && t.status !== 'closed' ? html`<span class="bd vio">${icon('spark')} AI</span>` : ''}${t.plan_code ? html`<span class="bd">${CV.cap(t.plan_code)}</span>` : ''}${t.assigned_name ? html`<span class="bd">${t.assigned_name}</span>` : ''}</span></span></a>`)
        : CV.empty('chat', filter === 'open' ? 'No open conversations' : 'Nothing here', filter === 'open' ? 'Every customer has an answer. Great work.' : 'Try another filter.');

      const msgsHtml = (msgs) => msgs.length ? msgs.map((m) => {
        const cls = m.internal ? 'note' : m.author_type === 'system' ? 'sys' : m.author_type === 'user' ? 'user' : m.author_type === 'ai' ? 'ai' : 'staff';
        const pending = m.visible_at && new Date(m.visible_at) > new Date();
        const face = m.author_type === 'ai' && m.persona_id ? html`<img class="pav" src="/api/public/personas/${m.persona_id}/photo" alt="" width="22" height="22">` : '';
        const pics = (m.attachments || []).length ? html`<div class="pics">${m.attachments.map((a) => html`<button type="button" data-alb="${a.url}" title="${a.width ? a.width + '×' + a.height + ' · ' : ''}${Math.max(1, Math.round(a.size / 1024))} KB${a.ai_readable ? '' : ' · too big for the AI'}"><img src="${a.url}" alt="Image" loading="lazy"></button>`)}</div>` : '';
        return html`<div class="msg ${cls}${pending ? ' typing' : ''}"><div class="bub">${m.body}${pics}</div><span class="who">${face}${m.internal ? '🔒 Internal note · ' : ''}${m.author_name || (m.author_type === 'user' ? 'Customer' : 'Castvoo team')}${m.author_type === 'ai' ? html` ${aiBadge()}` : m.author_type === 'staff' && !m.internal ? html` <span class="bd">Human</span>` : ''}${m.via && m.via !== 'castvoo' ? ' · via ' + m.via : ''} · ${pending ? 'typing…' : dt(m.visible_at || m.created_at)}</span></div>`;
      }) : html`<div class="mut small" style="text-align:center">No messages yet.</div>`;
      const toolsHtml = (log) => log && log.length ? html`<details class="aitools"><summary>${icon('cpu')} What the AI checked <span class="bd">${log.length}</span></summary><ol>${log.map((x) => html`<li class="${x.ok ? '' : 'bad'}"><b>${x.tool}</b><time>${dt(x.created_at)}</time><code>${JSON.stringify(x.output).slice(0, 400)}</code></li>`)}</ol></details>` : '';

      let threadHtml;
      if (th) {
        const t = th.thread;
        threadHtml = html`<div class="tt">
            <a class="ib sm back" href="#support${keep()}" aria-label="Back to all conversations">${icon('back')}</a>
            <h3>${t.subject || 'Conversation #' + t.id}</h3>
            ${statusBadge(t.status)}
            <button class="ib sm" data-cust aria-label="Show customer details" title="Customer details">${icon('user')}</button>
          </div>
          <div class="row" style="padding:8px 16px;border-bottom:1px solid var(--line);gap:8px">
            ${canReply ? html`<select class="in" id="assign" style="width:auto;height:34px;font-size:13px" aria-label="Assign to"><option value="">Not assigned</option>${th.staff.map((s) => html`<option value="${s.id}" ${String(t.assigned_to) === String(s.id) ? raw('selected') : ''}>${s.id === CV.me.user.id ? 'Me (' + (s.name || 'me') + ')' : s.name || 'Teammate ' + s.id}</option>`)}</select>
            <div class="seg" role="group" aria-label="Status">${['open', 'pending', 'closed'].map((s) => html`<button type="button" class="${t.status === s ? 'on' : ''}" data-status="${s}">${{ open: 'Open', pending: 'Waiting', closed: 'Closed' }[s]}</button>`)}</div>` : html`<span class="mut small">You can read conversations. Your role can't reply.</span>`}
          </div>
          ${th.ai_on || !t.ai_enabled || t.ai_paused ? html`<div class="aibar ${aiState(t)[0]}">
            ${th.agent ? html`<img class="pav lg" src="${th.agent.avatar}" alt="" width="30" height="30">` : html`<span class="pav lg ph">${icon('spark')}</span>`}
            <div class="tx"><b>${th.agent ? th.agent.name + ' · ' : ''}${aiState(t)[1]}</b><small>${t.needs_human ? html`${CV.AI_REASON[t.handoff_reason] || 'Needs a person'} · ${QUEUE[t.queue] || t.queue} team${t.handoff_at ? ' · ' + ago(t.handoff_at) : ''}` : t.ai_paused ? 'The AI stays quiet until you hand it back.' : t.ai_enabled ? 'AI support answers this customer. Reply yourself any time: the AI then pauses.' : 'The AI does not answer this conversation.'}</small></div>
            ${canReply ? html`<div class="row" style="gap:6px;margin-left:auto">
              ${t.ai_enabled && !t.ai_paused ? html`<button type="button" class="btn sec sm" data-ai="takeover">${icon('user')} Take over</button>` : ''}
              ${t.ai_paused || t.needs_human ? html`<button type="button" class="btn sm" data-ai="handback">${icon('spark')} Hand back to AI</button>` : ''}
              <button type="button" class="sw-ai" role="switch" aria-checked="${t.ai_enabled ? 'true' : 'false'}" data-ai="${t.ai_enabled ? 'off' : 'on'}" title="AI on or off for this conversation"><span></span>AI</button>
            </div>` : ''}
          </div>` : ''}
          <div class="ib-body">
            <div class="msgs" id="msgs">${msgsHtml(th.messages)}</div>
            <aside class="cust">
              <div class="row"><span class="av" style="width:40px;height:40px">${initials(t.user_name, t.user_email)}</span><div style="min-width:0"><b>${t.user_name || 'Customer'}</b><div class="mut small break">${t.user_email || ''}</div></div></div>
              <dl class="kv"><dt>Plan</dt><dd>${t.plan_code ? html`${CV.cap(t.plan_code)} ${CV.planBadge(t.plan_status, t.plan_free)}` : '—'}</dd>
                <dt>Wallet</dt><dd>${usdc(Number(t.wallet_cents || 0) + Number(t.bonus_cents || 0), { cents: true })}</dd>
                <dt>Country</dt><dd>${t.user_country || '—'}</dd>
                <dt>Telegram</dt><dd>${t.tg_username ? '@' + t.tg_username : '—'}</dd>
                <dt>Workspace</dt><dd>${t.workspace_name || '—'}</dd>
                <dt>Customer since</dt><dd>${date(t.user_since)}</dd></dl>
              ${can('users.view') ? html`<a class="btn sec sm" href="#users/${t.user_id}">${icon('user')} Open profile</a>` : ''}
              ${t.ai_summary ? html`<div class="aisum"><span class="lbl">${icon('spark')} AI summary</span><p>${t.ai_summary}</p>${t.needs_human ? html`<div class="tags">${prioBadge(t.priority) || html`<span class="bd">${CV.cap(t.priority)} priority</span>`}<span class="bd blue">${QUEUE[t.queue] || t.queue}</span></div>` : ''}</div>` : ''}
              ${toolsHtml(th.tool_log)}
            </aside>
          </div>
          ${canReply ? html`<form class="composer" id="composer">
            <div class="cpics" id="cpics" hidden></div>
            <textarea name="body" placeholder="Write a reply… (the customer gets it by email and in their dashboard). Paste a screenshot to attach it." aria-label="Reply"></textarea>
            <div class="row between">
              <label class="check small"><input type="checkbox" name="internal"> Internal note (only the team sees it)</label>
              <label class="btn ghost sm" style="cursor:pointer" title="Attach up to 3 images">${icon('image')} Image<input type="file" id="cfile" accept="image/jpeg,image/png,image/webp" multiple hidden></label>
              <div class="row" style="gap:6px;margin-left:auto">
                <button type="button" class="btn ghost sm" data-suggest title="Cas writes a draft for you to check. It is never sent by itself.">${icon('spark')} Suggest with Cas</button>
                <button type="button" class="btn sec sm" data-close>Reply and close</button>
                <button type="submit" class="btn sm">${icon('send')} <span data-sendlbl>Send reply</span></button>
              </div>
            </div></form>` : ''}`;
      } else {
        threadHtml = html`<div class="ib-none">${CV.empty('chat', 'Pick a conversation', 'Choose someone on the left to read and reply.')}</div>`;
      }

      const filters = [['open', 'Open', list.counts.open], ['human', 'Needs human', list.counts.human], ['pending', 'Waiting on customer', list.counts.pending], ['closed', 'Closed'], ['mine', 'Mine'], ['all', 'All']];
      const page = html`<div class="inbox${th ? ' has-thread' : ''}" id="inbox">
        <div class="ib-list">
          <div class="hd">
            <form id="sf" class="tsearch" style="width:100%;display:flex">${icon('search')}<input name="q" type="search" value="${q}" placeholder="Search name, email or subject" aria-label="Search conversations"></form>
            <div class="chips">${filters.map(([k, l, n]) => html`<a class="chip${filter === k ? ' on' : ''}" href="#support?${new URLSearchParams({ f: k, ...(q ? { q } : {}) })}">${l}${n !== undefined ? html`<span class="n">${n}</span>` : ''}</a>`)}</div>
          </div>
          <div class="items" id="items">${listHtml(list)}</div>
        </div>
        <section class="ib-thread" id="thread">${threadHtml}</section>
      </div>`;

      return {
        html: page,
        mount(el) {
          $('#sf', el).addEventListener('submit', (e) => { e.preventDefault(); const v = e.target.q.value.trim(); const p = new URLSearchParams(); if (filter !== 'open') p.set('f', filter); if (v) p.set('q', v); CV.go('support' + (String(p) ? '?' + p : '')); });
          const msgs = $('#msgs', el);
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
          let lastCount = th ? th.messages.length : 0;
          // Poll every 10 seconds: refresh the list and new messages, without touching what you're typing.
          CV.every(10000, async () => {
            try {
              const [l, t] = await Promise.all([get(listUrl()), threadId ? get('/api/admin/support/' + threadId) : null]);
              const items = $('#items', el); if (items) put(items, listHtml(l));
              if (t && msgs && t.messages.length !== lastCount) { const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80; lastCount = t.messages.length; put(msgs, msgsHtml(t.messages)); if (atBottom) msgs.scrollTop = msgs.scrollHeight; }
              CV.counts.support = l.counts.unread; CV.renderNav();
            } catch { /* keep quiet while polling */ }
          });
          if (!th) return;
          on(el, 'click', '[data-cust]', () => $('.ib-body', el).classList.toggle('show-cust'));
          on(el, 'click', '[data-alb]', (e, b) => CV.lightbox(b.dataset.alb));
          const form = $('#composer', el);
          if (!form) return;
          const ta = form.body;
          const sync = () => { form.classList.toggle('internal', form.internal.checked); $('[data-sendlbl]', form).textContent = form.internal.checked ? 'Save note' : 'Send reply'; $('[data-close]', form).hidden = form.internal.checked; };
          form.internal.addEventListener('change', sync);
          /* images for the next reply: uploaded at once, sent with the reply */
          let pend = [];
          const pics = $('#cpics', form);
          const drawPics = () => { pics.hidden = !pend.length; put(pics, html`${pend.map((x) => html`<span class="cpic${x.att ? '' : ' up'}"><img src="${x.url}" alt=""><button type="button" data-rmpic="${x.k}" aria-label="Remove image">${icon('x')}</button></span>`)}`); };
          const addPics = (files) => {
            for (const f of [...files]) {
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { toast('Use a JPG, PNG or WEBP image.', 'bad'); continue; }
              if (f.size > 10 * 1024 * 1024) { toast('Images can be up to 10 MB.', 'bad'); continue; }
              if (pend.length >= 3) { toast('Up to 3 images per reply.', 'bad'); break; }
              const x = { k: Math.random().toString(36).slice(2), url: URL.createObjectURL(f) };
              pend.push(x);
              fetch(`/api/admin/support/${threadId}/attachments`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type, 'x-cv': '1' }, body: f })
                .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Upload failed.'); x.att = j.attachment; drawPics(); })
                .catch((ex) => { pend = pend.filter((y) => y !== x); drawPics(); toast(ex.message, 'bad'); });
            }
            drawPics();
          };
          $('#cfile', form).addEventListener('change', (e) => { addPics(e.target.files); e.target.value = ''; });
          ta.addEventListener('paste', (e) => { const fs = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); addPics(fs); } });
          on(form, 'click', '[data-rmpic]', (e, b) => { pend = pend.filter((y) => y.k !== b.dataset.rmpic); drawPics(); });
          const send = async (btn, close) => {
            const body = ta.value.trim();
            if (pend.some((x) => !x.att)) { toast('Wait a second, an image is still uploading.', 'info'); return; }
            if (!body && !pend.length) { toast('Write a message first.', 'bad'); ta.focus(); return; }
            const internal = form.internal.checked;
            const ok = await act(btn, () => post(`/api/admin/support/${threadId}/reply`, { body, internal, close: !!close, attachments: pend.map((x) => x.att.id) }), internal ? 'Note saved.' : close ? 'Reply sent and conversation closed.' : 'Reply sent.');
            if (ok) { ta.value = ''; pend = []; CV.reload(); }
          };
          form.addEventListener('submit', (e) => { e.preventDefault(); send(e.submitter || $('button[type=submit]', form), false); });
          on(form, 'click', '[data-close]', (e, b) => send(b, true));
          ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') form.requestSubmit(); });
          on(form, 'click', '[data-suggest]', async (e, b) => {
            const r = await act(b, () => post(`/api/admin/support/${threadId}/suggest`));
            if (r && r.text) { ta.value = r.text; form.internal.checked = false; sync(); ta.focus(); toast('Cas wrote a draft. Read it, change anything, then send.', 'info'); }
          });
          on(el, 'click', '[data-ai]', async (e, b) => {
            const a = b.dataset.ai;
            const msg = { takeover: 'You have the conversation. The AI is paused.', handback: 'Handed back. The AI answers the next message.', off: 'AI switched off for this conversation.', on: 'AI switched on for this conversation.' }[a];
            if (await act(b, () => post(`/api/admin/support/${threadId}/ai`, { action: a }), msg)) CV.reload();
          });
          on(el, 'click', '[data-status]', async (e, b) => {
            if (await act(b, () => post(`/api/admin/support/${threadId}/status`, { status: b.dataset.status }), 'Status changed.')) CV.reload();
          });
          $('#assign', el)?.addEventListener('change', async (e) => {
            await act(null, () => post(`/api/admin/support/${threadId}/assign`, { user_id: e.target.value ? Number(e.target.value) : null }), e.target.value ? 'Assigned.' : 'Unassigned.');
          });
        },
      };
    },
  });
})();
