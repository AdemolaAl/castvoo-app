'use strict';
/*
 * app-cas.js: "Ask Cas" (chat with the AI helper) and "Train Cas" (teach Cas about the business).
 * API: POST /api/ai/ask, GET/POST /api/app/ai-profile, GET /api/ai/my-examples
 */

const CHAT = [];  // this visit's conversation: { role: 'user' | 'assistant', content }
const TRAIN_FIELDS = [
  ['business', 'Business name', 'input', 120, 'For example: Ada\'s Closet'],
  ['what_you_sell', 'What you sell', 'textarea', 1500, 'Your products or services, prices, what makes them special.'],
  ['audience', 'Who your customers are', 'textarea', 800, 'For example: young professionals in Lagos who love fashion.'],
  ['tone', 'How you talk', 'input', 200, 'For example: warm, short sentences, a little playful'],
  ['language', 'Main language', 'input', 60, 'For example: English, sometimes Pidgin'],
  ['offers', 'Current offers', 'textarea', 1500, 'Deals, codes, deadlines Cas can mention.'],
  ['links', 'Important links', 'textarea', 800, 'Your shop, booking page, WhatsApp, website…'],
  ['always', 'Always do', 'textarea', 600, 'For example: end with one clear button. Use emojis lightly.'],
  ['never', 'Never do', 'textarea', 600, 'For example: never promise guaranteed results. No ALL CAPS.'],
];

PAGES.ai = {
  title: 'Ask Cas', sub: 'Your AI helper',
  async render(el, q, alive) {
    const tab = q.tab === 'train' ? 'train' : 'chat';
    const p = APP.state.plan;
    const left = aiLeft();
    el.innerHTML = '<div class="box hello"><div class="mesh" style="width:300px;height:300px;right:20%;top:-40%;background:rgba(110,195,255,.5)"></div><div style="display:flex;flex-direction:column;gap:10px;min-width:0;padding-bottom:20px">' +
      '<span class="pill" style="background:rgba(255,255,255,.16);color:#fff;align-self:flex-start" data-aileft>' + fmt(left) + ' AI writes left</span>' +
      '<h2>Hi' + ((ME.user && ME.user.name) ? ' ' + esc(ME.user.name.split(' ')[0]) : '') + ', I\'m Cas.</h2><p>Ask me to write or translate a message, or ask how your messages are doing. I look at your real numbers in Castvoo. Teach me about your business and everything I write sounds like you.</p>' +
      '<p class="hsmall">' + fmt(p.usage.ai_writes) + ' of ' + fmt(p.limits.ai_writes) + ' AI writes used this month. ' + (p.ai_refill_at ? 'They refill on ' + fmtDate(p.ai_refill_at, false) + '. If they run out, I rest until then. ' : p.status === 'trial' ? 'Your plan\'s full amount starts when the trial ends. ' : '') + 'There is never an extra charge.</p></div><div class="hart" data-cas="think"></div></div>' +
      '<div class="seg2 tabs" id="aiTab"><button type="button" data-t="chat" class="' + (tab === 'chat' ? 'on' : '') + '">' + icon('chat') + 'Ask Cas</button><button type="button" data-t="train" class="' + (tab === 'train' ? 'on' : '') + '">' + icon('spark') + 'Train Cas</button></div><div id="aiBody"></div>';
    $('#aiTab').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) appGo('ai', b.dataset.t === 'train' ? { tab: 'train' } : null); };
    if (tab === 'train') return trainCas($('#aiBody'), alive);
    chatCas($('#aiBody'), q.ask);
  },
};

function chatCas(box, autoAsk) {
  if (!aiOn()) {
    box.innerHTML = emptyBox({ cas: 'think', title: 'Cas is being switched on', text: 'The AI helper isn\'t available just yet. You can already teach Cas about your business on the Train Cas tab, so it\'s ready when it switches on.', action: '<button type="button" class="btn b-blue sm" data-go="ai" data-q="tab=train">Train Cas</button>' });
    return;
  }
  const prompts = ['How did my last broadcast do?', 'What should I send next?', 'Write 3 hooks for my next offer.', 'How do I get more people to start my bot?', 'Turn my welcome message into French.'];
  box.innerHTML = '<div class="box chatb"><div class="chatl" id="chL"></div>' +
    '<div class="chips aichips" id="chP">' + prompts.map((t) => '<button type="button" class="chb">' + esc(t) + '</button>').join('') + '</div>' +
    '<form class="chatf" id="chF"><textarea class="inp" id="chQ" rows="2" maxlength="1500" placeholder="Ask Cas anything about your Telegram…" aria-label="Your question"></textarea><button type="submit" class="btn b-blue" id="chGo" aria-label="Ask">' + icon('send') + '<span class="hide-sm">Ask</span></button></form>' +
    '<p class="hint">Each question uses 1 AI write. Cas can make mistakes, so check anything important.</p></div>';
  const list = $('#chL');
  const draw = () => {
    list.innerHTML = (CHAT.length ? '' : '<div class="cmsg a"><span class="cav" data-cas="mini"></span><div class="cb">Hi! Ask me anything about your messages, your subscribers or how to use Castvoo. I can also write messages for you.</div></div>') +
      CHAT.map((m) => '<div class="cmsg ' + (m.role === 'user' ? 'u' : 'a') + '">' + (m.role === 'user' ? '' : '<span class="cav" data-cas="mini"></span>') + '<div class="cb">' + (m.pending ? '<span class="tg-typing in"><i></i><i></i><i></i></span>' : fmtMsg(m.content)) + '</div>' + (m.role === 'assistant' && !m.pending ? '<button type="button" class="cpy" data-copy="' + esc(m.content) + '" data-msg="Copied" aria-label="Copy answer">' + icon('copy') + '</button>' : '') + '</div>').join('');
    paintCas(list);
    list.scrollTop = list.scrollHeight;
  };
  const ask = async (question) => {
    question = question.trim();
    if (question.length < 2) return;
    const history = CHAT.filter((m) => !m.pending).slice(-6).map((m) => ({ role: m.role, content: m.content }));
    CHAT.push({ role: 'user', content: question });
    const wait = { role: 'assistant', content: '', pending: true }; CHAT.push(wait);
    draw();
    $('#chQ').value = ''; $('#chGo').disabled = true;
    try {
      const r = await POST('/api/ai/ask', { question, history });
      wait.content = r.answer; wait.pending = false; setAiLeft(r.ai_writes_left);
    } catch (e) {
      CHAT.splice(CHAT.indexOf(wait), 1);
      CHAT.push({ role: 'assistant', content: '⚠️ ' + e.message });
      apiErr(e, { silent: true });
    }
    if ($('#chGo')) { $('#chGo').disabled = false; draw(); }
  };
  $('#chF').onsubmit = (e) => { e.preventDefault(); ask($('#chQ').value); };
  $('#chQ').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#chQ').value); } };
  $('#chP').onclick = (e) => { const b = e.target.closest('.chb'); if (b) ask(b.textContent); };
  draw();
  if (autoAsk) ask(autoAsk);
}

async function trainCas(box, alive) {
  box.innerHTML = skel(1, 400);
  const d = await GET('/api/app/ai-profile');
  if (!alive()) return;
  const pf = d.profile || {};
  const canEdit = canSend();
  const ex = (pf.examples || []).slice(0, 5); while (ex.length < 3) ex.push('');
  const faqs = (pf.faqs || []).slice(0, 15); if (!faqs.length) faqs.push({ q: '', a: '' });
  const dis = canEdit ? '' : ' disabled';
  box.innerHTML = '<div class="trainw"><div class="box trainf">' +
    '<div class="bh"><h3>Teach Cas about your business</h3><span class="pill p-blue" id="trPct"></span></div><div class="prog2"><i id="trBar" style="width:0"></i></div>' +
    '<p class="muted" style="font-size:14px">The better Cas knows your business, the better it writes. Fill in what you can; every field is optional. Cas uses this every time it writes or answers.</p>' +
    (canEdit ? '' : '<div class="note2"><span>🔒</span><span>Your role can\'t change this. Ask the workspace owner.</span></div>') +
    '<div class="tgrid">' + TRAIN_FIELDS.map((f) => '<div class="field' + (f[2] === 'textarea' ? ' wide' : '') + '"><label for="tr_' + f[0] + '">' + f[1] + '</label>' + (f[2] === 'input' ? '<input class="inp" id="tr_' + f[0] + '" data-tf="' + f[0] + '" maxlength="' + f[3] + '" placeholder="' + esc(f[4]) + '" value="' + esc(pf[f[0]] || '') + '"' + dis + '>' : '<textarea class="inp" id="tr_' + f[0] + '" data-tf="' + f[0] + '" rows="3" maxlength="' + f[3] + '" placeholder="' + esc(f[4]) + '"' + dis + '>' + esc(pf[f[0]] || '') + '</textarea>') + '</div>').join('') + '</div>' +
    '<div class="field"><div class="bh"><label>Example messages you like <span class="hint">(up to 5)</span></label>' + (canEdit ? '<button type="button" class="btn b-ghost xs" id="trMine">' + icon('refresh') + 'Use my last sent messages</button>' : '') + '</div><div id="trEx" class="trl"></div>' + (canEdit ? '<button type="button" class="btn b-ghost xs" id="trExA" style="align-self:flex-start">' + icon('plus') + 'Add an example</button>' : '') + '</div>' +
    '<div class="field"><label>Questions customers ask <span class="hint">(and your answers)</span></label><div id="trFq" class="trl"></div>' + (canEdit ? '<button type="button" class="btn b-ghost xs" id="trFqA" style="align-self:flex-start">' + icon('plus') + 'Add a question</button>' : '') + '</div>' +
    '<p class="ferr" id="trE" hidden></p>' +
    (canEdit ? '<button type="button" class="btn b-blue" id="trSave" style="align-self:flex-start">' + icon('check') + 'Save what Cas knows</button>' : '') +
    '</div><div class="box trainside"><div style="width:110px;align-self:center" data-cas="happy"></div><b>Why this matters</b><p class="muted" style="font-size:14px">Without training, Cas writes good general messages. With training, Cas uses your prices, your offers, your links and your way of talking, and avoids what you never say.</p><div class="note2"><span>🔒</span><span>Only your workspace uses this. It is never shared with other customers.</span></div></div></div>';
  const drawEx = () => { $('#trEx').innerHTML = ex.map((x, i) => '<div class="trr"><textarea class="inp" rows="3" maxlength="1500" data-ex="' + i + '" placeholder="Paste a message that sounds just like you"' + dis + '>' + esc(x) + '</textarea>' + (canEdit ? '<button type="button" class="x" data-exx="' + i + '" aria-label="Remove example">×</button>' : '') + '</div>').join(''); const a = $('#trExA'); if (a) a.hidden = ex.length >= 5; };
  const drawFq = () => { $('#trFq').innerHTML = faqs.map((x, i) => '<div class="trr fq"><div class="fqi"><input class="inp" maxlength="300" data-fq="' + i + '" placeholder="Question, like: Do you deliver to Abuja?" value="' + esc(x.q) + '"' + dis + '><textarea class="inp" rows="2" maxlength="1000" data-fa="' + i + '" placeholder="Your answer"' + dis + '>' + esc(x.a) + '</textarea></div>' + (canEdit ? '<button type="button" class="x" data-fqx="' + i + '" aria-label="Remove question">×</button>' : '') + '</div>').join(''); const a = $('#trFqA'); if (a) a.hidden = faqs.length >= 15; };
  const score = () => {
    const vals = TRAIN_FIELDS.map((f) => ($('#tr_' + f[0]).value || '').trim());
    let n = vals.filter(Boolean).length + (ex.some((x) => x.trim()) ? 1 : 0) + (faqs.some((x) => x.q.trim() && x.a.trim()) ? 1 : 0);
    const pct = Math.round(n / (TRAIN_FIELDS.length + 2) * 100);
    $('#trPct').textContent = 'Cas knows you ' + pct + '%'; $('#trBar').style.width = pct + '%';
  };
  drawEx(); drawFq(); score();
  box.oninput = (e) => {
    const t = e.target;
    if (t.dataset.ex != null) ex[t.dataset.ex] = t.value;
    if (t.dataset.fq != null) faqs[t.dataset.fq].q = t.value;
    if (t.dataset.fa != null) faqs[t.dataset.fa].a = t.value;
    score();
  };
  box.onclick = async (e) => {
    const t = e.target;
    const exx = t.closest('[data-exx]'); if (exx) { ex.splice(+exx.dataset.exx, 1); drawEx(); score(); return; }
    const fqx = t.closest('[data-fqx]'); if (fqx) { faqs.splice(+fqx.dataset.fqx, 1); if (!faqs.length) faqs.push({ q: '', a: '' }); drawFq(); score(); return; }
    if (t.closest('#trExA')) { if (ex.length < 5) { ex.push(''); drawEx(); } return; }
    if (t.closest('#trFqA')) { if (faqs.length < 15) { faqs.push({ q: '', a: '' }); drawFq(); } return; }
    const mine = t.closest('#trMine');
    if (mine) {
      btnBusy(mine, true, 'Loading…');
      try {
        const r = await GET('/api/ai/my-examples');
        const got = (r.examples || []).filter(Boolean);
        if (!got.length) toast('No sent messages yet. Send one first, or paste examples.', { kind: 'info' });
        else { let k = 0; for (let i = 0; i < ex.length && k < got.length; i++) if (!ex[i].trim()) ex[i] = got[k++]; while (k < got.length && ex.length < 5) ex.push(got[k++]); drawEx(); score(); toast('Added ' + plural(Math.min(got.length, 5), 'message') + '.'); }
      } catch (ex2) { apiErr(ex2); }
      btnBusy(mine, false);
      return;
    }
    const sv = t.closest('#trSave');
    if (sv) {
      const body = {};
      TRAIN_FIELDS.forEach((f) => { body[f[0]] = $('#tr_' + f[0]).value.trim(); });
      body.examples = ex.map((x) => x.trim()).filter(Boolean);
      body.faqs = faqs.map((x) => ({ q: x.q.trim(), a: x.a.trim() })).filter((x) => x.q && x.a);
      btnBusy(sv, true, 'Saving…');
      try { await POST('/api/app/ai-profile', body); toast('Saved. Cas will use this from now on.'); refreshState(); }
      catch (ex3) { $('#trE').textContent = ex3.message; $('#trE').hidden = false; }
      btnBusy(sv, false);
    }
  };
}
