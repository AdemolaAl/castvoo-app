'use strict';
/* Castvoo Admin — Support AI: the 24/7 AI support team (agents, rules, limits) and a sandbox to test it. */
(() => {
  const { html, raw, icon, $, $$, on, put, num, get, post, putj, del, act, dialog, confirm, can, toast } = CV;

  const ESC_LABEL = {
    human_request: ['Customer asks for a person', 'Hands over at once, without the AI answering.'],
    sensitive: ['Refunds, chargebacks, legal, data deletion, ownership, closing the account', 'Always a person. The AI never decides these.'],
    manual_payment: ['Manual payments to confirm', 'Bank, mobile money and USDT sent by hand go to Finance with a summary.'],
    frustration: ['Angry or upset customer', 'Strong words, shouting, or frustration twice in a row.'],
    low_confidence: ['AI not sure', 'The AI may hand over when the answer is not in the knowledge.'],
    tool_errors: ['Checks fail', 'Two or more account checks failed while answering.'],
    failed_attempts: ['Not fixed after 3 tries', '"Still not working" three times in one conversation.'],
  };
  const sec = (ms) => Math.round((Number(ms) || 0) / 100) / 10;

  CV.page('support-ai', {
    intro: 'AI agents answer the support chat 24/7, check the customer\'s own account with safe tools and hand over to the team when a person is needed. They can never approve, credit or refund money.',
    async render() {
      const d = await get('/api/admin/support-ai');
      const s = d.settings;
      const ed = can('support_ai.edit');
      const dis = ed ? '' : raw(' disabled');
      const st = d.stats;
      const warn = !d.model.has_key ? 'No AI key is connected, so the AI team is quiet. Add it in AI settings.'
        : !d.features.support_ai ? 'The "AI support team" switch is off in Features.' : !d.features.support_chat ? 'Support chat is switched off in Features.' : !s.enabled ? 'The AI team is switched off below. The human team answers everything.' : '';
      const persona = (p) => html`<div class="sai-p${p.active ? '' : ' off'}" data-p="${p.id}">
          <div class="ptop"><img src="${p.avatar}" alt="" width="56" height="56"><div style="min-width:0"><b>${p.name}</b><br><small>${p.role || 'Support'}</small><br><span class="mut small">${p.has_photo ? 'Photo' : p.face ? 'Face: ' + faceLabel(p.face) : 'Initials'}</span></div>${p.active ? '' : html`<span class="bd" style="margin-left:auto">Off</span>`}</div>
          ${p.bio ? html`<p>${p.bio}</p>` : ''}
          ${ed ? html`<div class="acts"><button type="button" class="btn sec sm" data-edit="${p.id}">${icon('edit')} Edit</button>
            <button type="button" class="btn sec sm" data-face="${p.id}">${icon('user')} Face</button>
            <label class="btn sec sm" style="cursor:pointer">${icon('plus')} Photo<input type="file" accept="image/jpeg,image/png,image/webp" data-photo="${p.id}" hidden></label>
            ${p.has_photo ? html`<button type="button" class="ib sm" data-nophoto="${p.id}" title="Remove the photo (the face shows again)" aria-label="Remove photo">${icon('x')}</button>` : ''}
            <button type="button" class="ib sm" data-rm="${p.id}" title="Delete" aria-label="Delete ${p.name}">${icon('trash')}</button></div>` : ''}
        </div>`;
      const faceLabel = (k) => ((d.faces || []).find((f) => f.key === k) || { label: k }).label;
      /* The face picker: 8 illustrated faces, or initials. Used by "Face" and "Add agent". */
      const faceGrid = (cur) => html`<div class="facepick" role="radiogroup" aria-label="Face">${(d.faces || []).map((f) => html`<label class="fp${cur === f.key ? ' on' : ''}"><input type="radio" name="face" value="${f.key}" ${cur === f.key ? raw('checked') : ''}><img src="${f.url}" alt="" width="64" height="64"><span>${f.label}</span></label>`)}<label class="fp${!cur ? ' on' : ''}"><input type="radio" name="face" value="" ${!cur ? raw('checked') : ''}><span class="fpi">Aa</span><span>Initials</span></label></div>`;
      const pickedFace = (form) => { const r = form.querySelector('input[name=face]:checked'); return r ? r.value : ''; };
      const faceSync = (form) => form.addEventListener('change', (e) => { if (e.target.name === 'face') form.querySelectorAll('.fp').forEach((l) => l.classList.toggle('on', l.contains(e.target))); });
      const num2 = (name, label, value, hint, o = {}) => html`<div class="f"><label for="sa_${name}">${label}</label><input id="sa_${name}" name="${name}" type="number" value="${value}" min="${o.min ?? 0}" max="${o.max ?? 100000}" step="${o.step || 1}"${dis}>${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
      const page = html`
        ${warn ? html`<div class="note warn">${icon('warn')}<span>${warn}</span></div>` : ''}
        <div class="kpis">
          <div class="kpi"><div class="kh"><small>AI team</small><span class="ki" style="--c:${d.on ? '#0E9F6E' : '#E5484D'}">${icon('spark')}</span></div><b style="font-size:18px">${d.on ? 'Answering 24/7' : 'Off'}</b><span class="sub">${d.model.label}</span></div>
          <div class="kpi"><div class="kh"><small>AI replies, 24h</small><span class="ki" style="--c:#7B5CF5">${icon('chat')}</span></div><b>${num(st.replies_24h)}</b><span class="sub">${num(st.conversations_24h)} conversations</span></div>
          <a class="kpi" href="#support?f=human"><div class="kh"><small>Handed to the team, 24h</small><span class="ki" style="--c:#F59E0B">${icon('users')}</span></div><b>${num(st.handoffs_24h)}</b><span class="sub">${num(st.waiting_for_human)} waiting for a person now</span></a>
          ${d.resolution ? html`<div class="kpi" title="Conversations the AI solved with no handoff and no teammate reply, out of all conversations the AI took part in"><div class="kh"><small>Solved by AI, 7 days</small><span class="ki" style="--c:${d.resolution.d7.rate_pct == null || d.resolution.d7.rate_pct >= d.resolution.goal_pct ? '#0E9F6E' : '#F59E0B'}">${icon('check')}</span></div><b>${d.resolution.d7.rate_pct == null ? '–' : d.resolution.d7.rate_pct + '%'}</b><span class="sub">${num(d.resolution.d7.resolved)} of ${num(d.resolution.d7.total)} · 30 days: ${d.resolution.d30.rate_pct == null ? '–' : d.resolution.d30.rate_pct + '%'} · goal ${d.resolution.goal_pct}%</span></div>` : ''}
          <div class="kpi"><div class="kh"><small>AI cost, 24h</small><span class="ki" style="--c:#2F6BFF">${icon('wallet')}</span></div><b>$${Number(st.cost_24h || 0).toFixed(2)}</b><span class="sub">${num(st.tokens_24h)} tokens · ${num(st.site_chats_24h)} website chats</span></div>
        </div>

        <div class="card"><div class="ch"><h3>${icon('users')} Your AI support team</h3>${ed ? html`<button type="button" class="btn sm" data-add>${icon('plus')} Add agent</button>` : html`<span class="bd">${icon('lock')} Only Owner and Admin can change this</span>`}
            <p>First names only. Each conversation keeps the same agent. Pick one of the illustrated faces, or upload a photo (a photo shows first).</p></div>
          ${d.personas.length ? html`<div class="sai-team">${d.personas.map(persona)}</div>` : CV.empty('users', 'No agents yet', 'Add at least one agent so the AI team can answer.')}
        </div>

        <form class="card" id="saf"><div class="ch"><h3>${icon('sliders')} How they answer</h3>
            <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? raw('checked') : ''}${dis}> <b>AI team on</b></label></div>
          <div class="f"><label for="sa_rules">Tone and house rules</label><textarea id="sa_rules" name="house_rules" rows="5" placeholder="e.g. Greet Nigerian customers with 'Hi'. Never mention competitors. Offer the setup video when people are new."${dis}>${s.house_rules}</textarea>
            <span class="hint">On top of the built-in rules: warm plain English, the customer's language, short bubbles, and the money rules (no credits, refunds, discounts or approvals, ever).</span></div>
          <div class="fr">
            ${num2('typing_min_s', 'Shortest typing time (seconds)', sec(s.typing_min_ms), 'Each bubble "types" for a time based on its length.', { max: 15, step: 0.1 })}
            ${num2('typing_max_s', 'Longest typing time (seconds)', sec(s.typing_max_ms), '', { max: 20, step: 0.1 })}
            ${num2('debounce_s', 'Wait for more messages (seconds)', sec(s.debounce_ms), 'People often send 2 or 3 short messages in a row.', { max: 10, step: 0.1 })}
          </div>
          <div class="fr">
            ${num2('daily_cap_per_user', 'AI replies per customer per day', s.daily_cap_per_user, 'Then a person takes over.', { min: 1, max: 1000 })}
            ${num2('daily_cap_total', 'AI replies per day, everyone', s.daily_cap_total, 'A safety limit on cost.', { min: 1, max: 200000 })}
            ${num2('msgs_per_min', 'Messages a customer can send per minute', s.msgs_per_min, '', { min: 2, max: 60 })}
            ${num2('free_conversations_per_month', 'Free plan: AI chats per month', s.free_conversations_per_month, 'After that, Free customers get the team and email. Paid plans: unlimited (fair use).', { max: 1000 })}
          </div>
          <div class="fr">
            <div class="f"><label for="sa_eta_f">Reply time we promise: Free</label><input id="sa_eta_f" name="eta_free" value="${s.handoff_eta.free}"${dis}></div>
            <div class="f"><label for="sa_eta_p">Paid plans</label><input id="sa_eta_p" name="eta_paid" value="${s.handoff_eta.paid}"${dis}></div>
            <div class="f"><label for="sa_eta_x">Priority plans</label><input id="sa_eta_x" name="eta_priority" value="${s.handoff_eta.priority}"${dis}><span class="hint">Used in "a teammate will reply here …".</span></div>
          </div>
          <div class="f"><label>Plans with priority support</label><div class="chips">${d.plans.map((p) => html`<label class="chip pick${s.priority_plans.includes(p.code) ? ' on' : ''}"><input type="checkbox" name="prio_${p.code}" ${s.priority_plans.includes(p.code) ? raw('checked') : ''} hidden${dis}>${p.name}</label>`)}</div></div>
          <div class="fr two">
            <div class="f"><label for="sa_model">Model (optional)</label><input id="sa_model" name="model" value="${s.model}" placeholder="${d.model.cas_model}"${dis}><span class="hint">Empty = the same model as Cas (${d.model.label}). Provider and key are in AI settings.</span></div>
            ${num2('max_tool_rounds', 'Most account checks per answer', s.max_tool_rounds, '', { min: 1, max: 10 })}
          </div>
          <div class="f"><label>Hand over to a person when…</label><div class="esc">${d.escalation_keys.map((k) => html`<label class="check" style="align-items:flex-start"><input type="checkbox" name="esc_${k}" ${s.escalation[k] ? raw('checked') : ''}${dis}><span><b>${(ESC_LABEL[k] || [k])[0]}</b><br><small class="hint">${(ESC_LABEL[k] || ['', ''])[1]}</small></span></label>`)}</div></div>
          <div class="fr two">
            <div class="f"><label class="check" style="align-items:flex-start"><input type="checkbox" name="customer_images" ${s.customer_images !== false ? raw('checked') : ''}${dis}><span><b>Customers can send images</b><br><small class="hint">Screenshots in Help (up to 3 per message, 10 MB each). The AI reads them; text inside an image never counts as an instruction. Never in the website chat.</small></span></label></div>
            <div class="f"><label class="check" style="align-items:flex-start"><input type="checkbox" name="powered_by" ${s.powered_by !== false ? raw('checked') : ''}${dis}><span><b>Show the "Powered by" line</b><br><small class="hint">A small line under the support chat and the website chat, linking to replyvoo.com.</small></span></label>
              <input name="powered_by_text" value="${s.powered_by_text || 'Powered by Replyvoo'}" maxlength="60" aria-label="Powered by text" style="margin-top:8px"${dis}></div>
          </div>
          <div class="fr">
            ${num2('site_chat_daily_cap', 'Website chat: answers per day', s.site_chat_daily_cap, html`Visitors only, no account access. Switch it off in <a href="#features">Features</a> (Website chat).`, { max: 100000 })}
            ${num2('site_chat_per_ip_day', 'Website chat: answers per visitor per day', s.site_chat_per_ip_day, '', { min: 1, max: 1000 })}
          </div>
          ${ed ? html`<div class="row end"><button class="btn" type="submit">${icon('check')} Save</button></div>` : ''}
        </form>

        ${can('support_ai.test') ? html`<div class="card" id="sbx"><div class="ch"><h3>${icon('spark')} Test the support AI</h3><p>Chat as a customer. The AI reads that workspace with read-only tools: nothing is credited, repaired, emailed or handed over, and nothing appears in their chat.</p></div>
          <div class="fr two">
            <div class="f"><label for="sbx_q">Customer workspace</label><div class="row" style="flex-wrap:nowrap"><input id="sbx_q" placeholder="Search name or email" autocomplete="off"><select id="sbx_ws" aria-label="Workspace"><option value="">Pick a workspace</option></select></div></div>
            <div class="f"><label for="sbx_p">Agent</label><select id="sbx_p">${d.personas.filter((p) => p.active).map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
          </div>
          <div class="sbx"><div class="sbx-chat"><div class="sbx-msgs" id="sbx_m"><div class="mut small" style="text-align:center;margin:auto">Pick a workspace, then write like a customer would.</div></div>
            <form id="sbx_f"><textarea name="m" placeholder="e.g. I paid but my wallet is empty" aria-label="Message"></textarea><button class="btn" type="submit">${icon('send')}</button></form></div>
            <div class="sbx-log" id="sbx_l"><b>${icon('cpu')} Tools the AI used</b><span class="hint">They show here after each answer.</span></div></div>
        </div>` : ''}`;

      return {
        html: page,
        mount(el) {
          /* agents */
          const used = new Set(d.personas.map((x) => x.face).filter(Boolean));
          const editDlg = (p) => dialog({
            title: p ? 'Edit ' + p.name : 'New agent', icon: 'user', okText: p ? 'Save' : 'Add agent', text: 'A first name and a short role. Customers see the name and the face.', wide: !p,
            body: p ? '' : html`<div class="f"><label>Face</label>${faceGrid(((d.faces || []).find((f) => !used.has(f.key)) || {}).key || '')}</div>`,
            onOpen: (form) => faceSync(form),
            fields: [
              { name: 'name', label: 'First name', required: true, value: p ? p.name : '', placeholder: 'e.g. Mia' },
              { name: 'role', label: 'Role', value: p ? p.role : '', placeholder: 'e.g. Billing and payments' },
              { name: 'bio', label: 'Short bio (helps the AI sound like this person)', type: 'textarea', rows: 3, value: p ? p.bio : '' },
              { name: 'sort', label: 'Order', type: 'number', value: p ? p.sort : 0, min: 0, max: 999 },
              { name: 'active', label: 'Answers customers', type: 'checkbox', value: p ? p.active : true },
            ],
            onSubmit: (v, form) => (p ? putj('/api/admin/support-ai/personas/' + p.id, { ...v, face: undefined, sort: Number(v.sort) || 0 }) : post('/api/admin/support-ai/personas', { ...v, face: pickedFace(form) || null, sort: Number(v.sort) || 0 })),
          }).then((r) => { if (r) { toast('Saved.'); CV.reload(); } });
          on(el, 'click', '[data-add]', () => editDlg(null));
          on(el, 'click', '[data-edit]', (e, b) => editDlg(d.personas.find((x) => String(x.id) === b.dataset.edit)));
          on(el, 'click', '[data-rm]', async (e, b) => {
            const p = d.personas.find((x) => String(x.id) === b.dataset.rm);
            if (await confirm('Delete ' + p.name + '?', 'Conversations with ' + p.name + ' get another agent next time.', { danger: true, okText: 'Delete' })) { if (await act(b, () => del('/api/admin/support-ai/personas/' + p.id), 'Deleted.')) CV.reload(); }
          });
          on(el, 'click', '[data-face]', (e, b) => {
            const p = d.personas.find((x) => String(x.id) === b.dataset.face);
            dialog({
              title: 'Pick a face for ' + p.name, icon: 'user', wide: true, okText: 'Use this face',
              text: p.has_photo ? 'This agent has a photo, which shows first. Remove the photo to show the face.' : 'Customers see it in the chat, next to every answer.',
              body: faceGrid(p.face || ''), onOpen: (form) => faceSync(form),
              onSubmit: (v, form) => putj('/api/admin/support-ai/personas/' + p.id + '/face', { face: pickedFace(form) || null }),
            }).then((r) => { if (r) { toast('Face saved.'); CV.reload(); } });
          });
          on(el, 'click', '[data-nophoto]', async (e, b) => { if (await act(b, () => del(`/api/admin/support-ai/personas/${b.dataset.nophoto}/photo`), 'Photo removed.')) CV.reload(); });
          on(el, 'change', '[data-photo]', async (e, inp) => {
            const f = inp.files && inp.files[0];
            if (!f) return;
            if (f.size > 5 * 1024 * 1024) return toast('Photos can be up to 5 MB.', 'bad');
            const ok = await act(null, async () => {
              const r = await fetch(`/api/admin/support-ai/personas/${inp.dataset.photo}/photo`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type, 'x-cv': '1' }, body: f });
              const j = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(j.error || 'Upload failed.');
              return j;
            }, 'Photo saved.');
            if (ok) CV.reload();
          });
          on(el, 'change', '.chip.pick input', (e, i) => i.closest('.chip').classList.toggle('on', i.checked));

          /* settings */
          const f = $('#saf', el);
          f.addEventListener('submit', async (e) => {
            e.preventDefault();
            const v = (n) => f.elements[n].value;
            const body = {
              enabled: f.enabled.checked, house_rules: v('house_rules'), model: v('model').trim(),
              typing_min_ms: Math.round(Number(v('typing_min_s')) * 1000), typing_max_ms: Math.round(Number(v('typing_max_s')) * 1000), debounce_ms: Math.round(Number(v('debounce_s')) * 1000),
              daily_cap_per_user: Number(v('daily_cap_per_user')), daily_cap_total: Number(v('daily_cap_total')), msgs_per_min: Number(v('msgs_per_min')),
              free_conversations_per_month: Number(v('free_conversations_per_month')), max_tool_rounds: Number(v('max_tool_rounds')),
              site_chat_daily_cap: Number(v('site_chat_daily_cap')), site_chat_per_ip_day: Number(v('site_chat_per_ip_day')),
              handoff_eta: { free: v('eta_free'), paid: v('eta_paid'), priority: v('eta_priority') },
              priority_plans: d.plans.filter((p) => f.elements['prio_' + p.code] && f.elements['prio_' + p.code].checked).map((p) => p.code),
              escalation: Object.fromEntries(d.escalation_keys.map((k) => [k, f.elements['esc_' + k].checked])),
              customer_images: f.customer_images.checked, powered_by: f.powered_by.checked, powered_by_text: v('powered_by_text').trim(),
            };
            if (await act($('button[type=submit]', f), () => putj('/api/admin/support-ai/settings', body), 'Support AI saved.')) CV.reload();
          });

          /* sandbox */
          const box = $('#sbx', el);
          if (!box) return;
          const q = $('#sbx_q', box), wsSel = $('#sbx_ws', box), list = $('#sbx_m', box), logEl = $('#sbx_l', box), form = $('#sbx_f', box);
          let history = [];
          let tmr = null;
          const search = async () => {
            try {
              const r = await get('/api/admin/support-ai/workspaces?q=' + encodeURIComponent(q.value.trim()));
              put(wsSel, html`<option value="">Pick a workspace</option>${r.workspaces.map((w) => html`<option value="${w.id}">${w.name} · ${w.owner_email || w.owner_name || 'no email'} · ${w.plan_code} (${w.plan_status})</option>`)}`);
              if (r.workspaces.length === 1) wsSel.value = String(r.workspaces[0].id);
            } catch { /* ignore */ }
          };
          q.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(search, 250); });
          search();
          wsSel.addEventListener('change', () => { history = []; put(list, html`<div class="mut small" style="text-align:center;margin:auto">New conversation. Write like a customer would.</div>`); });
          const bubble = (cls, text, name, avatar) => html`<div class="msg ${cls}">${raw('')}<div class="bub">${text}</div>${name ? html`<span class="who">${avatar ? html`<img class="pav" src="${avatar}" alt="" width="22" height="22">` : ''}${name}${cls === 'ai' ? html` <span class="bd vio aib">${icon('spark')} AI</span>` : ''}</span>` : ''}</div>`;
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const m = form.m.value.trim();
            if (!wsSel.value) return toast('Pick a workspace first.', 'bad');
            if (!m) return;
            if (!history.length) put(list, '');
            list.insertAdjacentHTML('beforeend', String(bubble('user', m, 'Customer')));
            const typing = document.createElement('div');
            typing.className = 'msg ai typing';
            typing.innerHTML = '<div class="bub">typing…</div>';
            list.appendChild(typing); list.scrollTop = list.scrollHeight;
            form.m.value = '';
            const r = await act($('button[type=submit]', form), () => post('/api/admin/support-ai/sandbox', { workspace_id: Number(wsSel.value), persona_id: Number($('#sbx_p', box).value) || null, history, message: m }));
            typing.remove();
            if (!r) return;
            history.push({ role: 'user', content: m });
            for (const b of r.bubbles) { list.insertAdjacentHTML('beforeend', String(bubble('ai', b, r.persona && r.persona.name, r.persona && r.persona.avatar))); }
            history.push({ role: 'assistant', content: r.bubbles.join('\n\n') });
            if (r.handoff) list.insertAdjacentHTML('beforeend', String(html`<div class="msg sys"><div class="bub">Would hand over to a person: ${CV.AI_REASON ? CV.AI_REASON[r.handoff.reason] || r.handoff.reason : r.handoff.reason} · ${r.handoff.queue || 'support'} team</div></div>`));
            list.scrollTop = list.scrollHeight;
            put(logEl, html`<b>${icon('cpu')} Tools the AI used</b>${r.tools.length ? r.tools.map((t) => html`<details class="aitools" open><summary><b style="font-family:var(--mono)">${t.name}</b>${t.ok ? '' : html` <span class="bd bad">failed</span>`}</summary><code style="font-family:var(--mono);font-size:11px;overflow-wrap:anywhere;display:block;margin-top:6px">${JSON.stringify(t.output, null, 1).slice(0, 1500)}</code></details>`) : html`<span class="hint">No tools for this answer.</span>`}${r.usage ? html`<span class="hint">${num(r.usage.input_tokens)} tokens read · ${num(r.usage.output_tokens)} written</span>` : ''}`);
          });
          form.m.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
        },
      };
    },
  });
})();
