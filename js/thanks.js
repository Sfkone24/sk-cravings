import { formatMoney } from './shared.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const drop = (key) => { try { localStorage.removeItem(key); } catch { /* ignore */ } };

const PENDING_KEY = 'skc.pending.v1';
const CART_KEY = 'skc.cart.v1';
const IG = 'https://ig.me/m/sk.cravings';

const card = document.querySelector('[data-card]');
const params = new URLSearchParams(location.search);
const pending = read(PENDING_KEY);
// Only trust the saved order if it is the one this page was opened for.
const ref = params.get('ref');
const mine = pending && (!ref || pending.reference === ref) ? pending : null;
const logo = '<img src="media/brand/logo.png" alt="SK Cravings" width="526" height="472">';

run();

async function run() {
  if (params.get('demo') === '1' || mine?.demo) {
    drop(CART_KEY);
    show({
      kicker: 'Preview mode', title: ['Order', 'placed'],
      body: 'This was a test run of checkout. Square isn\'t connected yet, so no payment was taken and nothing was sent to SK.',
      summary: mine?.summary, reference: mine?.reference || ref,
    });
    return;
  }

  // Square may add the order id to the address when it sends the customer back; otherwise use the one we saved.
  const orderId = params.get('orderId') || mine?.orderId;
  if (!orderId) {
    show({
      kicker: 'Thank you', title: ['Thanks for', 'ordering'],
      body: 'If you finished paying on Square, SK has your order and your receipt is on its way. Questions? Send a DM.',
      reference: ref, actions: dmAction(),
    });
    return;
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(`api/order-status?orderId=${encodeURIComponent(orderId)}`, { cache: 'no-store' });
      const out = await res.json();
      if (out.paid) {
        drop(CART_KEY);
        drop(PENDING_KEY);
        const type = mine?.summary?.type;
        show({
          kicker: 'Payment received', title: [mine?.name ? `Thanks, ${mine.name.split(' ')[0]}` : 'Thank you', 'it\'s cooking'],
          body: type === 'delivery'
            ? 'SK has your order and will text you when it\'s on the way.'
            : 'SK has your order and will text you the pickup spot and when it\'s ready.',
          summary: mine?.summary || fromSquare(out), reference: out.reference || mine?.reference || ref, actions: dmAction('Message SK'),
        });
        return;
      }
      if (out.state === 'CANCELED') break;
    } catch { /* network blip: try again */ }
    await new Promise((r) => setTimeout(r, 1800));
  }

  show({
    kicker: 'Not paid yet', title: ['Almost', 'there'],
    body: 'We haven\'t seen a payment for this order yet. If you just paid, give it a minute and refresh. Otherwise you can finish paying below.',
    summary: mine?.summary, reference: mine?.reference || ref,
    actions: `${mine?.url ? `<a class="btn btn-gold" href="${esc(mine.url)}">Finish paying</a>` : ''}<a class="btn btn-ghost" href="./#order">Back to my order</a>`,
  });
}

function dmAction(label = 'DM @sk.cravings') {
  return `<a class="btn btn-green" href="${IG}" target="_blank" rel="noopener">${label}</a><a class="btn btn-ghost" href="./">Back to the menu</a>`;
}

function fromSquare(out) {
  if (!Array.isArray(out.items) || out.totalCents == null) return null;
  return { lines: out.items.map((l) => ({ name: l.name, qty: Number(l.quantity) || 1 })), totalCents: out.totalCents };
}

function show({ kicker, title, body, summary, reference, actions }) {
  const rows = summary?.lines?.map((l) => `
    <div class="receipt-row">
      <span>${esc(l.qty)} × ${esc(l.name)}${l.label ? `<small>${esc(l.label)}</small>` : ''}</span>
      ${l.totalCents != null ? `<span>${esc(formatMoney(l.totalCents))}</span>` : ''}
    </div>`).join('') || '';
  const extras = summary ? [
    summary.deliveryCents ? `<div class="receipt-row"><span>Delivery fee</span><span>${esc(formatMoney(summary.deliveryCents))}</span></div>` : '',
    summary.taxCents ? `<div class="receipt-row"><span>Tax</span><span>${esc(formatMoney(summary.taxCents))}</span></div>` : '',
    summary.when ? `<div class="receipt-row"><span>${summary.type === 'delivery' ? 'Delivering' : 'Pickup'}</span><span>${esc(summary.when)}</span></div>` : '',
    `<div class="receipt-row receipt-total"><span>Total</span><span>${esc(formatMoney(summary.totalCents))}</span></div>`,
  ].join('') : '';
  card.innerHTML = `
    ${logo}
    <p class="thanks-ref">${esc(kicker)}${reference ? ` · ${esc(reference)}` : ''}</p>
    <h1><span class="h-line">${esc(title[0])}</span><span class="h-script">${esc(title[1])}</span></h1>
    <p class="lead">${esc(body)}</p>
    ${summary ? `<div class="receipt">${rows}${extras}</div>` : ''}
    <div class="hero-cta" style="justify-content:center;margin-top:4px">${actions || '<a class="btn btn-gold" href="./">Back to the menu</a>'}</div>`;
}
