'use strict';
/* Castvoo Admin — Payments and Withdrawals. */
(() => {
  const { html, raw, icon, $, on, num, usd, dt, ago, get, post, act, dialog, can, toast } = CV;

  const coinIcon = (p) => {
    if (p.provider === 'manual_crypto') return String(p.coin).toUpperCase() === 'BTC' ? html`<span class="coin btc">₿</span>` : html`<span class="coin usdt">₮</span>`;
    if (p.provider === 'gatevoo') return html`<span class="coin gv">G</span>`;
    if (p.provider === 'paystack') return html`<span class="coin ps">P</span>`;
    if (p.provider === 'flutterwave') return html`<span class="coin fw">F</span>`;
    if (p.provider === 'manual') return html`<span class="coin" style="background:${/^#[0-9a-fA-F]{6}$/.test(p.method_color || '') ? p.method_color : '#64748B'}">${p.method_icon || '$'}</span>`;
    return html`<span class="coin" style="background:#64748B">$</span>`;
  };

  /** Approve a payment made with one of the team's own methods (bank transfer, mobile money...). */
  function approveOwn(p) {
    const local = p.currency && p.currency !== 'USD';
    const due = local ? `${Number(p.amount_local).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${p.currency}` : `${Number(p.amount).toFixed(2)} USD`;
    return dialog({
      title: `Approve ${usd(p.amount, { cents: true })} by ${p.method_label || 'manual payment'}?`, icon: 'check', okText: 'Approve and credit wallet',
      body: html`<div class="note warn">${icon('warn')}<span>Check your ${p.method_label || 'account'} first: the money arrived and it is <b>exactly ${due}</b>. The cents are unique to this customer. If a different amount arrived, enter what it is worth in US dollars below, or ask the customer in Support first.</span></div>
        ${p.proof_ref ? html`<div class="row" style="gap:6px"><span class="small mut">Reference</span>${CV.copyField(p.proof_ref, 'Copy reference')}</div>` : ''}`,
      fields: [{ name: 'amount', label: 'Amount to credit (US dollars)', type: 'number', step: '0.01', prefix: '$', placeholder: String(p.amount), hint: `Leave empty to credit ${usd(p.amount, { cents: true })} (the normal case). Top-up bonuses are added by the usual rules.` }],
      onSubmit: async (v) => { await post(`/api/admin/payments/${encodeURIComponent(p.reference)}/approve`, v.amount ? { amount: Number(v.amount) } : {}); toast('Approved. The wallet is credited and the customer is emailed.'); CV.reload(); CV.refreshCounts(); },
    });
  }

  /* =================== PAYMENTS =================== */
  CV.page('payments', {
    intro: 'Every top-up. Manual payments (crypto sent by hand, and your own methods like bank transfer) must be checked before you approve them: the wallet is credited the moment you press Approve.',
    async render({ query }) {
      const f = { status: query.get('status') || '', provider: query.get('provider') || '', check: query.get('check') || '', q: query.get('q') || '' };
      const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
      const res = await get('/api/admin/payments?' + params);
      const canReview = can('payments.review');
      const setF = (patch) => { const n = { ...f, ...patch }; const p = new URLSearchParams(Object.entries(n).filter(([, v]) => v)); CV.go('payments' + (String(p) ? '?' + p : '')); };
      const chip = (label, patch, onNow) => html`<button class="chip${onNow ? ' on' : ''}" data-f='${JSON.stringify(patch)}'>${label}</button>`;

      const row = (p) => {
        const isManual = p.provider === 'manual_crypto';
        const isOwn = p.provider === 'manual';
        const waiting = p.status === 'pending' && ((isManual && p.txid) || (isOwn && p.submitted_at));
        const local = p.currency && p.currency !== 'USD' && p.amount_local ? `${Number(p.amount_local).toLocaleString('en-US')} ${p.currency}` : '';
        return html`<div class="pay">
          <div style="min-width:0">
            <div class="top1">${coinIcon(p)}<span class="amt">${usd(p.amount, { cents: true })}</span>${Number(p.bonus) ? html`<span class="bd vio">+${usd(p.bonus)} bonus</span>` : ''}${CV.payBadge(p.status)}${waiting ? html`<span class="bd warn">${icon('warn')} Check this</span>` : ''}</div>
            <div class="det">
              <span><b>${CV.providerName(p.provider, p.coin, p.method_label)}</b>${local ? ' · ' + local : ''}</span>
              <span>${can('users.view') ? html`<a href="#users/${p.user_id}">${p.user_name || p.user_email}</a>` : p.user_name || p.user_email}${p.user_email && p.user_name ? html` · ${p.user_email}` : ''}</span>
              <span>${dt(p.created_at)}</span>
              <span class="mono">${p.reference}</span>
            </div>
            ${p.txid ? html`<div class="row" style="margin-top:8px;gap:6px"><span class="small mut">TXID</span>${CV.copyField(p.txid, 'Copy TXID')}${isManual ? html`<a class="btn sec xs" href="${CV.txUrl(p.coin, p.txid)}" target="_blank" rel="noopener noreferrer">${icon('ext')} Check on ${CV.explorerName(p.coin)}</a>` : ''}</div>` : isManual && p.status === 'pending' ? html`<div class="small mut" style="margin-top:6px">Waiting for the customer to paste the transaction ID.</div>` : ''}
            ${isOwn ? html`<div class="row" style="margin-top:8px;gap:6px">${p.proof_ref ? html`<span class="small mut">Reference</span>${CV.copyField(p.proof_ref, 'Copy reference')}` : ''}${p.has_screenshot ? html`<button type="button" class="btn sec xs" data-shot="${p.reference}">${icon('eye')} See screenshot</button>` : ''}${p.status === 'pending' && !p.submitted_at ? html`<span class="small mut">Waiting for the customer to say they paid.</span>` : p.submitted_at && !p.proof_ref && !p.has_screenshot ? html`<span class="small mut">No proof sent (not asked for this method).</span>` : ''}</div>` : ''}
            ${p.reason ? html`<div class="small" style="margin-top:6px;color:var(--bad)">${p.reason}</div>` : ''}
            ${p.reviewed_by_name ? html`<div class="small mut" style="margin-top:4px">Checked by ${p.reviewed_by_name}${p.paid_at ? ' · paid ' + dt(p.paid_at) : ''}</div>` : p.paid_at ? html`<div class="small mut" style="margin-top:4px">Paid ${dt(p.paid_at)}</div>` : ''}
          </div>
          <div class="acts">
            ${canReview && p.status === 'pending' && (isManual || isOwn) ? html`<button class="btn ok sm" data-approve="${p.reference}">${icon('check')} Approve</button><button class="btn danger sec sm" data-reject="${p.reference}">${icon('x')} Reject</button>` : ''}
            ${canReview && p.status === 'pending' && !isManual && !isOwn ? html`<button class="btn sec sm" data-recheck="${p.reference}">${icon('refresh')} Recheck</button>` : ''}
            ${canReview && p.status === 'paid' && !p.disputed_at && p.provider !== 'paystack' ? html`<button class="btn danger sec sm" data-chargeback="${p.reference}">${icon('warn')} Chargeback</button>` : ''}
            ${p.disputed_at ? html`<span class="bd bad">${icon('warn')} Charged back ${dt(p.disputed_at)}${Number(p.chargeback_cents) ? ' · ' + usd(Number(p.chargeback_cents) / 100, { cents: true }) + ' taken back' : ''}</span>` : ''}
            ${p.dispute_won_at ? html`<span class="bd ok">${icon('check')} Dispute won ${dt(p.dispute_won_at)}</span>` : canReview && p.disputed_at ? html`<button class="btn ok sec sm" data-won="${p.reference}">${icon('check')} Dispute won</button>` : ''}
          </div>
        </div>`;
      };

      const page = html`
        <div class="totals">
          <div class="kpi"><div class="kh"><small>Paid in the last 30 days</small><span class="ki" style="--c:#0E9F6E">${icon('wallet')}</span></div><b>${usd(res.totals.paid_30d)}</b></div>
          <a class="kpi" href="#payments?check=1"><div class="kh"><small>Payments to check</small><span class="ki" style="--c:${res.totals.to_check ? '#F59E0B' : '#94A3B8'}">${icon('warn')}</span></div><b>${num(res.totals.to_check)}</b><span class="sub">${res.totals.to_check ? 'Customers are waiting' : 'Nothing waiting'}</span></a>
          <div class="kpi"><div class="kh"><small>Shown below</small><span class="ki" style="--c:#2F6BFF">${icon('list')}</span></div><b>${num(res.payments.length)}</b><span class="sub">Newest first, up to 200</span></div>
        </div>
        <div class="card">
          <form class="row" id="pf">
            <div class="tsearch" style="width:auto;flex:1;min-width:200px;display:flex">${icon('search')}<input name="q" type="search" value="${f.q}" placeholder="Reference, TXID or email" aria-label="Search payments"></div>
            <select class="in" name="provider" style="width:auto" aria-label="Provider"><option value="">Any provider</option>${[['manual', 'Your own methods'], ['manual_crypto', 'Crypto (manual)'], ['gatevoo', 'Gatevoo'], ['paystack', 'Paystack'], ['flutterwave', 'Flutterwave']].map(([k, l]) => html`<option value="${k}" ${f.provider === k ? raw('selected') : ''}>${l}</option>`)}</select>
            <button class="btn sec">Search</button>
          </form>
          <div class="chips">
            ${chip('To check', { check: '1', status: '' }, f.check === '1')}
            ${chip('All', { check: '', status: '' }, !f.check && !f.status)}
            ${chip('Paid', { check: '', status: 'paid' }, f.status === 'paid')}
            ${chip('Waiting', { check: '', status: 'pending' }, f.status === 'pending' && !f.check)}
            ${chip('Failed', { check: '', status: 'failed' }, f.status === 'failed')}
            ${chip('Rejected', { check: '', status: 'rejected' }, f.status === 'rejected')}
          </div>
        </div>
        <div class="card flat">${res.payments.length ? res.payments.map(row) : CV.empty(f.check ? 'check' : 'card', f.check ? 'Nothing to check' : 'No payments here', f.check ? 'When a customer pastes a transaction ID or says they paid with one of your methods, it shows up here for you to check.' : 'Try another filter.')}</div>`;

      return {
        html: page,
        mount(el) {
          const form = $('#pf', el);
          form.addEventListener('submit', (e) => { e.preventDefault(); setF({ q: form.q.value.trim(), provider: form.provider.value }); });
          form.provider.addEventListener('change', () => form.requestSubmit());
          on(el, 'click', '[data-f]', (e, t) => setF(JSON.parse(t.dataset.f)));
          on(el, 'click', '[data-shot]', (e, b) => {
            const p = res.payments.find((x) => x.reference === b.dataset.shot);
            dialog({ title: `Screenshot from ${p.user_name || p.user_email}`, icon: 'eye', wide: true, cancelText: false, okText: 'Close',
              body: html`<img class="proof-img" src="/api/admin/payments/${encodeURIComponent(p.reference)}/screenshot" alt="Payment screenshot sent by the customer"><a class="btn sec sm" style="align-self:center" href="/api/admin/payments/${encodeURIComponent(p.reference)}/screenshot" target="_blank" rel="noopener noreferrer">${icon('ext')} Open full size</a>` });
          });
          on(el, 'click', '[data-approve]', (e, b) => {
            const p = res.payments.find((x) => x.reference === b.dataset.approve);
            if (p.provider === 'manual') return approveOwn(p);
            dialog({
              title: `Approve ${usd(p.amount, { cents: true })} in ${p.coin || 'crypto'}?`, icon: 'check', okText: 'Approve and credit wallet',
              body: html`<div class="note warn">${icon('warn')}<span>Open the transaction on ${CV.explorerName(p.coin)} first. Check it went to our address, it is confirmed, and the amount is <b>exactly ${Number(p.amount).toFixed(2)} ${p.coin || ''}</b>. The cents are unique to this customer. If a different amount arrived, don't approve: it may be someone else's payment, so ask the customer in Support first.</span></div>
                ${p.txid ? html`<a class="btn sec sm" href="${CV.txUrl(p.coin, p.txid)}" target="_blank" rel="noopener noreferrer" style="align-self:flex-start">${icon('ext')} Open on ${CV.explorerName(p.coin)}</a>` : html`<div class="note bad">${icon('warn')}<span>The customer has not pasted a transaction ID yet.</span></div>`}`,
              fields: [{ name: 'amount', label: 'Amount that really arrived (US dollars)', type: 'number', step: '0.01', prefix: '$', placeholder: String(p.amount), hint: `Leave empty when exactly ${usd(p.amount, { cents: true })} arrived (the normal case).` }],
              onSubmit: async (v) => { await post(`/api/admin/payments/${encodeURIComponent(p.reference)}/approve`, v.amount ? { amount: Number(v.amount) } : {}); toast('Approved. The wallet is credited and the customer is emailed.'); CV.reload(); CV.refreshCounts(); },
            });
          });
          on(el, 'click', '[data-reject]', (e, b) => {
            const p = res.payments.find((x) => x.reference === b.dataset.reject);
            dialog({
              title: 'Reject this payment?', text: 'The customer gets an email with your reason. Their wallet is not changed.', danger: true, okText: 'Reject payment',
              fields: [{ name: 'reason', label: 'Reason the customer will read', type: 'textarea', rows: 3, required: true, value: p.provider === 'manual' ? 'We could not find this payment in our account, or the amount was different.' : p.txid ? 'We could not find this transaction on the network, or it was sent to a different address.' : '' }],
              onSubmit: async (v) => { await post(`/api/admin/payments/${encodeURIComponent(p.reference)}/reject`, { reason: v.reason }); toast('Payment rejected.'); CV.reload(); CV.refreshCounts(); },
            });
          });
          on(el, 'click', '[data-chargeback]', (e, b) => {
            const p = res.payments.find((x) => x.reference === b.dataset.chargeback);
            dialog({
              title: `Record a chargeback on ${usd(p.amount, { cents: true })}?`, icon: 'warn', danger: true, okText: 'Record chargeback',
              text: 'Use this when the bank or processor took this top-up back. The disputed amount, and what is left of its bonus, is taken out of the wallet now, even if the balance goes below zero. Below zero, a paid plan moves to Free until a top-up covers it. Unsettled referral earnings from this payment are cancelled and the VooSquare commission is reversed. Once per payment. If the bank later decides for us, press Dispute won.',
              fields: [{ name: 'reason', label: 'Reason (for the audit log)', type: 'textarea', rows: 2, required: true, value: 'Card dispute' }],
              onSubmit: async (v) => { const r = await post(`/api/admin/payments/${encodeURIComponent(p.reference)}/chargeback`, { reason: v.reason }); toast(`Chargeback recorded. ${usd(r.debited, { cents: true })} taken from the wallet (now ${usd(r.wallet, { cents: true })})${r.dropped_to_free ? ', plan moved to Free' : ''}. ${r.voosquare_events ? r.voosquare_events + ' commission reversal(s) sent to VooSquare.' : ''}`); CV.reload(); },
            });
          });
          on(el, 'click', '[data-won]', (e, b) => {
            const p = res.payments.find((x) => x.reference === b.dataset.won);
            dialog({
              title: 'Mark this dispute as won?', icon: 'check', okText: 'Put the money back',
              text: `Only when the bank or processor decided the dispute for Castvoo and the money came back to us. ${Number(p.chargeback_cents) ? usd(Number(p.chargeback_cents) / 100, { cents: true }) : 'The amount taken'} goes back to the customer's wallet. This can be done once.`,
              onSubmit: async () => { const r = await post(`/api/admin/payments/${encodeURIComponent(p.reference)}/dispute-won`); toast(`Dispute won. ${usd(r.credited, { cents: true })} is back in the wallet.`); CV.reload(); },
            });
          });
          on(el, 'click', '[data-recheck]', async (e, b) => {
            const r = await act(b, () => post(`/api/admin/payments/${encodeURIComponent(b.dataset.recheck)}/recheck`));
            if (r) { toast(r.status === 'paid' ? 'It went through. The wallet is credited.' : `Still ${r.status || 'not paid'}${r.reason ? ': ' + r.reason : ''}.`, r.status === 'paid' ? 'ok' : 'info'); CV.reload(); }
          });
        },
      };
    },
  });

  /* =================== HELD REFERRAL EARNINGS (SEC-2) =================== */
  /** Earnings that look like a self-referral wait here. Release = a real referral (it counts again); Cancel = it never pays. */
  async function heldEarnings(tabs, canReview) {
    const res = await get('/api/admin/referrals/held');
    const total = res.held.reduce((s, x) => s + x.amount, 0);
    const mine = (x) => String(x.user_id) === String(CV.me.user.id);
    const row = (x) => html`<div class="pay">
      <div style="min-width:0">
        <div class="top1"><span class="amt">${usd(x.amount, { cents: true })}</span><span class="bd">${x.rate}%</span><span class="bd warn">${icon('warn')} Held</span></div>
        <div class="det">
          <span>Referrer: ${can('users.view') ? html`<a href="#users/${x.user_id}">${x.referrer_name || x.referrer_email}</a>` : x.referrer_name || x.referrer_email}${x.referrer_email && x.referrer_name ? html` · ${x.referrer_email}` : ''}</span>
          <span>From: ${x.workspace_name || 'workspace #' + x.from_workspace_id}${x.referred_email ? html` · ${x.referred_email}` : ''}</span>
          <span>Earned ${dt(x.created_at)}</span>
        </div>
        <div class="small" style="margin-top:6px;color:var(--bad)">${icon('warn')} Why it is held: ${x.hold_reason || 'possible self-referral'}</div>
      </div>
      <div class="acts">${canReview && !mine(x) ? html`<button class="btn ok sm" data-release="${x.id}">${icon('check')} Release</button><button class="btn danger sec sm" data-cancel-e="${x.id}">${icon('x')} Cancel</button>` : mine(x) ? html`<span class="bd">${icon('lock')} Yours: another teammate decides</span>` : ''}</div>
    </div>`;
    const page = html`
      <div class="card"><div class="row between">${tabs}<div class="chart-total"><b>${usd(total)}</b><span>${CV.plural(res.held.length, 'held earning')}</span></div></div></div>
      <div class="note">${icon('info')}<span>These referral earnings look like a self-referral: the referred account shares a Telegram account, email mailbox, VooSquare account, sign-up IP or payment card with the referrer. They do not count toward anyone's balance until you decide. <b>Release</b> if it is a real, different customer. <b>Cancel</b> if it is the same person: it never pays.</span></div>
      <div class="card flat">${res.held.length ? res.held.map(row) : CV.empty('check', 'Nothing held', 'When a referral earning looks like a self-referral, it waits here for review.')}</div>`;
    return {
      html: page,
      mount(el) {
        const decide = (id, action) => {
          const x = res.held.find((h) => String(h.id) === String(id));
          dialog({
            title: action === 'release' ? `Release ${usd(x.amount, { cents: true })}?` : `Cancel ${usd(x.amount, { cents: true })}?`,
            icon: action === 'release' ? 'check' : 'x', danger: action === 'cancel', okText: action === 'release' ? 'Release earning' : 'Cancel earning',
            text: action === 'release' ? `It counts toward ${x.referrer_name || x.referrer_email}'s balance again and settles on the normal date. Held because: ${x.hold_reason || 'possible self-referral'}.` : 'It never pays. Use this for self-referrals and duplicate accounts. This is logged.',
            onSubmit: async () => { await post(`/api/admin/referrals/held/${encodeURIComponent(x.id)}`, { action }); toast(action === 'release' ? 'Released.' : 'Cancelled.'); CV.reload(); },
          });
        };
        on(el, 'click', '[data-release]', (e, b) => decide(b.dataset.release, 'release'));
        on(el, 'click', '[data-cancel-e]', (e, b) => decide(b.dataset.cancelE, 'cancel'));
      },
    };
  }

  /* =================== WITHDRAWALS =================== */
  CV.page('withdrawals', {
    intro: 'Referral payouts. Send the crypto from our wallet first, then press "Mark paid" and paste the transaction ID. The customer is emailed.',
    async render({ query }) {
      const status = ['requested', 'paid', 'rejected', 'held'].includes(query.get('status')) ? query.get('status') : 'requested';
      const canReview = can('withdrawals.review');
      const tabs = html`<div class="tabs" style="border:0">${[['requested', 'Waiting'], ['paid', 'Paid'], ['rejected', 'Rejected'], ['held', 'Held earnings']].map(([k, l]) => html`<a class="tab${status === k ? ' on' : ''}" href="#withdrawals?status=${k}">${l}</a>`)}</div>`;
      if (status === 'held') return heldEarnings(tabs, canReview);
      const res = await get('/api/admin/withdrawals?status=' + status);
      const total = res.withdrawals.reduce((s, w) => s + w.amount, 0);
      const row = (w) => html`<div class="pay">
        <div style="min-width:0">
          <div class="top1">${w.coin === 'BTC' ? html`<span class="coin btc">₿</span>` : html`<span class="coin usdt">₮</span>`}<span class="amt">${usd(w.amount, { cents: true })}</span><span class="bd">${w.coin === 'BTC' ? 'Bitcoin' : 'USDT · TRC20'}</span>${CV.payBadge(w.status)}</div>
          <div class="det"><span>${can('users.view') ? html`<a href="#users/${w.user_id}">${w.user_name || w.user_email}</a>` : w.user_name || w.user_email} · ${w.user_email}</span><span>${CV.plural(w.referrals, 'referral')}</span><span>Asked ${ago(w.created_at)}</span></div>
          <div class="row" style="margin-top:8px;gap:6px"><span class="small mut">Send to</span>${CV.copyField(w.address, 'Copy address')}<a class="btn sec xs" href="${CV.addrUrl(w.coin, w.address)}" target="_blank" rel="noopener noreferrer">${icon('ext')} ${CV.explorerName(w.coin)}</a></div>
          ${w.txid ? html`<div class="row" style="margin-top:6px;gap:6px"><span class="small mut">Paid with</span><a class="mono small break" href="${CV.txUrl(w.coin, w.txid)}" target="_blank" rel="noopener noreferrer">${w.txid}</a></div>` : ''}
          ${w.held_earnings ? html`<div class="note warn" style="margin-top:8px">${icon('warn')}<span>${CV.plural(w.held_earnings, 'earning')} held for review (${w.self_referral_signals || 'possible self-referral'}). Held earnings are not in this payout. <a href="#withdrawals?status=held">Review them</a>.</span></div>` : w.self_referral_signals ? html`<div class="small" style="margin-top:6px;color:var(--warn)">${icon('warn')} Earlier self-referral signals: ${w.self_referral_signals}</div>` : ''}
          ${w.reason ? html`<div class="small" style="margin-top:6px;color:var(--bad)">${w.reason}</div>` : ''}
          ${w.processed_at ? html`<div class="small mut" style="margin-top:4px">Done ${dt(w.processed_at)}</div>` : ''}
        </div>
        <div class="acts">${canReview && w.status === 'requested' ? html`<button class="btn ok sm" data-paid="${w.id}">${icon('check')} Mark paid</button><button class="btn danger sec sm" data-reject="${w.id}">${icon('x')} Reject</button>` : ''}</div>
      </div>`;
      const page = html`
        <div class="card"><div class="row between">
          ${tabs}
          <div class="chart-total"><b>${usd(total)}</b><span>${CV.plural(res.withdrawals.length, 'request')}</span></div></div></div>
        <div class="card flat">${res.withdrawals.length ? res.withdrawals.map(row) : CV.empty('out', status === 'requested' ? 'No payouts waiting' : 'Nothing here yet', status === 'requested' ? 'When someone asks to withdraw referral earnings, it shows up here.' : '')}</div>`;
      return {
        html: page,
        mount(el) {
          on(el, 'click', '[data-paid]', (e, b) => {
            const w = res.withdrawals.find((x) => String(x.id) === b.dataset.paid);
            dialog({
              title: `Mark ${usd(w.amount, { cents: true })} as paid`, icon: 'check', okText: 'Mark paid',
              body: html`<div class="note">${icon('info')}<span>Send exactly ${usd(w.amount, { cents: true })} in ${w.coin} to this address first:</span></div>${CV.copyField(w.address, 'Copy address')}`,
              fields: [{ name: 'txid', label: 'Transaction ID (TXID) of the payout', required: true, placeholder: 'Paste it from your wallet' }],
              onSubmit: async (v) => { await post(`/api/admin/withdrawals/${w.id}/paid`, { txid: v.txid.trim() }); toast('Marked paid. The customer is emailed.'); CV.reload(); CV.refreshCounts(); },
            });
          });
          on(el, 'click', '[data-reject]', (e, b) => {
            const w = res.withdrawals.find((x) => String(x.id) === b.dataset.reject);
            dialog({
              title: 'Reject this payout?', text: 'The money goes back to their referral balance, unless you also cancel the earnings.', danger: true, okText: 'Reject payout',
              fields: [
                { name: 'reason', label: 'Reason the customer will read', type: 'textarea', rows: 3, required: true },
                { name: 'cancel_earnings', label: 'Also cancel these earnings (only for fake accounts or broken rules)', type: 'checkbox' },
              ],
              onSubmit: async (v) => { await post(`/api/admin/withdrawals/${w.id}/reject`, { reason: v.reason, cancel_earnings: v.cancel_earnings }); toast('Payout rejected.'); CV.reload(); CV.refreshCounts(); },
            });
          });
        },
      };
    },
  });
})();
