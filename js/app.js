import {
  formatMoney, normalizePhone, findItem, isOrderable, todayInfo, resolveOptions, defaultOptions, buildSlots,
} from './shared.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep going in memory */ } },
};

const CART_KEY = 'skc.cart.v1';
const DETAILS_KEY = 'skc.details.v1';
const PENDING_KEY = 'skc.pending.v1';

const state = {
  menu: null,
  mode: 'offline',          // 'production' | 'sandbox' | 'demo' | 'offline' (no checkout server reachable)
  cart: store.get(CART_KEY, []),
  view: 'cart',
  sending: false,
  item: null,               // plate open in the sheet: { item, options, qty }
  requested: new Set(),     // plate ids ticked in the Request a plate form
};

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;


async function init() {
  wireStaticUi();
  try {
    const res = await fetch('data/menu.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('menu ' + res.status);
    state.menu = await res.json();
  } catch {
    $('[data-menu-grid]').innerHTML = `<p class="notice">The menu didn't load. Refresh the page, or DM <a href="https://ig.me/m/sk.cravings">@sk.cravings</a> to order.</p>`;
    setStatus(false, 'Menu unavailable');
    return;
  }
  try {
    const res = await fetch('api/status', { cache: 'no-store' });
    if (res.ok) state.mode = (await res.json()).mode || 'demo';
  } catch { /* static hosting without the checkout server */ }

  pruneCart();
  renderAll();
  watchVideos();
  watchReveals();
  if (location.hash === '#order') openCart();
}

// ---------- rendering ----------

function biz() { return state.menu.business; }
function orderingOpen() { return biz().orderingOpen !== false; }
function igDm() { return `https://ig.me/m/${encodeURIComponent(biz().instagram || 'sk.cravings')}`; }

/** Orderable this minute: in today's drop, priced, not sold out, and ordering not paused. */
function live(item) { return orderingOpen() && isOrderable(item, state.menu, Date.now()); }

function renderAll() {
  const b = biz();
  const t = todayInfo(state.menu, Date.now());
  const drop = t.ids.map((id) => findItem(state.menu, id)).filter(Boolean);
  const past = state.menu.items.filter((it) => !t.ids.includes(it.id));
  const cooking = t.isToday && drop.some(live);

  setStatus(cooking, cooking ? `Cooking today · ${t.label}` : 'Nothing on the stove yet today');
  const closed = $('[data-closed-notice]');
  closed.hidden = orderingOpen();
  closed.textContent = b.closedMessage || 'Online ordering is paused right now.';

  const fee = b.delivery?.enabled !== false ? formatMoney(b.delivery?.feeCents ?? 0) : null;
  const how = `Pickup in Indy${fee ? ` or ${fee} delivery` : ''}.`;
  const title = $('[data-menu-title]');
  const sub = $('[data-menu-sub]');
  const follow = `<a class="btn btn-ghost" href="https://www.instagram.com/${esc(b.instagram)}/" target="_blank" rel="noopener">Follow @${esc(b.instagram)}</a>`;
  if (t.isToday && drop.length) {
    title.innerHTML = '<span class="h-line">Cooked today</span> <span class="h-script">ready now</span>';
    sub.textContent = `${t.label}${t.note ? ` · ${t.note}` : ''}. ${how} When it's gone, it's gone.`;
  } else if (drop.length) {
    title.innerHTML = '<span class="h-line">The last</span> <span class="h-script">drop</span>';
    sub.textContent = `SK hasn't posted today's plates yet. This is what she cooked ${t.label}. Want it again? Request it.`;
  } else {
    title.innerHTML = '<span class="h-line">Today\'s plates</span> <span class="h-script">coming up</span>';
    sub.textContent = 'SK posts the day\'s plates when she starts cooking.';
  }

  $('[data-menu-grid]').innerHTML = drop.length ? drop.map((it) => cardHtml(it, t)).join('') : `
    <div class="empty-drop">
      <b>Nothing on the stove yet</b>
      <p>No set menu here. Tell SK what you're craving and it might be the next drop.</p>
      <div class="hero-cta"><button class="btn btn-gold" type="button" data-request="">Request a plate</button>${follow}</div>
    </div>`;

  $('[data-rotation]').innerHTML = past.map(railHtml).join('');
  $('#rotation').hidden = past.length === 0;

  const featured = drop.find(live);
  const sticker = $('[data-featured]');
  sticker.hidden = !featured;
  if (featured) {
    sticker.dataset.item = featured.id;
    $('[data-featured-name]').textContent = featured.name;
    $('[data-featured-price]').textContent = formatMoney(featured.price);
  }

  // Wording depends on whether card payments are switched on yet.
  const paying = state.mode !== 'offline';
  $('[data-trust-pay]').textContent = paying ? 'Secure checkout by Square' : 'New plates every drop';
  $('[data-trust-how]').textContent = paying ? 'Cards, Apple Pay, Google Pay' : 'Order here, confirm by DM';
  $('[data-foot-pay]').textContent = paying
    ? 'Payments are processed securely by Square. Card details never touch this website.'
    : 'Orders are confirmed with SK by Instagram DM.';

  renderRequestChips();
  renderCart();
}

function setStatus(open, text) {
  $('[data-status]').classList.toggle('is-closed', !open);
  $('[data-status-text]').textContent = text;
}

function mediaHtml(item, { lazy = true } = {}) {
  if (!item.image) return '<div class="no-photo"><img src="media/brand/logo-sm.png" alt=""></div>';
  const img = `<img src="${esc(item.image)}" alt="${esc(item.name)}" ${lazy ? 'loading="lazy"' : ''} decoding="async">`;
  const vid = item.video && !reduceMotion
    ? `<video data-autoplay muted loop playsinline preload="none" aria-hidden="true" tabindex="-1"><source src="${esc(item.video)}" type="video/mp4"></video>`
    : '';
  return img + vid;
}

function cardHtml(item, t) {
  const can = live(item);
  const soldOut = t.isToday && item.soldOut === true;
  const flag = soldOut ? 'Sold out' : !t.isToday ? 'Last drop' : item.tag;
  const cta = can
    ? '<span>Add to order</span><i aria-hidden="true">+</i>'
    : `<span>${soldOut ? 'Sold out · request it' : 'Request this plate'}</span><i aria-hidden="true">→</i>`;
  const cls = can ? '' : soldOut ? 'is-soldout' : 'is-past';
  return `
    <button class="card reveal ${cls}" type="button" ${can ? 'data-item' : 'data-request'}="${esc(item.id)}">
      <div class="card-media ${item.imageFit === 'contain' ? 'is-contain' : ''}">
        ${mediaHtml(item)}
        ${flag ? `<span class="tag">${esc(flag)}</span>` : ''}
        ${Number.isInteger(item.price) ? `<span class="price"><span>${esc(formatMoney(item.price))}</span></span>` : ''}
      </div>
      <div class="card-body">
        <h3 class="card-name">${esc(item.name)}</h3>
        <p class="card-desc">${esc(item.description)}</p>
        <span class="card-cta">${cta}</span>
      </div>
    </button>`;
}

function railHtml(item) {
  return `
    <article class="rail-card">
      ${mediaHtml(item)}
      <span class="rail-flag">Made before</span>
      <div class="rail-body">
        <h3 class="rail-name">${esc(item.name)}</h3>
        <p class="rail-desc">${esc(item.description)}</p>
        <button class="rail-link" type="button" data-request="${esc(item.id)}" aria-label="Request ${esc(item.name)}">Request this</button>
      </div>
    </article>`;
}

// ---------- videos + reveals ----------

function watchVideos() {
  if (reduceMotion || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target;
      if (e.isIntersecting) {
        v.play().then(() => v.classList.add('is-playing')).catch(() => {});
      } else {
        v.pause();
      }
    }
  }, { threshold: 0.55 });
  const attach = () => $$('video[data-autoplay]:not([data-watched])').forEach((v) => { v.dataset.watched = '1'; io.observe(v); });
  attach();
  watchVideos.attach = attach;
}

function watchReveals() {
  const els = $$('.reveal:not(.is-in), .step, .section-head');
  if (reduceMotion || !('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  els.forEach((el, i) => { el.classList.add('reveal'); el.style.transitionDelay = `${(i % 4) * 70}ms`; io.observe(el); });
}

// ---------- plate sheet ----------

const itemDialog = $('#itemDialog');

function openItem(id) {
  const item = findItem(state.menu, id);
  if (!item) return;
  if (!live(item)) { openRequest(item.id); return; }
  state.item = { item, options: defaultOptions(item), qty: 1 };
  const media = $('[data-item-media]');
  media.className = `sheet-media ${item.imageFit === 'contain' ? 'is-contain' : ''}`;
  media.innerHTML = item.video && !reduceMotion
    ? `<video autoplay muted loop playsinline poster="${esc(item.image)}"><source src="${esc(item.video)}" type="video/mp4"></video>`
    : `<img src="${esc(item.image)}" alt="${esc(item.name)}">`;
  const tag = $('[data-item-tag]');
  tag.hidden = !item.tag;
  tag.textContent = item.tag || '';
  $('[data-item-name]').textContent = item.name;
  $('[data-item-desc]').textContent = item.description;
  $('#itemNote').value = '';
  $('[data-item-options]').innerHTML = (item.options || []).map((g) => `
    <fieldset class="opt-group">
      <legend>${esc(g.name)}${g.type === 'multi' ? ' <span class="opt">optional</span>' : ''}</legend>
      <div class="opt-list">
        ${g.choices.map((c, i) => `
          <label class="opt-item">
            <input type="${g.type === 'single' ? 'radio' : 'checkbox'}" name="opt-${esc(g.id)}" value="${esc(c.id)}" data-group="${esc(g.id)}" ${g.type === 'single' && i === 0 ? 'checked' : ''}>
            <span>${esc(c.name)}${c.price ? `<em>+${esc(formatMoney(c.price))}</em>` : ''}</span>
          </label>`).join('')}
      </div>
    </fieldset>`).join('');
  updateItemTotal();
  itemDialog.showModal();
}

function readItemOptions() {
  const { item } = state.item;
  const out = {};
  for (const g of item.options || []) {
    const checked = $$(`input[data-group="${CSS.escape(g.id)}"]:checked`, itemDialog).map((el) => el.value);
    out[g.id] = g.type === 'single' ? checked[0] : checked;
  }
  return out;
}

function updateItemTotal() {
  if (!state.item) return;
  state.item.options = readItemOptions();
  const { item, options, qty } = state.item;
  const r = resolveOptions(item, options);
  const unit = item.price + (r.ok ? r.extraCents : 0);
  $('[data-item-qty]').textContent = qty;
  $('[data-item-add]').textContent = `Add to order · ${formatMoney(unit * qty)}`;
}

function addCurrentItem() {
  const { item, options, qty } = state.item;
  const r = resolveOptions(item, options);
  if (!r.ok) { toast(r.error); return; }
  const note = $('#itemNote').value.trim().slice(0, 200);
  const key = JSON.stringify([item.id, r.clean, note]);
  const existing = state.cart.find((l) => l.key === key);
  if (existing) existing.qty = Math.min(25, existing.qty + qty);
  else state.cart.push({ key, id: item.id, qty, options: r.clean, note });
  saveCart();
  itemDialog.close();
  renderCart(true);
  toast(`${qty > 1 ? qty + ' × ' : ''}${item.name} added`);
}

// ---------- cart ----------

function saveCart() { store.set(CART_KEY, state.cart); }

/** Drop anything that is no longer on the menu or whose options changed. */
function pruneCart() {
  const before = state.cart.length;
  state.cart = (Array.isArray(state.cart) ? state.cart : []).filter((l) => {
    const item = findItem(state.menu, l.id);
    return item && isOrderable(item, state.menu, Date.now()) && resolveOptions(item, l.options).ok && Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= 25;
  });
  if (state.cart.length !== before) saveCart();
  return before - state.cart.length;
}

function cartLines() {
  return state.cart.map((l) => {
    const item = findItem(state.menu, l.id);
    const r = resolveOptions(item, l.options);
    const unit = item.price + r.extraCents;
    return { ...l, item, label: r.label, unit, total: unit * l.qty };
  });
}

function fulfillmentType() {
  return $('input[name="ftype"]:checked')?.value === 'delivery' ? 'delivery' : 'pickup';
}

function totals() {
  const b = biz();
  const subtotal = cartLines().reduce((s, l) => s + l.total, 0);
  const delivery = state.view === 'details' && fulfillmentType() === 'delivery' ? (b.delivery?.feeCents ?? 0) : 0;
  const tax = Math.round((subtotal * (Number(b.taxPercent) > 0 ? Number(b.taxPercent) : 0)) / 100);
  return { subtotal, delivery, tax, total: subtotal + delivery + tax, count: state.cart.reduce((s, l) => s + l.qty, 0) };
}

function renderCart(bump = false) {
  const lines = cartLines();
  const t = totals();

  $$('[data-cart-count]').forEach((el) => {
    el.textContent = t.count;
    if (el.classList.contains('cart-count')) {
      el.hidden = t.count === 0;
      if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    }
  });
  $('[data-cart-total]').textContent = formatMoney(t.subtotal);
  $('[data-cart-bar]').hidden = t.count === 0 || $('#cartDialog').open;

  $('[data-cart-lines]').innerHTML = lines.length ? lines.map((l) => `
    <div class="line" data-key="${esc(l.key)}">
      <img src="${esc(l.item.image)}" alt="" loading="lazy">
      <div>
        <div class="line-name">${esc(l.item.name)}</div>
        ${l.label ? `<div class="line-opts">${esc(l.label)}</div>` : ''}
        ${l.note ? `<div class="line-note">“${esc(l.note)}”</div>` : ''}
        <button class="line-remove" type="button" data-remove>Remove</button>
      </div>
      <div class="line-side">
        <span class="line-price">${esc(formatMoney(l.total))}</span>
        <div class="stepper stepper--sm" role="group" aria-label="Quantity for ${esc(l.item.name)}">
          <button type="button" data-line-qty="-1" aria-label="One less">−</button>
          <output>${l.qty}</output>
          <button type="button" data-line-qty="1" aria-label="One more">+</button>
        </div>
      </div>
    </div>`).join('') : `
    <div class="empty">
      <img src="media/brand/logo-sm.png" alt="">
      <b>Nothing here yet</b>
      <p>Pick a plate from the menu and it'll show up here.</p>
      <button class="btn btn-ghost" type="button" data-close>See the menu</button>
    </div>`;

  const rows = [
    ['Subtotal', formatMoney(t.subtotal)],
    ...(state.view === 'details' && fulfillmentType() === 'delivery' ? [['Delivery', formatMoney(t.delivery)]] : []),
    ...(t.tax ? [['Tax', formatMoney(t.tax)]] : []),
  ];
  $('[data-totals]').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    + `<dt class="grand">Total</dt><dd class="grand">${formatMoney(t.total)}</dd>`;

  $('[data-cart-foot]').hidden = lines.length === 0;
  if (lines.length === 0 && state.view === 'details') setView('cart');
  updateNextButton();
}

function updateNextButton() {
  const btn = $('[data-cart-next]');
  const fine = $('[data-foot-fine]');
  if (state.view === 'cart') {
    btn.textContent = 'Checkout';
    btn.disabled = false;
    fine.textContent = 'Pickup or delivery, and your details, on the next step.';
  } else if (state.mode === 'offline') {
    btn.textContent = 'Send order on Instagram';
    btn.disabled = false;
    fine.textContent = 'Online payment isn\'t switched on yet, so this copies your order for a DM to SK.';
  } else {
    btn.textContent = state.sending ? 'Opening Square…' : `Pay ${formatMoney(totals().total)} with Square`;
    btn.disabled = state.sending;
    fine.textContent = 'You\'ll finish on Square\'s secure checkout page. Card details never touch this site.';
  }
}

const cartDialog = $('#cartDialog');

function openCart() {
  setView('cart');
  renderCart();
  if (!cartDialog.open) cartDialog.showModal();
  $('[data-cart-bar]').hidden = true;
}

function setView(view) {
  state.view = view;
  $$('[data-view]', cartDialog).forEach((el) => { el.hidden = el.dataset.view !== view; });
  $('[data-back]').hidden = view === 'cart';
  $('[data-cart-title]').textContent = view === 'cart' ? 'Your order' : 'Checkout';
  if (view === 'details') prepareCheckoutForm();
  renderCart();
}

// ---------- checkout form ----------

function prepareCheckoutForm() {
  const b = biz();
  const form = $('[data-checkout-form]');
  $('[data-demo-banner]').hidden = state.mode !== 'demo' && state.mode !== 'sandbox';
  if (state.mode === 'sandbox') $('[data-demo-banner]').innerHTML = '<b>Square test mode.</b> Checkout opens Square\'s sandbox. Use a Square test card; no real money moves.';

  // No Square receipt to send until card payments are switched on.
  form.elements.email.closest('.field').hidden = state.mode === 'offline';

  const pickup = $('input[name="ftype"][value="pickup"]');
  const delivery = $('input[name="ftype"][value="delivery"]');
  pickup.disabled = b.pickup?.enabled === false;
  delivery.disabled = b.delivery?.enabled === false;
  if (pickup.disabled && !delivery.disabled) delivery.checked = true;
  $('[data-delivery-fee]').textContent = `+${formatMoney(b.delivery?.feeCents ?? 0)}`;

  // Remember the customer's details between visits (on this device only).
  const saved = store.get(DETAILS_KEY, {});
  for (const name of ['name', 'phone', 'email', 'line1', 'line2', 'city', 'state', 'zip']) {
    const el = form.elements[name];
    if (el && !el.value && saved[name]) el.value = saved[name];
  }

  const days = buildSlots(b, Date.now());
  const dateSel = form.elements.date;
  const keep = dateSel.value;
  dateSel.innerHTML = days.map((d) => `<option value="${d.date}">${esc(d.label)}</option>`).join('');
  if (days.some((d) => d.date === keep)) dateSel.value = keep;
  fillTimes(days);
  syncFulfillment();
}

function fillTimes(days = buildSlots(biz(), Date.now())) {
  const form = $('[data-checkout-form]');
  const day = days.find((d) => d.date === form.elements.date.value) || days[0];
  const timeSel = form.elements.time;
  const keep = timeSel.value;
  timeSel.innerHTML = day ? day.times.map((t) => `<option value="${t.value}">${t.label}</option>`).join('') : '<option value="">No times open</option>';
  if (day?.times.some((t) => t.value === keep)) timeSel.value = keep;
}

function syncFulfillment() {
  const b = biz();
  const isDelivery = fulfillmentType() === 'delivery';
  $('[data-address]').hidden = !isDelivery;
  $('[data-fulfillment-note]').textContent = isDelivery ? (b.delivery?.note || '') : (b.pickup?.note || '');
  renderCart();
}

function showFormError(message, field) {
  const box = $('[data-checkout-error]');
  box.hidden = !message;
  box.textContent = message || '';
  $$('.field.is-invalid', cartDialog).forEach((el) => el.classList.remove('is-invalid'));
  if (!message) return;
  const el = field && $('[data-checkout-form]').elements[field === 'time' ? 'time' : field];
  if (el && el.closest) { el.closest('.field')?.classList.add('is-invalid'); el.focus({ preventScroll: true }); }
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function readCheckout() {
  const f = $('[data-checkout-form]').elements;
  const type = fulfillmentType();
  const val = (n) => f[n].value.trim();
  const data = {
    items: state.cart.map((l) => ({ id: l.id, qty: l.qty, options: l.options, note: l.note })),
    customer: { name: val('name'), phone: val('phone'), email: val('email') },
    fulfillment: {
      type, date: f.date.value, time: f.time.value,
      address: type === 'delivery' ? { line1: val('line1'), line2: val('line2'), city: val('city'), state: val('state'), zip: val('zip') } : null,
    },
    notes: val('notes'),
  };
  // Friendly checks first; the server repeats every one of them.
  if (!data.fulfillment.date || !data.fulfillment.time) return { error: 'Pick a day and time for your order.', field: 'time' };
  if (type === 'delivery') {
    if (data.fulfillment.address.line1.length < 4) return { error: 'Enter the street address for delivery.', field: 'line1' };
    if (!/^\d{5}(-\d{4})?$/.test(data.fulfillment.address.zip)) return { error: 'Enter a 5-digit ZIP code.', field: 'zip' };
    if (data.fulfillment.address.city.length < 2) return { error: 'Enter the city for delivery.', field: 'city' };
  }
  if (data.customer.name.length < 2) return { error: 'Tell us your name so SK knows whose order it is.', field: 'name' };
  if (!normalizePhone(data.customer.phone)) return { error: 'Enter a 10-digit phone number so SK can text you about your order.', field: 'phone' };
  if (data.customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.customer.email)) return { error: 'That email address does not look right.', field: 'email' };
  return { data };
}

async function submitCheckout() {
  if (state.sending) return;
  const { data, error, field } = readCheckout();
  if (error) { showFormError(error, field); return; }
  showFormError('');
  store.set(DETAILS_KEY, { ...data.customer, ...(data.fulfillment.address || {}) });

  if (state.mode === 'offline') { await sendByInstagram(data); return; }

  state.sending = true;
  updateNextButton();
  try {
    const res = await fetch('api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...data, idempotencyKey: crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2) }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.url) {
      if (out.code === 'MENU_CHANGED' || out.code === 'ORDERING_CLOSED') await refreshMenu();
      if (out.code === 'SLOT_GONE') prepareCheckoutForm();
      showFormError(out.error || 'Checkout didn\'t go through. Please try again.', out.field);
      return;
    }
    store.set(PENDING_KEY, {
      orderId: out.orderId, reference: out.reference, demo: !!out.demo, url: out.url, at: Date.now(),
      summary: out.summary, name: data.customer.name, type: data.fulfillment.type,
    });
    location.href = out.url;
    return; // keep the button in its "opening" state while the browser leaves
  } catch {
    showFormError('No connection to checkout. Check your signal and try again.');
  }
  state.sending = false;
  updateNextButton();
}

async function refreshMenu() {
  try {
    const res = await fetch('data/menu.json', { cache: 'reload' });
    if (res.ok) state.menu = await res.json();
  } catch { /* keep the menu we have */ }
  const dropped = pruneCart();
  renderAll();
  watchVideos.attach?.();
  watchReveals();
  if (dropped) toast('The menu changed, so we updated your order.');
}

/** Fallback when the site is hosted without the checkout server: hand the order to a DM. */
async function sendByInstagram(data) {
  const lines = cartLines().map((l) => `${l.qty} × ${l.item.name}${l.label ? ` (${l.label})` : ''}${l.note ? ` — ${l.note}` : ''}`);
  const f = data.fulfillment;
  const when = `${$('[data-checkout-form]').elements.date.selectedOptions[0]?.textContent || f.date} at ${$('[data-checkout-form]').elements.time.selectedOptions[0]?.textContent || f.time}`;
  const text = [
    'Hey SK! I\'d like to order:', ...lines, '',
    `${f.type === 'delivery' ? 'Delivery' : 'Pickup'}: ${when}`,
    f.address ? `Address: ${[f.address.line1, f.address.line2, f.address.city, f.address.state, f.address.zip].filter(Boolean).join(', ')}` : '',
    `Name: ${data.customer.name}`, `Phone: ${data.customer.phone}`,
    data.notes ? `Notes: ${data.notes}` : '', `Total: ${formatMoney(totals().total)}`,
  ].filter((l) => l !== '').join('\n');
  const copied = await copyText(text);
  toast(copied ? 'Order copied. Paste it into the DM.' : 'Opening Instagram…');
  window.open(igDm(), '_blank', 'noopener');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// ---------- request a plate ----------

function renderRequestChips() {
  $('[data-request-chips]').innerHTML = state.menu.items.map((it) => `
    <label class="chip-pick">
      <input type="checkbox" value="${esc(it.id)}" ${state.requested.has(it.id) ? 'checked' : ''}>
      <span>${esc(it.name)}</span>
    </label>`).join('');
}

/** Jump to the request form, optionally with a plate already ticked. */
function openRequest(id) {
  if (itemDialog.open) itemDialog.close();
  if (cartDialog.open) cartDialog.close();
  const item = id && state.menu ? findItem(state.menu, id) : null;
  if (item) { state.requested.add(item.id); renderRequestChips(); }
  const section = $('#request');
  section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  section.classList.remove('is-flash'); void section.offsetWidth; section.classList.add('is-flash');
  if (item) toast(`${item.name} added to your request`);
}

function wireRequests() {
  const form = $('[data-request-form]');
  const msg = $('[data-request-msg]');
  form.addEventListener('change', (e) => {
    if (!e.target.matches('.chip-pick input')) return;
    if (e.target.checked) state.requested.add(e.target.value); else state.requested.delete(e.target.value);
    msg.textContent = '';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.menu) return;
    const f = form.elements;
    const picks = [...state.requested].map((id) => findItem(state.menu, id)?.name).filter(Boolean);
    const other = f.other.value.trim();
    const name = f.name.value.trim();
    if (!picks.length && !other) { msg.textContent = 'Tap a plate or tell SK what you\'re craving.'; return; }
    if (name.length < 2) { msg.textContent = 'Add your name so SK knows who\'s asking.'; f.name.focus(); return; }
    let when = '';
    if (f.date.value) {
      const [y, m, d] = f.date.value.split('-').map(Number);
      when = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
    }
    const qty = Math.max(1, Math.min(200, parseInt(f.qty.value, 10) || 1));
    const text = [
      'Hey SK! Plate request from the website:',
      ...picks.map((p) => `• ${p}`),
      other ? `• Something else: ${other}` : '',
      when ? `For: ${when}` : '',
      `How many: ${qty} ${qty === 1 ? 'plate' : 'plates'}`,
      `Name: ${name}`,
      f.phone.value.trim() ? `Phone: ${f.phone.value.trim()}` : '',
    ].filter(Boolean).join('\n');
    const copied = await copyText(text);
    msg.textContent = copied
      ? 'Copied! Paste it into the Instagram DM with SK that just opened.'
      : 'Instagram is opening. Tell SK what you want in the DM.';
    window.open(igDm(), '_blank', 'noopener');
  });
}

// ---------- catering ----------

function wireCatering() {
  const form = $('[data-catering-form]');
  const msg = $('[data-catering-msg]');
  const compose = () => {
    const f = form.elements;
    return [
      `Hey SK! I'm looking for: ${f.type.value}`,
      f.date.value ? `Date: ${f.date.value}` : '',
      f.guests.value ? `Guests: ${f.guests.value}` : '',
      `Name: ${f.name.value.trim()}`,
      f.phone.value.trim() ? `Phone: ${f.phone.value.trim()}` : '',
      f.details.value.trim() ? `Details: ${f.details.value.trim()}` : '',
    ].filter(Boolean).join('\n');
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.elements.name.value.trim().length < 2) {
      msg.textContent = 'Add your name so SK knows who\'s asking.';
      form.elements.name.focus();
      return;
    }
    const text = compose();
    const how = e.submitter?.dataset.send || 'instagram';
    const c = state.menu?.business.contact || {};
    if (how === 'sms' && c.phone) { location.href = `sms:${c.phone}?&body=${encodeURIComponent(text)}`; return; }
    if (how === 'email' && c.email) { location.href = `mailto:${c.email}?subject=${encodeURIComponent('Catering request')}&body=${encodeURIComponent(text)}`; return; }
    const copied = await copyText(text);
    msg.textContent = copied ? 'Copied! Paste it into the Instagram DM that just opened.' : 'Instagram is opening. Tell SK what you need in the DM.';
    window.open(state.menu ? igDm() : 'https://ig.me/m/sk.cravings', '_blank', 'noopener');
  });
  // Optional extra buttons appear only if SK adds a phone or email in menu.json.
  queueMicrotask(function addContactButtons() {
    if (!state.menu) { setTimeout(addContactButtons, 300); return; }
    const c = biz().contact || {};
    const box = $('[data-catering-actions]');
    if (c.phone) box.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost" type="submit" data-send="sms">Text SK</button>');
    if (c.email) box.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost" type="submit" data-send="email">Email SK</button>');
  });
}

// ---------- wiring ----------

function wireStaticUi() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-item], [data-request], [data-open-cart], [data-close], [data-remove], [data-line-qty], [data-qty]');
    if (!t) return;
    if (t.matches('[data-open-cart]')) { openCart(); return; }
    if (t.matches('[data-request]')) { openRequest(t.dataset.request); return; }
    if (t.matches('[data-close]')) { t.closest('dialog')?.close(); return; }
    if (t.matches('[data-qty]')) {
      state.item.qty = Math.max(1, Math.min(25, state.item.qty + Number(t.dataset.qty)));
      updateItemTotal();
      return;
    }
    if (t.matches('[data-remove], [data-line-qty]')) {
      const key = t.closest('.line')?.dataset.key;
      const line = state.cart.find((l) => l.key === key);
      if (!line) return;
      if (t.matches('[data-remove]')) line.qty = 0;
      else line.qty = Math.min(25, line.qty + Number(t.dataset.lineQty));
      state.cart = state.cart.filter((l) => l.qty > 0);
      saveCart();
      renderCart(true);
      return;
    }
    if (t.matches('[data-item]') && state.menu) openItem(t.dataset.item);
  });

  // Tapping the dark backdrop closes a dialog.
  for (const d of [itemDialog, cartDialog]) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  itemDialog.addEventListener('close', () => { $('[data-item-media]').innerHTML = ''; state.item = null; });
  cartDialog.addEventListener('close', () => { state.view = 'cart'; renderCart(); });

  itemDialog.addEventListener('change', (e) => { if (e.target.matches('input[data-group]')) updateItemTotal(); });
  $('[data-item-form]').addEventListener('submit', (e) => { e.preventDefault(); addCurrentItem(); });

  $('[data-cart-next]').addEventListener('click', () => {
    if (state.view === 'cart') {
      if (!orderingOpen()) { toast(biz().closedMessage || 'Online ordering is paused right now.'); return; }
      setView('details');
      $('.drawer-body[data-view="details"]').scrollTop = 0;
    } else submitCheckout();
  });
  $('[data-back]').addEventListener('click', () => setView('cart'));

  const form = $('[data-checkout-form]');
  form.addEventListener('submit', (e) => { e.preventDefault(); submitCheckout(); });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'ftype') syncFulfillment();
    if (e.target.name === 'date') fillTimes();
  });
  form.addEventListener('input', () => { if (!$('[data-checkout-error]').hidden) showFormError(''); });

  // Coming back from Square with the Back button restores the page from cache: unfreeze the button.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) { state.sending = false; updateNextButton(); }
  });

  wireRequests();
  wireCatering();
}

let toastTimer;
function toast(message) {
  const el = $('[data-toast]');
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
}

init();
