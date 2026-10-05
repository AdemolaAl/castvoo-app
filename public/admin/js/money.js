'use strict';
/* Castvoo Admin — Payments and Withdrawals. */
(() => {
  const { html, raw, icon, $, on, num, usd, dt, ago, get, post, act, dialog, can, toast } = CV;

  const coinIcon = (p) => {
    if (p.provider === 'manual_crypto') return String(p.coin).toUpperCase() === 'BTC' ? html`<span class="coin btc">₿</span>` : html`<span class="coin usdt">₮</span>`;
    if (p.provider === 'gatevoo') return html`<span class="coin gv">G</span>`;
    if (p.provider === 'paystack') return html`<span class="coin ps">P</span>`;
    if (p.provider === 'flutterwave') return html`<span class="coin fw">F</span>`;
    return html`<span class="coin" style="background:#64748B">$</span>`;
  };

  /* =================== PAYMENTS =================== */
  CV.page('payments', {
    intro: 'Every top-up. Crypto sent by hand must be checked on the blockchain before you approve it: the wallet is credited the moment you press Approve.',
    async render({ query }) {
      const f = { status: query.get('status') || '', provider: query.get('provider') || '', check: query.get('check') || '', q: query.get('q') || '' };
      const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
      const res = await get('/api/admin/payments?' + params);
      const canReview = can('payments.review');
      const setF = (patch) => { const n = { ...f, ...patch }; const p = new URLSearchParams(Object.entries(n).filter(([, v]) => v)); CV.go('payments' + (String(p) ? '?' + p : '')); };
      const chip = (label, patch, onNow) => html`<button class="chip${onNow ? ' on' : ''}" data-f='${JSON.stringify(patch)}'>${label}</button>`;

      const row = (p) => {
        const isManual = p.provider === 'manual_crypto';
        const local = p.currency && p.currency !== 'USD' && p.amount_local ? `${Number(p.amount_local).toLocaleString('en-US')} ${p.currency}` : '';
        return html`<div class="pay">
          <div style="min-width:0">
            <div class="top1">${coinIcon(p)}<span class="amt">${usd(p.amount, { cents: true })}</span>${Number(p.bonus) ? html`<span class="bd vio">+${usd(p.bonus)} bonus</span>` : ''}${CV.payBadge(p.status)}${isManual && p.status === 'pending' && p.txid ? html`<span class="bd warn">${icon('warn')} Check this</span>` : ''}</div>
            <div class="det">
              <span><b>${CV.providerName(p.provider, p.coin)}</b>${local ? ' · ' + local : ''}</span>
              <span>${can('users.view') ? html`<a href="#users/${p.user_id}">${p.user_name || p.user_email}</a>` : p.user_name || p.user_email}${p.user_email && p.user_name ? html` · ${p.user_email}` : ''}</span>
              <span>${dt(p.created_at)}</span>
              <span class="mono">${p.reference}</span>
            </div>
            ${p.txid ? html`<div class="row" style="margin-top:8px;gap:6px"><span class="small mut">TXID</span>${CV.copyField(p.txid, 'Copy TXID')}${isManual ? html`<a class="btn sec xs" href="${CV.txUrl(p.coin, p.txid)}" target="_blank" rel="noopener noreferrer">${icon('ext')} Check on ${CV.explorerName(p.coin)}</a>` : ''}</div>` : isManual && p.status === 'pending' ? html`<div class="small mut" style="margin-top:6px">Waiting for the customer to paste the transaction ID.</div>` : ''}
            ${p.reason ? html`<div class="small" style="margin-top:6px;color:var(--bad)">${p.reason}</div>` : ''}
            ${p.reviewed_by_name ? html`<div class="small mut" style="margin-top:4px">Checked by ${p.reviewed_by_name}${p.paid_at ? ' · paid ' + dt(p.paid_at) : ''}</div>` : p.paid_at ? html`<div class="small mut" style="margin-top:4px">Paid ${dt(p.paid_at)}</div>` : ''}
          </div>
          <div class="acts">
            ${canReview && p.status === 'pending' && isManual ? html`<button class="btn ok sm" data-approve="${p.reference}">${icon('check')} Approve</button><button class="btn danger sec sm" data-reject="${p.reference}">${icon('x')} Reject</button>` : ''}
            ${canReview && p.status === 'pending' && !isManual ? html`<button class="btn sec sm" data-recheck="${p.reference}">${icon('refresh')} Recheck</button>` : ''}
            ${canReview && p.status === 'paid' && !p.disputed_at && p.provider !== 'paystack' ? html`<button class="btn danger sec sm" data-chargeback="${p.reference}">${icon('warn')} Chargeback</button>` : ''}
            ${p.disputed_at ? html`<span class="bd bad">${icon('warn')} Charged back ${dt(p.disputed_at)}</span>` : ''}
          </div>
        </div>`;
      };

      const page = html`
        <div class="totals">
          <div class="kpi"><div class="kh"><small>Paid in the last 30 days</small><span class="ki" style="--c:#0E9F6E">${icon('wallet')}</span></div><b>${usd(res.totals.paid_30d)}</b></div>
          <a class="kpi" href="#payments?check=1"><div class="kh"><small>Crypto to check</small><span class="ki" style="--c:${res.totals.to_check ? '#F59E0B' : '#94A3B8'}">${icon('warn')}</span></div><b>${num(res.totals.to_check)}</b><span class="sub">${res.totals.to_check ? 'Customers are waiting' : 'Nothing waiting'}</span></a>
          <div class="kpi"><div class="kh"><small>Shown below</small><span class="ki" style="--c:#2F6BFF">${icon('list')}</span></div><b>${num(res.payments.length)}</b><span class="sub">Newest first, up to 200</span></div>
        </div>
        <div class="card">
          <form class="row" id="pf">
            <div class="tsearch" style="width:auto;flex:1;min-width:200px;display:flex">${icon('search')}<input name="q" type="search" value="${f.q}" placeholder="Reference, TXID or email" aria-label="Search payments"></div>
            <select class="in" name="provider" style="width:auto" aria-label="Provider"><option value="">Any provider</option>${[['manual_crypto', 'Crypto (manual)'], ['gatevoo', 'Gatevoo'], ['paystack', 'Paystack'], ['flutterwave', 'Flutterwave']].map(([k, l]) => html`<option value="${k}" ${f.provider === k ? raw('selected') : ''}>${l}</option>`)}</select>
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
        <div class="card flat">${res.payments.length ? res.payments.map(row) : CV.empty(f.check ? 'check' : 'card', f.check ? 'No crypto to check' : 'No payments here', f.check ? 'When a customer pastes a transaction ID, it shows up here for you to check.' : 'Try another filter.')}</div>`;

      return {
        html: page,
        mount(el) {
          const form = $('#pf', el);
          form.addEventListener('submit', (e) => { e.preventDefault(); setF({ q: form.q.value.trim(), provider: form.provider.value }); });
          form.provider.addEventListener('change', () => form.requestSubmit());
          on(el, 'click', '[data-f]', (e, t) => setF(JSON.parse(t.dataset.f)));
          on(el, 'click', '[data-approve]', (e, b) => {
            const p = res.payments.find((x) => x.reference === b.dataset.approve);
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
              fields: [{ name: 'reason', label: 'Reason the customer will read', type: 'textarea', rows: 3, required: true, value: p.txid ? 'We could not find this transaction on the network, or it was sent to a different address.' : '' }],
              onSubmit: async (v) => { await post(`/api/admin/payments/${encodeURIComponent(p.reference)}/reject`, { reason: v.reason }); toast('Payment rejected.'); CV.reload(); CV.refreshCounts(); },
            });
          });
          on(el, 'click', '[data-chargeback]', (e, b) => {
            const p = res.payments.find((x) => x.reference === b.dataset.chargeback);
            dialog({
              title: `Record a chargeback on ${usd(p.amount, { cents: true })}?`, icon: 'warn', danger: true, okText: 'Record chargeback',
              text: 'Use this when the bank or crypto processor took this top-up back. Unsettled referral earnings from this customer are cancelled, and the affiliate commission paid on plans bought with this money is reversed in VooSquare. The wallet is not changed: adjust it in Users if needed. This can be done once per payment.',
              fields: [{ name: 'reason', label: 'Reason (for the audit log)', type: 'textarea', rows: 2, required: true, value: 'Card dispute' }],
              onSubmit: async (v) => { const r = await post(`/api/admin/payments/${encodeURIComponent(p.reference)}/chargeback`, { reason: v.reason }); toast(`Chargeback recorded. ${r.voosquare_events ? r.voosquare_events + ' commission reversal(s) sent to VooSquare.' : 'No plan payment used this money.'}`); CV.reload(); },
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

  /* =================== WITHDRAWALS =================== */
  CV.page('withdrawals', {
    intro: 'Referral payouts. Send the crypto from our wallet first, then press "Mark paid" and paste the transaction ID. The customer is emailed.',
    async render({ query }) {
      const status = ['requested', 'paid', 'rejected'].includes(query.get('status')) ? query.get('status') : 'requested';
      const res = await get('/api/admin/withdrawals?status=' + status);
      const canReview = can('withdrawals.review');
      const total = res.withdrawals.reduce((s, w) => s + w.amount, 0);
      const row = (w) => html`<div class="pay">
        <div style="min-width:0">
          <div class="top1">${w.coin === 'BTC' ? html`<span class="coin btc">₿</span>` : html`<span class="coin usdt">₮</span>`}<span class="amt">${usd(w.amount, { cents: true })}</span><span class="bd">${w.coin === 'BTC' ? 'Bitcoin' : 'USDT · TRC20'}</span>${CV.payBadge(w.status)}</div>
          <div class="det"><span>${can('users.view') ? html`<a href="#users/${w.user_id}">${w.user_name || w.user_email}</a>` : w.user_name || w.user_email} · ${w.user_email}</span><span>${CV.plural(w.referrals, 'referral')}</span><span>Asked ${ago(w.created_at)}</span></div>
          <div class="row" style="margin-top:8px;gap:6px"><span class="small mut">Send to</span>${CV.copyField(w.address, 'Copy address')}<a class="btn sec xs" href="${CV.addrUrl(w.coin, w.address)}" target="_blank" rel="noopener noreferrer">${icon('ext')} ${CV.explorerName(w.coin)}</a></div>
          ${w.txid ? html`<div class="row" style="margin-top:6px;gap:6px"><span class="small mut">Paid with</span><a class="mono small break" href="${CV.txUrl(w.coin, w.txid)}" target="_blank" rel="noopener noreferrer">${w.txid}</a></div>` : ''}
          ${w.reason ? html`<div class="small" style="margin-top:6px;color:var(--bad)">${w.reason}</div>` : ''}
          ${w.processed_at ? html`<div class="small mut" style="margin-top:4px">Done ${dt(w.processed_at)}</div>` : ''}
        </div>
        <div class="acts">${canReview && w.status === 'requested' ? html`<button class="btn ok sm" data-paid="${w.id}">${icon('check')} Mark paid</button><button class="btn danger sec sm" data-reject="${w.id}">${icon('x')} Reject</button>` : ''}</div>
      </div>`;
      const page = html`
        <div class="card"><div class="row between">
          <div class="tabs" style="border:0">${[['requested', 'Waiting'], ['paid', 'Paid'], ['rejected', 'Rejected']].map(([k, l]) => html`<a class="tab${status === k ? ' on' : ''}" href="#withdrawals?status=${k}">${l}</a>`)}</div>
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
