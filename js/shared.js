// Shared by the browser and the checkout server, so prices, options and
// time slots are worked out by exactly the same code on both sides.

export function formatMoney(cents) {
  const n = Number(cents) || 0;
  const s = (Math.abs(n) / 100).toFixed(2);
  return (n < 0 ? '-$' : '$') + (s.endsWith('.00') ? s.slice(0, -3) : s);
}

/** US phone number -> "+1XXXXXXXXXX", or null if it is not a valid 10-digit number. */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (ten.length !== 10 || ten[0] === '0' || ten[0] === '1') return null;
  return '+1' + ten;
}

export function prettyPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 || '');
}

export function findItem(menu, id) {
  return (menu?.items || []).find((it) => it.id === id) || null;
}

/**
 * SK has no fixed menu: each day she posts a "drop" (menu.json -> today).
 * Returns what was last posted and whether it was posted for today's date in her time zone.
 */
export function todayInfo(menu, nowMs) {
  const t = menu?.today || {};
  const tz = menu?.business?.timezone || 'America/Indiana/Indianapolis';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : null;
  const ids = Array.isArray(t.plates) ? t.plates.filter((id) => typeof id === 'string') : [];
  let label = '';
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    label = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' })
      .format(new Date(Date.UTC(y, m - 1, d)));
  }
  return { date, label, ids, note: String(t.note || ''), isToday: !!date && date === nowInZone(nowMs, tz).date };
}

/** Can this plate be ordered right now? Only if it is in today's drop, priced, and not sold out. */
export function isOrderable(item, menu, nowMs) {
  if (!item || item.soldOut === true || !Number.isInteger(item.price) || item.price <= 0) return false;
  const t = todayInfo(menu, nowMs);
  return t.isToday && t.ids.includes(item.id);
}

/**
 * Check a customer's option picks against the menu item.
 * selected: { [groupId]: choiceId | choiceId[] }
 * Returns { ok, error, picks: [{group, choice}], extraCents, label, clean }
 */
export function resolveOptions(item, selected) {
  const sel = selected && typeof selected === 'object' ? selected : {};
  const groups = Array.isArray(item?.options) ? item.options : [];
  const known = new Set(groups.map((g) => g.id));
  for (const key of Object.keys(sel)) {
    if (!known.has(key)) return { ok: false, error: `Unknown option "${key}" for ${item.name}.` };
  }
  const picks = [];
  const clean = {};
  let extraCents = 0;
  for (const group of groups) {
    const raw = sel[group.id];
    if (group.type === 'single') {
      const choice = group.choices.find((c) => c.id === raw);
      if (!choice) return { ok: false, error: `Choose a ${group.name.toLowerCase()} for ${item.name}.` };
      picks.push({ group, choice });
      clean[group.id] = choice.id;
      extraCents += choice.price || 0;
    } else {
      const ids = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      const seen = new Set();
      const kept = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const choice = group.choices.find((c) => c.id === id);
        if (!choice) return { ok: false, error: `Unknown choice for ${group.name} on ${item.name}.` };
        picks.push({ group, choice });
        kept.push(choice.id);
        extraCents += choice.price || 0;
      }
      clean[group.id] = kept;
    }
  }
  const label = picks
    .map(({ group, choice }) => (group.type === 'multi' ? `+ ${choice.name}` : choice.name))
    .join(', ');
  return { ok: true, picks, extraCents, label, clean };
}

/** The picks a fresh item starts with: first choice of every single-choice group. */
export function defaultOptions(item) {
  const out = {};
  for (const group of item?.options || []) {
    out[group.id] = group.type === 'single' ? group.choices[0]?.id : [];
  }
  return out;
}

// ---------- time, in the business's own time zone ----------

function partsInZone(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  return p;
}

function offsetMinutes(ms, tz) {
  const p = partsInZone(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** { date: 'YYYY-MM-DD', minutes: minutes since local midnight } for an instant. */
export function nowInZone(ms, tz) {
  const p = partsInZone(ms, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}

/** Local wall-clock date + time in tz -> { ms, rfc3339 } */
export function zonedToInstant(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = offsetMinutes(guess, tz);
  let ms = guess - off * 60000;
  const off2 = offsetMinutes(ms, tz);
  if (off2 !== off) { off = off2; ms = guess - off * 60000; }
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  return { ms, rfc3339: `${date}T${pad(hh)}:${pad(mm)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (v) => String(v).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export function timeLabel(hhmm) {
  const mins = toMinutes(hhmm);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function dateLabel(date, todayDate) {
  if (date === todayDate) return 'Today';
  if (date === addDays(todayDate, 1)) return 'Tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** Days and times a customer may pick, from the hours in menu.json. */
export function buildSlots(business, nowMs) {
  const h = business.hours;
  const tz = business.timezone;
  const now = nowInZone(nowMs, tz);
  const open = toMinutes(h.open), close = toMinutes(h.close);
  const step = Math.max(5, h.slotMinutes || 30);
  const days = [];
  for (let i = 0; i <= (h.daysAhead ?? 0); i++) {
    const date = addDays(now.date, i);
    const earliest = i === 0 ? now.minutes + (h.leadMinutes || 0) : 0;
    const times = [];
    for (let t = open; t <= close; t += step) {
      if (t < earliest) continue;
      const value = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      times.push({ value, label: timeLabel(value) });
    }
    if (times.length) days.push({ date, label: dateLabel(date, now.date), times });
  }
  return days;
}

/** Server-side check of a chosen slot. graceMinutes forgives time spent filling in the form. */
export function checkSlot(business, date, time, nowMs, graceMinutes = 20) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) {
    return { ok: false, error: 'Pick a day and time for your order.' };
  }
  const h = business.hours;
  const tz = business.timezone;
  const now = nowInZone(nowMs, tz);
  const open = toMinutes(h.open), close = toMinutes(h.close);
  const step = Math.max(5, h.slotMinutes || 30);
  const t = toMinutes(time);
  const lastDay = addDays(now.date, h.daysAhead ?? 0);
  if (date < now.date || date > lastDay) return { ok: false, error: 'That day is not open for orders. Pick another day.' };
  if (t < open || t > close || (t - open) % step !== 0) return { ok: false, error: 'That time is outside ordering hours. Pick another time.' };
  const instant = zonedToInstant(date, time, tz);
  if (instant.ms < nowMs + ((h.leadMinutes || 0) - graceMinutes) * 60000) {
    return { ok: false, error: 'That time is too soon. Pick a later time.' };
  }
  return { ok: true, ...instant, label: `${dateLabel(date, now.date)} at ${timeLabel(time)}` };
}
