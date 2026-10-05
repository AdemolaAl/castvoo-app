'use strict';
/* Castvoo Admin — Features, Settings & connections, Team, Audit log, System. */
(() => {
  const { html, raw, icon, $, $$, on, put, num, usd, date, dt, ago, get, post, putj, act, dialog, confirm, can, toast } = CV;

  /* =================== FEATURES =================== */
  // Which connection each switch depends on. any: one of them is enough.
  const NEEDS = {
    login_email: { all: ['email'] }, login_telegram: { all: ['telegram'] }, login_google: { all: ['google'] }, login_voosquare: { all: ['voosquare_login'] },
    ai: { all: ['ai'] }, sales_emails: { all: ['email'] }, topups: { any: ['paystack', 'flutterwave', 'gatevoo'], soft: 'Crypto by hand still works without them.' },
    crypto: { any: ['gatevoo'], soft: 'Without Gatevoo, customers pay to the manual addresses in Settings.' },
  };
  const GROUP_IC = { Accounts: ['users', '#29A9EB'], Sending: ['send', '#2F6BFF'], AI: ['spark', '#A855F7'], Money: ['wallet', '#0E9F6E'], Support: ['chat', '#7B5CF5'], Emails: ['mail', '#F97316'], Platform: ['cpu', '#334155'] };

  CV.page('features', {
    intro: 'Big switches for the whole platform. Switching something off hides it on the website and dashboard straight away, and the server refuses it.',
    async render() {
      const { features, integrations: integ } = await get('/api/admin/features');
      const ed = can('features.edit');
      const groups = [...new Set(features.map((f) => f.group))];
      const need = (f) => {
        const n = NEEDS[f.key];
        if (!n) return '';
        if (n.all) { const miss = n.all.filter((k) => !integ[k]); return miss.length ? html`<span class="bd warn">${icon('plug')} Needs ${miss.map((k) => CV.INTEG[k]).join(', ')} connected</span>` : ''; }
        if (n.any && !n.any.some((k) => integ[k])) return html`<span class="bd ${n.soft ? 'blue' : 'warn'}">${icon('info')} ${n.any.map((k) => CV.INTEG[k]).join(' / ')} not connected. ${n.soft || ''}</span>`;
        return '';
      };
      const page = html`${ed ? '' : html`<div class="note">${icon('lock')}<span>You can see the switches. Only Owner and Admin can flip them.</span></div>`}
        <div class="grid g2">${groups.map((g) => { const [ic, c] = GROUP_IC[g] || ['toggle', '#64748B']; return html`<div class="card flat">
          <div class="ch" style="padding:16px"><h3><span class="big-ic" style="background:${c};width:30px;height:30px;border-radius:9px">${icon(ic)}</span> ${g}</h3></div>
          <div style="border-top:1px solid var(--line)">${features.filter((f) => f.group === g).map((f) => html`<div class="feat">
            <div class="tx"><b>${f.name}${f.key === 'maintenance' && f.enabled ? html` <span class="bd bad">ON NOW</span>` : ''}</b><p>${f.about}</p>${need(f)}</div>
            ${CV.sw(f.enabled, { fkey: f.key }, { lg: true, disabled: !ed, label: f.name })}
          </div>`)}</div></div>`; })}</div>`;
      return {
        html: page,
        mount(el) {
          on(el, 'click', '[data-fkey]', async (e, s) => {
            const f = features.find((x) => x.key === s.dataset.fkey);
            const next = s.getAttribute('aria-checked') !== 'true';
            if (f.key === 'maintenance' && next && !(await confirm('Turn on maintenance mode?', 'All sending and sign-ups pause, and customers see the maintenance message. Turn it off as soon as you are done.', { danger: true, okText: 'Turn on maintenance' }))) return;
            if (f.key !== 'maintenance' && !next && !(await confirm(`Switch off “${f.name}”?`, `${f.about} Customers lose this straight away.`, { danger: true, okText: 'Switch off' }))) return;
            CV.setSw(s, next); s.classList.add('busy');
            const ok = await act(null, () => post('/api/admin/features/' + f.key, { enabled: next }), `${f.name} is ${next ? 'on' : 'off'}.`);
            s.classList.remove('busy');
            if (!ok) CV.setSw(s, !next); else { f.enabled = next; if (f.key === 'maintenance') CV.reload(); }
          });
        },
      };
    },
  });

  /* =================== SETTINGS & CONNECTIONS =================== */
  const INTEGRATIONS = [
    { key: 'telegram', name: 'Telegram bot', ic: 'send', c: '#29A9EB', env: ['CASTVOO_BOT_TOKEN', 'CASTVOO_BOT_USERNAME'], test: 'telegram', about: 'The Castvoo bot that logs people in and joins their channels and groups. Make it with @BotFather. Press Test to set its webhook.' },
    { key: 'email', name: 'Email (Resend)', ic: 'mail', c: '#111827', env: ['RESEND_API_KEY', 'EMAIL_FROM'], test: 'email', about: 'Sends login codes, receipts and every other email. Verify your domain in Resend first. Without it, emails are only written to the server log.' },
    { key: 'ai', name: 'Cas AI (Anthropic)', ic: 'spark', c: '#A855F7', env: ['ANTHROPIC_API_KEY'], test: 'ai', about: 'Lets Cas write messages, answer questions and suggest support replies.' },
    { key: 'paystack', name: 'Paystack', ic: 'card', c: '#0BA4DB', env: ['PAYSTACK_SECRET_KEY'], test: 'paystack', urls: [['Webhook URL — paste in Paystack → Settings → API Keys & Webhooks', '/pay/paystack']], about: 'Card, bank transfer and mobile money in Nigeria, Ghana and South Africa.' },
    { key: 'flutterwave', name: 'Flutterwave', ic: 'card', c: '#F5A623', env: ['FLW_SECRET_KEY', 'FLW_WEBHOOK_HASH'], test: 'flutterwave', urls: [['Webhook URL — paste in Flutterwave → Settings → Webhooks (use the same secret hash as FLW_WEBHOOK_HASH)', '/pay/flutterwave']], about: 'Cards everywhere, M-Pesa in Kenya, MTN and Orange money in Cameroon.' },
    { key: 'gatevoo', name: 'Gatevoo', ic: 'wallet', c: '#111111', gv: true, env: ['GATEVOO_URL', 'GATEVOO_KEY', 'GATEVOO_WEBHOOK_SECRET'], test: 'gatevoo', urls: [['Webhook URL — paste in Gatevoo → Connect', '/pay/gatevoo']], about: 'Our own crypto checkout for USDT and Bitcoin. Payments are confirmed automatically.' },
    { key: 'google', name: 'Google login', ic: 'user', c: '#EA4335', env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], urls: [['Authorized redirect URI — paste in Google Cloud → Credentials → OAuth client', '/api/auth/google/callback']], about: '“Continue with Google” on the login page.' },
    { key: 'voosquare', name: 'VooSquare', ic: 'home', c: '#5B3DF5', status: (i) => i.voosquare_login && i.voosquare_api, partial: (i) => i.voosquare_login || i.voosquare_api, env: ['VOO_BASE', 'VOO_CLIENT_ID', 'VOO_CLIENT_SECRET', 'VOO_API_KEY'], urls: [['Redirect URI — paste in VooSquare → Admin → Products → Castvoo', '/api/auth/voosquare/callback'], ['Support webhook — paste in VooSquare → Admin → Products → Castvoo', '/api/voosquare/support/webhook'], ['Summary URL — paste in VooSquare → Admin → Products → Castvoo', '/api/voosquare/summary']], about: 'Log in with a VooSquare account. Castvoo support chats also appear in the VooSquare HQ inbox, and replies written there come back here. Activity events feed the VooSquare dashboard.' },
  ];
  const MONEY_KEYS = ['crypto', 'referral', 'billing'];
  const canSet = (key) => (key === 'crypto' ? CV.role() === 'owner' : MONEY_KEYS.includes(key) ? ['owner', 'admin', 'finance'].includes(CV.role()) : can('settings.edit'));
  const TABS = [['connections', 'Connections', 'plug'], ['crypto', 'Crypto & Gatevoo', 'wallet'], ['business', 'Company & trial', 'home'], ['money', 'Billing & referrals', 'card'], ['support', 'Support & legal', 'chat']];

  const sform = (key, title, ic, about, fields) => {
    const ro = !canSet(key);
    return html`<form class="card" data-skey="${key}"><div class="ch"><h3>${icon(ic)} ${title}</h3>${ro ? html`<span class="bd">${icon('lock')} Read only</span>` : html`<div class="acts"><button type="submit" class="btn sm">${icon('check')} Save</button></div>`}${about ? html`<p>${about}</p>` : ''}</div>
      <div class="fr">${fields.map((f) => CV.field({ ...f }))}</div></form>`;
  };
  const disableRo = (el) => $$('form[data-skey]', el).forEach((f) => { if (!canSet(f.dataset.skey)) for (const x of f.elements) x.disabled = true; });

  CV.page('settings', {
    intro: () => {
      const t = (location.hash.split('/')[1] || '').split('?')[0] || 'connections';
      return t === 'connections' ? 'Connections are set in Railway → your Castvoo service → Variables. After adding a variable, Railway restarts Castvoo by itself. Then press Test.' : 'Business rules. They change the website, emails, legal pages and the dashboard straight away.';
    },
    async render({ args }) {
      const tab = TABS.some(([k]) => k === args[0]) ? args[0] : 'connections';
      const [s, plans] = await Promise.all([get('/api/admin/settings'), CV.plans()]);
      const st = s.settings, integ = s.integrations;
      const origin = location.origin;
      const nav = html`<div class="card" style="padding:10px 12px"><div class="tabs" style="border:0">${TABS.map(([k, l, ic]) => html`<a class="tab${tab === k ? ' on' : ''}" href="#settings/${k}">${icon(ic)} ${l}</a>`)}</div></div>`;
      let body;
      if (tab === 'connections') {
        body = html`
          ${s.problems.length ? html`<div class="note bad">${icon('warn')}<span><b>Fix before launch:</b> ${s.problems.join(' ')}</span></div>` : ''}
          <div class="grid g2">${INTEGRATIONS.map((x) => {
            const okk = x.status ? x.status(integ) : !!integ[x.key];
            const part = !okk && x.partial && x.partial(integ);
            return html`<div class="intg" data-intg="${x.key}">
              <div class="ih">${x.gv ? html`<svg style="width:36px;height:36px"><use href="#gv"/></svg>` : html`<span class="big-ic" style="background:${x.c}">${icon(x.ic)}</span>`}<b>${x.gv ? html`<span class="gv-wm" style="font-size:17px">Gate<span>voo</span></span>` : x.name}</b>
                <span class="bd ${okk ? 'ok' : part ? 'warn' : 'bad'}"><span class="dot"></span>${okk ? 'Connected' : part ? 'Half set up' : 'Not connected'}</span></div>
              <p class="small mut">${x.about}</p>
              <div class="stack" style="gap:6px"><span class="lbl">Variables to set in Railway</span><div class="chips">${x.env.map((v) => html`<button type="button" class="chip mono" data-copy="${v}" title="Copy">${v} ${icon('copy')}</button>`)}</div></div>
              ${(x.urls || []).map(([l, p]) => html`<div class="stack" style="gap:6px"><span class="lbl">${l}</span>${CV.copyField(origin + p, 'Copy URL')}</div>`)}
              ${x.test && can('system.view') ? html`<div class="row"><button type="button" class="btn sec sm" data-test="${x.test}" ${okk ? '' : raw('disabled title="Connect it first"')}>${icon('refresh')} Test</button>${x.test === 'email' ? html`<span class="hint">Sends a test login code to you.</span>` : ''}</div><div class="res" hidden></div>` : ''}
            </div>`;
          })}</div>`;
      } else if (tab === 'crypto') {
        const c = st.crypto;
        const ro = !canSet('crypto');
        body = html`<form class="gvc" data-skey="crypto">
          <div class="row between"><div class="gv-brand"><svg><use href="#gv"/></svg><span class="gv-wm">Gate<span>voo</span></span></div>
            <span class="bd ${s.gatevoo.configured ? 'ok' : 'bad'}"><span class="dot"></span>${s.gatevoo.configured ? 'Connected' : 'Not connected'}</span></div>
          <p class="small mut">Gatevoo is our own crypto checkout. Customers pay USDT or Bitcoin on a Gatevoo page and their wallet is credited automatically, with no checking by hand.${s.gatevoo.url ? html` Gatevoo address: <span class="mono">${s.gatevoo.url}</span>` : ''}</p>
          <div class="feat" style="border:1px solid #E3E1DB;border-radius:14px;background:#fff">
            <div class="tx"><b>Use Gatevoo for crypto top-ups</b><p>${s.gatevoo.configured ? (c.use_gatevoo !== false ? 'On: customers see one “USDT or Bitcoin” option that opens Gatevoo.' : 'Off: customers send crypto to the manual addresses below.') : 'Gatevoo is not connected yet, so the manual addresses below are used. Connect it in the Connections tab.'}</p></div>
            ${CV.sw(c.use_gatevoo !== false, { gvsw: '1' }, { lg: true, disabled: ro, label: 'Use Gatevoo for crypto top-ups' })}
          </div>
          <div class="note">${icon('info')}<span><b>Manual mode</b> (when Gatevoo is off or not connected): the customer sends an exact USDT amount (like 100.37) to the address below, then pastes the transaction ID. It appears in Payments → “To check”. Approve only if that exact amount arrived to this address in that transaction. Leave the address empty to hide manual crypto.</span></div>
          <div class="fr two">
            ${CV.field({ name: 'usdt_address', label: 'USDT (TRC20) address', value: c.usdt_address, placeholder: 'Starts with T…', hint: 'Only a TRON (TRC20) address. Double-check every letter.' })}
            ${CV.field({ name: 'btc_address', label: 'Bitcoin address (kept for later)', value: c.btc_address, placeholder: 'bc1… or 1… or 3…', hint: 'Bitcoin is offered through Gatevoo only. Manual mode uses USDT, because every top-up gets its own exact amount (like 100.37) so a payment can only match one customer.' })}
          </div>
          ${ro ? html`<span class="bd">${icon('lock')} Only an Owner can change where crypto goes</span>` : html`<div class="row end"><button type="submit" class="btn dark">${icon('check')} Save crypto settings</button></div>`}
        </form>`;
      } else if (tab === 'business') {
        const t = st.trial;
        body = html`${sform('company', 'Company details', 'home', 'Shown in emails, receipts and legal pages.', [
          { name: 'name', label: 'Company name', value: st.company.name },
          { name: 'address', label: 'Address', value: st.company.address },
          { name: 'support_email', label: 'Support email', value: st.company.support_email, type: 'email' },
          { name: 'privacy_email', label: 'Privacy email', value: st.company.privacy_email, type: 'email' },
          { name: 'billing_email', label: 'Billing email', value: st.company.billing_email, type: 'email' },
        ])}
        ${sform('trial', 'Free trial', 'clock', 'What new sign-ups get, with no card needed.', [
          { name: 'days', label: 'Trial length (days)', type: 'number', min: 0, max: 60, value: t.days },
          { name: 'plan', label: 'Trial plan', type: 'select', value: t.plan, options: plans.filter((p) => p.active || p.code === t.plan).map((p) => ({ value: p.code, label: p.name })) },
          { name: 'ai_writes', label: 'AI writes during the trial', type: 'number', min: 0, value: t.ai_writes },
        ])}`;
      } else if (tab === 'money') {
        const b = st.billing, r = st.referral;
        body = html`${sform('billing', 'Billing', 'card', 'Top-up limits, refunds and reminders.', [
          { name: 'min_topup', label: 'Smallest top-up', type: 'number', step: '0.01', prefix: '$', value: b.min_topup_cents / 100 },
          { name: 'max_topup', label: 'Biggest top-up', type: 'number', step: '0.01', prefix: '$', value: b.max_topup_cents / 100 },
          { name: 'refund_days', label: 'Refund window (days)', type: 'number', min: 0, max: 90, value: b.refund_days },
          { name: 'data_retention_days', label: 'Keep data after a plan ends (days)', type: 'number', min: 7, value: b.data_retention_days },
          { name: 'renew_reminder_days', label: 'Low-balance reminder (days before renewal)', type: 'number', min: 1, max: 14, value: b.renew_reminder_days },
        ])}
        ${sform('referral', 'Referral program', 'users', 'How much people earn for bringing paying customers.', [
          { name: 'rate_1', label: 'Tier 1 share (%)', type: 'number', min: 0, max: 60, value: r.rates[0], hint: 'From the first paying referral.' },
          { name: 'tier2_min', label: 'Tier 2 starts at (paying referrals)', type: 'number', min: 2, value: r.tier2_min },
          { name: 'rate_2', label: 'Tier 2 share (%)', type: 'number', min: 0, max: 60, value: r.rates[1] },
          { name: 'tier3_min', label: 'Tier 3 starts at (paying referrals)', type: 'number', min: 3, value: r.tier3_min },
          { name: 'rate_3', label: 'Tier 3 share (%)', type: 'number', min: 0, max: 60, value: r.rates[2] },
          { name: 'settle_days', label: 'Earnings settle after (days)', type: 'number', min: 0, max: 120, value: r.settle_days, hint: 'Covers refunds and chargebacks.' },
          { name: 'min_withdraw', label: 'Smallest withdrawal', type: 'number', step: '0.01', prefix: '$', value: r.min_withdraw_cents / 100 },
          { name: 'cookie_days', label: 'Referral link remembered for (days)', type: 'number', min: 1, max: 365, value: r.cookie_days },
        ])}`;
      } else {
        body = html`${sform('support', 'Support', 'chat', 'What customers see in the help chat.', [
          { name: 'reply_time', label: 'Reply time text', type: 'textarea', rows: 2, value: st.support.reply_time },
          { name: 'telegram_username', label: 'Support Telegram username (optional)', value: st.support.telegram_username, placeholder: 'castvoo_support', prefix: '@' },
        ])}
        ${sform('legal_updated', 'Legal pages', 'note', 'The “Last updated” date on Terms, Privacy, Refunds and the other legal pages. Change it whenever you change a policy.', [
          { name: 'value', label: 'Last updated', value: st.legal_updated, placeholder: '3 October 2026' },
        ])}
        <div class="row"><a class="btn sec sm" href="/legal/terms" target="_blank" rel="noopener">${icon('ext')} View legal pages</a></div>`;
      }
      return {
        html: html`${nav}${body}`,
        mount(el) {
          disableRo(el);
          on(el, 'click', '[data-test]', async (e, b) => {
            const res = $('.res', b.closest('.intg'));
            const r = await act(b, () => post(`/api/admin/integrations/${b.dataset.test}/test`));
            if (!r) return;
            res.hidden = false; res.className = 'res ' + (r.ok ? 'ok' : 'bad'); res.textContent = (r.ok ? '✓ ' : '✗ ') + (r.detail || (r.ok ? 'Works.' : 'Failed.'));
          });
          const gv = $('[data-gvsw]', el);
          if (gv) gv.addEventListener('click', () => CV.setSw(gv, gv.getAttribute('aria-checked') !== 'true'));
          on(el, 'submit', 'form[data-skey]', async (e, f) => {
            e.preventDefault();
            const key = f.dataset.skey;
            const v = CV.formValues(f);
            let value;
            if (key === 'legal_updated') value = v.value.trim();
            else if (key === 'crypto') value = { use_gatevoo: gv.getAttribute('aria-checked') === 'true', usdt_address: v.usdt_address.trim(), btc_address: v.btc_address.trim() };
            else value = v;
            if (key === 'referral' && !(await confirm('Change the referral program?', 'New earnings use the new numbers. The referral terms page updates too.', { okText: 'Save' }))) return;
            if (key === 'crypto' && (value.usdt_address !== st.crypto.usdt_address || value.btc_address !== st.crypto.btc_address) && !(await confirm('Change the crypto addresses?', 'Customers will send money to these addresses. A wrong letter means the money is lost forever. Check them twice.', { danger: true, okText: 'Yes, they are correct' }))) return;
            if (await act($('button[type=submit]', f), () => putj('/api/admin/settings/' + key, { value }), 'Saved.')) { if (key === 'crypto') CV.reload(); else if (st[key] !== undefined) st[key] = value; }
          });
        },
      };
    },
  });

  /* =================== TEAM =================== */
  const PERM_LABEL = {
    'overview.view': 'See the overview', 'users.view': 'See users, prices and offers', 'users.edit': 'Change plans, suspend people', 'wallet.adjust': 'Wallet corrections and refunds',
    'support.view': 'Read support chats', 'support.reply': 'Reply to customers', 'payments.view': 'See payments and withdrawals', 'payments.review': 'Approve or reject crypto payments',
    'withdrawals.review': 'Pay or reject withdrawals', 'pricing.edit': 'Change prices and plans', 'offers.edit': 'Offers, coupons, banners', 'countries.edit': 'Countries, rates, payment methods',
    'content.edit': 'Website text', 'emails.edit': 'Email templates', 'knowledge.edit': 'Cas knowledge (and Try Cas)', 'ai.edit': 'AI settings', 'features.edit': 'Turn features on and off',
    'settings.edit': 'Settings and connections', 'team.manage': 'Add and change teammates', 'audit.view': 'See the audit log', 'system.view': 'System health and connection tests',
  };

  CV.page('team', {
    intro: 'Your team and what each role can do. Higher rank means more power. You can only give roles below your own (owners can give any role).',
    async render() {
      const t = await get('/api/admin/team');
      const me = CV.me.user;
      const myRank = CV.rank(me.role);
      const manage = can('team.manage');
      const isOwner = me.role === 'owner';
      const giveable = t.roles.filter((r) => isOwner || r.rank < myRank);
      const canTouch = (s) => manage && s.id !== me.id && (isOwner || s.rank < myRank);
      const ordered = [...t.roles].sort((a, b) => b.rank - a.rank);
      const ladder = html`<div class="ladder">${ordered.map((r, i) => html`${i ? html`<span class="gt">›</span>` : ''}<div class="rung${r.key === me.role ? ' me' : ''}"><b>${r.name}</b><small>Rank ${r.rank}${r.key === me.role ? ' · you' : ''}</small></div>`)}</div>`;
      const page = html`
        <div class="card"><div class="ch"><h3>${icon('shield')} Ranks</h3>${manage ? html`<div class="acts"><button class="btn sm" data-add>${icon('plus')} Add teammate</button></div>` : ''}</div>${ladder}</div>
        <div class="card flat"><div class="ch" style="padding:16px"><h3>${icon('users')} Team <span class="bd">${t.staff.length}</span></h3></div>
          <div class="tw" style="border-top:1px solid var(--line)"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th>Last login</th><th></th></tr></thead><tbody>${t.staff.map((s) => html`<tr>
            <td class="main-cell" data-l="Person"><div class="ucell"><span class="av">${CV.initials(s.name, s.email)}</span><div style="min-width:0"><b>${s.name || s.email}${s.id === me.id ? ' (you)' : ''}</b><small>${s.email || (s.tg_username ? '@' + s.tg_username : '')}</small></div></div></td>
            <td data-l="Role">${canTouch(s) ? html`<select class="in" data-role="${s.id}" style="width:auto;height:34px" aria-label="Role for ${s.name || s.email}">${[...new Map([...giveable, t.roles.find((r) => r.key === s.staff_role)].map((r) => [r.key, r])).values()].sort((a, b) => b.rank - a.rank).map((r) => html`<option value="${r.key}" ${r.key === s.staff_role ? raw('selected') : ''}>${r.name} (${r.rank})</option>`)}</select>` : CV.roleBadge(s.staff_role, s.role_name)}</td>
            <td data-l="Last login">${s.last_login_at ? ago(s.last_login_at) : 'Never'}</td>
            <td data-l="">${canTouch(s) ? html`<button class="btn danger sec xs" data-remove="${s.id}">${icon('trash')} Remove</button>` : ''}</td>
          </tr>`)}</tbody></table></div></div>
        <div class="card"><div class="ch"><h3>${icon('lock')} Roles and what they can do</h3></div>
          <div class="grid g3">${ordered.map((r) => html`<div class="row" style="align-items:flex-start;gap:10px;flex-wrap:nowrap"><span class="bd role-${r.key}">${r.name}</span><span class="small mut">${r.about}</span></div>`)}</div>
          <div class="mx-wrap"><table class="mx"><thead><tr><th>Can…</th>${ordered.map((r) => html`<th>${r.name}</th>`)}</tr></thead><tbody>${Object.keys(t.matrix).map((p) => html`<tr><td>${PERM_LABEL[p] || p}</td>${ordered.map((r) => (t.matrix[p].includes(r.key) ? html`<td class="y" aria-label="yes">✓</td>` : html`<td class="n" aria-label="no">—</td>`))}</tr>`)}</tbody></table></div>
          <p class="hint">Money settings (crypto addresses, billing, referrals) can also be changed by Finance.</p>
        </div>`;
      return {
        html: page,
        mount(el) {
          on(el, 'click', '[data-add]', () => dialog({
            title: 'Add a teammate', text: 'They get an email with a link to the admin panel. They log in with this email address.', icon: 'plus', okText: 'Add to team',
            fields: [
              { name: 'email', label: 'Their email', type: 'email', required: true, placeholder: 'name@example.com' },
              { name: 'role', label: 'Role', type: 'select', value: giveable.find((r) => r.key === 'support') ? 'support' : giveable[giveable.length - 1].key, options: giveable.sort((a, b) => b.rank - a.rank).map((r) => ({ value: r.key, label: `${r.name} — ${r.about}` })) },
            ],
            onSubmit: async (v) => {
              if (v.role === 'owner' && !(await confirm('Make them an Owner?', 'Owners can do everything, including removing you.', { danger: true, okText: 'Yes, make Owner' }))) return false;
              await post('/api/admin/team', { email: v.email.trim(), role: v.role }); toast(`${v.email} is on the team.`); CV.reload();
            },
          }));
          on(el, 'change', '[data-role]', async (e, sel) => {
            const s = t.staff.find((x) => String(x.id) === sel.dataset.role);
            const r = t.roles.find((x) => x.key === sel.value);
            if (!(await confirm(`Make ${s.name || s.email} ${r.name}?`, r.about, { okText: 'Change role', danger: r.key === 'owner' }))) { sel.value = s.staff_role; return; }
            if (await act(null, () => post(`/api/admin/team/${s.id}/role`, { role: r.key }), 'Role changed.')) CV.reload(); else sel.value = s.staff_role;
          });
          on(el, 'click', '[data-remove]', async (e, b) => {
            const s = t.staff.find((x) => String(x.id) === b.dataset.remove);
            if (!(await confirm(`Remove ${s.name || s.email} from the team?`, 'They lose access to the admin panel straight away. Their own Castvoo account stays.', { danger: true, okText: 'Remove' }))) return;
            if (await act(b, () => post(`/api/admin/team/${s.id}/role`, { role: null }), 'Removed from the team.')) CV.reload();
          });
        },
      };
    },
  });

  /* =================== AUDIT LOG =================== */
  const ACTION = {
    'user.suspended': ['Suspended a user', 'lock'], 'user.active': ['Unsuspended a user', 'check'], 'workspace.plan': ['Changed a plan', 'edit'], 'wallet.adjust': ['Corrected a wallet', 'wallet'], 'wallet.refund': ['Recorded a refund', 'wallet'],
    'payment.approve': ['Approved a payment', 'check'], 'payment.reject': ['Rejected a payment', 'x'], 'payment.recheck': ['Rechecked a payment', 'refresh'], 'withdrawal.paid': ['Paid a withdrawal', 'out'], 'withdrawal.reject': ['Rejected a withdrawal', 'x'],
    'plan.create': ['Created a plan', 'tag'], 'plan.update': ['Changed a plan', 'tag'], 'offer.create': ['Created an offer', 'gift'], 'offer.update': ['Changed an offer', 'gift'], 'offer.on': ['Switched an offer on', 'toggle'], 'offer.off': ['Switched an offer off', 'toggle'], 'offer.delete': ['Deleted an offer', 'trash'],
    'country.save': ['Changed a country', 'globe'], 'method.save': ['Changed a payment method', 'card'], 'feature.on': ['Switched a feature on', 'toggle'], 'feature.off': ['Switched a feature off', 'toggle'], 'content.save': ['Changed website text', 'text'],
    'email.save': ['Changed an email', 'mail'], 'email.reset': ['Reset an email', 'mail'], 'knowledge.create': ['Added Cas knowledge', 'book'], 'knowledge.update': ['Changed Cas knowledge', 'book'], 'knowledge.delete': ['Deleted Cas knowledge', 'trash'],
    'team.add': ['Added a teammate', 'shield'], 'team.role': ['Changed a role', 'shield'], 'team.remove': ['Removed a teammate', 'shield'], 'integration.test': ['Tested a connection', 'plug'],
  };
  const actionInfo = (a) => ACTION[a] || (a.startsWith('settings.') ? [`Changed ${a.slice(9).replace('_', ' ')} settings`, 'plug'] : [a, 'list']);
  const targetLink = (t) => {
    const [k, id] = String(t || '').split(':');
    if (k === 'user' && can('users.view')) return html`<a href="#users/${id}">user #${id}</a>`;
    if (k === 'payment' && can('payments.view')) return html`<a href="#payments?q=${id}">${id}</a>`;
    return t;
  };

  CV.page('audit', {
    intro: 'Every change anyone on the team makes, newest first. Nothing here can be edited or deleted.',
    async render({ query }) {
      const q = query.get('q') || '';
      const page = Math.max(1, Number(query.get('page')) || 1);
      const { entries } = await get('/api/admin/audit?' + new URLSearchParams({ ...(q ? { q } : {}), page: String(page) }));
      let lastDay = '';
      const items = entries.map((e) => {
        const day = date(e.created_at);
        const head = day !== lastDay ? html`<div class="tl-day">${day === date(new Date()) ? 'Today' : day}</div>` : '';
        lastDay = day;
        const [label, ic] = actionInfo(e.action);
        const hasData = e.data && Object.keys(e.data).length;
        return html`${head}<div class="ev"><span class="ic">${icon(ic)}</span><div style="min-width:0"><b>${label}</b><small>${e.actor_name || e.actor_email || 'System'} · ${targetLink(e.target)} · <span class="mono">${e.action}</span></small>
          ${hasData ? html`<details><summary>Details</summary><pre>${JSON.stringify(e.data, null, 2)}</pre></details>` : ''}</div><time title="${dt(e.created_at)}">${CV.time(e.created_at)} · ${ago(e.created_at)}</time></div>`;
      });
      const html2 = html`<div class="card"><form class="row" id="af"><div class="tsearch" style="width:auto;flex:1;min-width:200px;display:flex">${icon('search')}<input name="q" type="search" value="${q}" placeholder="Search by action (e.g. payment, plan), target or person" aria-label="Search the audit log"></div><button class="btn sec">Search</button></form></div>
        <div class="card flat"><div class="tl">${entries.length ? items : CV.empty('list', 'Nothing found', q ? 'Try another word.' : 'Changes will show here.')}</div>
        ${page > 1 || entries.length === 100 ? html`<div class="row between" style="padding:12px 16px;border-top:1px solid var(--line)"><span class="mut small">Page ${page}</span><div class="row"><button class="btn sec sm" data-page="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>${icon('back')} Newer</button><button class="btn sec sm" data-page="${page + 1}" ${entries.length < 100 ? raw('disabled') : ''}>Older ${icon('chev')}</button></div></div>` : ''}</div>`;
      return {
        html: html2,
        mount(el) {
          const go = (patch) => { const p = new URLSearchParams({ ...(q ? { q } : {}), ...patch }); if (p.get('page') === '1') p.delete('page'); if (!p.get('q')) p.delete('q'); CV.go('audit' + (String(p) ? '?' + p : '')); };
          $('#af', el).addEventListener('submit', (e) => { e.preventDefault(); go({ q: e.target.q.value.trim(), page: '1' }); });
          on(el, 'click', '[data-page]', (e, b) => go({ page: b.dataset.page }));
        },
      };
    },
  });

  /* =================== SYSTEM =================== */
  CV.page('system', {
    intro: 'The engine room: messages waiting to send, background jobs and server health. This page refreshes itself every 30 seconds.',
    async render() {
      const s = await get('/api/admin/system');
      const uptime = s.process.uptime_min >= 1440 ? `${Math.floor(s.process.uptime_min / 1440)} d ${Math.floor((s.process.uptime_min % 1440) / 60)} h` : s.process.uptime_min >= 60 ? `${Math.floor(s.process.uptime_min / 60)} h ${s.process.uptime_min % 60} min` : `${s.process.uptime_min} min`;
      const queued = s.queue.reduce((a, q) => a + q.queued, 0);
      const page = html`
        ${s.problems.length ? html`<div class="note bad">${icon('warn')}<span><b>Problems:</b> ${s.problems.join(' ')}</span></div>` : html`<div class="note ok">${icon('check')}<span>No setup problems found.</span></div>`}
        <div class="row end"><span class="mut small">Updated ${CV.time(new Date())}</span><button class="btn sec sm" data-refresh>${icon('refresh')} Refresh</button></div>
        <div class="kpis">
          <div class="kpi"><div class="kh"><small>Messages waiting</small><span class="ki" style="--c:#2F6BFF">${icon('send')}</span></div><b>${num(queued)}</b><span class="sub">${s.queue.length} bots sending</span></div>
          <div class="kpi"><div class="kh"><small>Background jobs waiting</small><span class="ki" style="--c:${s.outbox.failing ? '#E5484D' : '#64748B'}">${icon('list')}</span></div><b>${num(s.outbox.pending)}</b><span class="sub">${s.outbox.failing ? html`<span class="dn">${num(s.outbox.failing)} failing</span>` : 'None failing'}${s.outbox.refused ? html` · <span class="dn">${num(s.outbox.refused)} refused by VooSquare</span>` : ''}</span></div>
          <div class="kpi"><div class="kh"><small>Database size</small><span class="ki" style="--c:#0E9F6E">${icon('cpu')}</span></div><b>${s.db.size}</b><span class="sub">${s.db.version}</span></div>
          <div class="kpi"><div class="kh"><small>Server memory</small><span class="ki" style="--c:#F59E0B">${icon('dash')}</span></div><b>${num(s.process.memory_mb)} MB</b><span class="sub">Node ${s.process.node}</span></div>
          <div class="kpi"><div class="kh"><small>Running for</small><span class="ki" style="--c:#6366F1">${icon('clock')}</span></div><b>${uptime}</b><span class="sub">Workers ${s.process.workers ? 'on' : 'off'}</span></div>
        </div>
        <div class="grid g2">
          <div class="card flat"><div class="ch" style="padding:16px"><h3>${icon('send')} Sending queue per bot</h3></div>${s.queue.length ? html`<div class="tw" style="border-top:1px solid var(--line)"><table class="tbl"><thead><tr><th>Sender</th><th class="num">Waiting</th><th>Oldest</th><th>Worker</th></tr></thead><tbody>${s.queue.map((q) => { const l = s.leases.find((x) => x.sender_key === q.sender_key); return html`<tr><td class="main-cell" data-l="Sender"><span class="mono break">${q.sender_key}</span></td><td data-l="Waiting" class="num">${num(q.queued)}</td><td data-l="Oldest">${ago(q.oldest)}</td><td data-l="Worker">${l ? html`<span class="bd ok">Sending</span>` : html`<span class="bd warn">Idle</span>`}</td></tr>`; })}</tbody></table></div>` : html`<div style="border-top:1px solid var(--line)">${CV.empty('check', 'Queue is empty', 'Every message has been sent.')}</div>`}</div>
          <div class="card flat"><div class="ch" style="padding:16px"><h3>${icon('lock')} Active workers (leases)</h3></div>${s.leases.length ? html`<div class="list" style="border-top:1px solid var(--line)">${s.leases.map((l) => html`<div class="li"><span class="ic ok">${icon('cpu')}</span><span class="tx"><b class="mono break">${l.sender_key}</b><small>Worker ${l.owner} · until ${CV.time(l.expires_at)}</small></span></div>`)}</div>` : html`<div style="border-top:1px solid var(--line)">${CV.empty('cpu', 'No workers busy', 'Workers pick up messages as soon as they are queued.')}</div>`}</div>
        </div>
        <div class="grid g2">
          <div class="card flat"><div class="ch" style="padding:16px"><h3>${icon('warn')} Top failures, last 24 hours</h3></div>${s.failed_24h.length ? html`<div class="list" style="border-top:1px solid var(--line)">${s.failed_24h.map((f) => html`<div class="li"><span class="ic bad">${icon('warn')}</span><span class="tx"><b style="white-space:normal">${f.error || 'Unknown error'}</b></span><span class="end"><span class="bd bad">${num(f.n)}</span></span></div>`)}</div>` : html`<div style="border-top:1px solid var(--line)">${CV.empty('check', 'No failures', 'Nothing failed in the last 24 hours.')}</div>`}</div>
          <div class="card flat"><div class="ch" style="padding:16px"><h3>${icon('plug')} Broken connections</h3></div>${s.broken_connections.length ? html`<div class="list" style="border-top:1px solid var(--line)">${s.broken_connections.map((c) => html`<div class="li"><span class="ic bad">${icon('plug')}</span><span class="tx"><b>${c.title || c.username || 'Connection ' + c.id} <span class="bd">${c.kind}</span></b><small style="white-space:normal">${c.workspace} · ${c.last_error || ''}</small></span></div>`)}</div>` : html`<div style="border-top:1px solid var(--line)">${CV.empty('check', 'All connections work', '')}</div>`}</div>
        </div>
        <div class="card"><div class="ch"><h3>${icon('send')} Castvoo's own Telegram bot</h3></div>
          ${s.platform_bot ? (s.platform_bot.error ? html`<div class="note bad">${icon('warn')}<span>${s.platform_bot.error}</span></div>` : html`<dl class="kv"><dt>Webhook</dt><dd class="mono break">${s.platform_bot.url || 'Not set — press Test on Telegram in Settings'}</dd><dt>Updates waiting</dt><dd>${num(s.platform_bot.pending)}</dd><dt>Last error</dt><dd>${s.platform_bot.last_error ? html`${s.platform_bot.last_error} <span class="mut small">(${ago(s.platform_bot.last_error_at)})</span>` : 'None'}</dd></dl>`)
            : html`<div class="note warn">${icon('warn')}<span>The bot is not connected (CASTVOO_BOT_TOKEN is missing). <a href="#settings">How to connect</a></span></div>`}
          <div class="integ">${Object.entries(s.integrations).map(([k, v]) => html`<span class="bd ${v ? 'ok' : ''}"><span class="dot"></span>${CV.INTEG[k] || k}</span>`)}</div>
        </div>`;
      return {
        html: page,
        mount(el) {
          on(el, 'click', '[data-refresh]', () => CV.reload());
          CV.every(30000, () => CV.reload());
        },
      };
    },
  });
})();
