// ═══════════════════════════════════════════════════════════════
//  PHC CRM — Google Apps Script API
//  Sheets: Tasks | Leads | Clients | Deals | Partners
//
//  HOW TO DEPLOY:
//  1. Open your PHC CRM Google Sheet
//  2. Extensions → Apps Script → paste this entire file
//  3. Run initializeAll() once (creates + formats all tabs)
//  4. Deploy → New Deployment → Web App
//     • Execute as: Me
//     • Who has access: Anyone
//  5. Copy the Web App URL → paste into each tool's settings
//
//  NOTE (2026-08-12): LOGO_DATA_URI and the three ICON_*_GOLD/NAVY
//  constants below are PLACEHOLDERS. Their real values are long
//  base64-encoded images that live only in the deployed Apps Script —
//  they were never fully captured here (screenshots / paste-size limits).
//  DO NOT paste this file over the live one without first copying the
//  real values for those four constants from the live editor, or every
//  email image will break.
// ═══════════════════════════════════════════════════════════════

const SHEET_HEADERS = {
  Tasks: [
    'id', 'name', 'status', 'priority', 'category',
    'due', 'assignees', 'memo', 'link', 'createdAt', 'updatedAt'
  ],
  Leads: [
    'id', 'createdAt', 'updatedAt', 'fullName', 'nationality',
    'phone', 'telegram', 'email', 'source', 'budget', 'timeline',
    'interestedIn', 'stage', 'score', 'agent', 'referralPartner', 'notes',
    'lastContact', 'followUpDate', 'followUpAction', 'activities'
  ],
  Clients: [
    'id', 'createdAt', 'updatedAt', 'name', 'nat',
    'telegram', 'phone', 'project', 'unit', 'floor',
    'bookingDate', 'spa', 'titleStatus', 'payDay', 'payAmount',
    'payTotal', 'payMade', 'bank', 'status', 'referralPartner', 'notes'
  ],
  Deals: [
    'id', 'createdAt', 'updatedAt', 'closedDate', 'clientName',
    'project', 'unit', 'salePrice', 'commissionRate', 'commissionTotal',
    'referralPartner', 'partnerPct', 'partnerAmt',
    'nickPct', 'monikaPct', 'rezaPct', 'nickAmt', 'monikaAmt', 'rezaAmt',
    'agent', 'notes'
  ],
  // Registry of approved referral partners — a ?ref= code only counts as
  // a real, credited partner if it has an 'Approved' row here. Anything
  // else still shows up in alerts (so staff aren't blind to it) but
  // clearly marked unverified, never silently swallowed or silently
  // treated as legitimate.
  Partners: [
    'id', 'createdAt', 'updatedAt', 'slug', 'displayName', 'ratePct',
    'status', 'contactName', 'contactPhone', 'contactEmail', 'notes'
  ]
};

// ── HTTP entry points ────────────────────────────────────────────

// Set an API_KEY value in Project Settings → Script Properties to require
// every request to include a matching ?key=... (GET) or {key:...} (POST).
// Deliberately fails OPEN (allows the request) if no API_KEY property has
// been set yet, so deploying this code can never lock you out of your own
// tools mid-rollout — it only enforces once you've actually set the key.
function isAuthorized_(providedKey) {
  const required = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!required) return true;
  return providedKey === required;
}

function doGet(e) {
  try {
    const p = e.parameter || {};
    if (!isAuthorized_(p.key)) return respond({ error: 'Unauthorized' });
    if (p.action === 'ping')   return respond({ ok: true, ts: new Date().toISOString() });
    if (p.action === 'getAll') return respond(getAllRows(p.sheet || 'Tasks'));
    return respond({ error: 'Unknown action: ' + p.action });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

function doPost(e) {
  try {
    const body  = JSON.parse(e.postData.contents);
    if (!isAuthorized_(body.key)) return respond({ error: 'Unauthorized' });
    const sheet = body.sheet || 'Tasks';
    if (body.action === 'insert') return respond(insertRow(sheet, body.data));
    if (body.action === 'update') return respond(updateRow(sheet, body.id, body.data));
    if (body.action === 'delete') return respond(deleteRow(sheet, body.id));
    return respond({ error: 'Unknown action: ' + body.action });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Sheet helpers ────────────────────────────────────────────────

function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const headers = SHEET_HEADERS[name];
    if (headers) {
      const lastCol = headers.length;
      sheet.getRange(1, 1, 1, lastCol).setValues([headers]);
      sheet.getRange(1, 1, 1, lastCol)
        .setBackground('#083467')
        .setFontColor('#ffffff')
        .setFontWeight('bold')
        .setFontSize(10);
      sheet.setFrozenRows(1);
      // Banding — column letter from count (works for ≤26 columns)
      const lastColLetter = String.fromCharCode(64 + lastCol);
      sheet.getRange('A2:' + lastColLetter + '1000')
        .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
    }
  }
  return sheet;
}

// ── CRUD (generic) ───────────────────────────────────────────────

function getAllRows(sheetName) {
  const sheet = getOrCreateSheet(sheetName);
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1)
    .filter(row => row[0] !== '' && row[0] !== null && row[0] !== undefined)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        const v = row[i];
        obj[h] = (v instanceof Date)
          ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : (v === null || v === undefined ? '' : String(v));
      });
      return obj;
    });
}

function insertRow(sheetName, data) {
  if (!data || !data.id) return { error: 'Missing id' };
  const headers = SHEET_HEADERS[sheetName];
  if (!headers) return { error: 'Unknown sheet: ' + sheetName };
  const sheet = getOrCreateSheet(sheetName);
  const now = new Date().toISOString();
  data.createdAt = data.createdAt || now;
  data.updatedAt = now;
  const row = headers.map(h => {
    const v = data[h];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v); // arrays → JSON string
    return v;
  });
  const nextRow = sheet.getLastRow() + 1;
  sheet.appendRow(row);

  // Force phone column to text format — prevents +country codes being parsed as formulas
  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx !== -1) {
    const phoneCell = sheet.getRange(nextRow, phoneIdx + 1);
    phoneCell.setNumberFormat('@STRING@');
    phoneCell.setValue(String(row[phoneIdx]));
  }

  // Trigger confirmation email to client + alert to agent
  if (sheetName === 'Leads') {
    try { sendConfirmationEmails(data); } catch(err) { Logger.log('Email error: ' + err); }
    try { sendTelegramAlert(data); } catch(err) { Logger.log('Telegram error: ' + err); }
  }

  return { success: true, id: data.id };
}

function updateRow(sheetName, id, data) {
  if (!id) return { error: 'Missing id' };
  const headers = SHEET_HEADERS[sheetName];
  if (!headers) return { error: 'Unknown sheet: ' + sheetName };
  const sheet   = getOrCreateSheet(sheetName);
  const allData = sheet.getDataRange().getValues();
  const sheetHdrs = allData[0];
  const idIdx = sheetHdrs.indexOf('id');

  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][idIdx]) === String(id)) {
      data.updatedAt = new Date().toISOString();
      const updatedRow = sheetHdrs.map((h, colIdx) => {
        if (data[h] !== undefined && data[h] !== null) {
          const v = data[h];
          return typeof v === 'object' ? JSON.stringify(v) : v;
        }
        return allData[i][colIdx];
      });
      sheet.getRange(i + 1, 1, 1, sheetHdrs.length).setValues([updatedRow]);
      return { success: true };
    }
  }
  return { error: 'Row not found: ' + id };
}

function deleteRow(sheetName, id) {
  if (!id) return { error: 'Missing id' };
  const sheet   = getOrCreateSheet(sheetName);
  const allData = sheet.getDataRange().getValues();
  const headers = allData[0];
  const idIdx   = headers.indexOf('id');

  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][idIdx]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { error: 'Row not found: ' + id };
}

// ── Backward-compatible aliases (Task Manager v4 still works) ────

function getTasksSheet() { return getOrCreateSheet('Tasks'); }
function getAllTasks()    { return getAllRows('Tasks'); }
function insertTask(d)   { return insertRow('Tasks', d); }
function updateTask(id, d) { return updateRow('Tasks', id, d); }
function deleteTask(id)  { return deleteRow('Tasks', id); }

// ── One-time setup ────────────────────────────────────────────────

/**
 * Run this ONCE from the Apps Script editor after pasting.
 * Creates and formats all tabs.
 */
function initializeAll() {
  ['Tasks', 'Leads', 'Clients', 'Deals', 'Partners'].forEach(name => {
    const sheet = getOrCreateSheet(name);
    Logger.log('✅ ' + name + ' ready — rows: ' + sheet.getLastRow());
  });
}

// Alias so old initializeTasks() calls still work
function initializeTasks() { initializeAll(); }

// ── Schema migration ──────────────────────────────────────────────

/**
 * Run once after adding 'telegram' to Leads SHEET_HEADERS.
 * Inserts the new column after 'phone' without destroying existing data.
 */
function migrateLeadsSchema() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Leads');
  if (!sheet) { Logger.log('❌ Leads sheet not found'); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.includes('telegram')) {
    Logger.log('✅ telegram column already exists — no migration needed');
    return;
  }

  const phoneIdx = headers.indexOf('phone'); // 0-based
  if (phoneIdx === -1) { Logger.log('❌ phone column not found'); return; }

  // Insert blank column after phone (Sheets column = 1-based, so +2)
  sheet.insertColumnAfter(phoneIdx + 1);
  sheet.getRange(1, phoneIdx + 2).setValue('telegram');

  // Re-apply header style to the new cell
  sheet.getRange(1, phoneIdx + 2)
    .setBackground('#083467')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(10);

  Logger.log('✅ telegram column added to Leads at position ' + (phoneIdx + 2));
}

/**
 * Run once after adding 'referralPartner' to Leads SHEET_HEADERS.
 * Inserts the new column after 'agent' without destroying existing data.
 */
function migrateLeadsSchemaForReferral() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Leads');
  if (!sheet) { Logger.log('❌ Leads sheet not found'); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.includes('referralPartner')) {
    Logger.log('✅ referralPartner column already exists on Leads — no migration needed');
    return;
  }

  const agentIdx = headers.indexOf('agent'); // 0-based
  if (agentIdx === -1) { Logger.log('❌ agent column not found'); return; }

  sheet.insertColumnAfter(agentIdx + 1);
  sheet.getRange(1, agentIdx + 2).setValue('referralPartner');
  sheet.getRange(1, agentIdx + 2)
    .setBackground('#083467')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(10);

  Logger.log('✅ referralPartner column added to Leads at position ' + (agentIdx + 2));
}

/**
 * Run once after adding 'referralPartner', 'partnerPct', 'partnerAmt' to
 * Deals SHEET_HEADERS. Inserts them after 'commissionTotal' without
 * destroying existing data.
 */
function migrateDealsSchemaForReferral() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Deals');
  if (!sheet) { Logger.log('❌ Deals sheet not found'); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.includes('referralPartner')) {
    Logger.log('✅ referralPartner column already exists on Deals — no migration needed');
    return;
  }

  const afterIdx = headers.indexOf('commissionTotal'); // 0-based
  if (afterIdx === -1) { Logger.log('❌ commissionTotal column not found'); return; }

  const newCols = ['referralPartner', 'partnerPct', 'partnerAmt'];
  let insertAt = afterIdx + 1; // 1-based column to insert after
  newCols.forEach(col => {
    sheet.insertColumnAfter(insertAt);
    sheet.getRange(1, insertAt + 1).setValue(col)
      .setBackground('#083467').setFontColor('#ffffff').setFontWeight('bold').setFontSize(10);
    insertAt++;
  });

  Logger.log('✅ referralPartner/partnerPct/partnerAmt columns added to Deals starting at position ' + (afterIdx + 2));
}

/**
 * Run once after adding 'referralPartner' to Clients SHEET_HEADERS.
 * Without this, a lead's referral attribution has nowhere to land when
 * staff manually promote a Lead to a Client — it would only survive to
 * the eventual Deal if someone remembers to re-type it in by hand weeks
 * or months later. Inserts the column after 'status' without destroying
 * existing data.
 */
function migrateClientsSchemaForReferral() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Clients');
  if (!sheet) { Logger.log('❌ Clients sheet not found'); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.includes('referralPartner')) {
    Logger.log('✅ referralPartner column already exists on Clients — no migration needed');
    return;
  }

  const afterIdx = headers.indexOf('status'); // 0-based
  if (afterIdx === -1) { Logger.log('❌ status column not found'); return; }

  sheet.insertColumnAfter(afterIdx + 1);
  sheet.getRange(1, afterIdx + 2).setValue('referralPartner');
  sheet.getRange(1, afterIdx + 2)
    .setBackground('#083467')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(10);

  Logger.log('✅ referralPartner column added to Clients at position ' + (afterIdx + 2));
}

/**
 * Run once after adding the Partners sheet. Seeds the three partners
 * already live in production (reza/leif/nick) as pre-approved, so their
 * existing referral links keep working the moment this ships — without
 * this, formatReferralLabel_() would suddenly mark them "unverified"
 * even though they were already agreed and active.
 */
function seedInitialPartners() {
  const sheet = getOrCreateSheet('Partners');
  const existing = getAllRows('Partners');
  const seeds = [
    { slug: 'reza', displayName: 'Reza', ratePct: '33.33' },
    { slug: 'leif', displayName: 'Leif', ratePct: '33.33' },
    { slug: 'nick', displayName: 'Nick', ratePct: '33.33' },
  ];
  let added = 0;
  seeds.forEach(seed => {
    if (existing.some(r => (r.slug || '').toLowerCase() === seed.slug)) return;
    const now = new Date().toISOString();
    insertRow('Partners', {
      id: 'P-' + seed.slug + '-' + Date.now(),
      createdAt: now, updatedAt: now,
      slug: seed.slug, displayName: seed.displayName, ratePct: seed.ratePct,
      status: 'Approved', contactName: '', contactPhone: '', contactEmail: '',
      notes: 'Seeded — already live before the Partners registry existed.',
    });
    added++;
  });
  Logger.log('✅ Partners seeded: ' + added + ' added, ' + (seeds.length - added) + ' already existed');
}

// ═══════════════════════════════════════════════════════════════
//  CONFIRMATION EMAIL SYSTEM
//
//  Fires automatically on every new Lead insert.
//  Sends: (1) branded confirmation to client, (2) lead alert to team.
//
//  SETUP NOTE:
//  GmailApp sends from the Google account that owns this Apps Script.
//  To send from invest@propertyhubcambodia.com, either:
//    a) Paste + deploy this script while logged in as that account, OR
//    b) Add invest@propertyhubcambodia.com as a "Send mail as" alias in
//       Gmail Settings → Accounts and Import, then verify it.
// ═══════════════════════════════════════════════════════════════

// Confirmed live 2026-08-12.
const FROM_EMAIL  = 'invest@propertyhubcambodia.com';
const WA_NUMBER   = '85511666952';
const AGENT_EMAIL = 'invest@propertyhubcambodia.com,propertyhubcambodia@gmail.com,narithkgame2@gmail.com';
// These two also get a plain copy of the exact client-facing email (not
// just the Agent Alert) — useful for checking the actual wording/quality
// without digging through the CRM. invest@ is left out since it already
// gets the Agent Alert and doesn't need a second copy. Sent as separate
// solo emails in sendClientConfirmation() below, never one bcc'd email —
// GmailApp leaks the full bcc list to every bcc'd recipient's own inbox
// once there's more than one address, so nobody would see the other's.
const CLIENT_COPY_RECIPIENTS = ['propertyhubcambodia@gmail.com', 'narithkgame2@gmail.com'];

// PLACEHOLDER — see file-header note. Real value is a long base64 PNG,
// never fully captured here. DO NOT deploy this file until these four
// constants are replaced with the real values copied from the live editor.
const LOGO_DATA_URI = 'data:image/png;base64,__PLACEHOLDER_COPY_FROM_LIVE_EDITOR__';

// PLACEHOLDER — same caveat as LOGO_DATA_URI above.
const ICON_PHONE_GOLD = 'data:image/png;base64,__PLACEHOLDER_COPY_FROM_LIVE_EDITOR__'; // for the gold CTA button
const ICON_PHONE_NAVY = 'data:image/png;base64,__PLACEHOLDER_COPY_FROM_LIVE_EDITOR__';
const ICON_PIN_GOLD   = 'data:image/png;base64,__PLACEHOLDER_COPY_FROM_LIVE_EDITOR__';

// ── Orchestrator ──────────────────────────────────────────────────

function sendConfirmationEmails(lead) {
  const scenario = detectScenario(lead);
  const lang     = detectLang(lead);
  if (lead.email && lead.email.indexOf('@') !== -1) {
    try { sendClientConfirmation(lead, scenario, lang); }
    catch (err) { Logger.log('Client confirmation email error: ' + err); }
  }
  try { sendAgentNotification(lead, scenario, lang); }
  catch (err) { Logger.log('Agent notification email error: ' + err); }
}

// ── Telegram lead alert ────────────────────────────────────────────
// Token/chat ID are read from Script Properties (Project Settings →
// Script Properties in the Apps Script editor) — never hardcoded here.

function scoreTag_(score) {
  const n = Number(score) || 0;
  if (n >= 5) return 'VIP';
  if (n >= 4) return 'A';
  if (n >= 3) return 'B';
  return 'C';
}

function telegramLangLabel_(nationality) {
  if (nationality === 'Japanese')  return 'JP';
  if (nationality === 'German')    return 'DE';
  if (nationality === 'Cambodian') return 'KH';
  return 'EN';
}

// Looks up a ?ref= slug against the Partners sheet. Returns null only if
// the slug matches no row at all; otherwise returns the row data
// (including status), so callers can distinguish "not a partner" from
// "a partner, but not yet approved."
function getPartnerInfo_(slug) {
  if (!slug) return null;
  const rows = getAllRows('Partners');
  const match = rows.find(r => (r.slug || '').toLowerCase() === slug.toLowerCase());
  return match || null;
}

// Referral attribution should never be silently swallowed OR silently
// trusted — an approved partner shows their real name; anything else
// (typo, unapproved code, someone testing) still shows up but clearly
// marked, so staff know it happened without treating it as a credited
// partner referral.
function formatReferralLabel_(slug) {
  if (!slug) return '';
  const partner = getPartnerInfo_(slug);
  if (partner && partner.status === 'Approved') return partner.displayName || slug;
  const niceSlug = slug.charAt(0).toUpperCase() + slug.slice(1);
  return niceSlug + ' (unverified — not an approved partner)';
}

// Telegram's legacy Markdown parser treats a lone _ * ` [ as the start of
// formatting — one unescaped underscore (e.g. a name like "Chan_Dara" or an
// email like "john_doe@gmail.com") makes the whole message malformed, and
// Telegram's API rejects it outright. Combined with muteHttpExceptions below,
// that rejection is completely silent — the alert just never arrives, with
// no error anywhere. Every piece of lead-controlled text must go through
// this before being dropped into the message; only the static labels/
// headers we write ourselves are safe to leave as real Markdown.
function escTg_(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}

function sendTelegramAlert(lead) {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    Logger.log('Telegram not configured — skipping alert (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in Script Properties)');
    return;
  }

  const scenario  = detectScenario(lead);
  const typeLabel = scenario === 'viewing' ? 'New Viewing Request' : scenario === 'property' ? 'New Property Inquiry' : 'New Website Inquiry';

  // The client's own typed message was buried in `notes` alongside bookkeeping
  // tags — strip those so only the real message shows, same cleanup as the email alert.
  const clientMessage = escTg_((lead.notes || '')
    .replace(/\[Language:[^\]]*\]\s*\|?\s*/i, '')
    .replace(/^Website inquiry:?\s*/i, '')
    .replace(/\n?\[Form:[^\]]*\]/i, '')
    .trim());

  const personLines = [
    'Name: '  + escTg_(lead.fullName || '—'),
    'Phone: ' + escTg_(lead.phone    || '—'),
    'Email: ' + escTg_(lead.email    || '—'),
    'Score: ' + scoreTag_(lead.score),
  ].join('\n');

  // /welcome's matcher auto-fills interestedIn with its top algorithmic
  // match the moment the form is submitted — the client never clicked or
  // chose that specific property. Label it as a suggestion there, not a
  // request, so staff don't read it as something the client asked for.
  // Not "suggested" once the visitor tapped "I'm interested in this one" —
  // the website then adds "Selected: <project>." to the message.
  const isSuggestedProperty = /\[Form: \/welcome Landing Page\]/.test(lead.notes || '') && !/Selected: /.test(lead.notes || '');
  const propertyLines = [
    (isSuggestedProperty ? 'Suggested Property: ' : 'Property: ') + escTg_(lead.interestedIn || '—'),
    'Budget: '   + escTg_(lead.budget   || '—'),
    'Timeline: ' + escTg_(lead.timeline || '—'),
  ].join('\n');

  // "Website" is the fallback value, not a real channel — only show a line
  // when there's an actual answer to "where did this come from".
  const leadInfoLines = [
    (lead.source && lead.source !== 'Website') ? 'Came from: ' + escTg_(lead.source) : null,
    lead.referralPartner ? 'Referral partner: ' + escTg_(formatReferralLabel_(lead.referralPartner)) : null,
  ].filter(Boolean).join('\n');

  const msg = [
    '🔔 *PHC LEAD ALERT*',
    '*' + typeLabel + '*',
    '',
    '*Person:*',
    personLines,
    '',
    '*Property requirements:*',
    propertyLines,
    clientMessage    ? '\n*Message:*\n'   + clientMessage    : null,
    leadInfoLines     ? '\n*Lead Info:*\n' + leadInfoLines     : null,
  ].filter(line => line !== null).join('\n');

  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
    muteHttpExceptions: true,
  });
}

// ── Detection helpers ─────────────────────────────────────────────

function detectLang(lead) {
  // 1. Explicit language preference set by client on the website (highest priority)
  const notes = (lead.notes || '');
  const langMatch = notes.match(/\[Language:\s*([^\]]+)\]/i);
  if (langMatch) {
    const pref = langMatch[1].trim().toLowerCase();
    if (pref === 'khmer')    return 'kh';
    if (pref === 'japanese') return 'ja';
    if (pref === 'german')   return 'de';
    return 'en'; // English, Russian, Chinese, Other → English
  }
  // 2. Phone prefix fallback
  const phone = (lead.phone || '').replace(/[\s\-\(\)\.]/g, '');
  if (phone.startsWith('+855')) return 'kh';
  if (phone.startsWith('+81'))  return 'ja';
  if (phone.startsWith('+49'))  return 'de';
  // 3. Nationality fallback
  const nat = (lead.nationality || '').toLowerCase();
  if (nat === 'japanese')  return 'ja';
  if (nat === 'german')    return 'de';
  if (nat === 'cambodian') return 'kh';
  return 'en';
}

function detectScenario(lead) {
  if ((lead.stage || '') === 'Viewing') return 'viewing';
  if (lead.interestedIn === 'Lead Magnet - Investment Guide') return 'lead_magnet';
  const generic = ['Multiple/TBD', 'Not sure yet', ''];
  if (lead.interestedIn && generic.indexOf(lead.interestedIn) === -1) return 'property';
  return 'general';
}

function parseViewingDetails(lead) {
  const notes = lead.notes || '';
  const match  = notes.match(/Viewing request:\s*(\S+)\s+at\s+([^\n\r.]+)/);
  if (match) return { date: match[1], time: match[2].trim() };
  return { date: '—', time: '—' };
}

function parseInquiryType(lead) {
  // Skip [Language: ...] tags — find the first other [...]
  const match = (lead.notes || '').match(/\[(?!Language:)([^\]]+)\]/i);
  return match ? match[1] : 'Property Inquiry';
}

// /welcome writes the visitor's answers as one sentence (buildBaseMessage in
// phc-website/src/pages/LeadLanding.tsx):
//   "Website inquiry: a rental yield property in Phnom Penh, budget $100K – $200K. ..."
// Pull the goal and city back out for the client email. Fail-safe: if the
// wording ever changes this just returns empty strings and the rows are
// skipped — it can never break the email.
const WELCOME_GOAL_LABEL = {
  'rental yield':    'Rental yield',
  'capital growth':  'Capital growth',
  'home to live in': 'A home to live in'
};
const WELCOME_LABEL = {
  en: { city: 'Location',      goal: 'Goal'        },
  ja: { city: 'ご希望エリア',  goal: 'ご投資目的'  },
  de: { city: 'Standort',      goal: 'Ziel'        },
  kh: { city: 'ទីតាំង',         goal: 'គោលបំណង'     }
};
function parseWelcomeAnswers_(lead) {
  const notes = String(lead.notes || '');
  if (!/\[Form: \/welcome Landing Page\]/.test(notes)) return { goal: '', city: '' };
  const m = notes.match(/Website inquiry:\s*an?\s+(?:(.+?)\s+)?property(?:\s+in\s+([^,.\n]+?))?\s*[,.]/i);
  if (!m) return { goal: '', city: '' };
  const rawGoal = (m[1] || '').trim().toLowerCase();
  return {
    goal: WELCOME_GOAL_LABEL[rawGoal] || '',
    city: (m[2] || '').trim()
  };
}

function buildWaLink(lead, scenario) {
  const prop = lead.interestedIn || '';
  let text;
  if (scenario === 'viewing')       text = 'Hi, I submitted a viewing request' + (prop ? ' for ' + prop : '') + ' on your website.';
  else if (scenario === 'property') text = 'Hi, I enquired about ' + prop + ' on your website.';
  else                              text = 'Hi, I submitted an inquiry on your website.';
  return 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(text);
}

// ── Copy: 4 scenarios × 4 languages ──────────────────────────────

const INQUIRY_LABELS = {
  en: { 'Buying a Property':'Buying a Property', 'Selling a Property':'Selling a Property', 'Renting a Property':'Renting a Property', 'Property Investment':'Property Investment', 'General Consultation':'General Consultation' },
  ja: { 'Buying a Property':'不動産購入', 'Selling a Property':'不動産売却', 'Renting a Property':'賃貸', 'Property Investment':'不動産投資', 'General Consultation':'無料相談' },
  de: { 'Buying a Property':'Immobilienkauf', 'Selling a Property':'Immobilienverkauf', 'Renting a Property':'Mietimmobilie', 'Property Investment':'Immobilieninvestition', 'General Consultation':'Allgemeine Beratung' },
  kh: { 'Buying a Property':'ទិញអចលនទ្រព្យ', 'Selling a Property':'លក់អចលនទ្រព្យ', 'Renting a Property':'ជួលអចលនទ្រព្យ', 'Property Investment':'វិនិយោគអចលនទ្រព្យ', 'General Consultation':'ប្រឹក្សាទូទៅ' }
};

const CARD_LABELS = {
  en: { property:'Property', date:'Date', time:'Time', interest:'Inquiry',      budget:'Budget',   timeline:'Timeline'       },
  ja: { property:'物件',     date:'日付', time:'時間', interest:'ご関心',        budget:'ご予算',   timeline:'ご検討時期'     },
  de: { property:'Objekt',   date:'Datum',time:'Uhrzeit',interest:'Anfrage',    budget:'Budget',   timeline:'Zeitrahmen'     },
  kh: { property:'អចលនទ្រព្យ',date:'ថ្ងៃ',time:'ម៉ោង',interest:'ចំណាប់អារម្មណ៍',budget:'ទំហំថវិកា',timeline:'ពេលវេលា' }
};

function getClientCopy(scenario, lang, lead) {
  const n    = escH(lead.fullName || 'there');
  const prop = escH(lead.interestedIn || '');
  const cl   = CARD_LABELS[lang]    || CARD_LABELS.en;
  const il   = INQUIRY_LABELS[lang] || INQUIRY_LABELS.en;
  const ctas = { en:'Message Us on WhatsApp', ja:'WhatsAppでメッセージ', de:'Auf WhatsApp schreiben', kh:'ផ្ញើសារតាម WhatsApp' };
  const result = getClientCopyInner_(scenario, lang, lead, n, prop, cl, il, ctas);
  result.lang = lang;
  return result;
}

function getClientCopyInner_(scenario, lang, lead, n, prop, cl, il, ctas) {
  // ── Viewing ────────────────────────────────────────────────────
  if (scenario === 'viewing') {
    const vd = parseViewingDetails(lead);
    return {
      subject: { en:'Your Viewing Request — '+(lead.interestedIn||'Property'), ja:'内覧ご予約を承りました — '+(lead.interestedIn||''), de:'Besichtigungsanfrage erhalten — '+(lead.interestedIn||''), kh:'បានទទួលការស្នើសុំទស្សនា — '+(lead.interestedIn||'') }[lang] || 'Your Viewing Request',
      headerTitle: { en:"We've Got Your Viewing Request", ja:'内覧のご予約を承りました', de:'Ihre Besichtigungsanfrage ist eingegangen', kh:'យើងបានទទួលការស្នើសុំទស្សនារបស់អ្នក' }[lang],
      greeting: { en:'Hi '+n+',', ja:n+' 様、こんにちは', de:'Hallo '+n+',', kh:n+' ជំរាបសួរ' }[lang],
      opener: {
        en: 'Thanks for your viewing request for ' + prop + '. Here is what you shared with us.',
        ja: prop + ' の内覧ご予約をいただき、ありがとうございます。ご入力いただいた内容は以下のとおりです。',
        de: 'Vielen Dank für Ihre Besichtigungsanfrage für ' + prop + '. Hier ist eine Übersicht Ihrer Angaben.',
        kh: 'សូមអរគុណចំពោះការស្នើសុំទស្សនា ' + prop + '។ នេះជាព័ត៌មានដែលអ្នកបានផ្តល់មកយើង។'
      }[lang],
      detailRows: [
        { label: cl.property, value: prop },
        { label: cl.date, value: escH(vd.date) },
        { label: cl.time, value: escH(vd.time) },
      ],
      nextLine: {
        en: 'We will confirm your slot within 2 hours via WhatsApp.',
        ja: '担当者より2時間以内にWhatsAppにてご連絡いたします。',
        de: 'Wir bestätigen Ihren Termin innerhalb von 2 Stunden über WhatsApp.',
        kh: 'យើងនឹងបញ្ជាក់ម៉ោងទស្សនារបស់អ្នកតាម WhatsApp ក្នុងរយៈពេល 2 ម៉ោង។'
      }[lang],
      ctaText: ctas[lang],
    };
  }

  // ── Property Inquiry ───────────────────────────────────────────
  if (scenario === 'property') {
    // /welcome's matcher auto-fills this with its top match — the client
    // never clicked or chose it. Label and wording adjust so we're not
    // implying they asked about this specific property when they didn't.
    const isSuggested = /\[Form: \/welcome Landing Page\]/.test(lead.notes || '') && !/Selected: /.test(lead.notes || '');
    const rows = [{ label: isSuggested ? (SUGGESTED_LABEL[lang] || 'Suggested Property') : cl.property, value: prop }];
    // Mirror what the visitor answered on /welcome (location + goal).
    const wa = parseWelcomeAnswers_(lead);
    const wl = WELCOME_LABEL[lang] || WELCOME_LABEL.en;
    if (wa.city)       rows.push({ label: wl.city,     value: escH(wa.city) });
    if (wa.goal)       rows.push({ label: wl.goal,     value: escH(wa.goal) });
    if (lead.budget)   rows.push({ label: cl.budget,   value: escH(lead.budget) });
    if (lead.timeline) rows.push({ label: cl.timeline, value: escH(lead.timeline) });
    return {
      subject: { en:"We've Received Your Inquiry", ja:'お問い合わせを承りました', de:'Ihre Anfrage ist eingegangen', kh:'បានទទួលការសាកសួររបស់អ្នក' }[lang] || 'Inquiry Received',
      headerTitle: { en:"We've Got Your Inquiry", ja:'お問い合わせを承りました', de:'Ihre Anfrage ist eingegangen', kh:'យើងបានទទួលការសាកសួររបស់អ្នក' }[lang],
      greeting: { en:'Hi '+n+',', ja:n+' 様、こんにちは', de:'Hallo '+n+',', kh:n+' ជំរាបសួរ' }[lang],
      opener: isSuggested ? {
        en: 'Thanks for reaching out. Here is what you shared with us, along with a property that matches what you are looking for.',
        ja: 'お問い合わせをいただき、ありがとうございます。ご入力いただいた内容と、ご希望に合う物件は以下のとおりです。',
        de: 'Vielen Dank für Ihre Anfrage. Hier ist eine Übersicht Ihrer Angaben sowie ein passendes Objekt.',
        kh: 'សូមអរគុណចំពោះការទាក់ទងមកយើង។ នេះជាព័ត៌មានដែលអ្នកបានផ្តល់ ព្រមទាំងអចលនទ្រព្យមួយដែលសមស្របនឹងអ្នក។'
      }[lang] : {
        en: 'Thanks for reaching out about ' + prop + '. Here is what you shared with us.',
        ja: prop + ' へのお問い合わせをいただき、ありがとうございます。ご入力いただいた内容は以下のとおりです。',
        de: 'Vielen Dank für Ihre Anfrage zu ' + prop + '. Hier ist eine Übersicht Ihrer Angaben.',
        kh: 'សូមអរគុណចំពោះការចាប់អារម្មណ៍លើ ' + prop + '។ នេះជាព័ត៌មានដែលអ្នកបានផ្តល់មកយើង។'
      }[lang],
      detailRows: rows,
      nextLine: {
        en: 'Our team will follow up with matches within 24 hours. Feel free to message us directly in the meantime.',
        ja: '担当者より24時間以内にご連絡いたします。お急ぎの場合はWhatsAppにてお気軽にご連絡ください。',
        de: 'Unser Team meldet sich innerhalb von 24 Stunden mit passenden Angeboten. Sie können uns in der Zwischenzeit gerne direkt schreiben.',
        kh: 'ក្រុមការងារនឹងទំនាក់ទំនងអ្នកក្នុងរយៈពេល 24 ម៉ោង។ អ្នកអាចផ្ញើសារមកយើងផ្ទាល់បានគ្រប់ពេល។'
      }[lang],
      ctaText: ctas[lang],
    };
  }

  // ── Lead Magnet ────────────────────────────────────────────────
  if (scenario === 'lead_magnet') {
    return {
      subject: "Your 2026 Cambodia Property Investment Guide",
      headerTitle: { en:'Your Investment Guide Is Ready', ja:'投資ガイドのご用意ができました', de:'Ihr Investitionsleitfaden ist bereit', kh:'សៀវភៅណែនាំវិនិយោគរបស់អ្នករួចរាល់ហើយ' }[lang],
      greeting: { en:'Hi '+n+',', ja:n+' 様、こんにちは', de:'Hallo '+n+',', kh:n+' ជំរាបសួរ' }[lang],
      opener: {
        en: 'Thanks for your interest in Cambodia property investment. Your complimentary 2026 guide is ready below.',
        ja: 'カンボジア不動産投資にご関心をお持ちいただき、ありがとうございます。2026年版の無料ガイドをご用意しました。',
        de: 'Vielen Dank für Ihr Interesse an Immobilieninvestitionen in Kambodscha. Ihr kostenloser Leitfaden 2026 steht unten bereit.',
        kh: 'សូមអរគុណចំពោះការចាប់អារម្មណ៍លើអចលនទ្រព្យនៅកម្ពុជា។ សៀវភៅណែនាំឆ្នាំ 2026 របស់អ្នករួចរាល់ហើយ ខាងក្រោម។'
      }[lang],
      detailRows: [],
      nextLine: {
        en: 'Prefer to chat? Message us on WhatsApp any time.',
        ja: 'ご質問があれば、いつでもWhatsAppにてお気軽にご連絡ください。',
        de: 'Lieber persönlich sprechen? Schreiben Sie uns jederzeit auf WhatsApp.',
        kh: 'ចង់ជជែកផ្ទាល់? ផ្ញើសារមកយើងតាម WhatsApp បានគ្រប់ពេល។'
      }[lang],
      ctaText: ctas[lang],
      pdfUrl: 'https://drive.google.com/file/d/1Lj_x1d_Tbnj-j_x3r5n-sHpXGzu7Kxyw/view?usp=sharing',
      pdfLabel: { en:'Download PDF Guide', ja:'PDFガイドをダウンロード', de:'PDF-Leitfaden herunterladen', kh:'ទាញយក PDF' }[lang] || 'Download PDF Guide',
    };
  }

  // ── General Inquiry ────────────────────────────────────────────
  const rawType   = parseInquiryType(lead);
  const localType = il[rawType] || rawType;
  const rows = [];
  if (localType)                                               rows.push({ label: cl.interest,  value: localType });
  if (lead.budget)                                             rows.push({ label: cl.budget,    value: escH(lead.budget) });
  if (lead.timeline)                                           rows.push({ label: cl.timeline,  value: escH(lead.timeline) });
  if (lead.interestedIn && lead.interestedIn !== 'Not sure yet') rows.push({ label: cl.property, value: escH(lead.interestedIn) });

  return {
    subject: { en:'Thank You — Property Hub Cambodia', ja:'お問い合わせを承りました', de:'Vielen Dank für Ihre Anfrage', kh:'សូមអរគុណ — Property Hub Cambodia' }[lang] || 'Thank You',
    headerTitle: { en:"We've Got Your Inquiry", ja:'お問い合わせを承りました', de:'Ihre Anfrage ist eingegangen', kh:'យើងបានទទួលការសាកសួររបស់អ្នក' }[lang],
    greeting: { en:'Hi '+n+',', ja:n+' 様、こんにちは', de:'Hallo '+n+',', kh:n+' ជំរាបសួរ' }[lang],
    opener: {
      en: 'Thanks for reaching out. Here is what you shared with us.',
      ja: 'お問い合わせをいただき、ありがとうございます。ご入力いただいた内容は以下のとおりです。',
      de: 'Vielen Dank für Ihre Anfrage. Hier ist eine Übersicht Ihrer Angaben.',
      kh: 'សូមអរគុណចំពោះការទាក់ទងមកយើង។ នេះជាព័ត៌មានដែលអ្នកបានផ្តល់មកយើង។'
    }[lang],
    detailRows: rows,
    nextLine: {
      en: 'Our team will follow up within 24 hours. Feel free to message us directly in the meantime.',
      ja: '担当者より24時間以内にご連絡いたします。お急ぎの場合はWhatsAppにてお気軽にご連絡ください。',
      de: 'Unser Team meldet sich innerhalb von 24 Stunden bei Ihnen. Sie können uns in der Zwischenzeit gerne direkt schreiben.',
      kh: 'ក្រុមការងារនឹងទំនាក់ទំនងអ្នកក្នុងរយៈពេល 24 ម៉ោង។ អ្នកអាចផ្ញើសារមកយើងផ្ទាល់បានគ្រប់ពេល។'
    }[lang],
    ctaText: ctas[lang],
  };
}

// ── HTML builder ──────────────────────────────────────────────────

function escH(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildDetailTable(rows) {
  if (!rows || !rows.length) return '';
  const inner = rows.map(r =>
    '<tr>' +
    '<td style="padding:10px 16px;border-bottom:1px solid #f0f2f5;font-size:12px;color:#9ca3af;white-space:nowrap;width:110px">' + r.label + '</td>' +
    '<td style="padding:10px 16px;border-bottom:1px solid #f0f2f5;font-size:13px;color:#1f2437;font-weight:600">'              + r.value + '</td>' +
    '</tr>'
  ).join('');
  return '<table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;overflow:hidden;margin:20px 0 24px">' + inner + '</table>';
}

// Rebuilt 2026-08-13 to fix "Limit Exceeded: Email Body Size" — the old
// version embedded the logo twice (header + footer watermark) plus 3 icon
// images as base64, which pushed the email over GmailApp's size limit. This
// version uses zero embedded images, matching the lead alert email's own
// (already working, already approved) style: navy header, left-aligned
// detail table, plain-text button and footer.
function buildClientEmailHtml(copy, waLink, gdpr) {
  const rowsHtml = (copy.detailRows || []).map((r, i, arr) =>
    '<tr>' +
    '<td style="padding:9px 0;' + (i < arr.length - 1 ? 'border-bottom:1px solid #e8ecf2;' : '') + 'font-size:12px;color:#7a8799;width:110px;white-space:nowrap">' + r.label + '</td>' +
    '<td style="padding:9px 0 9px 16px;' + (i < arr.length - 1 ? 'border-bottom:1px solid #e8ecf2;' : '') + 'font-size:13.5px;color:#1f2437;font-weight:600">' + r.value + '</td>' +
    '</tr>'
  ).join('');

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>' +
  '<meta name="color-scheme" content="light only"/><meta name="supported-color-schemes" content="light only"/>' +
  '<style>@media (max-width:600px){.container{width:100% !important}}</style>' +
  '</head>' +
  '<body style="margin:0;padding:0;background-color:#f0f2f7;font-family:\'Inter\',-apple-system,BlinkMacSystemFont,Arial,sans-serif;-webkit-font-smoothing:antialiased">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f7;padding:24px 16px"><tr><td align="center">' +
  '<table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.10)">' +

  // Header
  '<tr><td bgcolor="#06264F" style="background-color:#06264F;padding:28px 28px 22px">' +
  '<p style="margin:0;font-size:11px;font-weight:bold;color:#CC9D4D;letter-spacing:2.5px;text-transform:uppercase">Property Hub Cambodia</p>' +
  '<p style="margin:8px 0 0;font-size:23px;color:#ffffff;font-weight:700">' + copy.headerTitle + '</p>' +
  '</td></tr>' +

  // Body — greeting, opener line, detail table, next-step line, CTA
  '<tr><td style="padding:26px 28px 8px">' +
  '<p style="margin:0 0 14px;font-size:15.5px;color:#1f2437;font-weight:600">' + copy.greeting + '</p>' +
  '<p style="margin:0 0 22px;font-size:14.5px;color:#4a5266;line-height:1.65">' + copy.opener + '</p>' +

  (rowsHtml
    ? '<p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#9aa3b4;letter-spacing:1.2px;text-transform:uppercase">' + (CLIENT_TABLE_LABEL[copy.lang] || 'Your Inquiry') + '</p>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 26px">' + rowsHtml + '</table>'
    : '') +

  (copy.nextLine ? '<p style="margin:0 0 22px;font-size:13.5px;color:#2B3444;line-height:1.6">' + copy.nextLine + '</p>' : '') +

  (copy.pdfUrl
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:16px"><tr>' +
      '<td bgcolor="#CC9D4D" style="background-color:#CC9D4D;border-radius:7px">' +
      '<a href="' + copy.pdfUrl + '" target="_blank" style="display:block;text-align:center;padding:14px 24px;font-size:13px;font-weight:700;color:#06264F;text-decoration:none">' + copy.pdfLabel + '</a>' +
      '</td></tr></table>'
    : '') +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px"><tr>' +
  '<td bgcolor="#25D366" style="background-color:#25D366;border-radius:7px">' +
  '<a href="' + waLink + '" target="_blank" style="display:block;text-align:center;padding:14px 0;font-size:13px;font-weight:700;color:#ffffff;text-decoration:none">' + copy.ctaText + '</a>' +
  '</td></tr></table>' +

  '<p style="margin:0 0 3px;font-size:13.5px;color:#4a5266">' + (CLIENT_SIGNOFF[copy.lang] || 'Warm regards,') + '</p>' +
  '<p style="margin:0 0 26px;font-size:15px;color:#06264F;font-weight:700">Property Hub Cambodia</p>' +
  '</td></tr>' +

  // Footer — plain text, no images
  '<tr><td bgcolor="#06264F" style="background-color:#06264F;padding:20px 28px">' +
  '<p style="margin:0 0 4px;font-size:12.5px;color:rgba(255,255,255,.75)">011 666 952 &nbsp;·&nbsp; <a href="mailto:invest@propertyhubcambodia.com" style="color:#CC9D4D;text-decoration:none">invest@propertyhubcambodia.com</a></p>' +
  '<p style="margin:0;font-size:12.5px;color:rgba(255,255,255,.75)">Time Square 5, St. 306, BKK1, Phnom Penh, Cambodia</p>' +
  (gdpr || '') +
  '</td></tr>' +
  '<tr><td style="height:3px;background-color:#CC9D4D;font-size:0;line-height:0">&nbsp;</td></tr>' +

  '</table></td></tr></table></body></html>';
}

const CLIENT_TABLE_LABEL = { en:'Your Inquiry', ja:'お問い合わせ内容', de:'Ihre Anfrage', kh:'ការសាកសួររបស់អ្នក' };
const CLIENT_SIGNOFF     = { en:'Warm regards,', ja:'よろしくお願いいたします。', de:'Herzliche Grüße,', kh:'ដោយក្តីស្មោះស' };
const SUGGESTED_LABEL    = { en:'Suggested Property', ja:'おすすめの物件', de:'Vorgeschlagenes Objekt', kh:'អចលនទ្រព្យដែលបានស្នើ' };

function buildAgentEmailHtml(lead, scenario, lang) {
  const scenarioLabel = { viewing:'Viewing Request', property:'Property Inquiry', lead_magnet:'Lead Magnet', general:'General Inquiry' }[scenario] || 'New Lead';
  const langLabel     = { en:'EN', ja:'JP', de:'DE', kh:'KH' }[lang] || lang.toUpperCase();
  const scoreNum      = parseInt(lead.score) || 0;
  const scoreTag      = scoreNum >= 5 ? 'VIP' : scoreNum >= 4 ? 'A' : scoreNum >= 3 ? 'B' : 'C';
  // Color-coded for fast visual triage — contrast-checked (all ≥4.5:1) against AA.
  const scorePill     = { VIP:['#FDF0D5','#92600C'], A:['#DCFCE7','#166534'], B:['#DBEAFE','#1E40AF'], C:['#F1F5F9','#475569'] }[scoreTag];
  const scoreHtml     = '<span style="display:inline-block;padding:2px 10px;border-radius:10px;background-color:' + scorePill[0] + ';color:' + scorePill[1] + ';font-size:11px;font-weight:700">' + scoreTag + '</span>';

  // Same "suggested, not requested" distinction as the Telegram alert —
  // /welcome's matcher auto-fills this with its top match, the client
  // never explicitly chose it.
  const isSuggestedProperty = /\[Form: \/welcome Landing Page\]/.test(lead.notes || '') && !/Selected: /.test(lead.notes || '');
  const rows = [
    ['Name',            escH(lead.fullName    || '—')],
    ['Phone/WhatsApp',  escH(lead.phone       || '—')],
    ['Email',           escH(lead.email       || '—')],
    [isSuggestedProperty ? 'Suggested Property' : 'Property', escH(lead.interestedIn|| '—')],
    ['Budget',          escH(lead.budget      || '—')],
    ['Timeline',        escH(lead.timeline    || '—')],
    ['Language',        langLabel],
    ['Score',           scoreHtml],
  ];
  // "Website" is the fallback value, not a real channel — only show a Source
  // row when we actually know where the lead came from.
  if (lead.source && lead.source !== 'Website') rows.push(['Source', escH(lead.source)]);
  if (lead.referralPartner) rows.push(['Referral Partner', escH(formatReferralLabel_(lead.referralPartner))]);

  // The client's own typed message was captured into `notes` (alongside a
  // [Language: ...] tag) but never actually shown anywhere before — staff
  // had no way to see what a client actually wrote. Strip the language
  // tag, the "Website inquiry" boilerplate, and the internal [Form: ...]
  // tag, only show a row if there's real content left.
  const clientMessage = (lead.notes || '')
    .replace(/\[Language:[^\]]*\]\s*\|?\s*/i, '')
    .replace(/^Website inquiry:?\s*/i, '')
    .replace(/\n?\[Form:[^\]]*\]/i, '')
    .trim();
  if (clientMessage) rows.push(['Message', escH(clientMessage)]);

  const rowsHtml = rows.map((r, i) =>
    '<tr>' +
    '<td style="padding:9px 16px;' + (i < rows.length - 1 ? 'border-bottom:1px solid #e8ecf2;' : '') + 'font-size:12px;color:#7a8799;width:140px;white-space:nowrap">' + r[0] + '</td>' +
    '<td style="padding:9px 16px;' + (i < rows.length - 1 ? 'border-bottom:1px solid #e8ecf2;' : '') + 'font-size:13px;color:#1f2437;font-weight:600;word-break:break-word">' + r[1] + '</td>' +
    '</tr>'
  ).join('');

  const phone    = (lead.phone || '').replace(/[^0-9+]/g, '');
  const waLink   = phone ? 'https://wa.me/' + phone.replace('+','') : '#';
  const callLink = phone ? 'tel:' + phone : '#';

  // Buttons — 44px+ tall (was ~34px, below the touch-target minimum) and
  // percentage-widthed so the row can't force the table wider than the
  // viewport on mobile.
  const btn = (href, bg, color, label) =>
    '<td width="33%" style="padding-right:6px"><a href="' + href + '" style="display:block;text-align:center;padding:14px 4px;background-color:' + bg + ';border-radius:7px;font-size:12px;font-weight:bold;color:' + color + ';text-decoration:none">' + label + '</a></td>';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>' +
  '<meta name="color-scheme" content="light only"/><meta name="supported-color-schemes" content="light only"/>' +
  '<style>@media (max-width:600px){.container{width:100% !important}}</style>' +
  '</head>' +
  '<body style="margin:0;padding:0;background-color:#f0f2f7;font-family:\'Inter\',-apple-system,BlinkMacSystemFont,Arial,sans-serif;-webkit-font-smoothing:antialiased">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f7;padding:24px 16px"><tr><td align="center">' +
  '<table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.10)">' +

  '<tr><td bgcolor="#06264F" style="background-color:#06264F;padding:16px 24px">' +
  '<p style="margin:0;font-size:11px;font-weight:bold;color:#CC9D4D;letter-spacing:2px;text-transform:uppercase">PHC Lead Alert</p>' +
  '<p style="margin:6px 0 0;font-size:20px;color:#ffffff;font-weight:700">' + scenarioLabel + '</p>' +
  '</td></tr>' +

  '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' + rowsHtml + '</table></td></tr>' +

  '<tr><td style="padding:16px 20px;background:#f8fafc;border-top:1px solid #e8ecf2">' +
  '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="table-layout:fixed"><tr>' +
  (phone ? btn(waLink, '#25D366', '#ffffff', 'WhatsApp') : '') +
  (phone ? btn(callLink, '#06264F', '#ffffff', 'Call') : '') +
  btn('https://narithkgame2.github.io/phc-tools/PHC_Lead_Tracker.html', '#CC9D4D', '#06264F', 'Open CRM') +
  '</tr></table>' +
  '</td></tr>' +

  '</table></td></tr></table></body></html>';
}

// ── Senders ───────────────────────────────────────────────────────

function sendClientConfirmation(lead, scenario, lang) {
  const copy   = getClientCopy(scenario, lang, lead);
  const waLink = buildWaLink(lead, scenario);
  const gdpr   = lang === 'de'
    ? '<p style="margin:8px 0 0;font-size:11px;color:rgba(255,255,255,.4)">Sie erhalten diese E-Mail, weil Sie eine Anfrage auf propertyhubcambodia.com gestellt haben. Zur Datenlöschung antworten Sie bitte auf diese E-Mail.</p>'
    : '';
  const html = buildClientEmailHtml(copy, waLink, gdpr);

  GmailApp.sendEmail(lead.email, copy.subject, '', {
    htmlBody: html,
    name:     'Property Hub Cambodia',
    from:     FROM_EMAIL,
    replyTo:  FROM_EMAIL,
  });

  // Plain copy (same subject, no prefix) to each address in
  // CLIENT_COPY_RECIPIENTS — as separate solo emails, not one bcc'd email,
  // so neither recipient ever sees the other's address. One failing send
  // shouldn't stop the others or the client's own email above.
  CLIENT_COPY_RECIPIENTS.forEach(addr => {
    try {
      GmailApp.sendEmail(addr, copy.subject, '', {
        htmlBody: html,
        name:     'Property Hub Cambodia',
        from:     FROM_EMAIL,
      });
    } catch (err) {
      Logger.log('Client copy to ' + addr + ' failed: ' + err);
    }
  });
}

function testClientConfirmation() {
  sendClientConfirmation({
    fullName: 'Test Client',
    email: 'narithkgame2@gmail.com',
    phone: '+855 11 666 952',
    interestedIn: 'GATO Tower',
    budget: '$100K-$200K',
    timeline: '',
    notes: '',
  }, 'property', 'en');
}

function testTelegramAlert() {
  sendTelegramAlert({
    fullName:     'Test Lead',
    phone:        '+855 11 666 952',
    email:        'test@phc.com',
    nationality:  'Japanese',
    budget:       '$100,000 – $200,000',
    timeline:     '3–6 months',
    interestedIn: 'Time Square 9',
    source:       'Website',
    score:        '4',
  });
}

function testTelegramGetUpdates() {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  Logger.log(res.getContentText());
}

function testTelegramGetMe() {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getMe', { muteHttpExceptions: true });
  Logger.log(res.getContentText());
}

function testTelegramRaw() {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  Logger.log('Token: ' + token);
  Logger.log('Chat ID: ' + chatId);
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: 'PHC test ping 🔔' }),
    muteHttpExceptions: true,
  });
  Logger.log('Response: ' + res.getContentText());
}

// ═══════════════════════════════════════════════════════════════
//  PAYMENT REMINDER BOT
//
//  Separate bot from @PHC_Lead_Bot (lead alerts, one-way) and
//  @PHC_Content_Bot (listing distribution) — this one lives inside
//  individual client groups and sends scheduled, personalized,
//  reviewed payment reminders. Reuses the Clients sheet directly —
//  no separate client list to maintain.
//
//  SETUP (one-time):
//  1. Create a new bot via @BotFather, copy its token
//  2. Script Properties → add: PAYMENT_BOT_TOKEN = <token>
//  3. Message the new bot once from your personal Telegram, then run
//     testPaymentBotGetUpdates() — your chat_id is in the log output
//  4. Script Properties → add: PAYMENT_REVIEWER_CHAT_ID = <that id>
//  5. Run migrateClientsSchemaForReminders() once — adds channel /
//     groupChatId / lastReminderSent columns to Clients
//  6. Fill in each client's channel ('Telegram'/'WhatsApp'/'Other')
//     and groupChatId (for Telegram clients — add the bot to their
//     group, post any message, run testPaymentBotGetUpdates() again
//     to read that group's chat_id off the log)
//  7. Run installPaymentReminderTriggers() once
// ═══════════════════════════════════════════════════════════════

const REMINDER_LEAD_DAYS = 5;

// Extend Clients schema — append-only, safe. Other tools reference
// columns by name via headers.indexOf(), never by fixed position, so
// adding columns at the end never breaks Lead Tracker / Client Manager / etc.
function migrateClientsSchemaForReminders() {
  const sheet = getOrCreateSheet('Clients');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const newCols = ['channel', 'groupChatId', 'lastReminderSent'];
  const toAdd = newCols.filter(c => !headers.includes(c));

  if (!toAdd.length) { Logger.log('✅ Reminder columns already exist — no migration needed'); return; }

  let nextCol = sheet.getLastColumn() + 1;
  toAdd.forEach(col => {
    sheet.getRange(1, nextCol).setValue(col)
      .setBackground('#083467').setFontColor('#ffffff').setFontWeight('bold').setFontSize(10);
    nextCol++;
  });
  Logger.log('✅ Added columns to Clients: ' + toAdd.join(', '));
}

function testPaymentBotGetUpdates() {
  const token = PropertiesService.getScriptProperties().getProperty('PAYMENT_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  Logger.log(res.getContentText());
}

// Diagnostic: a bot can only deliver updates via webhook OR getUpdates
// polling, never both — if a webhook URL is set, getUpdates always returns
// empty regardless of real activity. Checks which mode this bot is in.
function testPaymentBotWebhookInfo() {
  const token = PropertiesService.getScriptProperties().getProperty('PAYMENT_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo', { muteHttpExceptions: true });
  Logger.log(res.getContentText());
}

// Reuses Google Translate's language codes directly (matches the Content
// Bot's approach) — 'kh' isn't a valid Translate code, so Khmer is 'km' here,
// unlike the internal 'kh' label used elsewhere in this file for email copy.
const PAYMENT_LANG_MAP = { japanese: 'ja', german: 'de', russian: 'ru', cambodian: 'km' };

function detectClientLang(nat) {
  const key = (nat || '').toLowerCase().trim();
  return PAYMENT_LANG_MAP[key] || 'en';
}

// payDay comes back as a native Date object when typed directly into the
// sheet (Sheets auto-converts it), but as a plain string when set via the
// REST API — handle both, and fall back to the raw value if unparseable.
function formatPayDay(payDay) {
  if (!payDay) return '';
  const d = (payDay instanceof Date) ? payDay : new Date(payDay);
  if (isNaN(d.getTime())) return String(payDay);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMMM d, yyyy');
}

function buildReminderMessage(client) {
  const en = '👋 Hi ' + (client.name || 'there') + ',\n\n' +
    'This is a friendly reminder that your payment of $' + (client.payAmount || '') +
    ' for ' + (client.project || '') + ' — Unit ' + (client.unit || '') +
    ' is due on ' + formatPayDay(client.payDay) + '.\n\n' +
    'Please let us know if you have any questions.\n\n' +
    '— Property Hub Cambodia';

  const lang = detectClientLang(client.nat);
  if (lang === 'en') return en;
  try {
    return LanguageApp.translate(en, 'en', lang);
  } catch (err) {
    Logger.log('buildReminderMessage translate error: ' + err);
    return en; // fall back to English rather than send nothing
  }
}

// True if payDay is exactly `daysAhead` days from today — fires once, on
// that exact day, not every day from then until the due date.
function isDueInDays(payDay, daysAhead) {
  if (!payDay) return false;
  const due = new Date(payDay);
  if (isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000) === daysAhead;
}

function checkPaymentReminders() {
  const token = PropertiesService.getScriptProperties().getProperty('PAYMENT_BOT_TOKEN');
  const reviewerChatId = PropertiesService.getScriptProperties().getProperty('PAYMENT_REVIEWER_CHAT_ID');
  if (!token || !reviewerChatId) { Logger.log('Payment reminders: missing Script Properties'); return; }

  const sheet = getOrCreateSheet('Clients');
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const idIdx = headers.indexOf('id');
  const payDayIdx = headers.indexOf('payDay');
  const lastSentIdx = headers.indexOf('lastReminderSent');

  const dueTelegram = [];
  const dueOther = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[idIdx]) continue;
    if (String(row[lastSentIdx]) === todayStr) continue; // already handled this cycle
    if (!isDueInDays(row[payDayIdx], REMINDER_LEAD_DAYS)) continue;

    const client = {};
    headers.forEach((h, c) => client[h] = row[c]);
    client._row = i + 1;

    if ((client.channel || '').toLowerCase() === 'telegram') dueTelegram.push(client);
    else dueOther.push(client);
  }

  if (!dueTelegram.length && !dueOther.length) { Logger.log('No payment reminders due today.'); return; }

  dueTelegram.forEach(client => sendReminderForReview(token, reviewerChatId, client, sheet, headers));

  if (dueOther.length) {
    const names = dueOther.map(c => c.name + ' (' + (c.channel || 'no channel set') + ')').join('\n');
    sendPaymentBotMessage(token, reviewerChatId,
      '⚠️ ' + dueOther.length + ' client(s) due for a payment reminder are NOT on Telegram — handle manually:\n\n' + names);
    const lastSentIdx2 = headers.indexOf('lastReminderSent');
    dueOther.forEach(c => sheet.getRange(c._row, lastSentIdx2 + 1).setValue(todayStr));
  }
}

function sendReminderForReview(token, reviewerChatId, client, sheet, headers) {
  const message = buildReminderMessage(client);
  const reviewText = '💳 Payment reminder ready — ' + client.name + ' (' + client.project + ' Unit ' + client.unit + ')\n\n' + message;
  const keyboard = { inline_keyboard: [[
    { text: '✅ Approve', callback_data: 'pr_approve_' + client.id },
    { text: '❌ Reject', callback_data: 'pr_reject_' + client.id },
  ]] };
  sendPaymentBotMessage(token, reviewerChatId, reviewText, keyboard);

  const lastSentIdx = headers.indexOf('lastReminderSent');
  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  sheet.getRange(client._row, lastSentIdx + 1).setValue(todayStr);
}

function sendPaymentBotMessage(token, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text: text };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', contentType: 'application/x-www-form-urlencoded', payload: payload, muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) Logger.log('Payment bot sendMessage failed: chatId=' + JSON.stringify(chatId) + ' (type=' + typeof chatId + ') response=' + resp.getContentText());
  return data.result;
}

// ── Polling for Approve/Reject taps (same pattern as the Content Bot) ────

function checkPaymentBotUpdates() {
  const token = PropertiesService.getScriptProperties().getProperty('PAYMENT_BOT_TOKEN');
  if (!token) return;
  const props = PropertiesService.getScriptProperties();
  const lastOffset = Number(props.getProperty('PAYMENT_BOT_OFFSET') || '0');

  const resp = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token + '/getUpdates?offset=' + (lastOffset + 1) + '&timeout=0',
    { muteHttpExceptions: true }
  );
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) { Logger.log('Payment bot getUpdates failed: ' + resp.getContentText()); return; }
  Logger.log('Payment bot: fetched ' + data.result.length + ' update(s), offset=' + (lastOffset + 1));
  if (!data.result.length) return;

  data.result.forEach(update => {
    if (update.callback_query) {
      try { handlePaymentCallback(token, update.callback_query); }
      catch (err) { Logger.log('handlePaymentCallback error: ' + err); }
    } else if (update.message) {
      // Logged so a chat ID (personal or group) can be read off the
      // Executions log even when the 1-minute trigger consumes the message
      // before a manual test run gets a chance to see it via getUpdates.
      const m = update.message;
      Logger.log('message: chat.id=' + m.chat.id + ' chat.type=' + m.chat.type + ' chat.title="' + (m.chat.title || '') + '" text="' + (m.text || m.caption || '') + '"');
    }
    props.setProperty('PAYMENT_BOT_OFFSET', String(update.update_id));
  });
}

// Sheet-sourced numeric IDs can pick up subtle formatting quirks (e.g. a
// trailing ".0") when Apps Script serializes them for the API request —
// Telegram then rejects the malformed chat_id as "chat not found" even
// though it displays identically to a working string ID. Force a clean
// integer string regardless of whether Sheets stored it as text or a number.
function normalizeChatId(id) {
  if (typeof id === 'number') return String(Math.trunc(id));
  return String(id).trim();
}

function handlePaymentCallback(token, cb) {
  const data = cb.data || ''; // "pr_approve_<id>" or "pr_reject_<id>"
  const parts = data.split('_');
  const action = parts[1];
  const clientId = parts.slice(2).join('_');

  const sheet = getOrCreateSheet('Clients');
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const idIdx = headers.indexOf('id');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idIdx]) !== String(clientId)) continue;
    const client = {};
    headers.forEach((h, c) => client[h] = rows[i][c]);

    if (action === 'approve') {
      if (!client.groupChatId) {
        answerPaymentCallback(token, cb.id, 'No groupChatId set for ' + client.name + ' — add it to the sheet first.');
        return;
      }
      const message = buildReminderMessage(client);
      sendPaymentBotMessage(token, normalizeChatId(client.groupChatId), message);
      finishPaymentReview(token, cb.message.chat.id, cb.message.message_id, '✅ SENT to ' + client.name);
      answerPaymentCallback(token, cb.id, 'Sent to ' + client.name + '!');
    } else {
      finishPaymentReview(token, cb.message.chat.id, cb.message.message_id, '❌ REJECTED — ' + client.name);
      answerPaymentCallback(token, cb.id, 'Rejected.');
    }
    return;
  }
  answerPaymentCallback(token, cb.id, 'Client not found.');
}

function finishPaymentReview(token, chatId, messageId, statusText) {
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/editMessageReplyMarkup', {
    method: 'post', contentType: 'application/x-www-form-urlencoded',
    payload: { chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: [] }) },
    muteHttpExceptions: true,
  });
  sendPaymentBotMessage(token, chatId, statusText);
}

function answerPaymentCallback(token, callbackQueryId, text) {
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
    method: 'post', contentType: 'application/x-www-form-urlencoded',
    payload: { callback_query_id: callbackQueryId, text: text }, muteHttpExceptions: true,
  });
}

function installPaymentReminderTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'checkPaymentReminders' || fn === 'checkPaymentBotUpdates') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkPaymentReminders').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('checkPaymentBotUpdates').timeBased().everyMinutes(1).create();
  Logger.log('✅ Payment reminder triggers installed — daily check at 9am, button polling every minute.');
}

function sendAgentNotification(lead, scenario, lang) {
  const label   = { viewing:'Viewing Request', property:'Property Inquiry', lead_magnet:'Lead Magnet', general:'General Inquiry' }[scenario] || 'New Lead';
  const subject = '[PHC] New ' + label + ' — ' + escH(lead.fullName || 'Unknown') + ' · ' + escH(lead.interestedIn || lead.budget || 'Website');

  GmailApp.sendEmail(AGENT_EMAIL, subject, '', {
    htmlBody: buildAgentEmailHtml(lead, scenario, lang),
    name:     'PHC CRM',
    from:     FROM_EMAIL,
  });
}
