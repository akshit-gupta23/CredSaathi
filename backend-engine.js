/* CredSathi in-browser engine: a JavaScript port of backend/app.py.
   Documents are read locally via Tesseract.js/pdf.js when the browser allows it; if Worker
   construction is blocked (as in Claude's own artifact preview sandbox), fileRows() falls
   back to asking Claude's vision API to transcribe the file instead - see visionRows(). */
(function (root) {
'use strict';

// ------------------------------------------------------------ small helpers
const pyRound = x => {                       // Python-style round(): halves go to the even integer
  if (!isFinite(x)) return x;
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
};
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => sum(xs) / xs.length;
const pstdev = xs => { const m = mean(xs); return Math.sqrt(sum(xs.map(x => (x - m) * (x - m))) / xs.length); };
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const cv = xs => (xs.length > 1 && mean(xs) > 0) ? pstdev(xs) / mean(xs) : null;
const num = s => parseFloat(String(s).replace(/,/g, ''));
const title = s => s.toLowerCase().replace(/[a-z]+/g, w => w[0].toUpperCase() + w.slice(1));
const DAY = 86400000;

function mkDate(y, mo, d) {                  // UTC midnight, or null when the date does not exist
  if (!(y >= 1 && y <= 9999 && mo >= 1 && mo <= 12 && d >= 1)) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}
const dayDiff = (b, a) => Math.round((b - a) / DAY);
const ym = dt => String(dt.getUTCFullYear()).padStart(4, '0') + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');

// ------------------------------------------------------------ regexes
const MONTHS = {}; 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').forEach((m, i) => { MONTHS[m] = i + 1; });
const DATE = /\b(\d{1,2})[\/\-. ]+(\d{1,2}|[A-Za-z]{3})[A-Za-z]*[\/\-. ,]+(\d{2,4})\b/;
const AMT_DEC_SRC = '(?<![\\d,.])\\d{1,3}(?:,\\d{2,3})*\\.\\d{2}(?!\\d)|(?<![\\d,.])\\d+\\.\\d{2}(?!\\d)';
const AMT_ANY_SRC = '(?<![\\d,.])(?:\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.\\d{1,2})?(?![\\d/])';
const AMT_DEC = new RegExp(AMT_DEC_SRC), AMT_DEC_G = new RegExp(AMT_DEC_SRC, 'g');
const AMT_ANY = new RegExp(AMT_ANY_SRC), AMT_ANY_G = new RegExp(AMT_ANY_SRC, 'g');

const CREDIT_KW = /\b(CR|CREDIT|DEPOSIT|RECEIVED|SALARY|PAYOUT|INWARD)\b|UPI\/CR|\/CR\//i;
const DEBIT_KW = /\b(DR|DEBIT|WITHDRAWAL|PAID|SENT|PURCHASE|ATM|POS)\b|UPI\/DR|\/DR\//i;
const EMI_KW = /NACH|LOAN|FINSERV|BAJAJ|KREDITBEE|MONEYVIEW|LAZYPAY|CREDITCARD|HOMECREDIT|FULLERTON|PAYSENSE|ECSDR|EMI(?:$|\/|\d)/;
const BOUNCE_KW = /BOUNCE|RETURNCH|CHQRET|ECSRET|NACHRET|INSUFF|DISHON|UNPAID|MANDATEFAIL/;
const EXCLUDE_IN = /REFUND|REVERS|CASHBACK|SELF|OWNACC|INTEREST/;

function parseDate(s) {
  const m = DATE.exec(s);
  if (!m) return [null, s];
  const mo = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (mo === undefined) return [null, s];
  const y = parseInt(m[3], 10) + (m[3].length === 2 ? 2000 : 0);
  const dt = mkDate(y, mo, parseInt(m[1], 10));
  if (!dt) return [null, s];
  return [dt, s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)];
}

// ------------------------------------------------------------ bank statement
function parseBank(rows) {
  let recs = [];
  for (const ln of rows) {
    const [d, rest] = parseDate(ln);
    if (!d) {
      if (recs.length && !AMT_DEC.test(ln)) recs[recs.length - 1].desc += ' ' + ln;
      continue;
    }
    let nums = (rest.match(AMT_DEC_G) || []).map(num);
    if (!nums.length) nums = (rest.replace(/\d{8,}/g, ' ').match(AMT_ANY_G) || []).map(num).filter(x => x >= 1);
    if (!nums.length) continue;
    const desc = rest.replace(AMT_DEC_G, ' ');
    recs.push({ date: d, desc: desc.trim(), amt: nums.length >= 2 ? nums[nums.length - 2] : nums[nums.length - 1],
                bal: nums.length >= 2 ? nums[nums.length - 1] : null, type: null });
  }
  const score = order => {
    let ok = 0;
    for (let i = 0; i + 1 < recs.length; i++) {
      const a = recs[i], b = recs[i + 1];
      const [cur, prv] = order === 'asc' ? [b, a] : [a, b];
      if (cur.bal !== null && prv.bal !== null && Math.abs(Math.abs(cur.bal - prv.bal) - cur.amt) < 1) ok++;
    }
    return ok;
  };
  const order = score('asc') >= score('desc') ? 'asc' : 'desc';
  recs.forEach((r, i) => {
    const j = order === 'asc' ? i - 1 : i + 1;
    const p = (j >= 0 && j < recs.length) ? recs[j] : null;
    if (p && p.bal !== null && r.bal !== null && Math.abs(Math.abs(r.bal - p.bal) - r.amt) < 1)
      r.type = r.bal > p.bal ? 'credit' : 'debit';
  });
  for (const r of recs) {
    if (!r.type) {
      const up = r.desc.toUpperCase();
      if (/\bDR\b|UPI\/DR/.test(up) || (DEBIT_KW.test(up) && !CREDIT_KW.test(up))) r.type = 'debit';
      else if (CREDIT_KW.test(up) || up.includes('ZOMATO') || up.includes('SWIGGY')) r.type = 'credit';
    }
  }
  recs = recs.filter(r => r.type);
  recs.sort((a, b) => a.date - b.date);
  return recs;
}

function holderName(rows) {
  const re = /(?:account\s*(?:holder|name)|customer\s*name|name)\s*[:\-]\s*(?:m[rs]s?\.?\s+)?([A-Za-z][A-Za-z .]{2,40})/i;
  for (const ln of rows.slice(0, 40)) {
    const m = re.exec(ln);
    if (m) return title(m[1].trim());
  }
  return null;
}

// ------------------------------------------------------------ earnings screenshots
function firstAmt(text) {
  const m = AMT_ANY.exec(text.replace(/\b\d{1,2}\s+[A-Za-z]{3}\b/g, ' '));
  return m ? num(m[0]) : null;
}
function findAmt(rows, label) {
  const re = new RegExp(label, 'i');
  for (let i = 0; i < rows.length; i++) {
    const m = re.exec(rows[i]);
    if (m) {
      const v = firstAmt(rows[i].slice(m.index + m[0].length)) || (i + 1 < rows.length ? firstAmt(rows[i + 1]) : null);
      if (v) return v;
    }
  }
  return null;
}

function parseEarn(rows, hint) {
  const low = rows.join('\n').toLowerCase();
  const plat = low.includes('zomato') ? 'zomato' : low.includes('swiggy') ? 'swiggy' : hint;
  let total = null;
  for (const pat of ['total\\s+(?:earnings?|payouts?)', '(?:net|weekly|monthly|month|week)\\s*(?:earnings?|payouts?)', 'payouts?', 'earnings?']) {
    total = findAmt(rows, pat);
    if (total) break;
  }
  let orders = null;
  let m = /(?:orders?|deliveries|trips)\D{0,12}?(\d{1,4})\b/.exec(low) || /\b(\d{1,4})\s+(?:orders?|deliveries|trips)/.exec(low);
  if (m) orders = parseInt(m[1], 10);
  let days = null;
  m = /(?:active|working|worked|login)\s*days?\D{0,8}(\d{1,2})\b/.exec(low) || /\b(\d{1,2})\s*(?:active|working)\s*days/.exec(low);
  if (m) days = parseInt(m[1], 10);
  const daily = new Map();
  const keyRe = /\b\d{1,2}\s*[A-Za-z]{3}\b|\b[A-Za-z]{3}\s*\d{1,2}\b|\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/;
  for (const ln of rows) {
    if (/total|incentive|tip|bonus/i.test(ln)) continue;
    const key = keyRe.exec(ln);
    if (key) {
      const v = firstAmt(ln.split(key[0]).join(' '));
      if (v && v > 20) daily.set(key[0].toLowerCase(), v);
    }
  }
  const dvals = [...daily.values()];
  if (!total && dvals.length) total = sum(dvals);

  // Most reliable source of the statement's period: the actual dated rows we already parsed
  // (e.g. "1 aug" .. "31 aug"), rather than pattern-matching a date range out of prose text -
  // free text can contain misleading matches (e.g. "WEEK 1-4" inside an incentive line).
  let spanFromRows = null;
  const dayKeys = [...daily.keys()];
  if (dayKeys.length >= 2) {
    const stamps = [];
    for (const k of dayKeys) {
      let mm = /^(\d{1,2})\s*([a-z]{3})/.exec(k), d_, mo_;
      if (mm && MONTHS[mm[2]]) { d_ = parseInt(mm[1], 10); mo_ = MONTHS[mm[2]]; }
      else { mm = /^([a-z]{3})\s*(\d{1,2})/.exec(k); if (mm && MONTHS[mm[1]]) { d_ = parseInt(mm[2], 10); mo_ = MONTHS[mm[1]]; } }
      if (d_ && mo_) stamps.push(Date.UTC(2000, mo_ - 1, d_));
    }
    if (stamps.length >= 2) spanFromRows = Math.round((Math.max(...stamps) - Math.min(...stamps)) / 86400000) + 1;
  }

  let span = null;
  if (spanFromRows) {
    span = spanFromRows;
  } else {
    m = /(\d{1,2})\s*([a-z]{3})\w*(?:\s*,?\s*\d{4})?\s*(?:-|–|to)\s*(\d{1,2})\s*([a-z]{3})/.exec(low);
    if (m && MONTHS[m[2]] && MONTHS[m[4]]) {
      const a = Date.UTC(2000, MONTHS[m[2]] - 1, parseInt(m[1], 10)), b = Date.UTC(2000, MONTHS[m[4]] - 1, parseInt(m[3], 10));
      const dd = dayDiff(b, a);
      span = (((dd % 366) + 366) % 366) + 1;
    } else if (/\bweek(?:ly)?\b/.test(low) && !/\bweek\s*\d/.test(low)) span = 7;
    else if (low.includes('today') || low.includes('yesterday')) span = 1;
    else if (low.includes('month')) span = 30;
  }
  const periodKnown = span !== null;
  span = span || 30;
  days = days || (dvals.length || null);
  return { platform: plat, total, orders, days, daily: dvals, periodDays: span, periodKnown,
           monthly: total ? pyRound(total * 30 / span) : 0 };
}

// ------------------------------------------------------------ profile + score
function buildProfile(bankRows, earns, notes) {
  const now = new Date(), p2 = n => String(n).padStart(2, '0');
  const a = { id: 'GW-' + p2(now.getDate()) + p2(now.getHours()) + p2(now.getMinutes()), name: holderName(bankRows) || 'Applicant',
              age: null, role: 'Delivery Partner', existingEMI: 0, failedPayments: 0, avgBalance: 0 };
  const txns = bankRows.length ? parseBank(bankRows) : [];
  let monthly = [], vol = null, weeksActive = null, weeksTotal = null;
  const src = {};
  if (txns.length) {
    const first = txns[0].date, last = txns[txns.length - 1].date;
    const days = dayDiff(last, first) + 1;
    const span = Math.max(days / 30.4, 0.25);
    if (days < 25) notes.push(`Statement covers only ${days} day(s); monthly figures are extrapolated - upload a longer statement for a firmer score.`);
    const per = {};
    const inc = []; let emi = 0, exp = 0;
    for (const t of txns) {
      const up = t.desc.toUpperCase().replace(/[^A-Z0-9/]/g, ''), k = ym(t.date);
      if (!per[k]) per[k] = { credits: 0, debits: 0, gig: 0 };
      if (BOUNCE_KW.test(up)) a.failedPayments += 1;
      if (t.type === 'credit') {
        per[k].credits += t.amt;
        if (EXCLUDE_IN.test(up)) continue;
        const s = up.includes('ZOMATO') ? 'zomato' : up.includes('SWIGGY') ? 'swiggy' : 'other';
        src[s] = (src[s] || 0) + t.amt;
        if (s !== 'other') per[k].gig += t.amt;
        inc.push([dayDiff(t.date, first), t.amt, s !== 'other']);
      } else {
        per[k].debits += t.amt;
        if (/SELF|OWNACC/.test(up)) continue;
        if (EMI_KW.test(up)) emi += t.amt; else exp += t.amt;
      }
    }
    a.existingEMI = pyRound(emi / span);
    a.monthlyExpenses = pyRound(exp / span);
    a.transactions = txns.length;
    a.historyMonths = Math.max(1, pyRound(days / 30.4));
    const keys = Object.keys(per).sort();
    monthly = keys.map(k => ({ month: k, credits: pyRound(per[k].credits), debits: pyRound(per[k].debits), gig: pyRound(per[k].gig) }));
    const gigOnly = inc.filter(i => i[2]);
    const use = gigOnly.length ? gigOnly : inc;
    const bucket = size => {
      const n = Math.max(1, Math.floor((days + size - 1) / size)), b = {};
      for (const [d_, amt] of use) { const w = Math.floor(d_ / size); b[w] = (b[w] || 0) + amt; }
      const out = []; for (let w = 0; w < n; w++) out.push(b[w] || 0);
      return [n, out];
    };
    const [nweeks, wseries] = bucket(7);
    weeksTotal = nweeks; weeksActive = wseries.filter(v => v > 0).length;
    const series = keys.length >= 3 ? keys.map(k => per[k].credits) : bucket(14)[1];
    const c = cv(series);
    vol = c !== null ? pyRound(c * 100) : null;
    a._bank_income_month = {};
    for (const s of Object.keys(src)) a._bank_income_month[s] = pyRound(src[s] / span);
  }
  return [a, txns, monthly, vol, weeksActive, weeksTotal];
}

function detectEarningsPlatform(rows) {       // returns 'zomato' | 'swiggy' | null if this looks like a
  const low = rows.join('\n').toLowerCase();   // gig-platform payout statement, not a bank statement
  const plat = low.includes('zomato') ? 'zomato' : low.includes('swiggy') ? 'swiggy' : null;
  if (!plat) return null;
  const looksLikePayoutDoc = /payout|trip payout|delivery partner|order summary|earnings? statement/.test(low);
  if (!looksLikePayoutDoc) return null;
  // Bank statements from these platforms' own bank would mention "a/c", IFSC, running balance, etc.
  // A partner payout statement won't have a running "balance" column - use that as a tie-breaker.
  const looksLikeBankStatement = /\bifsc\b|running balance|closing balance|a\/c\s*no/.test(low);
  return looksLikeBankStatement ? null : plat;
}

function assemble(files) {                   // files: [{slot, name, rows}] -> {status, body}
  const notes = [], preview = {};
  const bankRows = [], earns = [];
  for (const f of files) {
    if (f.error) { notes.push(`Could not read ${f.name}: ${f.error}`); continue; }
    preview[f.name] = f.rows.slice(0, 60);
    const detected = f.slot === 'bank' ? detectEarningsPlatform(f.rows) : null;
    if (detected) {
      notes.push(`${f.name} looked like a ${title(detected)} payout statement (not a bank statement), so it was read as earnings instead.`);
      earns.push(parseEarn(f.rows, detected));
    } else if (f.slot === 'bank') {
      f.rows.forEach(r => bankRows.push(r));
    } else {
      earns.push(parseEarn(f.rows, f.slot));
    }
  }
  if (!bankRows.length && !earns.length)
    return { status: 400, body: { error: notes.length ? notes.join(' ') : 'No readable file received. Upload at least one bank statement or earnings screenshot.' } };

  const [a, txns, monthly, volIn, wa, wt] = buildProfile(bankRows, earns, notes);
  let vol = volIn;
  if (bankRows.length && !txns.length)
    notes.push('Bank statement text was read, but no transaction rows (date + amount) could be recognised. Try a sharper/cropped screenshot or a PDF.');
  const bankSrc = a._bank_income_month || {}; delete a._bank_income_month;
  const bal = txns.filter(t => t.bal !== null).map(t => t.bal);
  a.avgBalance = bal.length ? pyRound(mean(bal)) : 0;
  const shot = {};
  for (const e of earns) {
    shot[e.platform] = (shot[e.platform] || 0) + e.monthly;
    if (!e.periodKnown && e.total) notes.push(`${title(e.platform)} screenshot: period not visible, assumed the amount covers 30 days.`);
  }
  const sources = [];
  for (const [s, label] of [['zomato', 'Zomato payouts'], ['swiggy', 'Swiggy payouts']]) {
    const amt = bankSrc[s] || pyRound(shot[s] || 0);
    if (amt) sources.push({ name: label, amount: amt });
  }
  if (bankSrc.other) sources.push({ name: 'Other credits (non-platform)', amount: bankSrc.other });
  a.incomeSources = sources;
  a.monthlyIncome = sum(sources.map(s => s.amount));
  a.activeSources = sources.length;
  a.platforms = sources.filter(s => s.name.includes('payouts')).map(s => s.name.split(' ')[0]).join(' \u00b7 ') || 'Gig platform';
  if (a.transactions === undefined) a.transactions = 0;
  if (a.historyMonths === undefined) a.historyMonths = 1;
  if (a.monthlyExpenses === undefined) {
    a.monthlyExpenses = pyRound(a.monthlyIncome * 0.55);
    notes.push('No bank statement: monthly expenses are ASSUMED at 55% of income. Edit them in step 2.');
  }
  if (vol === null) {
    const dl = []; earns.forEach(e => e.daily.forEach(d => dl.push(d)));
    const c = cv(dl); vol = c !== null ? pyRound(c * 100) : 20;
    if (c === null) notes.push('Not enough data to measure income variation; assumed 20%.');
  }
  a.volatilityPct = clamp(vol, 0, 100);
  a.incomeConsistencyPct = pyRound(100 - a.volatilityPct);
  a.tenureMonths = a.historyMonths;
  const inc = Math.max(a.monthlyIncome, 1);
  const disp = a.monthlyIncome - a.monthlyExpenses - a.existingEMI;
  let cont;
  if (wt) cont = 100 * wa / wt;
  else {
    const d = earns.filter(e => e.days);
    cont = d.length ? clamp(100 * sum(d.map(e => e.days)) / sum(d.map(e => e.periodDays))) : 60;
  }
  const cushion = clamp(a.avgBalance / (0.5 * inc) * 100);
  const comps = [
    { label: 'Income stability', weight: 30, score: pyRound(a.incomeConsistencyPct) },
    { label: 'Repayment capacity', weight: 25, score: pyRound(clamp(disp / inc / 0.4 * 100)) },
    { label: 'Work continuity', weight: 20, score: pyRound(clamp(cont)) },
    { label: 'Debt burden', weight: 15, score: pyRound(clamp(100 - a.existingEMI / inc * 250)) },
    { label: 'Financial behaviour', weight: 10, score: pyRound((clamp(100 - 20 * a.failedPayments) + cushion) / 2) },
  ];
  const earnings = earns.map(e => { const o = Object.assign({}, e); delete o.daily; o.dailyEntries = e.daily.length; return o; });
  return { status: 200, body: { applicant: a, scoreComponents: comps, monthly, notes, preview, earnings } };
}

// ------------------------------------------------------------ local OCR + PDF (browser only)
let _workerP = null;
function getWorker() {
  if (!root.Tesseract) throw new Error('Tesseract not available');
  if (!_workerP) {
    _workerP = (async () => {
      const w = await root.Tesseract.createWorker('eng');
      await w.setParameters({ tessedit_pageseg_mode: '11' });     // sparse text: finds text scattered over a screenshot
      return w;
    })();
    _workerP.catch(() => { _workerP = null; });
  }
  return _workerP;
}

function prepCanvas(c) {                     // make dark-mode screenshots readable (dark background -> light)
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  let tot = 0, n = 0;
  for (let i = 0; i < d.length; i += 40) { tot += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; n++; }
  const invert = n && tot / n < 110;
  for (let i = 0; i < d.length; i += 4) {
    let g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function ocrRows(canvas) {
  const w = await getWorker();
  const { data } = await w.recognize(canvas);
  let lines = data.lines;
  if (!lines || !lines.length) {
    lines = [];
    (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => lines.push(l))));
  }
  const items = [];
  for (const l of lines) {
    const t = (l.text || '').replace(/\s+/g, ' ').trim();
    if (!t || (l.confidence !== undefined && l.confidence < 15)) continue;
    const bb = l.bbox;
    items.push([(bb.y0 + bb.y1) / 2, bb.x0, bb.y1 - bb.y0, t]);
  }
  if (!items.length) return [];
  items.sort((a, b) => a[0] - b[0]);
  const h = median(items.map(t => t[2])) || 10;
  const rows = [];
  for (const it of items) {
    if (rows.length && Math.abs(it[0] - rows[rows.length - 1][0]) < h * 0.6) rows[rows.length - 1][1].push(it);
    else rows.push([it[0], [it]]);
  }
  return rows.map(r => r[1].sort((a, b) => a[1] - b[1]).map(t => t[3]).join('  '));
}

async function imageRows(file) {
  const bmp = await createImageBitmap(file);
  let scale = bmp.width < 900 ? 2 : 1;
  if (bmp.width * scale > 3000) scale = 3000 / bmp.width;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return ocrRows(prepCanvas(c));
}

function pdfTextLines(items) {               // rebuild visual text lines from pdf.js text runs
  const its = items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: i.height || 10 }));
  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of its) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.y - it.y) <= Math.max(2, it.h * 0.4)) L.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines.map(L => {
    L.items.sort((a, b) => a.x - b.x);
    let out = '', prevEnd = null;
    for (const it of L.items) {
      if (prevEnd !== null) { const gap = it.x - prevEnd; out += gap < it.h * 0.15 ? '' : gap < it.h ? ' ' : '  '; }
      out += it.s.trim() === it.s ? it.s : it.s.trim();
      prevEnd = it.x + it.w;
    }
    return out.trim();
  }).filter(Boolean);
}

async function pdfRows(file) {
  if (!root.pdfjsLib) throw new Error('pdf.js not available');
  const data = new Uint8Array(await file.arrayBuffer());
  const task = root.pdfjsLib.getDocument({ data });
  task.onPassword = (update, reason) => {
    const p = root.prompt(reason === 2 ? 'Wrong password. Try again (Cancel to skip this file):'
                                       : '"' + file.name + '" is password protected. Enter the password:');
    if (p === null) task.destroy(); else update(p);
  };
  const pdf = await task.promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const lines = pdfTextLines((await page.getTextContent()).items);
    if (lines.join('\n').trim().length > 40) { lines.forEach(l => out.push(l)); continue; }
    const vp = page.getViewport({ scale: 2 });                     // scanned page: render it and OCR it
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    (await ocrRows(prepCanvas(c))).forEach(l => out.push(l));
  }
  return out;
}

// ------------------------------------------------------------ document transcription (Claude vision fallback)
async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read ' + (file.name || 'file') + ' from disk.'));
    r.readAsDataURL(file);
  });
}

const TRANSCRIBE_PROMPT = [
  'Transcribe every line of visible text in this document, top to bottom, exactly as printed.',
  'Keep every date, amount, label and number - do not summarise, round, or skip rows, including repeated dates.',
  'If any part is a table, put each row on its own output line with its cell values separated by " | ".',
  'Output ONLY the transcribed lines, one per line. No headings, no commentary, no markdown fences, no numbering.',
].join(' ');

async function visionRows(file) {
  const isPdf = /\.pdf$/i.test(file.name || '') || file.type === 'application/pdf';
  const b64 = await fileToBase64(file);
  if (!b64) return [];
  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: file.type || 'image/png', data: b64 } };
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: TRANSCRIBE_PROMPT }] }],
      }),
    });
  } catch (e) {
    throw new Error('Could not reach the transcription service. Check your internet connection and try again.');
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (_) {}
    throw new Error('Could not read ' + (file.name || 'file') + ': ' + msg);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

async function fileRows(f) {
  const isPdf = /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';
  try {
    const rows = await (isPdf ? pdfRows(f) : imageRows(f));
    if (rows.length) return rows;
    throw new Error('Local OCR returned no text');            // treat empty result as a failure too, and fall back
  } catch (localErr) {
    try {
      return await visionRows(f);
    } catch (visionErr) {
      // Both paths failed - surface whichever error is more informative to the person.
      throw new Error(
        /not available/i.test(String(localErr.message))
          ? visionErr.message                                  // local libraries never even loaded - vision's error is the real story
          : `${localErr.message}; fallback also failed: ${visionErr.message}`
      );
    }
  }
}

// Same contract the old backend had: takes the FormData, resolves to a fetch-like response.
async function localExtract(fd) {
  const files = [];
  for (const slot of ['bank', 'zomato', 'swiggy']) {
    for (const f of fd.getAll(slot)) {
      if (!f || !f.size) continue;
      try { files.push({ slot, name: f.name, rows: await fileRows(f) }); }
      catch (e) { files.push({ slot, name: f.name, error: (e && e.message) || String(e) }); }
    }
  }
  const r = assemble(files);
  return { ok: r.status === 200, status: r.status, json: async () => r.body };
}

root.CredSathiEngine = { assemble, parseBank, parseEarn, parseDate, localExtract };
root.localExtract = localExtract;
})(typeof window !== 'undefined' ? window : globalThis);
