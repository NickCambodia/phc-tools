// ═══════════════════════════════════════════════════════════════
//  PHC Bridge Script
//  Paste this into the Apps Script editor bound to the EXISTING
//  lead inquiry Google Sheet (ID: 1-YtoUwEp-dQfMsl7AHbM1rbaG5rwUpPu9QheLEsyOKI)
//
//  HOW TO SET UP:
//  1. Open the existing lead sheet → Extensions → Apps Script
//  2. Paste this entire file (replace all existing code)
//  3. Run setupTrigger() once — installs the onChange trigger
//  4. Optional: run syncAllToPHC() to backfill all existing rows
// ═══════════════════════════════════════════════════════════════

// PHC CRM Apps Script Web App URL
var PHC_API_URL = 'https://script.google.com/macros/s/AKfycbyCd3r8sX18YONWUf98_eB_B3uuXbn3ALq8A7ataIysQfUPU9y43DvZUe-OoRIticXBzg/exec';

// Tab name in the existing lead inquiry sheet
var SOURCE_TAB = 'PHC Lead Sheet';

// ── Column index map (0-based) for the 24-column source sheet ────
// Timestamp(0) LeadID(1) FullName(2) WhatsApp(3) Telegram(4)
// Email(5) Language(6) Segment(7) Source(8) Purpose(9)
// BudgetMin(10) BudgetMax(11) ConfirmedBudget(12) PreferredArea(13)
// PropertyType(14) Timeline(15) Score(16) Stage(17) FollowUpStatus(18)
// AgentAssigned(19) NextFollowUpDate(20) CriteriaNotes(21)
// MatchedListings(22) ConversationURL(23)

var COL = {
  TIMESTAMP:        0,
  LEAD_ID:          1,
  FULL_NAME:        2,
  WHATSAPP:         3,
  TELEGRAM:         4,
  EMAIL:            5,
  LANGUAGE:         6,
  SEGMENT:          7,
  SOURCE:           8,
  PURPOSE:          9,
  BUDGET_MIN:       10,
  BUDGET_MAX:       11,
  CONFIRMED_BUDGET: 12,
  PREFERRED_AREA:   13,
  PROPERTY_TYPE:    14,
  TIMELINE:         15,
  SCORE:            16,
  STAGE:            17,
  FOLLOW_UP_STATUS: 18,
  AGENT_ASSIGNED:   19,
  NEXT_FOLLOW_UP:   20,
  CRITERIA_NOTES:   21,
  MATCHED_LISTINGS: 22,
  CONVERSATION_URL: 23
};

// ── Field mappers ────────────────────────────────────────────────

function mapStage(raw) {
  var s = String(raw || '').trim().toLowerCase();
  if (s === 'new inquiry')     return 'New Lead';
  if (s === 'qualified')       return 'Contacted';
  if (s === 'proposal sent')   return 'Contacted';
  if (s === 'site visit')      return 'Viewing';
  if (s === 'closed' || s === 'closed/won' || s === 'won') return 'Closed';
  if (s === 'hold')            return 'Hold';
  if (s === 'lost' || s === 'released') return 'Released';
  return 'New Lead';
}

function mapScore(raw) {
  var s = String(raw || '').trim().toUpperCase();
  if (s === 'VIP') return 5;
  if (s === 'A')   return 4;
  if (s === 'B')   return 3;
  return 2; // C or unknown
}

function mapNationality(language) {
  var l = String(language || '').trim().toLowerCase();
  if (l === 'japanese')      return 'Japanese';
  if (l === 'german')        return 'German';
  if (l === 'russian')       return 'Russian';
  if (l === 'chinese')       return 'Chinese';
  if (l === 'khmer' || l === 'cambodian') return 'Cambodian';
  if (l === 'english' || l === 'british') return 'British';
  if (l === 'singaporean')   return 'Singaporean';
  return 'Other';
}

function mapBudget(confirmed, max, min) {
  var val = parseFloat(String(confirmed || max || min || '0').replace(/[^0-9.]/g, '')) || 0;
  if (val >= 500000)  return '$500K+';
  if (val >= 300000)  return '$300K-$500K';
  if (val >= 200000)  return '$200K-$300K';
  if (val >= 100000)  return '$100K-$200K';
  return 'Under $100K';
}

function mapTimeline(raw) {
  var t = String(raw || '').trim().toLowerCase();
  if (t.indexOf('0-3') !== -1 || t.indexOf('immediate') !== -1 || t.indexOf('asap') !== -1) return '0-3 months';
  if (t.indexOf('3-6') !== -1) return '3-6 months';
  if (t.indexOf('6-12') !== -1 || t.indexOf('6 - 12') !== -1) return '6-12 months';
  if (t.indexOf('12+') !== -1 || t.indexOf('1 year') !== -1 || t.indexOf('more than') !== -1) return '12+ months';
  return t || '6-12 months';
}

function mapSource(raw) {
  var s = String(raw || '').trim().toLowerCase();
  if (s.indexOf('facebook') !== -1) return 'Facebook';
  if (s.indexOf('instagram') !== -1) return 'Instagram';
  if (s.indexOf('referral') !== -1 || s.indexOf('refer') !== -1) return 'Referral';
  if (s.indexOf('website') !== -1 || s.indexOf('web') !== -1) return 'Website';
  if (s.indexOf('manychat') !== -1) return 'ManyChat';
  if (s.indexOf('line') !== -1) return 'Line';
  if (s.indexOf('whatsapp') !== -1) return 'WhatsApp';
  if (s.indexOf('telegram') !== -1) return 'Telegram';
  return raw || 'Other';
}

function formatDate(val) {
  if (!val) return '';
  try {
    var d = (val instanceof Date) ? val : new Date(val);
    // Reject invalid dates and Google Sheets epoch ghost dates (pre-2000)
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '';
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  } catch (e) {
    return '';
  }
}

// ── Row → PHC CRM Lead object ────────────────────────────────────

function rowToLead(row) {
  // Skip header rows (sheet has literal column name text instead of data)
  var rawId   = String(row[COL.LEAD_ID]   || '').trim();
  var rawName = String(row[COL.FULL_NAME] || '').trim();
  if (rawId === 'Lead ID' || rawName === 'Full Name') return null;

  var confirmed = row[COL.CONFIRMED_BUDGET];
  var budgetMax = row[COL.BUDGET_MAX];
  var budgetMin = row[COL.BUDGET_MIN];

  var notes = [
    row[COL.PURPOSE]        ? 'Purpose: '       + row[COL.PURPOSE]        : '',
    row[COL.PREFERRED_AREA] ? 'Area: '           + row[COL.PREFERRED_AREA] : '',
    row[COL.PROPERTY_TYPE]  ? 'Type: '           + row[COL.PROPERTY_TYPE]  : '',
    row[COL.CRITERIA_NOTES] ? 'Criteria: '       + row[COL.CRITERIA_NOTES] : '',
    row[COL.CONVERSATION_URL] ? 'Chat: '         + row[COL.CONVERSATION_URL] : '',
    row[COL.MATCHED_LISTINGS] ? 'Listings: '    + row[COL.MATCHED_LISTINGS] : ''
  ].filter(Boolean).join(' | ');

  // Use the existing Lead ID if present, otherwise generate one
  var sourceId = String(row[COL.LEAD_ID] || '').trim();
  var id = sourceId ? 'B-' + sourceId : 'B-' + Date.now();

  return {
    id:             id,
    createdAt:      formatDate(row[COL.TIMESTAMP]) || new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
    fullName:       String(row[COL.FULL_NAME] || '').trim(),
    nationality:    mapNationality(row[COL.LANGUAGE]),
    phone:          String(row[COL.WHATSAPP] || '').trim(),
    telegram:       String(row[COL.TELEGRAM] || '').trim(),
    email:          String(row[COL.EMAIL] || '').trim(),
    source:         mapSource(row[COL.SOURCE]),
    budget:         mapBudget(confirmed, budgetMax, budgetMin),
    timeline:       mapTimeline(row[COL.TIMELINE]),
    interestedIn:   '',
    stage:          mapStage(row[COL.STAGE]),
    score:          mapScore(row[COL.SCORE]),
    agent:          String(row[COL.AGENT_ASSIGNED] || '').trim(),
    notes:          notes,
    lastContact:    formatDate(row[COL.TIMESTAMP]),
    followUpDate:   formatDate(row[COL.NEXT_FOLLOW_UP]),
    followUpAction: String(row[COL.FOLLOW_UP_STATUS] || '').trim(),
    activities:     ''
  };
}

// ── Send to PHC CRM API ──────────────────────────────────────────

function sendToPHC(lead, isNew) {
  var payload = isNew
    ? { action: 'insert', sheet: 'Leads', data: lead }
    : { action: 'update', sheet: 'Leads', id: lead.id, data: lead };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(PHC_API_URL, options);
    var code = response.getResponseCode();
    var text = response.getContentText();
    Logger.log('[sendToPHC] ' + (isNew ? 'INSERT' : 'UPDATE') + ' id=' + lead.id + ' → HTTP ' + code + ' ' + text.substring(0, 100));
    return code === 200;
  } catch (e) {
    Logger.log('[sendToPHC] ERROR: ' + e.toString());
    return false;
  }
}

// ── Check if a lead ID already exists in PHC CRM ────────────────

function existsInPHC(leadId) {
  try {
    var url = PHC_API_URL + '?action=getAll&sheet=Leads';
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var rows = JSON.parse(response.getContentText());
    return rows.some(function(r) { return r.id === leadId; });
  } catch (e) {
    Logger.log('[existsInPHC] ERROR: ' + e.toString());
    return false;
  }
}

// ── onChange trigger ─────────────────────────────────────────────

/**
 * Fires automatically when a new row is inserted into the source sheet.
 * Bound to the existing lead inquiry sheet via setupTrigger().
 */
function onSheetChange(e) {
  if (!e || e.changeType !== 'INSERT_ROW') return;

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SOURCE_TAB);
  if (!sheet) return;

  // Give the sheet a moment to finish writing before we read
  Utilities.sleep(2000);

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return; // header only

  var row = sheet.getRange(lastRow, 1, 1, 24).getValues()[0];
  if (!row[COL.FULL_NAME]) return; // blank row

  var lead = rowToLead(row);
  if (!lead) return; // header row

  var isNew = !existsInPHC(lead.id);

  var ok = sendToPHC(lead, isNew);
  Logger.log('[onSheetChange] row ' + lastRow + ' → ' + (ok ? 'synced' : 'FAILED') + ' (id=' + lead.id + ')');
}

// ── Backfill: sync ALL existing rows to PHC CRM ──────────────────

/**
 * Run once to import all existing rows from the lead inquiry sheet.
 * Safe to re-run — will update rows that already exist (by ID).
 */
function syncAllToPHC() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SOURCE_TAB);
  if (!sheet) { Logger.log('❌ Sheet "' + SOURCE_TAB + '" not found'); return; }

  var allData = sheet.getDataRange().getValues();
  if (allData.length < 2) { Logger.log('No data rows found'); return; }

  // Fetch existing IDs from PHC CRM once (avoid N API calls)
  var existingIds = {};
  try {
    var url = PHC_API_URL + '?action=getAll&sheet=Leads';
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var rows = JSON.parse(response.getContentText());
    rows.forEach(function(r) { existingIds[r.id] = true; });
    Logger.log('PHC CRM has ' + rows.length + ' existing lead(s)');
  } catch (e) {
    Logger.log('Could not fetch existing leads: ' + e.toString());
  }

  var inserted = 0, updated = 0, skipped = 0, errors = 0;

  for (var i = 1; i < allData.length; i++) {
    var row = allData[i];
    if (!row[COL.FULL_NAME]) { skipped++; continue; } // blank row

    var lead = rowToLead(row);
    if (!lead) { skipped++; continue; } // header row

    var isNew = !existingIds[lead.id];
    var ok    = sendToPHC(lead, isNew);

    if (ok) {
      existingIds[lead.id] = true;
      if (isNew) inserted++; else updated++;
    } else {
      errors++;
    }

    // Throttle: 1 request per second to avoid Apps Script quota
    if (i % 10 === 0) Utilities.sleep(1000);
  }

  Logger.log('✅ syncAllToPHC complete — inserted: ' + inserted + ', updated: ' + updated + ', skipped: ' + skipped + ', errors: ' + errors);
}

// ── One-time setup ───────────────────────────────────────────────

/**
 * Run ONCE from the Apps Script editor to install the onChange trigger.
 * After this, every new row in the lead inquiry sheet auto-syncs to PHC CRM.
 */
function setupTrigger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Remove any existing triggers for onSheetChange to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'onSheetChange') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Removed existing onSheetChange trigger');
    }
  });

  // Create a new onChange trigger
  ScriptApp.newTrigger('onSheetChange')
    .forSpreadsheet(ss)
    .onChange()
    .create();

  Logger.log('✅ onSheetChange trigger installed on: ' + ss.getName());
  Logger.log('New rows in "' + SOURCE_TAB + '" will now auto-sync to PHC CRM.');
}
