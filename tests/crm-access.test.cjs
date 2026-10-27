// Tests the CRM access keys in PHC_AppsScript.gs (2026-10-27): runs the real script in a sandbox
// with fake Google services, so nothing reaches the live CRM. Run: node tests/crm-access.test.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

function load() {
  const props = new Map();
  const alerts = [];
  const prompts = [];
  const sheetRows = { Leads: [
    { id: 'W-1', fullName: 'Web Client', telegram: '', stage: 'New Lead', agent: 'Monika', source: 'Website', phone: '+855 12 345 678' },
    { id: 'TG-1', fullName: 'Bot Client', telegram: '@taro tg:123456', stage: 'New Lead', agent: 'Nick', source: 'Telegram', phone: '' },
  ] };
  const writes = [];
  const ctx = {
    console,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => props.set(k, String(v)),
      deleteProperty: (k) => props.delete(k),
      getProperties: () => Object.fromEntries(props),
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      // Apps Script returns signed bytes (-128..127)
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => d.toISOString().slice(0, 10),
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ body: JSON.parse(s), setMimeType() { return this; } }) },
    Session: { getScriptTimeZone: () => 'Asia/Phnom_Penh' },
    SpreadsheetApp: { getUi: () => ({
      ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' }, Button: { OK: 'OK' },
      prompt: () => { const t = prompts.shift(); return { getSelectedButton: () => (t === null ? 'CANCEL' : 'OK'), getResponseText: () => t }; },
      alert: (...a) => alerts.push(a.filter((x) => typeof x === 'string').join('\n')),
      createMenu: () => ({ addItem() { return this; }, addToUi() {} }),
    }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'PHC_AppsScript.gs'), 'utf8'), ctx);
  // the sheet itself is faked: only the access rules are under test
  ctx.getAllRows = (name) => (sheetRows[name] || []).map((r) => Object.assign({}, r));
  const flat = (d) => Object.fromEntries(Object.entries(d || {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  ctx.insertRow = (name, data, opts) => { writes.push(['insert', name, data && data.id, opts && opts.quiet ? 'quiet' : 'alerts']);
    (sheetRows[name] = sheetRows[name] || []).push(flat(data)); return { success: true, id: data && data.id }; };
  ctx.updateRow = (name, id, data) => { writes.push(['update', name, id]); const r = (sheetRows[name] || []).find((x) => String(x.id) === String(id));
    if (!r) return { error: 'Row not found: ' + id }; Object.assign(r, flat(data)); return { success: true }; };
  ctx.deleteRow = (name, id) => { writes.push(['delete', name, id]); return { success: true }; };
  const get = (q) => ctx.doGet({ parameter: q }).body;
  const post = (b) => ctx.doPost({ postData: { contents: JSON.stringify(b) } }).body;
  const makeKey = (name, role) => { prompts.push(name, role); ctx.accessCreate(); return (alerts[alerts.length - 1].match(/phc_[a-z]+_[0-9a-f]{32}/) || [])[0]; };
  return { ctx, props, alerts, prompts, writes, get, post, makeKey, sheetRows };
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); } catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + e.message); }
}
const UNAUTH = { error: 'Unauthorized' };

console.log('\nCRM access keys\n');

t('no key: everything is refused (fails closed)', () => {
  const s = load(); s.props.set('API_KEY', 'old-shared');
  assert.deepStrictEqual(s.get({ action: 'ping' }), UNAUTH);
  assert.deepStrictEqual(s.get({ action: 'getAll', sheet: 'Leads' }), UNAUTH);
  assert.deepStrictEqual(s.post({ action: 'insert', sheet: 'Leads', data: { id: 'X' } }), UNAUTH);
  assert.strictEqual(s.writes.length, 0);
});

t('no key even when no API_KEY property exists (the old code let everything through)', () => {
  const s = load();
  assert.deepStrictEqual(s.get({ action: 'getAll', sheet: 'Leads' }), UNAUTH);
});

t('the old shared key still works as staff during the switch', () => {
  const s = load(); s.props.set('API_KEY', 'old-shared');
  assert.strictEqual(s.get({ action: 'getAll', sheet: 'Leads', key: 'old-shared' }).length, 2);
  assert.deepStrictEqual(s.post({ action: 'delete', sheet: 'Deals', id: 'D1', key: 'old-shared' }), { success: true });
});

t('after API_KEY is deleted, the old shared key is refused', () => {
  const s = load(); s.props.set('API_KEY', 'old-shared'); s.props.delete('API_KEY');
  assert.deepStrictEqual(s.get({ action: 'getAll', sheet: 'Leads', key: 'old-shared' }), UNAUTH);
});

t('a staff key can read and write every tab', () => {
  const s = load(); const k = s.makeKey('Monika', 'staff'); s.sheetRows.Clients = [{ id: 'C1' }];
  assert.ok(/^phc_staff_[0-9a-f]{32}$/.test(k), k);
  assert.strictEqual(s.get({ action: 'getAll', sheet: 'Leads', key: k }).length, 2);
  assert.deepStrictEqual(s.post({ action: 'update', sheet: 'Clients', id: 'C1', data: {}, key: k }), { success: true });
  assert.deepStrictEqual(s.post({ action: 'delete', sheet: 'Tasks', id: 'T1', key: k }), { success: true });
});

t('the website key: ping, health check and add a lead only; it can never read leads', () => {
  const s = load(); const k = s.makeKey('Website', 'website');
  assert.strictEqual(s.get({ action: 'ping', key: k }).ok, true);
  assert.ok(/Unknown action/.test(s.post({ action: 'healthcheck', sheet: 'Leads', key: k }).error)); // what the daily check expects
  assert.deepStrictEqual(s.post({ action: 'insert', sheet: 'Leads', data: { id: 'W-2' }, key: k }), { success: true, id: 'W-2' });
  assert.deepStrictEqual(s.get({ action: 'getAll', sheet: 'Leads', key: k }), UNAUTH);
  assert.deepStrictEqual(s.post({ action: 'update', sheet: 'Leads', id: 'W-1', data: {}, key: k }), UNAUTH);
  assert.deepStrictEqual(s.post({ action: 'insert', sheet: 'Deals', data: { id: 'D9' }, key: k }), UNAUTH);
  assert.deepStrictEqual(s.post({ action: 'find', sheet: 'Leads', by: { id: 'W-1' }, key: k }), UNAUTH);
});

t('the bot key: only its own clients; no reading, no generic writes, no other tabs', () => {
  const s = load(); const k = s.makeKey('Telegram bot', 'bot');
  assert.strictEqual(s.get({ action: 'ping', key: k }).ok, true);
  for (const b of [{ action: 'insert', sheet: 'Leads', data: { id: 'TG-9' } }, { action: 'update', sheet: 'Leads', id: 'W-1', data: {} },
    { action: 'find', sheet: 'Leads', by: { id: 'W-1' } }, { action: 'delete', sheet: 'Leads', id: 'W-1' }, { action: 'botUpsert', sheet: 'Clients', lead: { id: 'TG-9' } }]) {
    assert.deepStrictEqual(s.post(Object.assign({ key: k }, b)), UNAUTH, b.action);
  }
  assert.deepStrictEqual(s.get({ action: 'getAll', sheet: 'Leads', key: k }), UNAUTH);
});

t('bot: a new client becomes a quiet row for Nick (no PHC email, no team alert)', () => {
  const s = load(); const k = s.makeKey('Telegram bot', 'bot');
  const r = s.post({ action: 'botUpsert', sheet: 'Leads', key: k, event: 'Guide sent (JP)',
    lead: { id: 'TG-777', fullName: 'Taro Yamada', nationality: 'Japanese', telegram: '@taro tg:777', budget: '$100K-$200K', score: 4, notes: 'Telegram bot' } });
  assert.deepStrictEqual(r, { success: true, created: true });
  assert.deepStrictEqual(s.writes.pop(), ['insert', 'Leads', 'TG-777', 'quiet']);
  const row = s.sheetRows.Leads.find((x) => x.id === 'TG-777');
  assert.strictEqual(row.agent, 'Nick'); assert.strictEqual(row.source, 'Telegram'); assert.strictEqual(row.stage, 'New Lead');
  assert.strictEqual(JSON.parse(row.activities)[0].note, 'Guide sent (JP)');
});

t('bot: an existing client gets a new history entry; what the team typed is never overwritten', () => {
  const s = load(); const k = s.makeKey('Telegram bot', 'bot');
  s.sheetRows.Leads.push({ id: 'TG-5', fullName: 'Hana', telegram: '@hana tg:5', stage: 'Viewing', agent: 'Nick', notes: 'Called her, wants 2BR',
    budget: '', interestedIn: 'TS7-5001', activities: JSON.stringify([{ type: 'Call', note: 'First call', ts: '2026-10-20T01:00:00Z' }]) });
  s.post({ action: 'botUpsert', sheet: 'Leads', key: k, event: 'Asked about MR-6004',
    lead: { id: 'TG-5', fullName: 'Hana S', telegram: '@hana_s tg:5', budget: '$200K-$300K', interestedIn: 'MR-6004', notes: 'bot text' } });
  const row = s.sheetRows.Leads.find((x) => x.id === 'TG-5');
  assert.strictEqual(row.stage, 'Viewing'); assert.strictEqual(row.notes, 'Called her, wants 2BR'); assert.strictEqual(row.fullName, 'Hana');
  assert.strictEqual(row.budget, '$200K-$300K', 'empty field filled'); assert.strictEqual(row.telegram, '@hana_s tg:5', 'username kept current');
  assert.strictEqual(row.interestedIn, 'TS7-5001, MR-6004');
  const acts = JSON.parse(row.activities); assert.strictEqual(acts.length, 2); assert.strictEqual(acts[0].note, 'Asked about MR-6004'); assert.strictEqual(acts[1].note, 'First call');
});

t('bot: can never write to a website lead, and forgetting a client blanks the personal data', () => {
  const s = load(); const k = s.makeKey('Telegram bot', 'bot');
  assert.ok(/TG-123/.test(s.post({ action: 'botUpsert', sheet: 'Leads', key: k, lead: { id: 'W-1', fullName: 'x' } }).error));
  assert.ok(/TG-123/.test(s.post({ action: 'botForget', sheet: 'Leads', key: k, id: 'W-1' }).error));
  assert.strictEqual(s.sheetRows.Leads.find((x) => x.id === 'W-1').fullName, 'Web Client');
  assert.deepStrictEqual(s.post({ action: 'botForget', sheet: 'Leads', key: k, id: 'TG-1' }), { success: true });
  const row = s.sheetRows.Leads.find((x) => x.id === 'TG-1');
  assert.ok(/Deleted/.test(row.fullName) && row.telegram === '' && row.stage === 'Released');
  assert.deepStrictEqual(s.post({ action: 'botForget', sheet: 'Leads', key: k, id: 'TG-404' }), { success: true, missing: true });
});

t('bot: a client who deleted their data and comes back is a fresh lead again', () => {
  const s = load(); const k = s.makeKey('Telegram bot', 'bot');
  s.post({ action: 'botForget', sheet: 'Leads', key: k, id: 'TG-1' });
  s.post({ action: 'botUpsert', sheet: 'Leads', key: k, event: 'Guide sent (Japanese PDF)', lead: { id: 'TG-1', fullName: 'Taro', nationality: 'Japanese', telegram: 'tg:1', notes: 'From the bot' } });
  const row = s.sheetRows.Leads.find((x) => x.id === 'TG-1');
  assert.deepStrictEqual([row.fullName, row.stage, row.agent, row.nationality, row.notes, row.source], ['Taro', 'New Lead', 'Nick', 'Japanese', 'From the bot', 'Telegram']);
  const acts = JSON.parse(row.activities); assert.strictEqual(acts[0].note, 'Guide sent (Japanese PDF)'); assert.ok(/deleted their data/.test(acts[1].note));
});

t('bot: "Other" nationality is upgraded once the client picks a language; a real one is kept', () => {
  const s = load(); const k = s.makeKey('Telegram bot', 'bot');
  s.sheetRows.Leads.push({ id: 'TG-8', fullName: 'A', nationality: 'Other', activities: '[]' }, { id: 'TG-9', fullName: 'B', nationality: 'German', activities: '[]' });
  s.post({ action: 'botUpsert', sheet: 'Leads', key: k, lead: { id: 'TG-8', nationality: 'Japanese' } });
  s.post({ action: 'botUpsert', sheet: 'Leads', key: k, lead: { id: 'TG-9', nationality: 'Japanese' } });
  assert.strictEqual(s.sheetRows.Leads.find((x) => x.id === 'TG-8').nationality, 'Japanese');
  assert.strictEqual(s.sheetRows.Leads.find((x) => x.id === 'TG-9').nationality, 'German');
});

t('the website key cannot use the bot actions', () => {
  const s = load(); const k = s.makeKey('Website', 'website');
  assert.deepStrictEqual(s.post({ action: 'botUpsert', sheet: 'Leads', key: k, lead: { id: 'TG-1' } }), UNAUTH);
});

t('find (staff only) matches a whole telegram entry, never part of one', () => {
  const s = load(); const k = s.makeKey('Nick', 'staff');
  assert.deepStrictEqual(s.post({ action: 'find', sheet: 'Leads', by: { telegram: 'tg:12' }, key: k }), { lead: null });
  assert.strictEqual(s.post({ action: 'find', sheet: 'Leads', by: { telegram: '@TARO' }, key: k }).lead.id, 'TG-1');
});

t('the bridge key: add, update and check a lead exists', () => {
  const s = load(); const k = s.makeKey('Bridge', 'bridge');
  assert.deepStrictEqual(s.post({ action: 'exists', sheet: 'Leads', id: 'W-1', key: k }), { exists: true });
  assert.deepStrictEqual(s.post({ action: 'exists', sheet: 'Leads', id: 'nope', key: k }), { exists: false });
  assert.deepStrictEqual(s.get({ action: 'getAll', sheet: 'Leads', key: k }), UNAUTH);
});

t('a made-up or mistyped key is refused', () => {
  const s = load(); const k = s.makeKey('Nick', 'staff');
  assert.deepStrictEqual(s.get({ action: 'ping', key: k.slice(0, -1) + (k.slice(-1) === 'a' ? 'b' : 'a') }), UNAUTH);
  assert.deepStrictEqual(s.get({ action: 'ping', key: 'phc_staff_00000000000000000000000000000000' }), UNAUTH);
});

t('Script Properties never hold a readable key, only fingerprints', () => {
  const s = load(); const k = s.makeKey('Nick', 'staff');
  const all = JSON.stringify(Object.fromEntries(s.props));
  assert.ok(!all.includes(k) && !all.includes(k.slice(10)), 'the key itself is not stored');
  assert.ok([...s.props.keys()].every((p) => /^K_[0-9a-f]{64}$/.test(p)));
});

t('replacing a key (lost phone) switches the old one off at once', () => {
  const s = load(); const k1 = s.makeKey('Reza', 'staff'); const k2 = s.makeKey('reza', 'staff');
  assert.notStrictEqual(k1, k2);
  assert.deepStrictEqual(s.get({ action: 'ping', key: k1 }), UNAUTH);
  assert.strictEqual(s.get({ action: 'ping', key: k2 }).ok, true);
  assert.strictEqual([...s.props.keys()].length, 1);
});

t('removing a key by name switches it off; other keys keep working', () => {
  const s = load(); const a = s.makeKey('Marina', 'staff'); const b = s.makeKey('Nick', 'staff');
  s.prompts.push('Marina'); s.ctx.accessRemove();
  assert.deepStrictEqual(s.get({ action: 'ping', key: a }), UNAUTH);
  assert.strictEqual(s.get({ action: 'ping', key: b }).ok, true);
  assert.ok(/Removed/.test(s.alerts[s.alerts.length - 1]));
});

t('an unknown role is refused and nothing is stored', () => {
  const s = load(); s.prompts.push('Someone', 'admin'); s.ctx.accessCreate();
  assert.ok(/Unknown role/.test(s.alerts[0])); assert.strictEqual(s.props.size, 0);
});

t('List access keys shows names and roles, never the keys', () => {
  const s = load(); s.props.set('API_KEY', 'old-shared'); const k = s.makeKey('Nick', 'staff'); s.ctx.accessList();
  const shown = s.alerts[s.alerts.length - 1];
  assert.ok(/Nick\s+·\s+staff/.test(shown) && /old shared key \(API_KEY\) still works/.test(shown) && !shown.includes(k), shown);
});

t('first setup makes the 4 team keys and the website key at once, and never runs twice', () => {
  const s = load(); s.ctx.accessSetupAll();
  const keys = s.alerts[0].match(/phc_[a-z]+_[0-9a-f]{32}/g);
  assert.strictEqual(keys.length, 5); assert.ok(/Nick \(staff\)/.test(s.alerts[0]) && /Website \(website\)/.test(s.alerts[0]));
  assert.strictEqual(s.get({ action: 'getAll', sheet: 'Leads', key: keys[0] }).length, 2);
  assert.deepStrictEqual(s.get({ action: 'getAll', sheet: 'Leads', key: keys[4] }), UNAUTH); // the website key cannot read
  s.ctx.accessSetupAll(); assert.ok(/already exist/.test(s.alerts[1])); assert.strictEqual(s.props.size, 5);
});

console.log('\nRESULTS: ' + pass + ' / ' + (pass + fail) + ' TESTS PASSED' + (fail ? '' : ' (100%)'));
process.exit(fail ? 1 : 0);
