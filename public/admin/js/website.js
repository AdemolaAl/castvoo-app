'use strict';
/* Castvoo Admin — Website text, Emails, Cas knowledge, AI settings. */
(() => {
  const { html, raw, icon, $, $$, on, put, num, ago, dt, get, post, putj, del, act, dialog, confirm, can, toast } = CV;

  /* =================== WEBSITE TEXT =================== */
  /** *word* → blue gradient words, like the real website. */
  const heroHtml = (t) => raw(CV.esc(t).replace(/\*([^*]+)\*/g, '<span class="gtext">$1</span>'));

  CV.page('content', {
    intro: 'The words on castvoo.com. Press Save on a box and the website changes straight away.',
    async render() {
      const { content: c } = await get('/api/admin/content');
      const ed = can('content.edit');
      const dis = ed ? '' : raw(' disabled');
      let faq = [];
      try { faq = JSON.parse(c.faq || '[]'); } catch { faq = []; }
      const box = (id, ic, title, sub, inner) => html`<form class="card" data-box="${id}"><div class="ch"><h3>${icon(ic)} ${title}</h3>${ed ? html`<div class="acts"><button type="submit" class="btn sm">${icon('check')} Save</button></div>` : ''}${sub ? html`<p>${sub}</p>` : ''}</div>${inner}</form>`;
      const inp = (key, label, hint, o = {}) => html`<div class="f"><label for="c_${key}">${label}</label>${o.area ? html`<textarea id="c_${key}" name="${key}" rows="${o.rows || 3}"${dis}>${c[key] || ''}</textarea>` : html`<input id="c_${key}" name="${key}" value="${c[key] || ''}"${dis}>`}${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
      const faqItem = (x, i) => html`<div class="faq-i" data-faq>
        <span class="n">${i + 1}</span>
        <div class="stack"><input class="in" name="q" value="${x.q}" placeholder="Question" aria-label="Question"${dis}><textarea class="in" name="a" placeholder="Answer" aria-label="Answer"${dis}>${x.a}</textarea></div>
        ${ed ? html`<div class="ctl"><button type="button" class="ib sm" data-up aria-label="Move up">${icon('up')}</button><button type="button" class="ib sm" data-down aria-label="Move down">${icon('down')}</button><button type="button" class="ib sm" data-rm aria-label="Delete question">${icon('trash')}</button></div>` : ''}
      </div>`;
      const page = html`
        <div class="row"><a class="btn sec sm" href="/" target="_blank" rel="noopener">${icon('ext')} View website</a>${ed ? '' : html`<span class="bd">${icon('lock')} Read only for your role</span>`}</div>
        <div class="grid g2">
          ${box('hero', 'home', 'Top of the home page', 'The first thing visitors read.', html`
            <div class="hero-pv" id="hero-pv"><h2>${heroHtml(c.hero_title)}</h2><p>${c.hero_subtitle}</p><span class="fake">${c.hero_cta}</span></div>
            ${inp('hero_title', 'Big title', html`Put stars around words to make them <span class="gtext" style="font-weight:800">blue</span>: <span class="mono">Turn your Telegram into a *sales machine.*</span>`)}
            ${inp('hero_subtitle', 'Text under the title', '', { area: true })}
            ${inp('hero_cta', 'Button text', 'Keep it short, like “Start free · 7 days on us”.')}`)}
          ${box('ann', 'bell', 'Announcement bar', 'A thin strip across the very top of the website.', html`
            <div class="ann-pv" id="ann-pv"></div>
            <label class="check"><input type="checkbox" name="announcement_on" ${c.announcement_on === '1' ? raw('checked') : ''}${dis}> Show the announcement bar</label>
            ${inp('announcement_text', 'Text')}
            ${inp('announcement_link', 'Link', 'Where it goes when tapped. #ai, #pricing or a full https:// link.')}`)}
        </div>
        <div class="grid g2">
          ${box('pricing', 'tag', 'Pricing section', '', html`${inp('pricing_title', 'Title')}${inp('pricing_subtitle', 'Text under the title', '', { area: true })}`)}
          ${box('other', 'text', 'Footer and maintenance', '', html`${inp('footer_tagline', 'Footer line')}${inp('maintenance_message', 'Maintenance message', 'Shown when Maintenance mode is on (Features page).', { area: true })}`)}
        </div>
        <form class="card" data-box="faq"><div class="ch"><h3>${icon('chat')} Questions and answers (FAQ)</h3>${ed ? html`<div class="acts"><button type="button" class="btn sec sm" data-add>${icon('plus')} Add a question</button><button type="submit" class="btn sm">${icon('check')} Save FAQ</button></div>` : ''}<p>Shown near the bottom of the home page, in this order. Cas also reads them.</p></div>
          <div class="faq" id="faq">${faq.map(faqItem)}</div>
        </form>`;
      return {
        html: page,
        mount(el) {
          const annPv = () => {
            const f = $('[data-box=ann]', el);
            const pv = $('#ann-pv', el);
            put(pv, f.announcement_on.checked ? html`<span>${f.announcement_text.value}</span>${f.announcement_link.value ? html`<a href="#" tabindex="-1">Learn more →</a>` : ''}` : html`<span style="opacity:.6">The bar is hidden.</span>`);
          };
          annPv();
          $('[data-box=ann]', el).addEventListener('input', annPv);
          $('[data-box=ann]', el).addEventListener('change', annPv);
          $('[data-box=hero]', el).addEventListener('input', (e) => {
            const f = e.currentTarget;
            put($('#hero-pv', el), html`<h2>${heroHtml(f.hero_title.value)}</h2><p>${f.hero_subtitle.value}</p><span class="fake">${f.hero_cta.value}</span>`);
          });
          const renumber = () => $$('[data-faq] .n', el).forEach((n, i) => { n.textContent = i + 1; });
          on(el, 'click', '[data-add]', () => { const d = document.createElement('div'); put(d, faqItem({ q: '', a: '' }, 0)); const item = d.firstElementChild; $('#faq', el).appendChild(item); renumber(); $('input', item).focus(); });
          on(el, 'click', '[data-rm]', async (e, b) => { const it = b.closest('[data-faq]'); if (($('input', it).value || $('textarea', it).value) && !(await confirm('Delete this question?', $('input', it).value, { danger: true, okText: 'Delete' }))) return; it.remove(); renumber(); });
          on(el, 'click', '[data-up]', (e, b) => { const it = b.closest('[data-faq]'); if (it.previousElementSibling) it.parentNode.insertBefore(it, it.previousElementSibling); renumber(); });
          on(el, 'click', '[data-down]', (e, b) => { const it = b.closest('[data-faq]'); if (it.nextElementSibling) it.parentNode.insertBefore(it.nextElementSibling, it); renumber(); });
          on(el, 'submit', 'form[data-box]', async (e, f) => {
            e.preventDefault();
            const btn = $('button[type=submit]', f);
            if (f.dataset.box === 'faq') {
              const items = $$('[data-faq]', f).map((it) => ({ q: $('input', it).value.trim(), a: $('textarea', it).value.trim() })).filter((x) => x.q || x.a);
              if (items.some((x) => !x.q || !x.a)) return toast('Every question needs an answer (and every answer a question).', 'bad');
              if (await act(btn, () => putj('/api/admin/content/faq', { value: JSON.stringify(items) }), 'FAQ saved. The website shows it now.')) c.faq = JSON.stringify(items);
              return;
            }
            const changed = [];
            for (const el2 of f.elements) {
              if (!el2.name) continue;
              const v = el2.type === 'checkbox' ? (el2.checked ? '1' : '0') : el2.value;
              if (v !== (c[el2.name] ?? '')) changed.push([el2.name, v]);
            }
            if (!changed.length) return toast('Nothing changed yet.', 'info');
            await act(btn, async () => { for (const [k, v] of changed) { await putj('/api/admin/content/' + k, { value: v }); c[k] = v; } }, 'Saved. The website shows it now.');
          });
        },
      };
    },
  });

  /* =================== EMAILS =================== */
  CV.page('emails', {
    intro: () => (location.hash.match(/^#emails\/./) ? 'Change the words, see the preview update, then Save. Use the {{variables}} exactly as shown: they are filled in for each customer.' : 'Every email Castvoo sends. Tap one to change its words. “Reset” brings back the original anytime.'),
    async render({ args }) {
      if (args[0]) return emailEditor(args[0]);
      const { emails } = await get('/api/admin/emails');
      const groups = [['transactional', 'Transactional', 'Sent because of something the customer did (login codes, receipts, replies). Always sent.'], ['marketing', 'Sales follow-ups', 'Helpful emails during and after the trial. Only sent when “Trial follow-up emails” is on in Features, and never to people who unsubscribed.']];
      const page = groups.map(([cat, label, about]) => {
        const list = emails.filter((e) => (e.category || 'transactional') === cat);
        if (!list.length) return '';
        return html`<div class="card flat"><div class="ch" style="padding:16px"><h3>${icon(cat === 'marketing' ? 'send' : 'mail')} ${label} <span class="bd">${list.length}</span></h3><p>${about}</p></div>
          <div class="list" style="border-top:1px solid var(--line)">${list.map((e) => html`<a class="li" href="#emails/${e.key}"><span class="ic">${icon('mail')}</span><span class="tx"><b>${e.name}</b><small>${e.when}</small></span><span class="end">${e.edited ? html`<span class="bd vio">Edited</span>` : ''}<span class="bd" title="Sent in the last 30 days">${num(e.sent_30d)} sent</span>${icon('chev', 'chev')}</span></a>`)}</div></div>`;
      });
      return { html: html`${page}` };
    },
  });

  async function emailEditor(key) {
    const e = await get('/api/admin/emails/' + encodeURIComponent(key));
    const ed = can('emails.edit');
    const dis = ed ? '' : raw(' disabled');
    const cur = e.current;
    const isEdited = JSON.stringify(cur) !== JSON.stringify(e.original);
    const page = html`
      <div class="card"><div class="uhead"><a class="ib" href="#emails" aria-label="Back to emails">${icon('back')}</a><div style="min-width:0"><h2 style="font-size:18px">${e.name}</h2><div class="meta"><span class="bd">${e.category === 'marketing' ? 'Sales follow-up' : 'Transactional'}</span>${isEdited ? html`<span class="bd vio">Edited</span>` : html`<span class="bd ok">Original</span>`}<span class="bd">${e.when}</span></div></div>
        ${ed ? html`<div class="acts"><button class="btn sec sm" data-test>${icon('send')} Send test to me</button><button class="btn danger sec sm" data-reset ${isEdited ? '' : raw('disabled')}>${icon('refresh')} Reset to original</button><button class="btn sm" data-save>${icon('check')} Save</button></div>` : ''}</div></div>
      <div class="em-ed">
        <form class="card" id="emf">
          <div class="f"><label>Subject</label><input name="subject" value="${cur.subject}"${dis}></div>
          <div class="f"><label>Preview text</label><input name="preheader" value="${cur.preheader}"${dis}><span class="hint">The grey line some inboxes show after the subject.</span></div>
          <div class="f"><label>Variables you can use <span class="mut">(tap to copy)</span></label><div class="vars">${[...e.vars, 'first_name', 'unsubscribe_url'].filter((v, i, a) => a.indexOf(v) === i).map((v) => html`<button type="button" data-copy="{{${v}}}">{{${v}}}</button>`)}</div></div>
          <div class="f"><label>Body (HTML)</label><textarea name="body" class="code" spellcheck="false"${dis}>${cur.body}</textarea></div>
          <div class="f"><label>Plain-text version</label><textarea name="text" class="code" style="min-height:140px" spellcheck="false"${dis}>${cur.text}</textarea><span class="hint">For email apps that don't show HTML. Leave empty to build it from the body.</span></div>
        </form>
        <div class="card" style="position:sticky;top:76px"><div class="ch"><h3>${icon('eye')} Preview</h3><span class="mut small" id="pv-sub"></span></div><iframe class="em-frame" id="pv" sandbox="" title="Email preview"></iframe></div>
      </div>`;
    return {
      html: page,
      mount(el) {
        const f = $('#emf', el);
        const vals = () => ({ subject: f.subject.value, preheader: f.preheader.value, body: f.body.value, text: f.text.value });
        let timer, seq = 0;
        const preview = async () => {
          const my = ++seq;
          try {
            const r = await post(`/api/admin/emails/${encodeURIComponent(key)}/preview`, vals());
            if (my !== seq) return;
            $('#pv', el).srcdoc = r.html;
            $('#pv-sub', el).textContent = r.subject;
          } catch (ex) { if (my === seq) $('#pv-sub', el).textContent = ex.message; }
        };
        preview();
        f.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(preview, 600); });
        CV.onLeave(() => clearTimeout(timer));
        on(el, 'click', '[data-save]', async (ev, b) => { if (await act(b, () => putj('/api/admin/emails/' + encodeURIComponent(key), vals()), 'Email saved. It is used from now on.')) CV.reload(); });
        on(el, 'click', '[data-reset]', async (ev, b) => {
          if (!(await confirm('Reset to the original email?', 'Your changes to this email will be thrown away.', { danger: true, okText: 'Reset' }))) return;
          if (await act(b, () => post(`/api/admin/emails/${encodeURIComponent(key)}/reset`), 'Back to the original.')) CV.reload();
        });
        on(el, 'click', '[data-test]', async (ev, b) => {
          const r = await act(b, () => post(`/api/admin/emails/${encodeURIComponent(key)}/test`));
          if (r) toast(r.ok ? `Test sent to ${r.to}. It uses the last SAVED version.` : 'The test could not be sent. Check Email in Settings & connections.', r.ok ? 'ok' : 'bad');
        });
      },
    };
  }

  /* =================== CAS KNOWLEDGE =================== */
  const tryCas = () => html`<form class="card" id="trycas"><div class="ch"><h3>${icon('spark')} Try Cas</h3><p>Ask what a customer would ask. Cas answers using the knowledge and house rules saved right now.</p></div>
    <div class="row" style="align-items:stretch"><input class="in" name="question" placeholder="e.g. Can I see who read my message?" style="flex:1;min-width:200px" aria-label="Question for Cas"><button class="btn" type="submit">${icon('send')} Ask Cas</button></div>
    <div id="cas-out"></div></form>`;
  function mountTryCas(el) {
    const f = $('#trycas', el);
    if (!f) return;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = f.question.value.trim();
      if (q.length < 2) return toast('Type a question first.', 'bad');
      const out = $('#cas-out', f);
      const btn = $('button[type=submit]', f);
      btn.classList.add('busy'); btn.disabled = true;
      put(out, html`<div class="sk" style="height:60px"></div>`);
      try {
        const r = await post('/api/admin/ai/test', { question: q });
        put(out, html`<div class="cas-ans">${r.answer}</div><div class="hint" style="margin-top:6px">${num((r.usage || {}).input_tokens)} tokens read · ${num((r.usage || {}).output_tokens)} written</div>`);
      } catch (ex) {
        put(out, html`<div class="note ${ex.code === 'ai_not_configured' ? 'warn' : 'bad'}">${icon('warn')}<span>${ex.message}${ex.code === 'ai_not_configured' ? html` <a href="#settings">Open Settings & connections</a>` : ''}</span></div>`);
      } finally { btn.classList.remove('busy'); btn.disabled = false; }
    });
  }

  function articleDialog(a) {
    return dialog({
      title: a ? 'Edit article' : 'New article', text: 'Write plainly, like you would explain it to a new teammate. Short facts work best.', icon: 'book', wide: true, okText: a ? 'Save' : 'Add article',
      fields: [
        { name: 'title', label: 'Title', required: true, value: a ? a.title : '', placeholder: 'e.g. How refunds work' },
        { name: 'body', label: 'What Cas should know', type: 'textarea', rows: 12, required: true, value: a ? a.body : '' },
        { name: 'active', label: 'Cas uses this article', type: 'checkbox', value: a ? a.active : true },
      ],
      onSubmit: async (v) => {
        if (a) await putj('/api/admin/knowledge/' + a.id, v); else await post('/api/admin/knowledge', v);
        toast(a ? 'Article saved.' : 'Article added. Cas reads it from now on.'); CV.reload();
      },
    });
  }

  CV.page('knowledge', {
    intro: 'Cas reads these before answering customers and drafting support replies. Keep them true and up to date.',
    async render() {
      const { articles } = await get('/api/admin/knowledge');
      const ed = can('knowledge.edit');
      const page = html`
        ${ed ? tryCas() : ''}
        <div class="card flat"><div class="ch" style="padding:16px"><h3>${icon('book')} Articles <span class="bd">${articles.filter((a) => a.active).length} in use</span></h3>${ed ? html`<div class="acts"><button class="btn sm" data-new>${icon('plus')} Add article</button></div>` : ''}</div>
          <div style="border-top:1px solid var(--line)">${articles.length ? articles.map((a) => html`<div class="kb${a.active ? '' : ' off'}">
            ${CV.sw(a.active, { kact: a.id }, { disabled: !ed, label: 'Cas uses ' + a.title })}
            <div class="tx"><b>${a.title}</b><p>${a.body}</p><div class="small mut" style="margin-top:4px">Updated ${ago(a.updated_at)}${a.updated_by_name ? ' by ' + a.updated_by_name : ''}</div></div>
            ${ed ? html`<div class="row" style="gap:6px"><button class="ib sm" data-edit="${a.id}" aria-label="Edit ${a.title}">${icon('edit')}</button><button class="ib sm" data-del="${a.id}" aria-label="Delete ${a.title}">${icon('trash')}</button></div>` : ''}
          </div>`) : CV.empty('book', 'No articles yet', 'Add what Cas should know about Castvoo: prices, rules, how-tos.')}</div></div>`;
      return {
        html: page,
        mount(el) {
          mountTryCas(el);
          on(el, 'click', '[data-new]', () => articleDialog());
          on(el, 'click', '[data-edit]', (e, b) => articleDialog(articles.find((a) => String(a.id) === b.dataset.edit)));
          on(el, 'click', '[data-del]', async (e, b) => {
            const a = articles.find((x) => String(x.id) === b.dataset.del);
            if (!(await confirm(`Delete “${a.title}”?`, 'Cas will forget it. You can switch it off instead if you might need it again.', { danger: true, okText: 'Delete' }))) return;
            if (await act(null, () => del('/api/admin/knowledge/' + a.id), 'Article deleted.')) CV.reload();
          });
          on(el, 'click', '[data-kact]', async (e, s) => {
            const a = articles.find((x) => String(x.id) === s.dataset.kact);
            const next = s.getAttribute('aria-checked') !== 'true';
            CV.setSw(s, next);
            if (await act(null, () => putj('/api/admin/knowledge/' + a.id, { title: a.title, body: a.body, active: next }), next ? 'Cas uses it again.' : 'Cas will ignore it.')) { a.active = next; s.closest('.kb').classList.toggle('off', !next); } else CV.setSw(s, !next);
          });
        },
      };
    },
  });

  /* =================== AI SETTINGS =================== */
  const MODELS = [['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (fast, cheapest)'], ['claude-sonnet-4-5', 'Claude Sonnet 4.5 (smarter, costs more)']];
  CV.page('ai', {
    intro: 'How Cas writes for customers. Changes apply to the next answer Cas gives.',
    async render() {
      const [s, ov0] = await Promise.all([get('/api/admin/settings'), get('/api/admin/overview').catch(() => null)]);
      const ov = ov0 || { ai: { writes_24h: null, input_24h: null, output_24h: null } };
      const n = (v) => (v == null ? '—' : num(v));
      const ai = s.settings.ai;
      const ed = can('ai.edit') && can('settings.edit');
      const dis = ed ? '' : raw(' disabled');
      const known = MODELS.some(([k]) => k === ai.model);
      const page = html`
        ${s.integrations.ai ? '' : html`<div class="note warn">${icon('warn')}<span>Cas is not connected yet: add ANTHROPIC_API_KEY in Railway. <a href="#settings">See how</a></span></div>`}
        <div class="kpis">
          <div class="kpi"><div class="kh"><small>AI writes, last 24h</small><span class="ki" style="--c:#A855F7">${icon('spark')}</span></div><b>${n(ov.ai.writes_24h)}</b><span class="sub">${ov0 ? 'Customer writes, rewrites and answers' : 'Usage could not load right now'}</span></div>
          <div class="kpi"><div class="kh"><small>Tokens read, 24h</small><span class="ki" style="--c:#6366F1">${icon('book')}</span></div><b>${n(ov.ai.input_24h)}</b></div>
          <div class="kpi"><div class="kh"><small>Tokens written, 24h</small><span class="ki" style="--c:#2F6BFF">${icon('edit')}</span></div><b>${n(ov.ai.output_24h)}</b></div>
          <div class="kpi"><div class="kh"><small>Connection</small><span class="ki" style="--c:${s.integrations.ai ? '#0E9F6E' : '#E5484D'}">${icon('plug')}</span></div><b style="font-size:18px">${s.integrations.ai ? 'Connected' : 'Not connected'}</b></div>
        </div>
        <form class="card" id="aif"><div class="ch"><h3>${icon('sliders')} How Cas writes</h3>${ed ? '' : html`<span class="bd">${icon('lock')} Only Owner and Admin can change this</span>`}</div>
          <div class="fr two">
            <div class="f"><label>AI model</label><select name="model_pick"${dis}>${MODELS.map(([k, l]) => html`<option value="${k}" ${ai.model === k ? raw('selected') : ''}>${l}</option>`)}<option value="other" ${known ? '' : raw('selected')}>Another model (type the name)</option></select>
              <input name="model" value="${ai.model}" placeholder="Model name" ${known ? raw('hidden') : ''}${dis}><span class="hint">Faster models answer quicker and cost less.</span></div>
            <div class="f"><label>Max answer length</label><input name="max_output_tokens" type="number" min="200" max="4000" step="50" value="${ai.max_output_tokens}"${dis}><span class="hint">In tokens (about ¾ of a word each). 900 ≈ a long message. Between 200 and 4,000.</span></div>
          </div>
          <div class="f"><label>Creativity: <b id="temp-v">${ai.temperature}</b></label><input name="temperature" type="range" min="0" max="1" step="0.05" value="${ai.temperature}"${dis}><div class="row between hint"><span>0 = careful, same answer every time</span><span>1 = playful, more variety</span></div></div>
          <div class="f"><label>House rules</label><textarea name="house_rules" rows="7" placeholder="e.g. Never promise profits. Always answer in the customer's language. Keep it under 120 words."${dis}>${ai.house_rules}</textarea><span class="hint">Cas follows these in every answer, on top of the knowledge articles.</span></div>
          ${ed ? html`<div class="row end"><button class="btn" type="submit">${icon('check')} Save AI settings</button></div>` : ''}
        </form>
        ${can('knowledge.edit') ? tryCas() : ''}`;
      return {
        html: page,
        mount(el) {
          const f = $('#aif', el);
          f.temperature.addEventListener('input', () => { $('#temp-v', el).textContent = f.temperature.value; });
          f.model_pick.addEventListener('change', () => { const o = f.model_pick.value === 'other'; f.model.hidden = !o; if (!o) f.model.value = f.model_pick.value; else f.model.focus(); });
          f.addEventListener('submit', async (e) => {
            e.preventDefault();
            const value = { model: f.model_pick.value === 'other' ? f.model.value.trim() : f.model_pick.value, max_output_tokens: Number(f.max_output_tokens.value), temperature: Number(f.temperature.value), house_rules: f.house_rules.value };
            await act($('button[type=submit]', f), () => putj('/api/admin/settings/ai', { value }), 'AI settings saved.');
          });
          mountTryCas(el);
        },
      };
    },
  });
})();
