// SK's kitchen: post the day's plates from a phone.
// It saves by updating data/menu.json in the website's GitHub repository, using a key
// (a GitHub token limited to this one repository) that is stored only on this phone.

import { nowInZone, todayInfo } from './shared.js';

const host = location.hostname;
const onPages = host.endsWith('.github.io');
const OWNER = onPages ? host.split('.')[0] : 'Sfkone24';
const REPO = onPages ? location.pathname.split('/')[1] : 'sk-cravings';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
const KEY = 'skc.kitchen.key';
const MENU_PATH = 'data/menu.json';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };

let menu = null;
let sha = null;
let busy = false;
const newPhotos = new Map();   // plate id -> base64 JPEG waiting to be uploaded

function say(text, bad = false) {
  const el = $('[data-msg]');
  el.textContent = text;
  el.classList.toggle('is-bad', bad);
}

async function gh(path, { method = 'GET', body } = {}) {
  const url = API + path + (method === 'GET' ? `?ref=${BRANCH}&t=${Date.now()}` : '');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getKey()}`,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { ok: res.ok, status: res.status, data };
}

const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function show(which) {
  $('[data-setup]').hidden = which !== 'setup';
  $('[data-board]').hidden = which !== 'board';
  $('[data-bar]').hidden = which !== 'board';
}

async function load() {
  if (!getKey()) { show('setup'); return; }
  show('board');
  say('Loading the menu…');
  const res = await gh(MENU_PATH).catch(() => ({ ok: false, status: 0 }));
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    show('setup');
    $('[data-setup] .fine').textContent = 'That key didn\'t work. Check it was copied in full and has access to the website.';
    return;
  }
  if (!res.ok || !res.data?.content) { say('Couldn\'t load the menu. Check your signal and reload the page.', true); return; }
  try { menu = JSON.parse(fromBase64(res.data.content)); } catch { say('The menu file is damaged. Ask for help before posting.', true); return; }
  sha = res.data.sha;
  render();
  say('');
}

function render() {
  const now = Date.now();
  const t = todayInfo(menu, now);
  const today = nowInZone(now, menu.business.timezone).date;
  const [y, m, d] = today.split('-').map(Number);
  $('[data-date]').textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
  $('[data-live]').textContent = t.isToday && t.ids.length
    ? `On the website right now: ${t.ids.length} ${t.ids.length === 1 ? 'plate' : 'plates'}.`
    : 'Nothing is posted for today yet. Customers see your last drop and can send requests.';
  $('#k-note').value = t.isToday ? t.note : '';
  const on = new Set(t.isToday ? t.ids : []);
  const items = [...menu.items].sort((a, b) => on.has(b.id) - on.has(a.id));
  $('[data-rows]').innerHTML = items.map((it) => rowHtml(it, on.has(it.id), t.isToday)).join('');
}

function rowHtml(it, isOn, sameDay) {
  const price = Number.isInteger(it.price) ? (it.price / 100).toFixed(2).replace(/\.00$/, '') : '';
  return `
    <div class="k-row ${isOn ? 'is-on' : ''}" data-id="${esc(it.id)}">
      <label class="k-on"><input type="checkbox" data-on ${isOn ? 'checked' : ''}><span>${esc(it.name)}</span></label>
      <label class="k-price"><span>$</span><input type="number" data-price inputmode="decimal" min="1" max="1000" step="0.01" value="${esc(price)}" aria-label="Price for ${esc(it.name)}"></label>
      <label class="k-sold"><input type="checkbox" data-sold ${isOn && sameDay && it.soldOut ? 'checked' : ''}><span>Sold out</span></label>
    </div>`;
}

const toCents = (v) => { const n = Math.round(Number(v) * 100); return Number.isFinite(n) && n >= 100 && n <= 100000 ? n : null; };
const slug = (name) => name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** Shrink a phone photo to the 4:5 card size so it loads fast. Returns base64 JPEG. */
async function photoToBase64(file) {
  const img = await createImageBitmap(file);
  const W = 720, H = 900;
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale, h = img.height * scale;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getContext('2d').drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
}

async function addNew() {
  const name = $('#n-name').value.trim();
  const price = toCents($('#n-price').value);
  if (name.length < 2) { say('Give the new plate a name.', true); return; }
  if (!price) { say('Give the new plate a price, like 20.', true); return; }
  const id = slug(name);
  if (!id || menu.items.some((it) => it.id === id)) { say('There is already a plate with that name. Tick it in the list instead.', true); return; }
  const item = { id, name, price, soldOut: false, description: $('#n-desc').value.trim(), options: [] };
  const file = $('#n-photo').files[0];
  if (file) {
    try { newPhotos.set(id, await photoToBase64(file)); item.image = `media/dishes/${id}.jpg`; }
    catch { say('That photo couldn\'t be read. The plate was added without it.', true); }
  }
  menu.items.push(item);
  $('[data-rows]').insertAdjacentHTML('afterbegin', rowHtml(item, true, true));
  $('#n-name').value = ''; $('#n-price').value = ''; $('#n-desc').value = ''; $('#n-photo').value = '';
  $('[data-new]').open = false;
  if (!$('[data-msg]').classList.contains('is-bad')) say(`${name} added. Tap "Post today's plates" to put it on the website.`);
}

async function post(clear = false) {
  if (busy || !menu) return;
  const now = Date.now();
  const today = nowInZone(now, menu.business.timezone).date;
  const sameDay = menu.today?.date === today;
  const plates = [];
  if (!clear) {
    for (const row of document.querySelectorAll('.k-row')) {
      const it = menu.items.find((x) => x.id === row.dataset.id);
      if (!it || !row.querySelector('[data-on]').checked) continue;
      const cents = toCents(row.querySelector('[data-price]').value);
      if (!cents) { say(`Set a price for ${it.name}.`, true); row.querySelector('[data-price]').focus(); return; }
      it.price = cents;
      it.soldOut = row.querySelector('[data-sold]').checked;
      plates.push(it.id);
    }
    if (!plates.length) { say('Tick at least one plate, or tap "Nothing today".', true); return; }
  }
  // A new day starts fresh: plates left off today's drop are not "sold out" any more.
  if (!sameDay || clear) for (const it of menu.items) if (!plates.includes(it.id)) it.soldOut = false;
  const next = { ...menu, today: { date: today, note: clear ? '' : $('#k-note').value.trim(), plates } };

  busy = true;
  $('[data-post]').disabled = true;
  say('Posting…');
  try {
    for (const [id, content] of newPhotos) {
      if (!plates.includes(id)) continue;
      const up = await gh(`media/dishes/${id}.jpg`, { method: 'PUT', body: { message: `Photo: ${id}`, content, branch: BRANCH } });
      if (!up.ok && up.status !== 422) throw new Error('photo');
      newPhotos.delete(id);
    }
    const res = await gh(MENU_PATH, {
      method: 'PUT',
      body: { message: clear ? `No drop for ${today}` : `Drop for ${today}: ${plates.join(', ')}`, content: toBase64(JSON.stringify(next, null, 2) + '\n'), sha, branch: BRANCH },
    });
    if (res.status === 409 || res.status === 422) {
      say('The menu changed somewhere else. Reloading it, then try again.', true);
      await load();
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    menu = next;
    sha = res.data.content.sha;
    render();
    say(clear ? 'Done. The website shows nothing cooking today.' : `Posted ${plates.length} ${plates.length === 1 ? 'plate' : 'plates'}. The website updates in about a minute.`);
  } catch {
    say('That didn\'t save. Check your signal and try again.', true);
  } finally {
    busy = false;
    $('[data-post]').disabled = false;
  }
}

$('[data-setup]').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('#k-token').value.trim();
  if (!value) return;
  try { localStorage.setItem(KEY, value); } catch { /* private mode */ }
  $('#k-token').value = '';
  load();
});
$('[data-rows]').addEventListener('change', (e) => {
  if (e.target.matches('[data-on]')) e.target.closest('.k-row').classList.toggle('is-on', e.target.checked);
});
$('[data-post]').addEventListener('click', () => post(false));
$('[data-clear]').addEventListener('click', () => { if (confirm('Show nothing cooking today on the website?')) post(true); });
$('[data-add-new]').addEventListener('click', addNew);
$('[data-forget]').addEventListener('click', () => {
  if (!confirm('Lock this phone? You will need the kitchen key to unlock it again.')) return;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  location.reload();
});

load();
