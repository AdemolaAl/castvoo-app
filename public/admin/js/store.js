'use strict';
/* Castvoo Admin — Pricing, Offers, Countries & payments. */
(() => {
  const { html, raw, icon, $, $$, on, put, num, usd, date, isoDay, get, post, putj, del, act, dialog, confirm, can, toast } = CV;

  /* =================== PRICING =================== */
  const planPreview = (p) => {
    const bullets = (Array.isArray(p.bullets) ? p.bullets : String(p.bullets || '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
    return html`<div class="pv${p.popular ? ' pop' : ''}${p.active ? '' : ' off'}">
      ${p.popular ? html`<span class="ribbon">Most popular</span>` : ''}
      <h4>${p.name || 'Plan name'}</h4><p class="tg">${p.tagline || ''}</p>
      <div class="price">${usd(p.price_month)}<small> /month</small></div>
      <div class="small mut">or ${usd(p.price_year)} a year</div>
      <ul>${bullets.map((b) => html`<li>${icon('check')}<span>${b}</span></li>`)}</ul>
      <div class="fake">${p.active ? 'Start free' : 'Hidden from the website'}</div>
    </div>`;
  };

  const planForm = (p, ro) => {
    const dis = ro ? raw(' disabled') : '';
    return html`<form class="stack" data-plan="${p.code}">
      <div class="fr two">
        <div class="f"><label>Name</label><input name="name" value="${p.name}" maxlength="30" required${dis}></div>
        <div class="f"><label>Short line under the name</label><input name="tagline" value="${p.tagline}" maxlength="120"${dis}></div>
      </div>
      <div class="fr two">
        <div class="f"><label>Price per month</label><div class="pre"><span>$</span><input name="price_month" type="number" step="0.01" min="0" value="${p.price_month}"${dis}></div></div>
        <div class="f"><label>Price per year</label><div class="pre"><span>$</span><input name="price_year" type="number" step="0.01" min="0" value="${p.price_year}"${dis}></div><span class="hint">Usually 10 × monthly (2 months free). ${ro ? '' : html`<button type="button" class="btn ghost xs" data-ten>Set to 10 months</button>`}</span></div>
      </div>
      <div class="fr four">
        <div class="f"><label>Bots, channels, groups</label><input name="connections" type="number" min="1" value="${p.connections}"${dis}></div>
        <div class="f"><label>Subscribers</label><input name="subscribers" type="number" min="100" step="100" value="${p.subscribers}"${dis}></div>
        <div class="f"><label>AI writes a month</label><input name="ai_writes" type="number" min="0" value="${p.ai_writes}"${dis}></div>
        <div class="f"><label>Team seats</label><input name="seats" type="number" min="1" value="${p.seats}"${dis}></div>
      </div>
      <div class="fr four">
        <div class="f"><label>Join requests a month</label><input name="join_requests" type="number" min="-1" value="${p.join_requests}"${dis}><span class="hint">-1 = no limit</span></div>
        <div class="f"><label>Welcome Flows</label><input name="flows" type="number" min="-1" value="${p.flows}"${dis}><span class="hint">-1 = no limit</span></div>
        <div class="f"><label>Messages per flow</label><input name="flow_steps" type="number" min="-1" value="${p.flow_steps}"${dis}><span class="hint">-1 = no limit</span></div>
        <div class="f"><label class="check" style="margin-top:26px"><input type="checkbox" name="branding" ${p.branding ? raw('checked') : ''}${dis}> "Free welcome bot by Castvoo.com" line</label></div>
      </div>
      <div class="f"><label>Features</label><div class="row" style="flex-wrap:wrap;gap:6px 14px">${(PF || []).map((x) => html`<label class="check small"><input type="checkbox" name="feat" value="${x.key}" ${(p.features || []).includes(x.key) ? raw('checked') : ''}${dis}> ${x.name}</label>`)}</div></div>
      <div class="f"><label>What's included (one line each)</label><textarea name="bullets" rows="6"${dis}>${(p.bullets || []).join('\n')}</textarea></div>
      <div class="row">
        <label class="check"><input type="checkbox" name="popular" ${p.popular ? raw('checked') : ''}${dis}> Mark as “Most popular”</label>
        <label class="check"><input type="checkbox" name="active" ${p.active ? raw('checked') : ''}${dis}> Show on the website</label>
        <div class="f" style="flex-direction:row;align-items:center;gap:8px"><label>Order</label><input name="sort" type="number" min="0" max="100" value="${p.sort}" style="width:76px"${dis}></div>
      </div>
      ${ro ? '' : html`<div class="row end"><button type="button" class="btn sec sm" data-undo>Undo changes</button><button type="submit" class="btn">${icon('check')} Save ${p.name}</button></div>`}
    </form>`;
  };
  const readPlan = (f) => ({
    name: f.name.value.trim(), tagline: f.tagline.value.trim(), price_month: Number(f.price_month.value), price_year: Number(f.price_year.value),
    connections: Number(f.connections.value), subscribers: Number(f.subscribers.value), ai_writes: Number(f.ai_writes.value), seats: Number(f.seats.value),
    bullets: f.bullets.value, popular: f.popular.checked, active: f.active.checked, sort: Number(f.sort.value) || 0,
    join_requests: Number(f.join_requests.value), flows: Number(f.flows.value), flow_steps: Number(f.flow_steps.value), branding: f.branding.checked,
    features: [...f.querySelectorAll('input[name=feat]:checked')].map((x) => x.value),
  });
  let PF = [];

  CV.page('pricing', {
    intro: 'Prices here change the website and the dashboard straight away. If you raise a price, people already paying keep their old price for 30 days and get an email first.',
    async render() {
      const plans = await CV.plans(true);
      PF = (await get('/api/admin/plan-features')).features;
      const ro = !can('pricing.edit');
      const page = html`
        ${ro ? html`<div class="note">${icon('lock')}<span>You can look at prices. Only Owner and Admin can change them.</span></div>` : ''}
        ${plans.map((p) => html`<div class="card" id="plan-${p.code}">
          <div class="ch"><h3>${icon('tag')} ${p.name} <span class="bd mono">${p.code}</span></h3><div class="acts">${p.active ? html`<span class="bd ok">On the website</span>` : html`<span class="bd">Hidden</span>`}<span class="bd blue">${CV.plural(p.workspaces, 'workspace')} on it</span></div></div>
          <div class="plan-ed">${planForm(p, ro)}<div><div class="pv-label">Live preview</div><div data-pv="${p.code}">${planPreview(p)}</div></div></div>
        </div>`)}
        ${ro ? '' : html`<button class="btn sec" id="add-plan" style="align-self:flex-start">${icon('plus')} Add a plan</button>`}`;
      return {
        html: page,
        mount(el) {
          $$('form[data-plan]', el).forEach((f) => {
            const p = plans.find((x) => x.code === f.dataset.plan);
            const pv = $(`[data-pv="${p.code}"]`, el);
            const refresh = () => put(pv, planPreview({ ...p, ...readPlan(f) }));
            f.addEventListener('input', refresh);
            f.addEventListener('change', refresh);
            on(f, 'click', '[data-ten]', () => { f.price_year.value = Math.round(Number(f.price_month.value) * 10 * 100) / 100; refresh(); });
            on(f, 'click', '[data-undo]', () => { f.reset(); refresh(); });
            f.addEventListener('submit', async (e) => {
              e.preventDefault();
              const v = readPlan(f);
              const notes = [];
              if (v.price_month !== p.price_month || v.price_year !== p.price_year) notes.push(`Price: ${usd(p.price_month)} → ${usd(v.price_month)} a month, ${usd(p.price_year)} → ${usd(v.price_year)} a year.`);
              const lower = [['connections', 'connections'], ['subscribers', 'subscribers'], ['ai_writes', 'AI writes'], ['seats', 'seats'], ['join_requests', 'join requests'], ['flows', 'Welcome Flows'], ['flow_steps', 'messages per flow']]
                .filter(([k]) => p[k] != null && (p[k] < 0 ? v[k] >= 0 : v[k] >= 0 && v[k] < p[k])).map(([k, l]) => `${l} ${p[k] < 0 ? 'unlimited' : num(p[k])} → ${num(v[k])}`);
              const lost = (p.features || []).filter((x) => !v.features.includes(x));
              if (lost.length && p.workspaces) notes.push(`You are removing features (${lost.join(', ')}). People on this plan lose them now (anyone who paid before 8 Oct 2026 keeps their old features).`);
              if (lower.length && p.workspaces) notes.push(`You are lowering limits (${lower.join(', ')}). ${CV.plural(p.workspaces, 'workspace is', 'workspaces are')} on this plan now. Anyone above a new limit will have sending paused until they upgrade.`);
              if (!v.active && p.active) notes.push('The plan will be hidden from the website. People already on it keep it.');
              if (notes.length && !(await confirm(`Save changes to ${v.name}?`, '', { okText: 'Save changes', danger: lower.length && p.workspaces, body: html`${notes.map((n) => html`<div class="note ${n.startsWith('You are lowering') ? 'warn' : ''}">${icon(n.startsWith('You are lowering') ? 'warn' : 'info')}<span>${n}</span></div>`)}` }))) return;
              if (await act($('button[type=submit]', f), () => putj('/api/admin/plans/' + encodeURIComponent(p.code), v), `${v.name} saved. The website shows it now.`)) { CV.bustPlans(); CV.reload(); }
            });
          });
          $('#add-plan', el)?.addEventListener('click', () => dialog({
            title: 'Add a plan', text: 'You can change everything later. New plans show on the website straight away if “Show on the website” is ticked.', icon: 'plus', okText: 'Create plan', wide: true,
            fields: [
              { name: 'code', label: 'Short code (never changes, letters and numbers)', required: true, placeholder: 'e.g. pro' },
              { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Pro' },
              { name: 'tagline', label: 'Short line under the name', placeholder: 'For agencies with many clients.' },
              { name: 'price_month', label: 'Price per month', type: 'number', step: '0.01', prefix: '$', required: true },
              { name: 'price_year', label: 'Price per year (leave empty for 10 × monthly)', type: 'number', step: '0.01', prefix: '$' },
              { name: 'connections', label: 'Bots, channels, groups', type: 'number', value: 10, required: true },
              { name: 'subscribers', label: 'Subscribers', type: 'number', value: 50000, required: true },
              { name: 'ai_writes', label: 'AI writes a month', type: 'number', value: 3000, required: true },
              { name: 'seats', label: 'Team seats', type: 'number', value: 5, required: true },
              { name: 'join_requests', label: 'Join requests a month (-1 = no limit)', type: 'number', value: 50000, required: true },
              { name: 'flows', label: 'Welcome Flows (-1 = no limit)', type: 'number', value: 30, required: true },
              { name: 'flow_steps', label: 'Messages per flow (-1 = no limit)', type: 'number', value: 30, required: true },
              { name: 'bullets', label: "What's included (one line each)", type: 'textarea', rows: 5 },
              { name: 'popular', label: 'Mark as “Most popular”', type: 'checkbox' },
              { name: 'active', label: 'Show on the website', type: 'checkbox', value: true },
            ],
            onSubmit: async (v) => {
              const body = { ...v, code: v.code.trim().toLowerCase(), price_year: v.price_year === '' ? Math.round(Number(v.price_month) * 1000) / 100 : v.price_year, sort: plans.length + 1 };
              await post('/api/admin/plans', body);
              toast(`${v.name} created.`); CV.bustPlans(); CV.reload();
            },
          }));
        },
      };
    },
  });

  /* =================== OFFERS =================== */
  const KINDS = {
    topup_bonus: { label: 'Top-up bonuses', one: 'top-up bonus', icon: 'wallet', c: '#0E9F6E', about: 'Extra free credit when someone adds enough money. The biggest bonus that fits is used.' },
    coupon: { label: 'Coupons', one: 'coupon', icon: 'tag', c: '#EC4899', about: 'A code that takes a percentage off plan payments for some months.' },
    banner: { label: 'Website banners', one: 'banner', icon: 'bell', c: '#6366F1', about: 'A short promotion shown on the website and in the dashboard.' },
  };
  const offerDetail = (o) => {
    const d = [];
    if (o.kind === 'coupon') d.push(html`<span class="bd dark mono">${o.code}</span>`, html`<span class="bd vio">${o.percent}% off for ${CV.plural(o.months, 'month')}</span>`);
    if (o.kind === 'topup_bonus') d.push(html`<span class="bd ok">Top up ${CV.usdc(o.min_topup_cents)} → +${CV.usdc(o.bonus_cents)} free</span>`);
    if (o.kind === 'banner' && o.link_url) d.push(html`<span class="bd blue">Links to ${o.link_url}</span>`);
    d.push(html`<span class="bd">${o.max_uses ? `${num(o.uses)} of ${num(o.max_uses)} used` : `${num(o.uses)} used`}</span>`);
    if (o.starts_at || o.ends_at) d.push(html`<span class="bd">${o.starts_at ? date(o.starts_at) : 'Now'} → ${o.ends_at ? date(o.ends_at) : 'no end'}</span>`);
    const now = Date.now();
    if (o.ends_at && new Date(o.ends_at).getTime() < now) d.push(html`<span class="bd warn">Ended</span>`);
    else if (o.starts_at && new Date(o.starts_at).getTime() > now) d.push(html`<span class="bd warn">Not started</span>`);
    else if (o.max_uses && o.uses >= o.max_uses) d.push(html`<span class="bd warn">Used up</span>`);
    return d;
  };
  function offerDialog(kind, o) {
    const k = KINDS[kind];
    const fields = [{ name: 'title', label: kind === 'banner' ? 'Banner text' : 'Title (customers see this)', required: true, value: o ? o.title : '', placeholder: kind === 'coupon' ? 'Welcome back: 20% off' : kind === 'topup_bonus' ? 'Top up $200, get $10 extra' : 'Weekend deal: 20% off Growth' }];
    if (kind === 'coupon') fields.push(
      { name: 'code', label: 'Code people type', required: true, value: o ? o.code : '', placeholder: 'SAVE20' },
      { name: 'percent', label: 'Discount (%)', type: 'number', min: 1, max: 100, required: true, value: o ? o.percent : 20 },
      { name: 'months', label: 'For how many months', type: 'number', min: 1, max: 24, value: o ? o.months : 1 });
    if (kind === 'topup_bonus') fields.push(
      { name: 'min_topup', label: 'When they top up at least', type: 'number', step: '0.01', prefix: '$', required: true, value: o ? Number(o.min_topup_cents) / 100 : '' },
      { name: 'bonus', label: 'Free bonus they get', type: 'number', step: '0.01', prefix: '$', required: true, value: o ? Number(o.bonus_cents) / 100 : '', hint: 'Not more than half of the top-up. Bonus can only pay for plans.' });
    if (kind === 'banner') fields.push({ name: 'link_url', label: 'Link (optional)', value: o ? o.link_url || '' : '', placeholder: '#pricing or https://…' });
    fields.push(
      { name: 'description', label: 'Note (optional)', type: 'textarea', rows: 2, value: o ? o.description : '' },
      { name: 'starts_at', label: 'Starts on (empty = now)', type: 'date', value: o ? isoDay(o.starts_at) : '' },
      { name: 'ends_at', label: 'Ends on (empty = no end)', type: 'date', value: o ? isoDay(o.ends_at) : '' },
      { name: 'max_uses', label: 'Max uses (empty = no limit)', type: 'number', min: 1, value: o && o.max_uses ? o.max_uses : '' },
      { name: 'active', label: 'Switched on', type: 'checkbox', value: o ? o.active : true });
    return dialog({
      title: o ? `Edit ${k.one}` : `New ${k.one}`, text: k.about, icon: k.icon, okText: o ? 'Save' : 'Create', wide: true, fields,
      onSubmit: async (v) => {
        const body = { ...v, kind, starts_at: v.starts_at ? new Date(v.starts_at + 'T00:00:00').toISOString() : null, ends_at: v.ends_at ? new Date(v.ends_at + 'T23:59:59').toISOString() : null, max_uses: v.max_uses === '' ? null : v.max_uses };
        if (o) await putj('/api/admin/offers/' + o.id, body); else await post('/api/admin/offers', body);
        toast(o ? 'Offer saved.' : 'Offer created.'); CV.reload();
      },
    });
  }

  CV.page('offers', {
    intro: 'Turn offers on and off with the big switches. Changes show on the website and in the dashboard straight away.',
    async render() {
      const { offers } = await get('/api/admin/offers');
      const ed = can('offers.edit');
      const page = html`${ed ? '' : html`<div class="note">${icon('lock')}<span>You can look at offers. Owner, Admin and Marketing can change them.</span></div>`}
        ${Object.entries(KINDS).map(([kind, k]) => {
          const list = offers.filter((o) => o.kind === kind);
          return html`<div class="card flat">
            <div class="ch" style="padding:16px"><h3><span class="big-ic" style="background:${k.c};width:32px;height:32px;border-radius:10px">${icon(k.icon)}</span> ${k.label}</h3>${ed ? html`<div class="acts"><button class="btn sm" data-new="${kind}">${icon('plus')} New ${k.one}</button></div>` : ''}<p>${k.about}</p></div>
            <div style="border-top:1px solid var(--line)">${list.length ? list.map((o) => html`<div class="offer${o.active ? '' : ' off'}">
              ${CV.sw(o.active, { toggle: o.id }, { lg: true, disabled: !ed, label: (o.active ? 'Switch off ' : 'Switch on ') + o.title })}
              <div class="tx"><b>${o.title}</b>${o.description ? html`<div class="small mut">${o.description}</div>` : ''}<div class="det">${offerDetail(o)}</div></div>
              ${ed ? html`<div class="acts"><button class="ib sm" data-edit="${o.id}" aria-label="Edit ${o.title}" title="Edit">${icon('edit')}</button><button class="ib sm" data-del="${o.id}" aria-label="Delete ${o.title}" title="Delete">${icon('trash')}</button></div>` : ''}
            </div>`) : CV.empty(k.icon, `No ${k.label.toLowerCase()} yet`, ed ? `Press “New ${k.one}” to make one.` : '')}</div>
          </div>`;
        })}`;
      return {
        html: page,
        mount(el) {
          on(el, 'click', '[data-new]', (e, b) => offerDialog(b.dataset.new));
          on(el, 'click', '[data-edit]', (e, b) => { const o = offers.find((x) => String(x.id) === b.dataset.edit); offerDialog(o.kind, o); });
          on(el, 'click', '[data-toggle]', async (e, b) => {
            const o = offers.find((x) => String(x.id) === b.dataset.toggle);
            const next = b.getAttribute('aria-checked') !== 'true';
            CV.setSw(b, next); b.classList.add('busy');
            const ok = await act(null, () => post(`/api/admin/offers/${o.id}/toggle`, { active: next }), `${o.title} is ${next ? 'on' : 'off'}.`);
            b.classList.remove('busy');
            if (!ok) CV.setSw(b, !next); else { o.active = next; b.closest('.offer').classList.toggle('off', !next); }
          });
          on(el, 'click', '[data-del]', async (e, b) => {
            const o = offers.find((x) => String(x.id) === b.dataset.del);
            if (!(await confirm(`Delete “${o.title}”?`, o.kind === 'coupon' ? 'If a customer is using this coupon, it is switched off instead of deleted.' : 'This cannot be undone. You can also just switch it off.', { danger: true, okText: 'Delete', icon: 'trash' }))) return;
            if (await act(null, () => del('/api/admin/offers/' + o.id), 'Offer deleted.')) CV.reload();
          });
        },
      };
    },
  });

  /* =================== COUNTRIES & PAYMENTS =================== */
  const PROVIDERS = { paystack: 'Paystack', flutterwave: 'Flutterwave', crypto: 'Crypto', manual: 'Checked by the team' };
  const methodReady = (m, integ) => (m.provider === 'crypto' || m.provider === 'manual' ? true : !!integ[m.provider]);
  function ratePreview(cur, rate) {
    const r = Number(rate);
    if (!r || r <= 0) return 'Enter a rate';
    if (String(cur).toUpperCase() === 'USD') return 'Prices shown in US dollars';
    let money;
    try { money = new Intl.NumberFormat('en-US', { style: 'currency', currency: String(cur).toUpperCase(), maximumFractionDigits: r < 100 ? 2 : 0 }).format(r); } catch { money = `${num(r)} ${cur}`; }
    return `${money} = $1`;
  }

  /** Colours typed in the admin go into style=""; anything that isn't #RRGGBB becomes the default. */
  const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? c : '#0B1430');
  const slugKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

  /** What the customer will see: the instructions, line by line, with a copy button on "Label: value" lines. */
  function instructionsPreview(text) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return html`<span class="mut small">Your instructions show here.</span>`;
    return html`${lines.map((l) => { const m = /^([^:]{1,40}):\s*(.+)$/.exec(l); return m ? html`<div class="ml"><span>${m[1]}</span><b>${m[2]}</b></div>` : html`<div class="ml"><b style="font-weight:600">${l}</b></div>`; })}`;
  }

  /** Add or edit one of the team's own payment methods. */
  function methodDialog(m, res) {
    const isNew = !m;
    const v = m || { kind: 'bank', proof_ref: 'required', proof_image: 'optional', all_countries: false, countries: [], active: true, sort: 50, icon: '', color: '' };
    const kinds = res.method_kinds || [];
    const k0 = kinds.find((k) => k.key === v.kind) || kinds[0] || { icon: '$', color: '#0B1430' };
    const proofSel = (name, cur) => html`<select name="${name}">${[['required', 'Required'], ['optional', 'Optional'], ['off', 'Don\'t ask']].map(([k, l]) => html`<option value="${k}" ${cur === k ? raw('selected') : ''}>${l}</option>`)}</select>`;
    const countries = res.countries;
    const body = html`<div class="mform">
      <div class="fr two">
        <div class="f"><label for="mf_label">Name customers see</label><input id="mf_label" name="label" value="${v.label || ''}" maxlength="40" placeholder="e.g. GTBank transfer" required></div>
        <div class="f"><label for="mf_kind">Kind</label><select id="mf_kind" name="kind">${kinds.map((k) => html`<option value="${k.key}" ${v.kind === k.key ? raw('selected') : ''}>${k.name}</option>`)}</select></div>
      </div>
      <div class="f"><label for="mf_detail">Short detail (under the name)</label><input id="mf_detail" name="detail" value="${v.detail || ''}" maxlength="80" placeholder="e.g. Naira bank transfer, confirmed in a few hours"></div>
      <div class="fr two">
        <div class="f"><label for="mf_key">Key</label><input id="mf_key" name="key" value="${v.key || ''}" maxlength="30" ${isNew ? '' : raw('disabled')} placeholder="made from the name"><span class="hint">${isNew ? 'Used in reports. Leave empty to make it from the name.' : 'The key can\'t change.'}</span></div>
        <div class="f"><label>Icon and colour</label><div class="row" style="gap:8px;flex-wrap:nowrap"><span class="big-ic" data-mic style="background:${safeColor(v.color || k0.color)};width:40px;height:40px;font-weight:800">${v.icon || k0.icon}</span><input name="icon" value="${v.icon || ''}" maxlength="8" placeholder="${k0.icon}" aria-label="Icon (emoji or letters)" style="width:70px"><input name="color" type="color" value="${safeColor(v.color || k0.color)}" aria-label="Colour" style="width:52px;padding:4px"></div></div>
      </div>
      <div class="f"><label for="mf_ins">Instructions for the customer</label><textarea id="mf_ins" name="instructions" rows="5" maxlength="2000" placeholder="Bank: GTBank&#10;Account number: 0123456789&#10;Account name: Zedapex Limited&#10;Use your email as the transfer note." required>${v.instructions || ''}</textarea>
        <span class="hint">One thing per line. Lines like “Account number: 0123456789” get a copy button for the customer. They also see the exact amount to send.</span></div>
      <div class="mpv"><small class="mut">Preview</small><div data-mpv>${instructionsPreview(v.instructions)}</div></div>
      <div class="fr four">
        <div class="f"><label for="mf_cur">Currency</label><input id="mf_cur" name="currency" value="${v.currency || ''}" maxlength="3" placeholder="USD" style="text-transform:uppercase"></div>
        <div class="f" data-ratef ${v.currency ? '' : raw('hidden')}><label for="mf_rate">Per $1</label><input id="mf_rate" name="usd_rate" type="number" step="any" min="0" value="${v.usd_rate ?? ''}" placeholder="country rate"></div>
        <div class="f"><label for="mf_min">Smallest</label><div class="pre"><span>$</span><input id="mf_min" name="min" type="number" step="0.01" min="0" value="${v.min ?? ''}" placeholder="any"></div></div>
        <div class="f"><label for="mf_max">Largest</label><div class="pre"><span>$</span><input id="mf_max" name="max" type="number" step="0.01" min="0" value="${v.max ?? ''}" placeholder="any"></div></div>
      </div>
      <span class="hint" style="margin-top:-6px">Empty currency = US dollars. In another currency the customer pays the local amount; leave “Per $1” empty to use the rate of their country (set above).</span>
      <div class="fr two">
        <div class="f"><label>Transaction reference</label>${proofSel('proof_ref', v.proof_ref)}</div>
        <div class="f"><label>Screenshot of the payment</label>${proofSel('proof_image', v.proof_image)}</div>
      </div>
      <div class="f"><label>Where it is offered</label>
        <label class="check"><input type="checkbox" name="all_countries" ${v.all_countries ? raw('checked') : ''}> All countries</label>
        <div data-cwrap ${v.all_countries ? raw('hidden') : ''}>
          <div class="tsearch" style="display:flex;margin:6px 0">${icon('search')}<input type="search" data-cq placeholder="Find a country" aria-label="Find a country"></div>
          <div class="mgrid">${countries.map((c) => html`<label class="check" data-cn="${(c.name + ' ' + c.code).toLowerCase()}"><input type="checkbox" name="c_${c.code}" ${(v.countries || []).includes(c.code) ? raw('checked') : ''}> ${c.flag} ${c.name}</label>`)}</div>
        </div></div>
      <div class="fr two">
        <div class="f"><label for="mf_sort">Order</label><input id="mf_sort" name="sort" type="number" min="0" max="999" value="${v.sort ?? 50}"><span class="hint">Lower shows first, after the built-in methods.</span></div>
        <div class="f"><label>&nbsp;</label><label class="check"><input type="checkbox" name="active" ${v.active ? raw('checked') : ''}> Customers can use it now</label></div>
      </div>
    </div>`;
    return dialog({
      title: isNew ? 'Add a payment method' : `Edit ${m.label}`, icon: 'wallet', wide: true, okText: isNew ? 'Add method' : 'Save changes',
      text: 'Customers pay you directly and send proof. Nothing is added to their wallet until someone in Finance approves it.',
      body,
      onOpen(form) {
        const ic = $('[data-mic]', form);
        let touchedIcon = !!v.icon, touchedColor = !!v.color;
        const kindOf = () => kinds.find((k) => k.key === form.kind.value) || k0;
        const drawIcon = () => { const k = kindOf(); ic.textContent = form.icon.value.trim() || k.icon; ic.style.background = safeColor(form.color.value); form.icon.placeholder = k.icon; };
        form.kind.addEventListener('change', () => { const k = kindOf(); if (!touchedColor) form.color.value = k.color; if (!touchedIcon) form.icon.value = ''; drawIcon(); });
        form.icon.addEventListener('input', () => { touchedIcon = true; drawIcon(); });
        form.color.addEventListener('input', () => { touchedColor = true; drawIcon(); });
        if (isNew) form.label.addEventListener('input', () => { form.key.placeholder = slugKey(form.label.value) || 'made from the name'; });
        form.instructions.addEventListener('input', () => put($('[data-mpv]', form), instructionsPreview(form.instructions.value)));
        form.currency.addEventListener('input', () => { const c = form.currency.value.trim().toUpperCase(); $('[data-ratef]', form).hidden = !c || c === 'USD'; });
        form.all_countries.addEventListener('change', () => { $('[data-cwrap]', form).hidden = form.all_countries.checked; });
        $('[data-cq]', form).addEventListener('input', (e) => { const q = e.target.value.trim().toLowerCase(); $$('[data-cn]', form).forEach((l) => { l.hidden = q && !l.dataset.cn.includes(q); }); });
        // Enter in the country search must not submit the form.
        $('[data-cq]', form).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
      },
      onSubmit: async (f) => {
        const body2 = {
          label: f.label.trim(), kind: f.kind, detail: f.detail.trim(), icon: f.icon.trim(), color: f.color, instructions: f.instructions,
          currency: f.currency.trim().toUpperCase(), usd_rate: f.usd_rate === '' ? null : Number(f.usd_rate),
          min: f.min === '' ? null : Number(f.min), max: f.max === '' ? null : Number(f.max),
          proof_ref: f.proof_ref, proof_image: f.proof_image, all_countries: !!f.all_countries,
          countries: Object.keys(f).filter((k) => k.startsWith('c_') && f[k]).map((k) => k.slice(2)), sort: Number(f.sort || 0), active: !!f.active,
        };
        if (body2.label.length < 2) throw new Error('Give the method a name.');
        if (body2.instructions.trim().length < 10) throw new Error('Write the instructions: where and how to pay.');
        if (!body2.all_countries && !body2.countries.length) throw new Error('Pick at least one country, or tick “All countries”.');
        if (isNew) { if (f.key && f.key.trim()) body2.key = f.key.trim(); await post('/api/admin/methods', body2); toast(`${body2.label} added.`); } else { await putj('/api/admin/methods/' + encodeURIComponent(m.key), body2); toast(`${body2.label} saved.`); }
        CV.reload();
      },
    });
  }

  CV.page('countries', {
    intro: 'A payment method only appears to customers when its provider is connected AND it is switched on here. Each country picks which methods its people see.',
    async render({ query }) {
      const res = await get('/api/admin/countries');
      const ed = can('countries.edit');
      const integ = res.integrations;
      const q = (query.get('q') || '').toLowerCase();
      const mName = (m) => `${m.label} · ${m.detail}`;
      const methodBadges = (c) => {
        const list = (c.methods || []).map((k) => res.methods.find((m) => m.key === k && m.provider !== 'manual')).filter(Boolean)
          .concat(res.methods.filter((m) => m.provider === 'manual' && (m.all_countries || (m.countries || []).includes(c.code))));
        return html`<div class="chips" data-mlist>${list.length ? list.map((m) => html`<span class="bd ${!m.active ? '' : methodReady(m, integ) ? 'blue' : 'warn'}" title="${!m.active ? 'Switched off' : methodReady(m, integ) ? 'Customers see this' : 'Provider not connected yet'}">${m.provider === 'crypto' ? 'Crypto' : m.label}${!methodReady(m, integ) ? ' ⚠' : ''}${!m.active ? ' (off)' : ''}</span>`) : html`<span class="bd bad">No way to pay</span>`}${ed ? html`<button type="button" class="btn ghost xs" data-pick>${icon('edit')} Change</button>` : ''}</div>`;
      };
      const row = (c) => html`<div class="ctry${c.active ? '' : ' off'}" data-code="${c.code}" data-name="${(c.name + ' ' + c.code + ' ' + c.currency).toLowerCase()}">
        <div class="nm"><span class="flag">${c.flag}</span><div style="min-width:0"><b>${c.name}</b><span class="small mut">${c.code} · ${CV.plural(c.users, 'user')}</span></div></div>
        <div class="rate-w"><div class="rate"><input class="in cur" name="currency" value="${c.currency}" maxlength="3" aria-label="Currency" ${ed ? '' : raw('disabled')}><span class="mut small">per $1</span><input class="in" name="usd_rate" type="number" step="any" min="0" value="${Number(c.usd_rate)}" aria-label="Exchange rate" ${ed ? '' : raw('disabled')}>${ed ? html`<button class="btn sm" data-save hidden>Save</button>` : ''}</div><div class="pvw" data-pvw>${ratePreview(c.currency, c.usd_rate)}</div></div>
        ${methodBadges(c)}
        <div class="sws"><label>${CV.sw(c.featured, { flag: 'featured' }, { disabled: !ed, label: 'Featured ' + c.name })}Featured</label><label>${CV.sw(c.active, { flag: 'active' }, { disabled: !ed, label: 'Active ' + c.name })}On</label></div>
      </div>`;
      const auto = res.methods.filter((m) => m.provider !== 'manual');
      const own = res.methods.filter((m) => m.provider === 'manual');
      const KINDS = Object.fromEntries((res.method_kinds || []).map((k) => [k.key, k]));
      const PROOF_TXT = { off: 'not asked', optional: 'optional', required: 'required' };
      const where = (m) => (m.all_countries ? 'All countries' : (m.countries || []).map((k) => { const c = res.countries.find((x) => x.code === k); return c ? c.flag + ' ' + c.name : k; }).join(', '));
      const amountTxt = (m) => (m.currency ? `Paid in ${m.currency}${m.usd_rate ? ` at ${num(m.usd_rate)} per $1` : ' at the country rate'}` : 'Paid in US dollars') + (m.min != null || m.max != null ? ` · ${m.min != null ? 'from ' + usd(m.min) : ''}${m.min != null && m.max != null ? ' ' : ''}${m.max != null ? 'up to ' + usd(m.max) : ''}` : '');
      const ownRow = (m) => html`<div class="feat own-m" data-own="${m.key}">
        <span class="big-ic" style="background:${safeColor(m.color)};width:36px;height:36px;font-weight:800">${m.icon}</span>
        <div class="tx"><b>${m.label}</b>${m.detail ? html`<p>${m.detail}</p>` : ''}
          <div class="row" style="margin-top:6px;gap:6px"><span class="bd vio">${(KINDS[m.kind] || {}).name || 'Other'}</span><span class="bd">${where(m)}</span><span class="bd">${amountTxt(m)}</span>
            <span class="bd">Reference ${PROOF_TXT[m.proof_ref]} · screenshot ${PROOF_TXT[m.proof_image]}</span>${m.payments ? html`<span class="bd blue">${CV.plural(m.payments, 'payment')}</span>` : ''}<span class="mono small mut">${m.key}</span></div></div>
        ${CV.sw(m.active, { oactive: m.key }, { lg: true, disabled: !ed, label: 'Method on or off' })}
        ${ed ? html`<div class="row" style="gap:6px"><button type="button" class="btn sec sm" data-oedit="${m.key}">${icon('edit')} Edit</button><button type="button" class="ib" data-odel="${m.key}" aria-label="Delete ${m.label}" title="Delete">${icon('trash')}</button></div>` : ''}
      </div>`;
      const page = html`
        <div class="card"><div class="ch"><h3>${icon('plug')} Payment providers</h3><a class="btn ghost sm" href="#settings">Connect in Settings ${icon('chev')}</a></div>
          <div class="integ">${['paystack', 'flutterwave', 'gatevoo'].map((k) => html`<span class="bd ${integ[k] ? 'ok' : 'bad'}"><span class="dot"></span>${CV.INTEG[k]}: ${integ[k] ? 'connected' : 'not connected'}</span>`)}</div>
          <div class="note warn">${icon('warn')}<span>Exchange rates are typed by hand. Check them against today's real rate before launch and every week after. ⚠ on a method means its provider is not connected yet.</span></div></div>
        <div class="card flat">
          <div class="ch" style="padding:16px"><h3>${icon('globe')} Countries</h3>
            <div class="tsearch" style="width:min(320px,100%);display:flex">${icon('search')}<input id="cq" type="search" value="${q}" placeholder="Find a country or currency" aria-label="Find a country"></div>
            <p>Featured countries are listed first at sign-up. Type a new rate and press Save. Press “Change” to pick how people in a country can pay.</p></div>
          <div style="border-top:1px solid var(--line)" id="clist">${res.countries.map(row)}</div>
          <div id="cnone" hidden>${CV.empty('search', 'No country found', 'Try another name.')}</div>
        </div>
        <div class="card flat">
          <div class="ch" style="padding:16px"><h3>${icon('card')} Built-in payment methods</h3><p>Paid and confirmed automatically by the provider. The name and detail are what customers see on the top-up screen. They can be switched off, not deleted.</p></div>
          <div style="border-top:1px solid var(--line)">${auto.map((m) => html`<form class="feat" data-method="${m.key}">
            <span class="big-ic" style="background:${safeColor(m.color)};width:36px;height:36px;font-weight:800">${m.icon}</span>
            <div class="tx"><div class="fr two"><div class="f"><label>Name</label><input name="label" value="${m.label}" maxlength="40" ${ed ? '' : raw('disabled')}></div><div class="f"><label>Detail</label><input name="detail" value="${m.detail}" maxlength="80" ${ed ? '' : raw('disabled')}></div></div>
              <div class="row" style="margin-top:6px"><span class="bd">${PROVIDERS[m.provider]}</span>${m.provider === 'crypto' ? html`<span class="bd ${integ.gatevoo ? 'ok' : 'blue'}">${integ.gatevoo ? 'Uses Gatevoo' : 'Manual addresses (Gatevoo not connected)'}</span>` : html`<span class="bd ${methodReady(m, integ) ? 'ok' : 'bad'}">${methodReady(m, integ) ? 'Provider connected' : 'Provider not connected'}</span>`}<span class="mono small mut">${m.key}</span></div></div>
            ${CV.sw(m.active, { mactive: m.key }, { lg: true, disabled: !ed, label: 'Method on or off' })}
            ${ed ? html`<button class="btn sec sm" type="submit">Save</button>` : ''}
          </form>`)}</div>
        </div>
        <div class="card flat" id="ownMethods">
          <div class="ch" style="padding:16px"><h3>${icon('wallet')} Your own payment methods</h3>${ed ? html`<button type="button" class="btn sm" data-addm>${icon('plus')} Add payment method</button>` : ''}
            <p>Bank transfer, mobile money, a crypto wallet or anything else. Customers see your instructions and an exact amount, pay, and send proof. You check it and approve it in <a href="#payments?check=1">Payments</a>.</p></div>
          <div style="border-top:1px solid var(--line)">${own.length ? own.map(ownRow) : CV.empty('wallet', 'No methods of your own yet', 'Add a local bank account or mobile money number so more people can top up.', ed ? html`<button type="button" class="btn sm" data-addm>${icon('plus')} Add payment method</button>` : '')}</div>
        </div>`;

      return {
        html: page,
        mount(el) {
          const filter = () => { const v = $('#cq', el).value.trim().toLowerCase(); let shown = 0; $$('.ctry', el).forEach((r) => { const hit = !v || r.dataset.name.includes(v); r.hidden = !hit; if (hit) shown++; }); $('#cnone', el).hidden = shown > 0; };
          $('#cq', el).addEventListener('input', filter);
          filter();
          const country = (code) => res.countries.find((c) => c.code === code);
          const save = async (c, patch, msg, btn) => {
            const body = { name: c.name, flag: c.flag, currency: c.currency, usd_rate: Number(c.usd_rate), methods: c.methods || [], featured: c.featured, active: c.active, sort: c.sort, ...patch };
            const ok = await act(btn, () => putj('/api/admin/countries/' + c.code, body), msg);
            if (ok) Object.assign(c, patch);
            return ok;
          };
          on(el, 'input', '.ctry input', (e, inp) => {
            const r = inp.closest('.ctry');
            $('[data-pvw]', r).textContent = ratePreview(r.querySelector('[name=currency]').value, r.querySelector('[name=usd_rate]').value);
            const btn = $('[data-save]', r); if (btn) btn.hidden = false;
          });
          on(el, 'click', '.ctry [data-save]', async (e, btn) => {
            const r = btn.closest('.ctry'); const c = country(r.dataset.code);
            const cur = r.querySelector('[name=currency]').value.trim().toUpperCase();
            const rate = Number(r.querySelector('[name=usd_rate]').value);
            if (!(rate > 0)) return toast('The rate must be more than 0.', 'bad');
            const old = Number(c.usd_rate);
            const big = old > 0 && (rate / old > 1.25 || rate / old < 0.8);
            if (!(await confirm(`Change ${c.name}'s rate?`, `${ratePreview(c.currency, old)}  →  ${ratePreview(cur, rate)}. Local prices on the website change straight away.`, { okText: 'Save rate', danger: big, body: big ? html`<div class="note warn">${icon('warn')}<span>That is a big change (more than 20%). Please double-check the number.</span></div>` : '' }))) return;
            if (await save(c, { currency: cur, usd_rate: rate }, `${c.name} saved.`, btn)) btn.hidden = true;
          });
          on(el, 'click', '.ctry [data-pick]', (e, b) => {
            const r = b.closest('.ctry'); const c = country(r.dataset.code);
            dialog({
              title: `How can people in ${c.name} pay?`, text: 'Tick the methods they should see. A method only shows when its provider is connected and the method is switched on.', icon: 'card', okText: 'Save methods',
              body: own.length ? html`<div class="note">${icon('info')}<span>Your own methods (${own.map((m) => m.label).join(', ')}) pick their countries themselves: press Edit on the method.</span></div>` : '',
              fields: auto.map((m) => ({ name: 'm_' + m.key, type: 'checkbox', value: (c.methods || []).includes(m.key), label: mName(m), hint: `${PROVIDERS[m.provider]}${methodReady(m, integ) ? '' : ' · not connected yet'}${m.active ? '' : ' · switched off'}` })),
              onSubmit: async (v) => {
                const methods = auto.filter((m) => v['m_' + m.key]).map((m) => m.key);
                if (!methods.length && !(await confirm(`Remove every payment method from ${c.name}?`, 'People in this country will not be able to top up.', { danger: true, okText: 'Remove all' }))) return false;
                await putj('/api/admin/countries/' + c.code, { name: c.name, flag: c.flag, currency: c.currency, usd_rate: Number(c.usd_rate), methods, featured: c.featured, active: c.active, sort: c.sort });
                c.methods = methods; toast(`${c.name}: payment methods saved.`);
                const d = document.createElement('div'); put(d, methodBadges(c)); $('[data-mlist]', r).replaceWith(d.firstElementChild);
              },
            });
          });
          on(el, 'click', '.ctry [data-flag]', async (e, s) => {
            const r = s.closest('.ctry'); const c = country(r.dataset.code);
            const key = s.dataset.flag; const next = s.getAttribute('aria-checked') !== 'true';
            if (key === 'active' && !next && !(await confirm(`Switch off ${c.name}?`, 'People who pick it will get the payment methods of “Another country” instead.', { okText: 'Switch off', danger: true }))) return;
            CV.setSw(s, next);
            if (await save(c, { [key]: next }, `${c.name}: ${key === 'featured' ? (next ? 'featured' : 'not featured') : next ? 'on' : 'off'}.`)) { if (key === 'active') r.classList.toggle('off', !next); } else CV.setSw(s, !next);
          });
          on(el, 'click', '[data-mactive]', async (e, s) => {
            const m = res.methods.find((x) => x.key === s.dataset.mactive);
            const next = s.getAttribute('aria-checked') !== 'true';
            if (!next && !(await confirm(`Switch off ${m.label} (${m.detail})?`, 'Customers will stop seeing it in every country.', { okText: 'Switch off', danger: true }))) return;
            CV.setSw(s, next);
            const f = s.closest('form');
            if (await act(null, () => putj('/api/admin/methods/' + m.key, { label: f.label.value, detail: f.detail.value, active: next }), `${m.label} is ${next ? 'on' : 'off'}.`)) m.active = next; else CV.setSw(s, !next);
          });
          on(el, 'submit', 'form[data-method]', async (e, f) => {
            e.preventDefault();
            const m = res.methods.find((x) => x.key === f.dataset.method);
            if (await act($('button[type=submit]', f), () => putj('/api/admin/methods/' + m.key, { label: f.label.value, detail: f.detail.value, active: m.active }), `${f.label.value} saved.`)) { m.label = f.label.value; m.detail = f.detail.value; }
          });
          /* ----- your own methods ----- */
          on(el, 'click', '[data-addm]', () => methodDialog(null, res));
          on(el, 'click', '[data-oedit]', (e, b) => methodDialog(res.methods.find((x) => x.key === b.dataset.oedit), res));
          on(el, 'click', '[data-oactive]', async (e, s) => {
            const m = res.methods.find((x) => x.key === s.dataset.oactive);
            const next = s.getAttribute('aria-checked') !== 'true';
            if (!next && !(await confirm(`Switch off ${m.label}?`, 'Customers stop seeing it. Payments already started with it can still be approved.', { okText: 'Switch off', danger: true }))) return;
            CV.setSw(s, next);
            if (await act(null, () => putj('/api/admin/methods/' + m.key, { active: next }), `${m.label} is ${next ? 'on' : 'off'}.`)) m.active = next; else CV.setSw(s, !next);
          });
          on(el, 'click', '[data-odel]', async (e, b) => {
            const m = res.methods.find((x) => x.key === b.dataset.odel);
            if (!(await confirm(`Delete ${m.label}?`, m.payments ? 'Payments already use it, so it is switched off and hidden instead. Their history keeps its name.' : 'Customers stop seeing it straight away.', { okText: 'Delete', danger: true }))) return;
            const r = await act(b, () => del('/api/admin/methods/' + encodeURIComponent(m.key)), (x) => (x.hidden ? `${m.label} is switched off and hidden.` : `${m.label} deleted.`));
            if (r) CV.reload();
          });
        },
      };
    },
  });
})();
