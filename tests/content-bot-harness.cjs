// Content Bot test harness (no dependencies, no build step): node tests/content-bot-harness.cjs
// Runs PHC_ContentBot_AppsScript.gs inside a Node `vm` with fakes for Telegram, the website endpoint, CacheService, LockService,
// SpreadsheetApp and LanguageApp. The fake Telegram copies a real Apps Script quirk: a Number chat id goes out as "3.5E8" and is
// answered "chat not found", so only String ids pass. Add a scenario for every bug found in real use. Never touches the network.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'PHC_ContentBot_AppsScript.gs'), 'utf8');

function makeEnv() {
  const env = { calls: [], props: { BOT_TOKEN: '111:TEST', INTAKE_API_SECRET: 'sek', DRY_RUN: '' }, cache: {}, intakeLog: [] };
  env.intakeBehavior = (payload) => null; // override per test: return {code, body}
  // a tiny in-memory Google Sheet, enough for the real (old) listing flow to run
  const HEADERS = ['id', 'createdAt', 'language', 'content', 'status', 'reviewMsgId', 'postedMsgId', 'postedAt', 'photoFileId', 'listingType', 'entities'];
  env.sheetData = [HEADERS.slice()];
  const cell = (r, c) => ({
    setValue(v) { while (env.sheetData.length < r) env.sheetData.push([]); env.sheetData[r - 1][c - 1] = v; return this; },
    getValue() { return (env.sheetData[r - 1] || [])[c - 1]; },
  });
  const sheet = {
    getLastColumn: () => HEADERS.length,
    getLastRow: () => env.sheetData.length,
    getDataRange: () => ({ getValues: () => env.sheetData.map((row) => HEADERS.map((_, i) => (row[i] === undefined ? '' : row[i]))) }),
    getRange(r, c, nr, nc) {
      const base = cell(r, c);
      base.getValues = () => [HEADERS.slice()];
      base.setValues = (vals) => { vals.forEach((row, i) => { while (env.sheetData.length < r + i) env.sheetData.push([]); row.forEach((v, j) => { env.sheetData[r + i - 1][c + j - 1] = v; }); }); return base; };
      ['setBackground', 'setFontColor', 'setFontWeight', 'setFontSize'].forEach((m) => { base[m] = () => base; });
      return base;
    },
    setFrozenRows() {},
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    LanguageApp: { translate: (t, from, to) => `[${to}] ${t}` },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => env.props[k] ?? null, setProperty: (k, v) => { env.props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in env.cache ? env.cache[k] : null), put: (k, v) => { env.cache[k] = v; }, remove: (k) => { delete env.cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }), getUserLock: () => ({ tryLock() { return !env.userLockBusy; }, releaseLock() { env.userLockReleased = (env.userLockReleased || 0) + 1; } }) },
    Utilities: { getUuid: () => 'abcdef12-3456-7890-abcd-ef1234567890'.replace(/./g, (c, i) => (c === '-' ? c : 'abcdef0123456789'[(i * 7 + env.calls.length) % 16])) },
    UrlFetchApp: {
      fetchAll(reqs) { env.fetchAllSizes = (env.fetchAllSizes || []).concat([reqs.length]); return reqs.map((r) => ctx.UrlFetchApp.fetch(r.url, r)); },
      fetch(url, opts) {
        opts = opts || {};
        const rec = { url, opts };
        env.calls.push(rec);
        const text = (o) => ({ getContentText: () => JSON.stringify(o), getResponseCode: () => 200 });
        if (url.includes('/getUpdates')) {
          env.getUpdatesUrls = (env.getUpdatesUrls || []);
          env.getUpdatesUrls.push(url);
          let next = (env.updates || []).shift();
          if (typeof next === 'function') next = next();
          return text({ ok: true, result: next || [] });
        }
        if (url.includes('api.telegram.org')) {
          // Real Apps Script behaviour (see phc-tools CLAUDE.md gotcha 11): a JS Number in a form payload is
          // sent as e.g. "3.53195979E8", which Telegram answers with "chat not found". Only strings work.
          const p = opts.payload || {};
          if (typeof p.chat_id === 'number' || typeof p.message_id === 'number') {
            env.telegramRejected = (env.telegramRejected || 0) + 1;
            return text({ ok: false, error_code: 400, description: 'Bad Request: chat not found' });
          }
          return text({ ok: true, result: { message_id: 900 + env.calls.length } });
        }
        if (url.includes('/rest/v1/properties') && url.includes('select=features')) {
          return text([{ features: ['Fitness Centre', '24-Hour Security', 'Sky Lounge'] }]);
        }
        if (url.includes('/rest/v1/properties') && url.includes('status=eq.active')) {
          return text(env.pageLive ? [{ id: 5 }] : []);
        }
        if (url.includes('/rest/v1/properties')) {
          return text([{ id: 8, title: 'Odom Living' }, { id: 16, title: 'GATO Tower' }]);
        }
        if (url.includes('/api/intake-unit')) {
          const payload = JSON.parse(opts.payload);
          env.intakeLog.push(payload);
          const custom = env.intakeBehavior(payload);
          const r = custom || defaultIntake(payload);
          return { getContentText: () => JSON.stringify(r.body), getResponseCode: () => r.code };
        }
        throw new Error('unexpected fetch ' + url);
      },
    },
  };
  function defaultIntake(p) {
    if (p.action === 'prepare') { const parts = [p.buildingName]; if (p.bedrooms !== null && p.bedrooms !== undefined) parts.push(p.bedrooms === 0 ? 'Studio' : `${p.bedrooms} Bedroom`); if (p.floor) parts.push(`Floor ${p.floor}`); return { code: 200, body: { ok: true, title: parts.join(' · '), slug: 'x-folder-a1b2c3', folder: 'x-folder-a1b2c3' } }; }
    if (p.action === 'photos') return { code: 200, body: { ok: true, urls: p.fileIds.map((f, i) => `https://u/${p.startIndex + i + 1}`) } };
    if (p.action === 'create') return { code: 200, body: { ok: true, id: 5, slug: 'x-slug-1005', refCode: 'GT-1005', previewUrl: 'https://site/property/x-slug-1005?preview=TOK' } };
    return { code: 200, body: { ok: true, removed: 0 } };
  }
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  env.ctx = ctx;
  env.sent = () => env.calls.filter((c) => c.url.includes('/sendMessage')).map((c) => c.opts.payload);
  env.edits = () => env.calls.filter((c) => c.url.includes('/editMessageText')).map((c) => c.opts.payload);
  return env;
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); } catch (e) { failures++; console.log('FAIL', name, '\n   ', e.message); }
}
const run = (env, code) => vm.runInContext(code, env.ctx);

// ---------- parsing
test('parseUnitText reads the standard caption', () => {
  const env = makeEnv();
  const r = run(env, `JSON.stringify(parseUnitText('#unit 2 bedroom, 2 bath, floor 14, unit 14B, 85 sqm, $185,000 https://youtu.be/Hk3x9aQ2mLw'))`);
  const o = JSON.parse(r);
  assert.deepStrictEqual(o, { price: 185000, bedrooms: 2, bathrooms: 2, sqm: 85, floor: '14', unitNumber: '14B', video: 'https://www.youtube.com/watch?v=Hk3x9aQ2mLw', listingType: 'resale', usedSqft: false });
});
test('parseUnitText handles studio, 14th floor, $1.2m, rent', () => {
  const env = makeEnv();
  const o = JSON.parse(run(env, `JSON.stringify(parseUnitText('#unit Studio, 14th floor, 38 m2, $1.2m'))`));
  assert.strictEqual(o.bedrooms, 0); assert.strictEqual(o.floor, '14'); assert.strictEqual(o.sqm, 38); assert.strictEqual(o.price, 1200000);
  const r = JSON.parse(run(env, `JSON.stringify(parseUnitText('/unit 1BR for rent $650/month 55sqm'))`));
  assert.strictEqual(r.listingType, 'rent'); assert.strictEqual(r.price, 650); assert.strictEqual(r.bedrooms, 1);
});
test('parseUnitText flags square feet and never converts', () => {
  const env = makeEnv();
  const o = JSON.parse(run(env, `JSON.stringify(parseUnitText('#unit 2 bed 900 sqft $150,000'))`));
  assert.strictEqual(o.usedSqft, true); assert.strictEqual(o.sqm, null);
});
test('unit number needs a digit (does not grab the word after "unit")', () => {
  const env = makeEnv();
  const o = JSON.parse(run(env, `JSON.stringify(parseUnitText('#unit corner unit with river view 2 bed $99,000'))`));
  assert.strictEqual(o.unitNumber, null);
});
test('#unit trigger detection', () => {
  const env = makeEnv();
  assert.strictEqual(run(env, `isUnitIntakeText('hello #unit 2 bed')`), true);
  assert.strictEqual(run(env, `isUnitIntakeText('/unit')`), true);
  assert.strictEqual(run(env, `isUnitIntakeText('#ForSale $100,000 unit details')`), false);
  assert.strictEqual(run(env, `isUnitIntakeText('#units are great')`), false);
});
test('image files sent "as File" are picked up; other documents are not', () => {
  const env = makeEnv();
  assert.strictEqual(run(env, `getImageFileId({photo:[{file_id:'a'},{file_id:'b'}]})`), 'b');
  assert.strictEqual(run(env, `getImageFileId({document:{file_id:'d1',mime_type:'image/jpeg'}})`), 'd1');
  assert.strictEqual(run(env, `getImageFileId({document:{file_id:'d2',file_name:'IMG_1.PNG'}})`), 'd2');
  assert.strictEqual(run(env, `getImageFileId({document:{file_id:'d3',mime_type:'application/pdf',file_name:'a.pdf'}})`), null);
});

// ---------- flow
const CHAT = 353195979;
const caption = '#unit 2 bedroom, floor 14, 85 sqm, $185,000';
const ids = (n) => Array.from({ length: n }, (_, i) => 'FILE' + (i + 1));
const cb = (data, mid = 700) => ({ id: 'cbq', data, message: { chat: { id: CHAT }, message_id: mid } });

test('message without #unit is left to the normal flow (no intake call, no unit prompt)', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, 'hi there', [], false, null, null, [])`);
  assert.strictEqual(env.sent().filter((p) => /existing|building/i.test(p.text)).length, 0);
});

test('only Nick can use #unit', () => {
  const env = makeEnv();
  env.ctx.__ids = ids(3);
  run(env, `handleIncomingMessage(999, '${caption}', [], false, null, null, __ids)`);
  assert.strictEqual(env.sent().length, 0);
});

test('only a price is needed to start a draft; missing bedrooms, floor or photos never block', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '#unit nice flat', [], false, null, null, [])`);
  const first = env.sent()[0].text;
  assert.ok(/- a price/.test(first) && !/- at least one photo/.test(first) && !/- the bedrooms/.test(first), first);
  assert.strictEqual(env.intakeLog.length, 0);
  const env2 = makeEnv();
  run(env2, `handleIncomingMessage(${CHAT}, '#unit $120,000 nice flat', [], false, null, null, [])`);
  assert.ok(/Is this building already on the website/.test(env2.sent()[0].text), env2.sent()[0].text);
});

test('square feet is refused with the sqm rule', () => {
  const env = makeEnv();
  env.ctx.__ids = ids(2);
  run(env, `handleIncomingMessage(${CHAT}, '#unit 2 bed 900 sqft $150,000', [], false, null, null, __ids)`);
  assert.ok(/sqm only/.test(env.sent()[0].text));
});

function startDraft(env, n = 7) {
  env.ctx.__ids = ids(n);
  run(env, `handleIncomingMessage(${CHAT}, '${caption} unit 14B https://youtu.be/Hk3x9aQ2mLw', [], false, null, null, __ids)`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice('unitdraft_'.length);
  return id;
}

test('full happy path: pick project, tick facilities, create (photos in batches of 3)', () => {
  const env = makeEnv();
  const id = startDraft(env, 7);
  const first = env.sent()[0];
  assert.ok(/Got 7 photos and a video link/.test(first.text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_pick'))})`);
  assert.ok(/Which project/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  const card = env.edits().pop();
  assert.ok(/Building: Odom Living \(on the website\)/.test(card.text) && /Odom Living · 2 Bedroom · Floor 14/.test(card.text), card.text);
  assert.ok(/Unit no\. \(private, never shown\): 14B/.test(card.text));
  assert.ok(/\$185,000/.test(card.text) && /85 sqm/.test(card.text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_f_0'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_f_2'))})`);
  assert.ok(/Facilities: 2 ticked/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const photoCalls = env.intakeLog.filter((p) => p.action === 'photos');
  assert.deepStrictEqual(photoCalls.map((p) => [p.startIndex, p.fileIds.length]), [[0, 3], [3, 3], [6, 1]]);
  const created = env.intakeLog.find((p) => p.action === 'create');
  assert.strictEqual(created.title, 'Odom Living · 2 Bedroom · Floor 14');
  assert.strictEqual(created.price, 185000); assert.strictEqual(created.parentPropertyId, 8);
  assert.strictEqual(created.unitNumber, '14B'); assert.strictEqual(created.sqm, 85);
  assert.deepStrictEqual(created.features, ['24-Hour Security', 'Swimming Pool']);
  assert.strictEqual(created.images.length, 7);
  assert.strictEqual(created.videoUrl, 'https://www.youtube.com/watch?v=Hk3x9aQ2mLw');
  const done = env.sent().pop().text;
  assert.ok(/Hidden draft created/.test(done) && /preview=TOK/.test(done) && /Publish Unit Live/.test(done));
  assert.ok(/Ref: GT-1005/.test(done), 'the reference code should be shown: ' + done);
  // every website call carried the shared secret
  env.calls.filter((c) => c.url.includes('/api/intake-unit')).forEach((c) => assert.strictEqual(c.opts.headers.Authorization, 'Bearer sek'));
});

test('the photo folder from prepare is used for the photos AND passed to create', () => {
  const env = makeEnv();
  const id = startDraft(env, 4);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.ok(env.intakeLog.filter((p) => p.action === 'photos').every((p) => p.slug === 'x-folder-a1b2c3'));
  assert.strictEqual(env.intakeLog.find((p) => p.action === 'create').folder, 'x-folder-a1b2c3');
});

test('a second tap on Create does nothing (no duplicate draft)', () => {
  const env = makeEnv();
  const id = startDraft(env, 3);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create').length, 1);
});

test('new building: asks for the name, then the area, then shows the summary', () => {
  const env = makeEnv();
  const id = startDraft(env, 2);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_new'))})`);
  assert.ok(/What is the building called/.test(env.edits().pop().text));
  run(env, `handleIncomingMessage(${CHAT}, 'Sky Villa', [], false, null, null, [])`);
  assert.ok(/Sky Villa is not on the website yet. Which area/.test(env.sent().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_a_1'))})`); // BKK3
  const prep = env.intakeLog.find((p) => p.action === 'prepare');
  assert.strictEqual(prep.buildingName, 'Sky Villa'); assert.strictEqual(prep.parentPropertyId, null);
  const card = env.edits().pop().text;
  assert.ok(/new building, BKK3/.test(card) && /Condo \(assumed/.test(card), card);
});

test('a forwarded listing is not swallowed while waiting for a building name', () => {
  const env = makeEnv();
  const id = startDraft(env, 2);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_new'))})`);
  assert.strictEqual(run(env, `isAwaitingUnitText(${CHAT}, '#ForSale $100,000 something', false)`), false);
  assert.strictEqual(run(env, `isAwaitingUnitText(${CHAT}, 'Sky Villa', true)`), false);
  assert.strictEqual(run(env, `isAwaitingUnitText(${CHAT}, 'Sky Villa', false)`), true);
});

test('a failed photo batch cleans up, creates nothing, and lets Nick retry', () => {
  const env = makeEnv();
  const id = startDraft(env, 7);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  env.intakeBehavior = (p) => (p.action === 'photos' && p.startIndex === 3 ? { code: 422, body: { ok: false, error: 'unsupported_image', failedIndex: 4 } } : null);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.ok(env.intakeLog.some((p) => p.action === 'cleanup' && p.slug === 'x-folder-a1b2c3'));
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create').length, 0);
  assert.ok(/photo 5.*HEIC/.test(env.sent().pop().text));
  assert.strictEqual(JSON.parse(env.cache['unitdraft_' + id]).step, 'summary'); // can retry
});

test('a failed create also cleans up the photos', () => {
  const env = makeEnv();
  const id = startDraft(env, 2);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  env.intakeBehavior = (p) => (p.action === 'create' ? { code: 500, body: { ok: false, error: 'create_failed' } } : null);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.ok(env.intakeLog.some((p) => p.action === 'cleanup'));
  assert.ok(/Nothing was created/.test(env.sent().pop().text));
});

test('missing secrets on the website side give a clear message', () => {
  const env = makeEnv();
  env.intakeBehavior = () => ({ code: 503, body: { error: 'Not configured' } });
  const id = startDraft(env, 2);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  assert.ok(/not switched on yet/.test(env.edits().pop().text));
});

test('DRY_RUN never calls the website', () => {
  const env = makeEnv();
  env.props.DRY_RUN = 'true';
  const id = startDraft(env, 5);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(env.calls.filter((c) => c.url.includes('/api/intake-unit')).length, 0);
  assert.ok(/DRY RUN/.test(env.sent().pop().text));
});

test('cancel removes the draft', () => {
  const env = makeEnv();
  const id = startDraft(env, 2);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_x'))})`);
  assert.ok(!env.cache['unitdraft_' + id]);
  assert.ok(/Cancelled/.test(env.edits().pop().text));
});

test('callbacks from anyone but Nick are refused', () => {
  const env = makeEnv();
  const id = startDraft(env, 2);
  const bad = { id: 'x', data: 'unit_' + id + '_go', message: { chat: { id: 12345 }, message_id: 1 } };
  run(env, `handleCallback(${JSON.stringify(bad)})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action !== 'prepare').length, 0);
});

test('Telegram never rejects our sends (chat ids and message ids go out as strings)', () => {
  const env = makeEnv();
  const id = startDraft(env, 3);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_pick'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_f_0'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(env.telegramRejected || 0, 0, 'Telegram rejected ' + env.telegramRejected + ' call(s) with chat not found');
  assert.ok(env.sent().length >= 2, 'bot should have sent messages');
});
test('a #unit message gets an answer (first reply is not rejected)', () => {
  const env = makeEnv();
  startDraft(env, 1);
  assert.strictEqual(env.telegramRejected || 0, 0);
});


// ---------- fast mode
const fastClock = (env) => run(env, `Date = { now: (function(){ let t = 0; return function(){ t += 15000; return t; }; })() };`);
const msgUpdate = (id, n = 3) => ({ update_id: id, message: { message_id: id, chat: { id: CHAT }, caption: caption, photo: [{ file_id: 'F1' }, { file_id: 'F2' }] } });
const tapUpdate = (id, data, mid = 700) => ({ update_id: id, callback_query: { id: 'cbq' + id, data, message: { chat: { id: CHAT }, message_id: mid } } });
const countPolls = (env) => (env.getUpdatesUrls || []).length;

test('idle: checkForUpdates polls exactly once, without waiting', () => {
  const env = makeEnv(); fastClock(env);
  run(env, `checkForUpdates()`);
  assert.strictEqual(countPolls(env), 1);
  assert.ok(env.getUpdatesUrls[0].includes('timeout=0'));
  assert.strictEqual(env.userLockReleased, 1);
});

test('busy: if a previous run still holds the lock, this run does nothing', () => {
  const env = makeEnv(); fastClock(env);
  env.userLockBusy = true;
  run(env, `checkForUpdates()`);
  assert.strictEqual(countPolls(env), 0);
});

test('during a #unit session the run keeps listening (long polling) and then stops by itself', () => {
  const env = makeEnv();
  env.updates = [[msgUpdate(901)]];
  fastClock(env);
  run(env, `checkForUpdates()`);
  const urls = env.getUpdatesUrls;
  assert.ok(urls.length > 1, 'should poll more than once, got ' + urls.length);
  assert.ok(urls[0].includes('timeout=0'));
  assert.ok(urls.slice(1).every((u) => u.includes('timeout=5')));
  assert.ok(urls.length <= Math.ceil(240000 / 15000) + 2, 'loop must be bounded by the 4 minute cap, got ' + urls.length);
  assert.strictEqual(env.userLockReleased, 1);
});

test('a tap that arrives while listening is handled in the SAME run (no wait for the next minute)', () => {
  const env = makeEnv();
  let draftId = null;
  env.updates = [
    [msgUpdate(901)],
    () => { draftId = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10); return [tapUpdate(902, 'unit_' + draftId + '_pick')]; },
  ];
  fastClock(env);
  run(env, `checkForUpdates()`);
  assert.ok(env.edits().some((e) => /Which project/.test(e.text)), 'the project list should already be shown');
});

test('the session closes when the draft is created or cancelled', () => {
  const env = makeEnv();
  const id = startDraft(env, 2);
  assert.strictEqual(run(env, `isUnitSessionActive()`), true);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(run(env, `isUnitSessionActive()`), false);
  const env2 = makeEnv();
  const id2 = startDraft(env2, 2);
  run(env2, `handleCallback(${JSON.stringify(cb('unit_' + id2 + '_x'))})`);
  assert.strictEqual(run(env2, `isUnitSessionActive()`), false);
});

test('a failed upload keeps the session open so a retry is also fast', () => {
  const env = makeEnv();
  const id = startDraft(env, 2);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  env.intakeBehavior = (p) => (p.action === 'photos' ? { code: 422, body: { ok: false, error: 'unsupported_image', failedIndex: 0 } } : null);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(run(env, `isUnitSessionActive()`), true);
});


// ---------- albums split across two polls
const albumPhoto = (uid, fid, gid, withCaption) => {
  const m = { message_id: uid, chat: { id: CHAT }, media_group_id: gid, photo: [{ file_id: fid + 's' }, { file_id: fid }] };
  if (withCaption) m.caption = caption;
  return { update_id: uid, message: m };
};

test('album split in two batches: late photos join the draft and the listing flow stays silent', () => {
  const env = makeEnv(); fastClock(env);
  env.updates = [[albumPhoto(901, 'A1', 'G1', true), albumPhoto(902, 'A2', 'G1', false)], [albumPhoto(903, 'A3', 'G1', false)]];
  run(env, `checkForUpdates()`);
  const key = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_'));
  const d = JSON.parse(env.cache[key]);
  assert.deepStrictEqual(d.images, ['A1', 'A2', 'A3']);
  const texts = env.sent().map((p) => p.text);
  assert.ok(texts.some((t) => /Got 2 photos/.test(t)), texts.join(' | '));
  assert.ok(!texts.some((t) => /couldn't recognize/.test(t)), 'listing recognizer must stay silent: ' + texts.join(' | '));
  assert.strictEqual(env.telegramRejected || 0, 0);
});

test('a late photo after the draft was created is reported, not silently lost or mistaken for a listing', () => {
  const env = makeEnv(); fastClock(env);
  env.updates = [[albumPhoto(901, 'A1', 'G2', true)]];
  run(env, `checkForUpdates()`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  env.updates = [[albumPhoto(950, 'LATE', 'G2', false)]];
  run(env, `checkForUpdates()`);
  const texts = env.sent().map((p) => p.text);
  assert.ok(texts.some((t) => /arrived after I had started creating/.test(t)), texts.join(' | '));
  assert.ok(!texts.some((t) => /couldn't recognize/.test(t)));
});

test('a photo-only album now waits for its text instead of the old "couldn\'t recognize" reply', () => {
  const env = makeEnv(); fastClock(env);
  env.updates = [[albumPhoto(901, 'P1', 'G9', false), albumPhoto(902, 'P2', 'G9', false)]];
  run(env, `checkForUpdates()`);
  const texts = env.sent().map((p) => p.text);
  assert.ok(texts.some((t) => /Got 2 photos. Now send the post text/.test(t)), texts.join(' | '));
  assert.ok(!texts.some((t) => /couldn't recognize/.test(t)));
});

test('photos of a cancelled draft are dropped quietly', () => {
  const env = makeEnv(); fastClock(env);
  env.updates = [[albumPhoto(901, 'A1', 'G3', true)]];
  run(env, `checkForUpdates()`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_x'))})`);
  const before = env.sent().length;
  env.updates = [[albumPhoto(960, 'A9', 'G3', false)]];
  run(env, `checkForUpdates()`);
  assert.strictEqual(env.sent().length, before);
});


// ====================== menu, full post reader, gaps ======================
const bold = (env, t) => run(env, `toBoldSansSerif(${JSON.stringify(t)})`);
const residenceL = (env) => [
  '#ForSale $35,000', '', bold(env, 'RESIDENCE L | 1BR UNIT'), '📍 Boeung Tumpun, Phnom Penh', '', '――――――――――', '',
  bold(env, 'UNIT DETAILS'), '✅ Unit G10-09 | 9th Floor', '✅ 1 Bedroom | 1 Bathroom', '✅ 47㎡ Gross | 38㎡ Net', '✅ Strata Title', '✅ Fully Furnished', '',
  bold(env, 'FACILITIES'), '✅ Swimming Pool & Gym', '✅ Coffee Shop', '✅ Convenience Store', '✅ Laundry Room', '', '💰 Selling Price: $35,000',
].join('\n');
const timeSquare6 = (env) => [
  bold(env, 'TIME SQUARE 6 | 1BR RESALE'), '', '💰 $98,000 → $94,000', '', '📍 BKK1, Phnom Penh', '', '――――――――――', '',
  bold(env, 'UNIT DETAILS'), '✅ 1 Bedroom | 1 Bathroom', '✅ 57㎡', '✅ 26th Floor', '✅ North Facing', '✅ Fully Furnished', '✅ Handover: Early 2027', '',
  '――――――――――', '📞 096 96 61 555', '🏠 t.me/NickREAKH', '📱 t.me/Nick_REAKH',
].join('\n');
const parsePost = (env, text) => JSON.parse(run(env, `JSON.stringify(parseTelegramPost(${JSON.stringify(text)}))`));
const menuTap = (env, verb) => {
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitmenu_')).slice(9);
  run(env, `handleCallback(${JSON.stringify(cb('menu_' + id + '_' + verb, 800))})`);
  return id;
};

test('reads your Residence L post: price, building, area, floor, unit, size, features; ignores the contact block', () => {
  const env = makeEnv();
  const o = parsePost(env, residenceL(env));
  assert.strictEqual(o.buildingName, 'Residence L');
  assert.strictEqual(o.price, 35000); assert.strictEqual(o.listingType, 'resale');
  assert.strictEqual(o.bedrooms, 1); assert.strictEqual(o.bathrooms, 1);
  assert.strictEqual(o.locationText, 'Boeung Tumpun'); assert.strictEqual(o.city, 'Phnom Penh');
  assert.strictEqual(o.floor, '9'); assert.strictEqual(o.unitNumber, 'G10-09');
  assert.strictEqual(o.grossSqm, 47); assert.strictEqual(o.netSqm, 38); assert.strictEqual(o.sqm, 47);
  ['Strata Title', 'Fully Furnished', 'Swimming Pool & Gym', 'Coffee Shop', 'Convenience Store', 'Laundry Room', 'Net area 38 sqm'].forEach((f) => assert.ok(o.extraFeatures.includes(f), 'missing feature ' + f + ' in ' + o.extraFeatures.join(' | ')));
  assert.ok(!o.extraFeatures.some((f) => /Unit G10|Floor|Bedroom|㎡/.test(f)), 'structured facts must not become features: ' + o.extraFeatures.join(' | '));
});

test('reads the price-drop post and ignores phone and t.me lines', () => {
  const env = makeEnv();
  const o = parsePost(env, timeSquare6(env));
  assert.strictEqual(o.buildingName, 'Time Square 6');
  assert.strictEqual(o.price, 94000); assert.deepStrictEqual(o.priceChange, { from: 98000, to: 94000 });
  assert.strictEqual(o.locationText, 'BKK1'); assert.strictEqual(o.floor, '26'); assert.strictEqual(o.sqm, 57); assert.strictEqual(o.bedrooms, 1);
  assert.deepStrictEqual(o.extraFeatures.sort(), ['Fully Furnished', 'Handover: Early 2027', 'North Facing']);
  assert.ok(!JSON.stringify(o).match(/096|t\.me|Nick_REAKH/));
});

test('square feet in a full post are flagged, never converted', () => {
  const env = makeEnv();
  const t = '#ForSale $50,000\n' + bold(env, 'SKY | 1BR UNIT') + '\n✅ 900 sqft\n✅ 1 Bedroom';
  assert.strictEqual(parsePost(env, t).usedSqft, true);
  assert.strictEqual(parsePost(env, t).sqm, null);
});

test('property type: from the title or a short caption, never from facility bullets', () => {
  const env = makeEnv();
  assert.strictEqual(run(env, `guessUnitType('LAND IN BKK3 | 500 SQM')`), 'Land');
  assert.strictEqual(run(env, `guessUnitType('SKY VILLA | 3BR VILLA')`), 'Villa / House');
  assert.strictEqual(run(env, `guessUnitType('BOREY | SHOPHOUSE')`), 'Commercial');
  assert.strictEqual(run(env, `guessUnitType('2 bedroom condo')`), 'Condo');
  assert.strictEqual(run(env, `guessUnitType('Landmark view')`), null);
  const f = JSON.parse(run(env, `JSON.stringify(parseUnitFacts(${JSON.stringify(residenceL(env) + '\n✅ Retail shop and office on level 2')}))`));
  assert.strictEqual(f.propertyType, null);
});

test('titles are tidied: RESIDENCE L becomes Residence L; mixed case is kept', () => {
  const env = makeEnv();
  assert.strictEqual(run(env, `titleCaseBuilding('RESIDENCE L')`), 'Residence L');
  assert.strictEqual(run(env, `titleCaseBuilding('UC88 WYNDHAM GARDEN')`), 'UC88 Wyndham Garden');
  assert.strictEqual(run(env, `titleCaseBuilding('Time Square 7')`), 'Time Square 7');
});

test('building names are matched to projects on the site, loosely but not carelessly', () => {
  const env = makeEnv();
  const m = (name) => JSON.parse(run(env, `JSON.stringify(matchUnitProject(${JSON.stringify(name)}, [{id:16,title:'GATO Tower'},{id:8,title:'Odom Living'},{id:7,title:'Odom Tower'}]))`));
  assert.strictEqual(m('GATO TOWER').id, 16);
  assert.strictEqual(m('gato tower').id, 16);
  assert.strictEqual(m('Residence L'), null);
  assert.strictEqual(m('Odom'), null);       // too short and ambiguous
  assert.strictEqual(m(''), null);
});

test('plain chat gets no menu and no reply', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, 'hi there', [], false, null, null, [])`);
  assert.strictEqual(env.sent().length, 0);
});

test('a post with photos gets ONE question with four buttons', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env); env.ctx.__imgs = ['F1', 'F2', 'F3'];
  run(env, `handleIncomingMessage(${CHAT}, __post, __imgs, false, null, null, __imgs)`);
  const q = env.sent()[0];
  assert.ok(/What should I do with this post\?/.test(q.text) && /Residence L, 1 bedroom, \$35,000/.test(q.text) && /3 photos/.test(q.text), q.text);
  const labels = JSON.parse(q.reply_markup).inline_keyboard.flat().map((b) => b.text);
  assert.deepStrictEqual(labels, ['Website draft', 'Post to channels', 'Both', 'Ignore']);
  assert.strictEqual(env.telegramRejected || 0, 0);
});

test('a forwarded listing with no photos also gets the question', () => {
  const env = makeEnv();
  env.ctx.__post = timeSquare6(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, [], true, 'NickREAKH', null, [])`);
  assert.ok(/What should I do with this post\?/.test(env.sent()[0].text));
});

test('#unit and #web skip the question', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '#web 2 bedroom, floor 5, 60 sqm, $99,000', ['F1'], false, null, null, ['F1'])`);
  assert.ok(!/What should I do/.test(env.sent()[0].text));
  assert.ok(/Is this building already on the website/.test(env.sent()[0].text));
});

test('Ignore does nothing at all', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'ign');
  assert.ok(/Ignored/.test(env.edits().pop().text));
  assert.strictEqual(env.intakeLog.length, 0);
  assert.strictEqual(Object.keys(env.cache).filter((k) => k.startsWith('unitdraft_')).length, 0);
});

test('Post to channels hands the ORIGINAL post to the existing flow, unchanged', () => {
  const env = makeEnv();
  run(env, `__chan = []; processChannelListing = function () { __chan.push(Array.from(arguments)); }`);
  env.ctx.__post = timeSquare6(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['P1'], true, 'NickREAKH', null, ['P1'])`);
  menuTap(env, 'chan');
  const calls = JSON.parse(run(env, `JSON.stringify(__chan)`));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][1], timeSquare6(env));
  assert.deepStrictEqual(calls[0][2], ['P1']); assert.strictEqual(calls[0][3], true); assert.strictEqual(calls[0][4], 'NickREAKH');
  assert.strictEqual(env.intakeLog.length, 0);
});

test('a second tap on the same question does nothing', () => {
  const env = makeEnv();
  run(env, `__chan = []; processChannelListing = function () { __chan.push(1); }`);
  env.ctx.__post = timeSquare6(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, [], true, 'NickREAKH', null, [])`);
  const id = menuTap(env, 'chan');
  run(env, `handleCallback(${JSON.stringify(cb('menu_' + id + '_chan', 800))})`);
  run(env, `handleCallback(${JSON.stringify(cb('menu_' + id + '_site', 800))})`);
  assert.strictEqual(JSON.parse(run(env, `JSON.stringify(__chan)`)).length, 1);
  assert.strictEqual(env.intakeLog.length, 0);
});

test('Website draft from your full post asks NO questions: straight to the summary, new building from the post', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1', 'F2', 'F3'], false, null, null, ['F1', 'F2', 'F3'])`);
  menuTap(env, 'site');
  const card = env.sent().pop().text;
  assert.ok(/Building: Residence L \(new building, Boeung Tumpun\)/.test(card), card);
  assert.ok(/Page title: Residence L · 1 Bedroom · Floor 9/.test(card), card);
  assert.ok(/Type: Condo \(assumed/.test(card) && /Price: \$35,000/.test(card) && /Area: 47 sqm/.test(card), card);
  assert.ok(/Unit no\. \(private, never shown\): G10-09/.test(card), card);
  assert.ok(/From your post: .*Strata Title/.test(card), card);
  assert.ok(/Claim to verify before going live: .*Strata Title/.test(card), card);
  assert.ok(/Photos: 3/.test(card), card);
  assert.ok(!/Which area|What type|Is this building/.test(card));
});

test('a full post for a building already on the site links to it, with no building question', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env).replace(bold(env, 'RESIDENCE L | 1BR UNIT'), bold(env, 'GATO TOWER | 1BR UNIT'));
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  const card = env.sent().pop().text;
  assert.ok(/Building: GATO Tower \(on the website\)/.test(card), card);
  assert.strictEqual(env.intakeLog.find((p) => p.action === 'prepare').parentPropertyId, 16);
});

test('creating from a full post sends every fact it read to the website', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1', 'F2'], false, null, null, ['F1', 'F2'])`);
  menuTap(env, 'site');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const c = env.intakeLog.find((p) => p.action === 'create');
  assert.strictEqual(c.title, 'Residence L · 1 Bedroom · Floor 9');
  assert.strictEqual(c.price, 35000); assert.strictEqual(c.listingType, 'resale'); assert.strictEqual(c.parentPropertyId, null);
  assert.strictEqual(c.unitNumber, 'G10-09'); assert.strictEqual(c.unitFloor, '9');
  assert.strictEqual(c.bedrooms, 1); assert.strictEqual(c.bathrooms, 1);
  assert.strictEqual(c.sqm, 47); assert.strictEqual(c.floorArea, '47 sqm');
  assert.strictEqual(c.propertyType, 'Condo'); assert.strictEqual(c.location, 'Boeung Tumpun'); assert.strictEqual(c.city, 'Phnom Penh');
  assert.ok(c.features.includes('Strata Title') && c.features.includes('Net area 38 sqm') && c.features.includes('Swimming Pool & Gym'));
  assert.strictEqual(c.images.length, 2);
  assert.ok(/Ref: GT-1005/.test(env.sent().pop().text));
});

test('a short caption through the menu still asks for the building, then only what is missing', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '2 bedroom for sale, floor 14, 85 sqm, $185,000 condo', ['F1'], false, null, null, ['F1'])`);
  // no "#unit": with photos it is a question first
  assert.ok(/What should I do with this post\?/.test(env.sent().pop().text));
  menuTap(env, 'site');
  assert.ok(/Is this building already on the website/.test(env.sent().pop().text));
});

test('nothing blocks a draft: missing bathrooms, floor and photos are listed for review', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '#unit 2 bedroom, 85 sqm, $185,000', [], false, null, null, [])`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  assert.ok(/What type of property is it\?/.test(env.edits().pop().text)); // no floor or unit clue: asked, not assumed
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_t_0'))})`); // Condo
  const card = env.edits().pop().text;
  assert.ok(/Not given: bathrooms, floor, photos/.test(card), card);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);   // and it can still be created
  assert.ok(/Hidden draft created/.test(env.sent().pop().text));
});

test('a plot of land: type from the caption, no bedrooms asked, title and payload without them', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '#unit land 500 sqm $250,000', ['F1'], false, null, null, ['F1'])`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_new'))})`);
  run(env, `handleIncomingMessage(${CHAT}, 'Land in BKK3', [], false, null, null, [])`);
  assert.ok(/Which area/.test(env.sent().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_a_1'))})`);
  const card = env.edits().pop().text;
  assert.ok(/Type: Land\n/.test(card) && /Page title: Land in BKK3\n/.test(card), card);
  assert.ok(!/Not given: .*bedrooms/.test(card), card);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const c = env.intakeLog.find((p) => p.action === 'create');
  assert.strictEqual(c.propertyType, 'Land'); assert.strictEqual(c.bedrooms, null); assert.strictEqual(c.bathrooms, null);
  assert.strictEqual(c.floorArea, '500 sqm'); assert.strictEqual(c.location, 'BKK3');
});

test('when the type cannot be guessed it is asked with buttons, and Change type works later', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '#unit 2 bedroom 120 sqm $90,000', ['F1'], false, null, null, ['F1'])`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  assert.ok(/What type of property is it\?/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_t_2'))})`); // Villa / House
  assert.ok(/Type: Villa \/ House\n/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_chg'))})`);
  assert.ok(/What type of property is it\?/.test(env.edits().pop().text));
});

test('"Other" area asks for a typed answer', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '#unit 2 bedroom, floor 3, 60 sqm, $80,000', ['F1'], false, null, null, ['F1'])`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_new'))})`);
  run(env, `handleIncomingMessage(${CHAT}, 'Sky Villa', [], false, null, null, [])`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_a_5'))})`); // Other
  assert.ok(/Reply with just the area name/.test(env.edits().pop().text));
  run(env, `handleIncomingMessage(${CHAT}, 'Boeung Keng Kang 3', [], false, null, null, [])`);
  assert.ok(/new building, Boeung Keng Kang 3/.test(env.sent().pop().text));
});

test('photos first, post text second: the text picks up the photos and asks the question', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '', ['P1', 'P2', 'P3'], false, null, null, ['P1', 'P2', 'P3'])`);
  assert.ok(/Got 3 photos. Now send the post text/.test(env.sent().pop().text));
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, [], false, null, null, [])`);
  const q = env.sent().pop().text;
  assert.ok(/What should I do with this post\?/.test(q) && /3 photos/.test(q), q);
  menuTap(env, 'site');
  assert.ok(/Photos: 3/.test(env.sent().pop().text));
});

test('a late photo of an album joins the question, and then the draft', () => {
  const env = makeEnv(); fastClock(env);
  env.ctx.__post = residenceL(env);
  const a1 = { update_id: 901, message: { message_id: 901, chat: { id: CHAT }, media_group_id: 'GM', caption: env.ctx.__post, photo: [{ file_id: 'A1s' }, { file_id: 'A1' }] } };
  const a2 = { update_id: 902, message: { message_id: 902, chat: { id: CHAT }, media_group_id: 'GM', photo: [{ file_id: 'A2s' }, { file_id: 'A2' }] } };
  env.updates = [[a1], [a2]];
  run(env, `checkForUpdates()`);
  assert.ok(env.sent().some((p) => /What should I do with this post\?/.test(p.text)));
  assert.ok(!env.sent().some((p) => /Now send the post text|couldn't recognize/.test(p.text)));
  menuTap(env, 'site');
  assert.ok(/Photos: 2/.test(env.sent().pop().text));
});

test('Both: the draft first, then a button; the channel posts wait until the page is live', () => {
  const env = makeEnv();
  run(env, `__chan = []; processChannelListing = function () { __chan.push(Array.from(arguments)); }`);
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'both');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const done = env.sent().pop();
  assert.ok(/Hidden draft created/.test(done.text) && /Ref: GT-1005/.test(done.text));
  assert.ok(JSON.parse(done.reply_markup).inline_keyboard[0][0].text === 'The page is live, prepare channel posts');
  // tapped too early
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_chan'))})`);
  assert.strictEqual(JSON.parse(run(env, `JSON.stringify(__chan)`)).length, 0);
  assert.ok(/not live yet/.test(env.sent().pop().text));
  // page published, tapped again
  env.pageLive = true;
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_chan'))})`);
  const calls = JSON.parse(run(env, `JSON.stringify(__chan)`));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][1], residenceL(env));             // your own post, unchanged
  assert.strictEqual(calls[0][6], 'https://www.propertyhubcambodia.com/property/x-slug-1005');
  assert.strictEqual(calls[0][7], 'GT-1005');
  // and a second tap does not post twice
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_chan'))})`);
  assert.strictEqual(JSON.parse(run(env, `JSON.stringify(__chan)`)).length, 1);
});

test('Both with a short caption: the channel post is built from the facts', () => {
  const env = makeEnv();
  run(env, `__chan = []; processChannelListing = function () { __chan.push(Array.from(arguments)); }`);
  env.pageLive = true;
  run(env, `handleIncomingMessage(${CHAT}, '2 bedroom for sale, floor 14, 85 sqm, $185,000', ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'both');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_16'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_chan'))})`);
  const t = JSON.parse(run(env, `JSON.stringify(__chan)`))[0][1];
  assert.ok(/^#ForSale \$185,000/.test(t) && /GATO TOWER \| 2BR UNIT/.test(t) && /✅ 85 sqm/.test(t) && /UNIT DETAILS/.test(t), t);
  // the existing parser must be able to read what was built
  const fields = JSON.parse(run(env, `JSON.stringify(parseListingText(${JSON.stringify(t)}))`));
  assert.strictEqual(fields.forSale, '$185,000'); assert.ok(/GATO TOWER/.test(fields.title));
});

test('the live link is placed just above the contact block, with no code line', () => {
  const env = makeEnv();
  const content = run(env, `'#ForSale $1\\n\\nTITLE\\n\\n――――――――――\\nUNIT DETAILS\\n✅ x\\n\\n――――――――――\\n' + CONTACT_STANDARD`);
  const out = run(env, `addPageLink(${JSON.stringify(content)}, 'https://www.propertyhubcambodia.com/property/x', 'GT-1019')`);
  assert.ok(out.indexOf('🔗 https://www.propertyhubcambodia.com/property/x') > -1 && out.indexOf('🔗') < out.lastIndexOf('📞') && !/🏷|Ref GT/.test(out));
  assert.ok(out.endsWith(run(env, `CONTACT_STANDARD`)));
  assert.strictEqual(run(env, `addPageLink('abc', '', null)`), 'abc');
});

test('menu buttons from anyone but Nick are refused', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitmenu_')).slice(9);
  run(env, `handleCallback(${JSON.stringify({ id: 'x', data: 'menu_' + id + '_site', message: { chat: { id: 12345 }, message_id: 1 } })})`);
  assert.strictEqual(env.intakeLog.length, 0);
});


// ====================== the real, existing listing flow still works behind the menu ======================
test('REGRESSION: a post forwarded from your channel, "Post to channels", runs the real old flow end to end', () => {
  const env = makeEnv();
  env.ctx.__post = timeSquare6(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['P1'], true, 'NickREAKH', null, ['P1'])`);
  menuTap(env, 'chan');
  const rows = env.sheetData.slice(1);
  assert.deepStrictEqual(rows.map((r) => r[2]), ['EN', 'JP', 'RU', 'DE']);
  rows.forEach((r) => {
    assert.ok(/📞 011 666 952/.test(r[3]), 'PHC contact block expected in ' + r[2]);
    assert.ok(!/096 96 61 555|Nick_REAKH/.test(r[3]), 'your personal contact block must be replaced in ' + r[2]);
    assert.strictEqual(r[8], JSON.stringify(['P1']));
    assert.strictEqual(r[4], 'Pending Review');
  });
  const review = env.sent().concat(env.calls.filter((c) => c.url.includes('/sendPhoto')).map((c) => c.opts.payload));
  assert.ok(review.some((p) => /New listing ready/.test(p.caption || p.text || '') && /Approve All/.test(p.reply_markup || '')), 'the Approve All review message must be sent');
  assert.strictEqual(env.telegramRejected || 0, 0);
});

test('REGRESSION: a pasted #ForSale listing through the menu reaches the old flow and the review message', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, [], false, null, null, [])`);  // no photos: still a listing, so still the question
  menuTap(env, 'chan');
  const rows = env.sheetData.slice(1);
  assert.strictEqual(rows.length, 4);
  assert.ok(/#ForSale \$35,000/.test(rows[0][3]), rows[0][3]);
  assert.ok(env.sent().some((p) => /New listing ready/.test(p.text)));
});

test('REGRESSION: Both puts the live link and the reference into every language version', () => {
  const env = makeEnv();
  env.pageLive = true;
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'both');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_chan'))})`);
  const rows = env.sheetData.slice(1);
  assert.strictEqual(rows.length, 4);
  rows.forEach((r) => {
    assert.ok(/🔗 https:\/\/www\.propertyhubcambodia\.com\/property\/x-slug-1005\n/.test(r[3]) && !/🏷|Ref GT/.test(r[3]), r[2] + ': ' + r[3]);
    assert.ok(r[3].indexOf('🔗') < r[3].lastIndexOf('📞'), 'link must sit above the contact block');
  });
});


// ====================== speed and other layouts ======================
test('SPEED: a tap 100 seconds after the first message is still answered in the same run', () => {
  const env = makeEnv(); fastClock(env);
  env.ctx.__post = residenceL(env);
  const first = { update_id: 901, message: { message_id: 901, chat: { id: CHAT }, caption: env.ctx.__post, photo: [{ file_id: 'A1s' }, { file_id: 'A1' }] } };
  let id = null;
  env.updates = [[first], [], [], [], [], [], [], () => {
    id = Object.keys(env.cache).find((k) => k.startsWith('unitmenu_')).slice(9);
    return [{ update_id: 902, callback_query: { id: 'c902', data: 'menu_' + id + '_site', message: { chat: { id: CHAT }, message_id: 800 } } }];
  }];
  run(env, `checkForUpdates()`);
  assert.ok(env.sent().some((p) => /Unit summary/.test(p.text)), 'the tap after 100 seconds should already have produced the summary');
});

test('SPEED: the listening run never exceeds the 4 minute cap, even if the session stays open', () => {
  const env = makeEnv(); fastClock(env);
  run(env, `unitSessionTouch()`);
  run(env, `checkForUpdates()`);
  assert.ok(env.getUpdatesUrls.length <= Math.ceil(240000 / 15000) + 2);
  assert.strictEqual(env.userLockReleased, 1);
});

// A post in another agent's layout: "Label: value" lines, a payment plan, the project named in the text
const layoutB = [
  'Time Square 10 | Studio Resale', '',
  'Floor: 6', 'Gross Size: 40 Sqm', 'Facing: East, Otres Beach', '',
  'Price $49,999', '',
  '• Payment Plans:', '', '- Deposit $5,000', '', '1. Complete down Payment to Owner', '',
  '2. Continue Installment with developer $368/ month', '(From November 2026- April 2029)', '', '3. Handover Payment = $16,553',
].join('\n');
const layoutC = layoutB.replace('Time Square 10 | Studio Resale', 'Studio resale at Time Square 10, Otres Beach');

test('LAYOUT: Label: value lines are read (floor, gross size, facing, price) and the payment plan is kept off the page', () => {
  const env = makeEnv();
  const o = parsePost(env, layoutB);
  assert.strictEqual(o.floor, '6'); assert.strictEqual(o.grossSqm, 40); assert.strictEqual(o.sqm, 40);
  assert.strictEqual(o.price, 49999); assert.strictEqual(o.bedrooms, 0); assert.strictEqual(o.buildingName, 'Time Square 10');
  assert.deepStrictEqual(o.extraFeatures, ['Facing: East, Otres Beach']);
  assert.strictEqual(o.paymentFound, true);
  assert.ok(!JSON.stringify(o).match(/Deposit|Installment|Handover Payment|368|16,553|5,000/), 'payment terms must not be copied: ' + JSON.stringify(o.extraFeatures));
});

test('LAYOUT: other label spellings', () => {
  const env = makeEnv();
  const t = ['Project: sky villa', 'Unit No: B-12', 'Bedrooms: 2', 'Bathrooms: 2', 'Net Size: 55 sqm', 'Gross Area: 70 sqm', 'Furnishing: Fully furnished', 'Location: BKK1, Phnom Penh', 'Asking Price: 120,000 USD', 'Phone: 089 111 222'].join('\n');
  const o = parsePost(env, t);
  assert.strictEqual(o.buildingName, 'Sky Villa'); assert.strictEqual(o.unitNumber, 'B-12');
  assert.strictEqual(o.bedrooms, 2); assert.strictEqual(o.bathrooms, 2);
  assert.strictEqual(o.grossSqm, 70); assert.strictEqual(o.netSqm, 55); assert.strictEqual(o.sqm, 70);
  assert.strictEqual(o.locationText, 'BKK1'); assert.strictEqual(o.city, 'Phnom Penh'); assert.strictEqual(o.price, 120000);
  assert.ok(o.extraFeatures.includes('Furnishing: Fully furnished') && o.extraFeatures.includes('Net area 55 sqm'));
  assert.ok(!JSON.stringify(o).includes('089'));
});

test('LAYOUT: a project named anywhere in the text is found; ambiguous or absent gives null', () => {
  const env = makeEnv();
  const find = (text) => JSON.parse(run(env, `JSON.stringify(findProjectInText(${JSON.stringify(text)}, [{id:4,title:'Time Square 10'},{id:3,title:'Time Square 9'},{id:16,title:'GATO Tower'}]))`));
  assert.strictEqual(find('Studio resale at Time Square 10, Otres Beach').id, 4);
  assert.strictEqual(find('time-square-10 resale').id, 4);
  assert.strictEqual(find('Gato Tower unit').id, 16);
  assert.strictEqual(find('Time Square 100 something'), null);   // not Time Square 10
  assert.strictEqual(find('Time Square 9 or GATO Tower, your pick'), null); // two projects: do not guess
  assert.strictEqual(find('a nice flat'), null);
});

test('LAYOUT: end to end, no question about the building, payment note shown', () => {
  const env = makeEnv();
  run(env, `__projects = null`);
  env.ctx.__post = layoutC;
  // the fake site knows two projects; add Time Square 10 for this test
  env.cache['unitprojects'] = JSON.stringify([{ id: 4, title: 'Time Square 10' }, { id: 16, title: 'GATO Tower' }]);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  const card = env.sent().pop().text;
  assert.ok(/Building: Time Square 10 \(on the website, found in your post\)/.test(card), card);
  assert.ok(/Price: \$49,999/.test(card) && /Area: 40 sqm/.test(card) && /Floor: 6/.test(card), card);
  assert.ok(/Payment plan found in your post: not added to the page/.test(card), card);
  assert.ok(!/Which project|Is this building/.test(card));
  assert.strictEqual(env.intakeLog.find((p) => p.action === 'prepare').parentPropertyId, 4);
});


// ====================== bedrooms asked when the post does not say ======================
const nickPost = [
  'Floor: 6', 'Gross Size: 40 Sqm', 'Facing: East, Otres Beach', '', 'Price $49,999', '', '• Payment Plans:', '', '- Deposit $5,000', '',
  '1. Complete down Payment to Owner', '', '2. Continue Installment with developer $368/ month (From November 2026- April 2029)', '', '3. Handover Payment = $16,553',
].join('\n');

test("YOUR REAL POST: no project and no bedrooms in the text, so the bot asks both, then shows the summary", () => {
  const env = makeEnv();
  env.cache['unitprojects'] = JSON.stringify([{ id: 4, title: 'Time Square 10' }, { id: 16, title: 'GATO Tower' }]);
  env.ctx.__post = nickPost;
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1', 'F2', 'F3'], false, null, null, ['F1', 'F2', 'F3'])`);
  menuTap(env, 'site');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  assert.ok(/Is this building already on the website/.test(env.sent().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_4'))})`);
  assert.ok(/How many bedrooms\?/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_b_0'))})`);   // Studio
  const card = env.edits().pop().text;
  assert.ok(/Building: Time Square 10 \(on the website\)/.test(card), card);
  assert.ok(/Page title: Time Square 10 · Studio · Floor 6/.test(card), card);
  assert.ok(/Type: Condo \(assumed/.test(card), card);
  assert.ok(/Price: \$49,999/.test(card) && /Bedrooms: Studio/.test(card) && /Area: 40 sqm/.test(card) && /Floor: 6/.test(card), card);
  assert.ok(/From your post: Facing: East, Otres Beach/.test(card), card);
  assert.ok(/Payment plan found in your post: not added to the page/.test(card), card);
  assert.ok(!/Deposit|Installment|368|16,553/.test(card), card);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const c = env.intakeLog.find((p) => p.action === 'create');
  assert.strictEqual(c.title, 'Time Square 10 · Studio · Floor 6');
  assert.strictEqual(c.bedrooms, 0); assert.strictEqual(c.price, 49999); assert.strictEqual(c.sqm, 40); assert.strictEqual(c.unitFloor, '6');
  assert.deepStrictEqual(c.features, ['Facing: East, Otres Beach']); // only this unit's own; the building's list is shown live by the page
});

test('bedrooms: any answer is stored and the title follows it', () => {
  const env = makeEnv();
  env.ctx.__post = nickPost;
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_b_2'))})`);   // 2 bedrooms
  assert.ok(/Page title: Odom Living · 2 Bedroom · Floor 6/.test(env.edits().pop().text));
});

test('bedrooms: "Skip, not sure" goes on without asking again, and the title has no bedroom part', () => {
  const env = makeEnv();
  env.ctx.__post = nickPost;
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_b_s'))})`);
  const next = env.edits().pop().text;
  assert.ok(!/How many bedrooms/.test(next), next);
  assert.ok(/What type of property is it\?/.test(next), next);  // no bedrooms means the type is not assumed
});

test('bedrooms are not asked when the post gives them, for land, or for commercial', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '#unit 2 bedroom floor 3 60 sqm $80,000', ['F1'], false, null, null, ['F1'])`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  assert.ok(!/How many bedrooms/.test(env.edits().pop().text));
  const env2 = makeEnv();
  run(env2, `handleIncomingMessage(${CHAT}, '#unit land 500 sqm $250,000', ['F1'], false, null, null, ['F1'])`);
  const id2 = Object.keys(env2.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env2, `handleCallback(${JSON.stringify(cb('unit_' + id2 + '_p_8'))})`);
  assert.ok(!/How many bedrooms/.test(env2.edits().pop().text));
  const env3 = makeEnv();
  run(env3, `handleIncomingMessage(${CHAT}, '#unit shophouse 120 sqm $400,000', ['F1'], false, null, null, ['F1'])`);
  const id3 = Object.keys(env3.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env3, `handleCallback(${JSON.stringify(cb('unit_' + id3 + '_p_8'))})`);
  assert.ok(!/How many bedrooms/.test(env3.edits().pop().text));
});


// ====================== listing type: a monthly instalment must never make a sale a rental ======================
const factsOf = (env, text) => JSON.parse(run(env, `JSON.stringify(parseUnitFacts(${JSON.stringify(text)}))`));

test('RENT BUG (found by the real draft TS10-1020): your exact post is a SALE, not a rental', () => {
  const env = makeEnv();
  const f = factsOf(env, nickPost);
  assert.strictEqual(f.listingType, 'resale');
  assert.strictEqual(f.price, 49999);
});

test('RENT BUG: end to end, the draft is created as resale at $49,999 (no /month)', () => {
  const env = makeEnv();
  env.cache['unitprojects'] = JSON.stringify([{ id: 4, title: 'Time Square 10' }]);
  env.ctx.__post = nickPost;
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_4'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_b_1'))})`);
  assert.ok(/Listing: Resale {3}Price: \$49,999\n/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(env.intakeLog.find((p) => p.action === 'create').listingType, 'resale');
});

test('rent is still detected when the post really is a rental', () => {
  const env = makeEnv();
  assert.strictEqual(factsOf(env, '#unit for rent studio $650/month').listingType, 'rent');
  assert.strictEqual(factsOf(env, '#unit 1 bedroom $650 per month floor 4 38 sqm').listingType, 'rent');
  assert.strictEqual(factsOf(env, '#unit 1 bedroom #rent $650 floor 4 38 sqm').listingType, 'rent');
  assert.strictEqual(factsOf(env, ['#ForRent $650/month', bold(env, 'SKY VILLA | 1BR UNIT'), '✅ 38 sqm'].join('\n')).listingType, 'rent');
  assert.strictEqual(factsOf(env, ['Rental Price: $650', 'Floor: 4', 'Bedrooms: 1'].join('\n')).listingType, 'rent');
});

test('rent is NOT guessed from words like rental yield, a monthly instalment, or a rental history', () => {
  const env = makeEnv();
  assert.strictEqual(factsOf(env, '#unit 2 bedroom floor 5 60 sqm $120,000 great rental yield').listingType, 'resale');
  assert.strictEqual(factsOf(env, ['Price $120,000', 'Floor: 5', 'Instalment $400/month with the developer'].join('\n')).listingType, 'resale');
  assert.strictEqual(factsOf(env, ['Price $120,000', 'Floor: 5', 'Currently rented at $600 a month'].join('\n')).listingType, 'resale');
});

test('a payment plan BEFORE the price does not swallow the price or the other fields', () => {
  const env = makeEnv();
  const t = ['• Payment Plans:', '- Deposit $5,000', '- Monthly $368/ month', '', 'Price $49,999', 'Floor: 6', 'Gross Size: 40 Sqm'].join('\n');
  const o = parsePost(env, t);
  assert.strictEqual(o.price, 49999); assert.strictEqual(o.floor, '6'); assert.strictEqual(o.sqm, 40); assert.strictEqual(o.listingType, null);
  assert.ok(!JSON.stringify(o.extraFeatures).match(/Deposit|Monthly/));
  assert.strictEqual(factsOf(env, t).listingType, 'resale');
});


// ====================== a unit in a building on the site also gets the building's facilities ======================
test('FACILITIES: a linked unit stores only its own features; the page adds the building list live', () => {
  const env = makeEnv();
  env.cache['unitprojects'] = JSON.stringify([{ id: 4, title: 'Time Square 10' }]);
  env.ctx.__post = nickPost;
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_4'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_b_1'))})`);
  assert.ok(/Facilities: none ticked\. The building's own facilities show automatically/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const c = env.intakeLog.find((p) => p.action === 'create');
  assert.deepStrictEqual(c.features, ['Facing: East, Otres Beach']);
  assert.ok(!env.calls.some((x) => x.url.includes('select=features')), 'the bot must not read or copy the building list any more');
});

test('FACILITIES: what you tick is added to the post\'s own features', () => {
  const env = makeEnv();
  env.cache['unitprojects'] = JSON.stringify([{ id: 4, title: 'Time Square 10' }]);
  env.ctx.__post = nickPost;
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_4'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_b_1'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_f_2'))})`); // Swimming Pool
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.deepStrictEqual(env.intakeLog.find((p) => p.action === 'create').features, ['Facing: East, Otres Beach', 'Swimming Pool']);
});

test('FACILITIES: a new building (no parent) gets no borrowed list', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const c = env.intakeLog.find((p) => p.action === 'create');
  assert.ok(!c.features.includes('Fitness Centre') && c.features.includes('Strata Title'));
});


// ---------- price update
const unitRow = (o = {}) => Object.assign({ ok: true, id: 21, title: 'Time Square 10 · 1 Bedroom · Floor 6', price: 62000, status: 'active', listingType: 'resale', bedrooms: 1, bathrooms: 1, sqm: 40, floor: '6', location: 'Otres Beach', city: 'Sihanoukville', refCode: 'TS10-1021', url: 'https://www.propertyhubcambodia.com/property/time-square-10-1-bedroom-floor-6-1021' }, o);
const priceEnv = (row) => {
  const env = makeEnv();
  run(env, `__chan = []; processChannelListing = function () { __chan.push(Array.from(arguments)); }`);
  env.intakeBehavior = (p) => (p.action === 'lookup' ? { code: 200, body: row || unitRow() } : null);
  return env;
};
const say = (env, t) => run(env, `handleIncomingMessage(${CHAT}, ${JSON.stringify(t)}, [], false, null, null, [])`);

test('PRICE: parsing finds the unit number and the new price, ignoring the old price', () => {
  const env = makeEnv();
  const P = (t) => JSON.parse(run(env, `JSON.stringify(parsePriceUpdate(${JSON.stringify(t)}))`));
  assert.deepStrictEqual(P('TS10-1021 price reduced to $58,500, was $62,000'), { id: 21, ref: 'TS10-1021', newPrice: 58500 });
  assert.strictEqual(P('GT-1019 new price $1.2m').newPrice, 1200000);
  assert.strictEqual(P('ts10-1021 reduced from $62,000 to $58.5k').newPrice, 58500);
  assert.strictEqual(P('#price TS10-1021 58500').newPrice, 58500);
  assert.strictEqual(P('/price 1021 $58,500').id, 21);
  assert.strictEqual(P('TS10-1021 price drop').newPrice, null);
});
test('PRICE: ordinary posts and chat are not mistaken for a price change', () => {
  const env = makeEnv();
  const P = (t) => run(env, `parsePriceUpdate(${JSON.stringify(t)})`);
  assert.strictEqual(P('#ForSale $185,000 GATO TOWER 2BR Ref GT-1019'), null); // a reference code alone is not enough
  assert.strictEqual(P('price reduced to $58,500'), null);                      // no unit number
  assert.strictEqual(P('hello team, see you at 9'), null);
});
test('PRICE: shows old to new and the percentage, changes nothing until the tap', () => {
  const env = priceEnv();
  say(env, 'TS10-1021 price reduced to $58,500, was $62,000');
  const m = env.sent().pop();
  assert.ok(/Found TS10-1021/.test(m.text) && /\$62,000 to \$58,500 \(down 5\.6%\)/.test(m.text) && /Live on the website/.test(m.text), m.text);
  assert.deepStrictEqual(JSON.parse(m.reply_markup).inline_keyboard.map((r) => r.map((b) => b.text)), [['Update website price', 'Update and post'], ['Cancel']]);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'price').length, 0);
});
test('PRICE: Update website price changes it once, with the price the bot saw', () => {
  const env = priceEnv();
  say(env, 'TS10-1021 price reduced to $58,500');
  run(env, `handleCallback(${JSON.stringify(cb('price_21_go'))})`);
  const sent = env.intakeLog.filter((p) => p.action === 'price');
  assert.deepStrictEqual(sent, [{ action: 'price', id: 21, expectedOldPrice: 62000, newPrice: 58500 }]);
  assert.ok(/Done\. TS10-1021 is now \$58,500 on the website \(was \$62,000\)/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('price_21_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'price').length, 1); // a second tap does nothing
  assert.strictEqual(JSON.parse(run(env, `JSON.stringify(__chan)`)).length, 0);
});
test('PRICE: a change over 15 percent must be confirmed a second time', () => {
  const env = priceEnv();
  say(env, 'TS10-1021 new price $45,000');
  assert.ok(/more than 15%/.test(env.sent().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('price_21_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'price').length, 0);
  assert.ok(/Please confirm: TS10-1021 from \$62,000 to \$45,000/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('price_21_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'price').length, 1);
});
test('PRICE: Update and post prepares the channel posts with the live link', () => {
  const env = priceEnv();
  say(env, 'TS10-1021 price reduced to $58,500');
  run(env, `handleCallback(${JSON.stringify(cb('price_21_post'))})`);
  const calls = JSON.parse(run(env, `JSON.stringify(__chan)`));
  assert.strictEqual(calls.length, 1);
  assert.ok(/^#ForSale \$58,500/.test(calls[0][1]) && /Price reduced from \$62,000/.test(calls[0][1]) && /TIME SQUARE 10 \| 1BR UNIT/.test(calls[0][1]), calls[0][1]);
  assert.strictEqual(calls[0][6], unitRow().url); assert.strictEqual(calls[0][7], 'TS10-1021');
  const fields = JSON.parse(run(env, `JSON.stringify(parseListingText(${JSON.stringify(calls[0][1])}))`));
  assert.strictEqual(fields.forSale, '$58,500');
});
test('PRICE: a hidden draft only gets its price saved, no post and no post button', () => {
  const env = priceEnv(unitRow({ status: 'draft' }));
  say(env, 'TS10-1021 price reduced to $58,500');
  const m = env.sent().pop();
  assert.ok(/not live yet/.test(m.text));
  assert.deepStrictEqual(JSON.parse(m.reply_markup).inline_keyboard[0].map((b) => b.text), ['Update website price']);
});
test('PRICE: a rent shows /month and a rise says up', () => {
  const env = priceEnv(unitRow({ listingType: 'rent', price: 650 }));
  say(env, 'TS10-1021 price now $700');
  assert.ok(/\$650\/month to \$700\/month \(up 7\.7%\)/.test(env.sent().pop().text));
});
test('PRICE: someone else changed the price meanwhile, so nothing is overwritten', () => {
  const env = priceEnv();
  say(env, 'TS10-1021 price reduced to $58,500');
  env.intakeBehavior = (p) => (p.action === 'price' ? { code: 409, body: { ok: false, error: 'price_changed', currentPrice: 60000 } } : null);
  run(env, `handleCallback(${JSON.stringify(cb('price_21_go'))})`);
  assert.ok(/Nothing was changed/.test(env.edits().pop().text) && /\$60,000/.test(env.edits().slice(-1)[0] ? env.calls.filter((c) => c.url.includes('/editMessageText')).pop().opts.payload.text : ''));
});
test('PRICE: unknown number, same price, no new price, and a stranger tapping', () => {
  let env = priceEnv(); env.intakeBehavior = () => ({ code: 404, body: { ok: false, error: 'not_found' } });
  say(env, 'TS10-1099 price reduced to $58,500');
  assert.ok(/could not find a single unit/.test(env.sent().pop().text));
  env = priceEnv(); say(env, 'TS10-1021 price reduced to $62,000');
  assert.ok(/already \$62,000/.test(env.sent().pop().text));
  env = priceEnv(); say(env, 'TS10-1021 price drop');
  assert.ok(/not the new price/.test(env.sent().pop().text));
  env = priceEnv(); say(env, 'TS10-1021 price reduced to $58,500');
  run(env, `handleCallback(${JSON.stringify({ id: 'x', data: 'price_21_go', message: { chat: { id: 999 }, message_id: 1 } })})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'price').length, 0);
});


test('PRICE BY REPLY: replying "REDUCED $58,500" to a post with a Ref edits the channel post and offers the website change', () => {
  const env = priceEnv();
  run(env, `HEADERS.forEach(function(){}); `);
  const H = JSON.parse(run(env, 'JSON.stringify(HEADERS)'));
  const row = H.map(() => ''); row[H.indexOf('language')] = 'EN'; row[H.indexOf('content')] = '#ForSale $62,000\nTIME SQUARE 10\n🔗 https://x/p\n🏷 Ref TS10-1021'; row[H.indexOf('reviewMsgId')] = 555; row[H.indexOf('postedMsgId')] = 9001;
  env.sheetData = [H, row];
  run(env, `handleStatusReply(${CHAT}, 'REDUCED $58,500', 555)`);
  assert.ok(env.calls.some((c) => c.url.includes('/editMessageText') && /PRICE REDUCED/.test(c.opts.payload.text)));
  const m = env.sent().pop();
  assert.ok(/Found TS10-1021/.test(m.text) && /\$62,000 to \$58,500/.test(m.text), m.text);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'price').length, 0);
});
test('PRICE BY REPLY: RESERVED, or REDUCED with no amount on a post with a Ref, never touches the website', () => {
  const env = priceEnv();
  const H = JSON.parse(run(env, 'JSON.stringify(HEADERS)'));
  const mk = (content) => { const row = H.map(() => ''); row[H.indexOf('language')] = 'EN'; row[H.indexOf('content')] = content; row[H.indexOf('reviewMsgId')] = 555; row[H.indexOf('postedMsgId')] = 9001; return [H, row]; };
  env.sheetData = mk('Ref TS10-1021'); run(env, `handleStatusReply(${CHAT}, 'RESERVED', 555)`);
  env.sheetData = mk('Ref TS10-1021'); run(env, `handleStatusReply(${CHAT}, 'REDUCED', 555)`);
  assert.ok(!env.sent().some((p) => /Found TS10/.test(p.text)));
  assert.strictEqual(env.intakeLog.length, 0);
});

// ---------- sold / rented, and channel only posts
const chanRow = (env, content, extra = {}) => {
  const H = JSON.parse(run(env, 'JSON.stringify(HEADERS)'));
  const row = H.map(() => ''); row[H.indexOf('language')] = 'EN'; row[H.indexOf('content')] = content; row[H.indexOf('reviewMsgId')] = 555; row[H.indexOf('postedMsgId')] = 9001;
  Object.keys(extra).forEach((k) => { row[H.indexOf(k)] = extra[k]; });
  env.sheetData = [H, row];
};
test('SOLD: parsing needs the word first and a unit number', () => {
  const env = makeEnv();
  const P = (t) => JSON.parse(run(env, `JSON.stringify(parseUnitStatusText(${JSON.stringify(t)}))`));
  assert.deepStrictEqual(P('SOLD TS10-1021'), { verb: 'sold', id: 21, ref: 'TS10-1021' });
  assert.deepStrictEqual(P('rented gt-1019'), { verb: 'rented', id: 19, ref: 'gt-1019' });
  assert.strictEqual(P('sold out soon, see TS10-1021'), null);
  assert.strictEqual(P('SOLD'), null);
  assert.strictEqual(P('#ForSale $100,000 TS10-1021'), null);
});
test('SOLD: typed, shows a card and changes the website only after the tap, once', () => {
  const env = priceEnv();
  say(env, 'SOLD TS10-1021');
  const m = env.sent().pop();
  assert.ok(/Found TS10-1021/.test(m.text) && /Mark it as sold/.test(m.text), m.text);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'status').length, 0);
  run(env, `handleCallback(${JSON.stringify(cb('ustat_21_sold_go'))})`);
  assert.deepStrictEqual(env.intakeLog.filter((p) => p.action === 'status'), [{ action: 'status', id: 21, expectedStatus: 'active', newStatus: 'sold' }]);
  assert.ok(/marked as sold and is off the website/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('ustat_21_sold_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'status').length, 1);
});
test('SOLD: Cancel changes nothing; a stranger cannot tap; a unit that is not live is not marked', () => {
  let env = priceEnv(); say(env, 'RENTED TS10-1021');
  run(env, `handleCallback(${JSON.stringify(cb('ustat_21_rented_no'))})`);
  assert.ok(/Cancelled/.test(env.edits().pop().text));
  run(env, `handleCallback(${JSON.stringify(cb('ustat_21_rented_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'status').length, 0);
  env = priceEnv(); say(env, 'SOLD TS10-1021');
  run(env, `handleCallback(${JSON.stringify({ id: 'x', data: 'ustat_21_sold_go', message: { chat: { id: 999 }, message_id: 1 } })})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'status').length, 0);
  env = priceEnv(unitRow({ status: 'draft' })); say(env, 'SOLD TS10-1021');
  assert.ok(/not live on the website/.test(env.sent().pop().text));
});
test('SOLD: the website says the unit is no longer live, so the bot reports no change', () => {
  const env = priceEnv(); say(env, 'SOLD TS10-1021');
  env.intakeBehavior = (p) => (p.action === 'status' ? { code: 409, body: { ok: false, error: 'status_changed' } } : null);
  run(env, `handleCallback(${JSON.stringify(cb('ustat_21_sold_go'))})`);
  assert.ok(/no longer live/.test(env.edits().pop().text));
});
test('SOLD BY REPLY: replying SOLD to a post with a Ref edits the channel and offers the website card', () => {
  const env = priceEnv();
  chanRow(env, '#ForSale $62,000\n🏷 Ref TS10-1021');
  run(env, `handleStatusReply(${CHAT}, 'SOLD', 555)`);
  assert.ok(env.calls.some((c) => c.url.includes('/editMessageText') && /SOLD/.test(c.opts.payload.text)));
  assert.ok(/Mark it as sold/.test(env.sent().pop().text));
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'status').length, 0);
});
test('CHANNEL ONLY: a REDUCED reply to a post with no Ref offers to create a website page with the new price', () => {
  const env = priceEnv();
  chanRow(env, '#ForSale $185,000\nGATO TOWER | 2BR UNIT\n✅ 14th Floor\n✅ 2 Bedroom | 2 Bathroom\n✅ 85 sqm', { photoFileId: JSON.stringify(['F1', 'F2']) });
  run(env, `handleStatusReply(${CHAT}, 'REDUCED $170,000', 555)`);
  const m = env.sent().pop();
  assert.ok(/no page on the website/.test(m.text));
  const btn = JSON.parse(m.reply_markup).inline_keyboard[0][0];
  assert.strictEqual(btn.text, 'Create a website page from this post');
  const before = env.sent().length;
  run(env, `handleCallback(${JSON.stringify(cb(btn.callback_data))})`);
  const draft = Object.keys(env.cache).filter((k) => k.startsWith('unitdraft_')).map((k) => JSON.parse(env.cache[k]))[0];
  assert.ok(draft, 'a website draft should have started');
  assert.strictEqual(draft.facts.price, 170000);
  assert.deepStrictEqual(draft.images, ['F1', 'F2']);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create').length, 0);
});
test('CHANNEL ONLY: SOLD on a post with no page only says so, no button', () => {
  const env = priceEnv();
  chanRow(env, '#ForSale $185,000\nGATO TOWER');
  run(env, `handleStatusReply(${CHAT}, 'SOLD', 555)`);
  const m = env.sent().pop();
  assert.ok(/no page on the website/.test(m.text) && !m.reply_markup);
});

// ---------- replying to the bot's own website messages
const replyMsg = (quoted, text, mid = 321) => ({ chat: { id: CHAT }, text, reply_to_message: { message_id: mid, text: quoted } });
const draftCreated = 'Hidden draft created. Nobody else can see it yet.\n\nTime Square 10 · 1 Bedroom · Floor 6\nRef: TS10-1021\n\nPreview link:\nhttps://www.propertyhubcambodia.com/property/time-square-10-1-bedroom-floor-6?preview=2aa1de26-2ab3-4f0e-8568-889cf614a1da';
test('REPLY: "reduced to $48,999" to the Hidden draft created message opens the price card', () => {
  const env = priceEnv();
  const handled = run(env, `handleUnitReply(${JSON.stringify(replyMsg(draftCreated, 'reduced to $48,999'))})`);
  assert.strictEqual(handled, true);
  assert.ok(/Found TS10-1021/.test(env.sent().pop().text));
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'lookup')[0].id, 21);
});
test('REPLY: a bare "$48,999" and "SOLD" and "RENTED" work the same way', () => {
  let env = priceEnv();
  assert.strictEqual(run(env, `handleUnitReply(${JSON.stringify(replyMsg(draftCreated, '$48,999'))})`), true);
  assert.ok(/\$48,999/.test(env.sent().pop().text));
  env = priceEnv();
  assert.strictEqual(run(env, `handleUnitReply(${JSON.stringify(replyMsg(draftCreated, 'SOLD'))})`), true);
  assert.ok(/Mark it as sold/.test(env.sent().pop().text));
  env = priceEnv();
  assert.strictEqual(run(env, `handleUnitReply(${JSON.stringify(replyMsg('Found TS10-1021: x', 'rented'))})`), true);
  assert.ok(/Mark it as rented/.test(env.sent().pop().text));
});
test('REPLY: chat, a plain number with no $, other chats, and messages without a unit are not handled', () => {
  const env = priceEnv();
  const H = (q, t) => run(env, `handleUnitReply(${JSON.stringify(replyMsg(q, t))})`);
  assert.strictEqual(H(draftCreated, 'thanks'), false);
  assert.strictEqual(H(draftCreated, '48999'), false);
  assert.strictEqual(H('no reference in this message', 'SOLD'), false);
  assert.strictEqual(run(env, `handleUnitReply(${JSON.stringify({ chat: { id: 999 }, text: 'SOLD', reply_to_message: { message_id: 1, text: draftCreated } })})`), false);
  assert.strictEqual(env.intakeLog.length, 0);
});
test('REPLY: a reply to a channel review message is left to the older status route', () => {
  const env = priceEnv();
  chanRow(env, '#ForSale $62,000\n🏷 Ref TS10-1021');
  assert.strictEqual(run(env, `handleUnitReply(${JSON.stringify(replyMsg('Review this post\nRef TS10-1021', 'SOLD', 555))})`), false);
  assert.strictEqual(env.intakeLog.length, 0);
});

// ---------- speed
test('SPEED: the review message is sent before JP, RU and DE are translated', () => {
  const env = makeEnv();
  env.order = [];
  run(env, `LanguageApp.translate = function (t, f, to) { __order.push('translate:' + to); return '[' + to + '] ' + t; }`);
  env.ctx.__order = env.order;
  const origFetch = env.ctx.UrlFetchApp.fetch;
  env.ctx.UrlFetchApp.fetch = function (url, opts) { if (/sendPhoto|sendMessage/.test(url) && opts && opts.payload && /New listing ready/.test(String(opts.payload.caption || opts.payload.text || ''))) env.order.push('review'); return origFetch.call(this, url, opts); };
  env.ctx.__post = residenceL(env);
  run(env, `processChannelListing('${CHAT}', __post, ['F1'], false, null, null)`);
  const iReview = env.order.indexOf('review');
  assert.ok(iReview >= 0, 'review message was sent: ' + JSON.stringify(env.order));
  assert.ok(env.order.slice(0, iReview).every((x) => x !== 'translate:ja' && x !== 'translate:ru' && x !== 'translate:de'), 'no JP/RU/DE translation before the review: ' + JSON.stringify(env.order.slice(0, iReview)));
  assert.ok(env.order.slice(iReview).some((x) => x === 'translate:ja'), 'JP is still translated after it');
  // every language row is complete and points at the review message
  const H = JSON.parse(run(env, 'JSON.stringify(HEADERS)'));
  const rows = env.sheetData.slice(1).filter((r) => r[H.indexOf('language')]);
  assert.deepStrictEqual(rows.map((r) => r[H.indexOf('language')]), ['EN', 'JP', 'RU', 'DE']);
  rows.forEach((r) => { assert.strictEqual(r[H.indexOf('status')], 'Pending Review'); assert.ok(r[H.indexOf('reviewMsgId')], 'review id set'); assert.ok(r[H.indexOf('content')]); });
  assert.strictEqual(new Set(rows.map((r) => r[H.indexOf('reviewMsgId')])).size, 1);
});
test('SPEED: a line that was translated once is not sent to the translator again', () => {
  const env = makeEnv();
  run(env, `__n = 0; LanguageApp.translate = function (t, f, to) { __n++; return '[' + to + '] ' + t; }`);
  run(env, `translateField('Swimming Pool & Gym', 'en', 'JP'); translateField('Swimming Pool & Gym', 'en', 'JP'); translateField('Swimming Pool & Gym', 'en', 'RU');`);
  assert.strictEqual(run(env, '__n'), 2); // JP once, RU once
  assert.strictEqual(run(env, `translateField('Swimming Pool & Gym', 'en', 'JP')`), '[ja] Swimming Pool & Gym');
});
test('SPEED: ALL CAPS lines keep their capitals when served from the cache', () => {
  const env = makeEnv();
  run(env, `LanguageApp.translate = function (t, f, to) { return 'x ' + t; }`);
  assert.strictEqual(run(env, `translateField('UNIT DETAILS', 'en', 'DE')`), 'X UNIT DETAILS');
  assert.strictEqual(run(env, `translateField('UNIT DETAILS', 'en', 'DE')`), 'X UNIT DETAILS');
});
test('SPEED: photos go to the website in parallel groups, in the right order, and one failure still cleans up', () => {
  const env = makeEnv();
  run(env, `handleIncomingMessage(${CHAT}, '#unit 2 bedroom, floor 14, 85 sqm, $185,000', ${JSON.stringify(ids(14))}, false, null, null, ${JSON.stringify(ids(14))})`);
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_pick'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.deepStrictEqual(env.fetchAllSizes, [4, 1]); // 5 batches of 3 photos: 4 together, then 1
  const created = env.intakeLog.find((p) => p.action === 'create');
  assert.deepStrictEqual(created.images, ids(14).map((_, i) => `https://u/${i + 1}`)); // order kept
});

test('TIMING: the report is sent only when DEBUG_TIMING is 1, and names the review step', () => {
  let env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `processChannelListing('${CHAT}', __post, ['F1'], false, null, null)`);
  assert.ok(!env.sent().some((p) => /^Timing/.test(p.text)));
  env = makeEnv(); env.props.DEBUG_TIMING = '1';
  env.ctx.__post = residenceL(env);
  run(env, `processChannelListing('${CHAT}', __post, ['F1'], false, null, null)`);
  const rep = env.sent().pop().text;
  assert.ok(/^Timing/.test(rep) && /REVIEW SENT \d/.test(rep) && /all languages done/.test(rep) && /Rows in the queue sheet/.test(rep), rep);
});

// ---------- duplicates and HEIC
const startLinkedDraft = (env, text) => {
  run(env, `handleIncomingMessage(${CHAT}, ${JSON.stringify(text)}, ['F1'], false, null, null, ['F1'])`); // the #unit tag skips the menu
  const id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_pick'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_p_8'))})`);
  return id;
};
const twinRow = { id: 21, refCode: 'TS10-1021', title: 'Time Square 10 · 1 Bedroom · Floor 6', price: 49999, status: 'draft' };
test('DUPLICATE: a similar unit asks before creating, and nothing is created yet', () => {
  const env = makeEnv();
  env.intakeBehavior = (p) => (p.action === 'twins' ? { code: 200, body: { ok: true, twins: [twinRow] } } : null);
  const id = startLinkedDraft(env, caption);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const t = env.edits().pop().text;
  assert.ok(/Possible duplicate/.test(t) && /TS10-1021: Time Square 10 · 1 Bedroom · Floor 6, \$49,999 \(hidden draft\)/.test(t) && /price reduced to/.test(t), t);
  assert.deepStrictEqual(env.intakeLog.filter((p) => p.action === 'twins')[0], { action: 'twins', parentPropertyId: 8, listingType: 'resale', floor: '14', bedrooms: 2, unitNumber: null });
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create' || p.action === 'photos').length, 0);
});
test('DUPLICATE: Create another anyway goes ahead exactly once', () => {
  const env = makeEnv();
  env.intakeBehavior = (p) => (p.action === 'twins' ? { code: 200, body: { ok: true, twins: [twinRow] } } : null);
  const id = startLinkedDraft(env, caption);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_dup'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create').length, 1);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_dup'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create').length, 1);
});
test('DUPLICATE: no similar unit, or a failed check, or a new building, never blocks the draft', () => {
  let env = makeEnv();
  let id = startLinkedDraft(env, caption);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create').length, 1);
  env = makeEnv();
  env.intakeBehavior = (p) => (p.action === 'twins' ? { code: 500, body: { ok: false } } : null);
  id = startLinkedDraft(env, caption);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create').length, 1);
  env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['F1'], false, null, null, ['F1'])`);
  menuTap(env, 'site');
  id = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_')).slice(10);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'twins').length, 0);
});
test('DUPLICATE: Cancel leaves everything alone', () => {
  const env = makeEnv();
  env.intakeBehavior = (p) => (p.action === 'twins' ? { code: 200, body: { ok: true, twins: [twinRow] } } : null);
  const id = startLinkedDraft(env, caption);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_x'))})`);
  assert.ok(/Cancelled/.test(env.edits().pop().text));
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'create').length, 0);
});
test('HEIC: HEIC files are not used as photos, other image files still are', () => {
  const env = makeEnv();
  const G = (m) => run(env, `getImageFileId(${JSON.stringify(m)})`);
  assert.strictEqual(G({ document: { file_id: 'h1', mime_type: 'image/heic', file_name: 'IMG_1.HEIC' } }), null);
  assert.strictEqual(G({ document: { file_id: 'h2', mime_type: 'image/heif' } }), null);
  assert.strictEqual(G({ document: { file_id: 'h3', file_name: 'IMG_2.heic' } }), null);
  assert.strictEqual(G({ document: { file_id: 'j1', mime_type: 'image/jpeg' } }), 'j1');
  assert.strictEqual(G({ photo: [{ file_id: 'p1' }, { file_id: 'p2' }] }), 'p2');
});
test('HEIC: you are told once, with what to do, even when ten files arrive together', () => {
  const env = makeEnv();
  const m = { chat: { id: CHAT }, document: { file_id: 'h1', mime_type: 'image/heic', file_name: 'a.heic' } };
  for (let i = 0; i < 10; i++) run(env, `warnAboutHeic(${JSON.stringify(m)})`);
  const msgs = env.sent().filter((p) => /HEIC/.test(p.text));
  assert.strictEqual(msgs.length, 1);
  assert.ok(/as Photos, not as Files/.test(msgs[0].text) && /Most Compatible/.test(msgs[0].text));
  run(env, `warnAboutHeic(${JSON.stringify({ chat: { id: CHAT }, document: { file_id: 'j', mime_type: 'image/jpeg' } })})`);
  run(env, `warnAboutHeic(${JSON.stringify({ chat: { id: 999 }, document: { file_id: 'h', mime_type: 'image/heic' } })})`);
  assert.strictEqual(env.sent().filter((p) => /HEIC/.test(p.text)).length, 1);
});

test('DUPLICATE: a twin that is already sold is described as a possible relisting, not offered a price change', () => {
  const env = makeEnv();
  env.intakeBehavior = (p) => (p.action === 'twins' ? { code: 200, body: { ok: true, twins: [Object.assign({}, twinRow, { status: 'sold' })] } } : null);
  const id = startLinkedDraft(env, caption);
  run(env, `handleCallback(${JSON.stringify(cb('unit_' + id + '_go'))})`);
  const t = env.edits().pop().text;
  assert.ok(/\(sold\)/.test(t) && /no longer live/.test(t) && !/price reduced to/.test(t), t);
});

// ---------- translation keeps names
// A fake translator that behaves like the real one did: it turns BKK into Bangkok unless the word is marked translate="no".
const fakeTranslator = (honourNoTranslate) => `LanguageApp.translate = function (t, f, to, opts) {
  __seen.push({ t: t, opts: opts || null });
  const bangkok = { ja: 'バンコク', ru: 'Бангкок', de: 'Bangkok' }[to] || 'Bangkok';
  let out = t;
  const keep = [];
  if (${honourNoTranslate}) { out = out.replace(/<span translate="no">(.*?)<\\/span>/g, function (m, g1) { keep.push(g1); return '@@' + (keep.length - 1) + '@@'; }); }
  out = out.replace(/\\bBKK([1-3]?)\\b/g, bangkok + '$1').replace(/Time Square/g, 'タイムスクエア').replace(/Located in/g, to === 'ja' ? '所在地' : 'In');
  if (${honourNoTranslate}) out = out.replace(/@@(\\d+)@@/g, function (m, i) { return '<span translate="no">' + keep[+i] + '</span>'; });
  return out;
}`;
test('NAMES: BKK1 is kept as BKK1 when the translator honours the do-not-translate mark', () => {
  const env = makeEnv();
  run(env, `__seen = []`); run(env, fakeTranslator(true));
  const r = run(env, `translateField('Located in BKK1, near Time Square 10', 'en', 'JP')`);
  assert.strictEqual(r, '所在地 BKK1, near Time Square 10');
  assert.strictEqual(JSON.parse(run(env, 'JSON.stringify(__seen[0].opts)')).contentType, 'html');
  assert.ok(!/<span/.test(r));
});
test('NAMES: if the translator ignores the mark and still says Bangkok, BKK is put back', () => {
  const env = makeEnv();
  run(env, `__seen = []`); run(env, fakeTranslator(false));
  assert.strictEqual(run(env, `translateField('Located in BKK3', 'en', 'JP')`), '所在地 BKK3'.replace('BKK3', 'BKK3'));
  assert.strictEqual(run(env, `translateField('Located in BKK', 'en', 'RU')`), 'In BKK');
  assert.strictEqual(run(env, `translateField('Located in BKK2', 'en', 'DE')`), 'In BKK2');
});
test('NAMES: a real mention of Bangkok is left alone, and text without names uses the plain translator', () => {
  const env = makeEnv();
  run(env, `__seen = []`); run(env, fakeTranslator(true));
  run(env, `LanguageApp.translate = function (t, f, to, opts) { __seen.push({ t: t, opts: opts || null }); return '[' + to + '] ' + t.replace('Bangkok', 'バンコク'); }`);
  assert.strictEqual(run(env, `translateField('Flights to Bangkok daily', 'en', 'JP')`), '[ja] Flights to バンコク daily');
  assert.strictEqual(run(env, `__seen[0].opts`), null);
  // when BKK is present and the text never says Bangkok, any Bangkok in the result is the old mistake; a text that says both is left to the marks
  assert.ok(/BKK/.test(run(env, `translateField('Flights from BKK to Bangkok', 'en', 'JP')`)));
});
test('NAMES: an ALL CAPS line with BKK1 keeps BKK1 in capitals', () => {
  const env = makeEnv();
  run(env, `__seen = []`); run(env, fakeTranslator(true));
  assert.strictEqual(run(env, `translateField('LOCATED IN BKK1', 'en', 'JP')`), 'LOCATED IN BKK1');
});
test('NAMES: ampersands and angle signs in the text survive the marked round trip', () => {
  const env = makeEnv();
  run(env, `__seen = []`); run(env, fakeTranslator(true));
  const r = run(env, `translateField('Pool & Gym in BKK1 <new>', 'en', 'DE')`);
  assert.strictEqual(r, 'Pool & Gym in BKK1 <new>');
});
test('NAMES: if the html mode is refused, the plain text translation is used and BKK is still restored', () => {
  const env = makeEnv();
  run(env, `LanguageApp.translate = function (t, f, to, opts) { if (opts) throw new Error('html not supported'); return t.replace(/BKK1/g, 'バンコク1'); }`);
  assert.strictEqual(run(env, `translateField('Located in BKK1', 'en', 'JP')`), 'Located in BKK1');
});
test('NAMES: a whole post forwarded from your own channel keeps BKK1 in JP', () => {
  const env = makeEnv();
  run(env, `__seen = []`); run(env, fakeTranslator(true));
  const out = run(env, `translateWholeText('#ForSale $35,000\\n📍 BKK1, Phnom Penh\\n✅ Located in BKK1', 'JP')`);
  assert.ok(!/バンコク/.test(out) && /BKK1, Phnom Penh/.test(out), out);
});

// ---------- bedrooms and bathrooms on one line, first in UNIT DETAILS
const FB = (env, bb, lang) => run(env, `formatBedBath(${JSON.stringify(bb)}, '${lang}')`);
test('BEDBATH: the line in every language, with plurals', () => {
  const env = makeEnv();
  assert.strictEqual(FB(env, { beds: 1, baths: 1 }, 'EN'), '🛏 1 Bed | 🛁 1 Bath');
  assert.strictEqual(FB(env, { beds: 2, baths: 2 }, 'EN'), '🛏 2 Beds | 🛁 2 Baths');
  assert.strictEqual(FB(env, { beds: 0, baths: 1 }, 'EN'), '🛏 Studio | 🛁 1 Bath');
  assert.strictEqual(FB(env, { beds: 2, baths: 1.5 }, 'EN'), '🛏 2 Beds | 🛁 1.5 Baths');
  assert.strictEqual(FB(env, { beds: 1, baths: null }, 'EN'), '🛏 1 Bed');
  assert.strictEqual(FB(env, { beds: 2, baths: 1 }, 'JP'), '🛏 2ベッドルーム | 🛁 1バスルーム');
  assert.strictEqual(FB(env, { beds: 0, baths: 1 }, 'JP'), '🛏 スタジオ | 🛁 1バスルーム');
  assert.strictEqual(FB(env, { beds: 1, baths: 1 }, 'RU'), '🛏 1 спальня | 🛁 1 ванная');
  assert.strictEqual(FB(env, { beds: 3, baths: 2 }, 'RU'), '🛏 3 спальни | 🛁 2 ванные');
  assert.strictEqual(FB(env, { beds: 5, baths: 11 }, 'RU'), '🛏 5 спален | 🛁 11 ванных');
  assert.strictEqual(FB(env, { beds: 2, baths: 1.5 }, 'RU'), '🛏 2 спальни | 🛁 1.5 ванной');
  assert.strictEqual(FB(env, { beds: 2, baths: 1 }, 'DE'), '🛏 2 Schlafzimmer | 🛁 1 Bad');
  assert.strictEqual(FB(env, { beds: 2, baths: 2 }, 'DE'), '🛏 2 Schlafzimmer | 🛁 2 Bäder');
});
test('BEDBATH: the old and the new way of writing it are both read; other lines are not mistaken for it', () => {
  const env = makeEnv();
  const P = (t) => JSON.parse(run(env, `JSON.stringify(parseBedBathText(${JSON.stringify(t)}))`));
  assert.deepStrictEqual(P('1 Bedroom | 1 Bathroom'), { beds: 1, baths: 1 });
  assert.deepStrictEqual(P('🛏 1 Bed | 🛁 1 Bath'), { beds: 1, baths: 1 });
  assert.deepStrictEqual(P('🛏️ 2 Beds | 🛁 1.5 Baths'), { beds: 2, baths: 1.5 });
  assert.deepStrictEqual(P('Studio | 1 Bath'), { beds: 0, baths: 1 });
  assert.deepStrictEqual(P('2BR'), { beds: 2, baths: null });
  assert.strictEqual(P('1 Bedroom Duplex'), null);
  assert.strictEqual(P('9th Floor'), null);
  assert.strictEqual(P('47 sqm Gross | 38 sqm Net'), null);
  assert.strictEqual(P(''), null);
});
const asm = (env, text, lang) => { run(env, 'COMPACT_LISTING_LAYOUT = true'); return run(env, `fromBoldSansSerif(assembleListing(parseListingText(${JSON.stringify(text)}), '${lang}'))`); };
const sourcePost = '#ForSale $35,000\n\nRESIDENCE L | 1BR UNIT\n📍 BKK1, Phnom Penh\n\n――――――――――\n\nUNIT DETAILS\n✅ Unit G10-09 | 9th Floor\n✅ 1 Bedroom | 1 Bathroom\n✅ 47㎡ Gross | 38㎡ Net\n✅ Strata Title\n✅ Fully Furnished\n\nFACILITIES\n✅ Swimming Pool & Gym\n✅ Coffee Shop\n✅ Convenience Store\n✅ Laundry Room\n\n📞 011 666 952';
test('COMPACT: a single unit becomes price, place, one facts line, features', () => {
  const env = makeEnv();
  const out = asm(env, sourcePost, 'EN');
  assert.strictEqual(out, [
    '#ForSale $35,000', '', '📍 Residence L, BKK1', '', 'Floor 9 | 📐 47 sqm | 1🛏 | 1🛁', '', 'Features:',
    '✅ Strata Title', '✅ Fully Furnished', '✅ Net area 38 sqm', '✅ Swimming Pool & Gym', '✅ Coffee Shop', '',
    '――――――――――', '📞 011 666 952', '📱 t.me/PropertyHubCambodia'].join('\n'));
  assert.ok(out.endsWith('📞 011 666 952\n📱 t.me/PropertyHubCambodia'));
  assert.ok(!/G10-09/.test(out), 'the unit number is never shown');
  assert.ok(!/Convenience|Laundry/.test(out), 'only the first two facilities are folded in');
  assert.ok(!/UNIT DETAILS|FACILITIES|🏷/.test(out));
});
test('COMPACT: the same unit in JP, RU and DE: floor and sizes in their words, icons unchanged, names kept', () => {
  const env = makeEnv();
  run(env, `LanguageApp.translate = function (t, f, to) { return '[' + to + '] ' + t; }`);
  const jp = asm(env, sourcePost, 'JP'), ru = asm(env, sourcePost, 'RU'), de = asm(env, sourcePost, 'DE');
  assert.ok(/9階 \| 📐 47 ㎡ \| 1🛏 \| 1🛁/.test(jp) && /特徴:/.test(jp) && /専有面積 38㎡/.test(jp) && /📍 Residence L, BKK1/.test(jp), jp);
  assert.ok(/9 этаж \| 📐 47 м² \| 1🛏 \| 1🛁/.test(ru) && /Особенности:/.test(ru), ru);
  assert.ok(/9\. Etage \| 📐 47 m² \| 1🛏 \| 1🛁/.test(de) && /Ausstattung:/.test(de), de);
});
test('COMPACT: a studio, a ground floor, 1.5 baths, a rental and utilities', () => {
  const env = makeEnv();
  const rent = '#ForRent $650/month\n\nSKY VILLA | STUDIO\n📍 Tonle Bassac, Phnom Penh\n\nUNIT DETAILS\n✅ Studio | 1 Bath\n✅ Floor G\n✅ 38 sqm\n✅ Fully Furnished\n💧 Water $0.5 per m3\n⚡ Electricity $0.25 per kWh';
  const out = asm(env, rent, 'EN');
  assert.ok(/^#ForRent \$650\/month\n\n📍 Sky Villa, Tonle Bassac\n\nGround floor \| 📐 38 sqm \| Studio \| 1🛁\n\nFeatures:\n✅ Fully Furnished\n\nUtilities:\n💧 Water \$0\.5 per m3\n⚡ Electricity \$0\.25 per kWh\n\n/.test(out), out);
  assert.ok(/2🛏 \| 1\.5🛁/.test(asm(env, sourcePost.replace('1 Bedroom | 1 Bathroom', '2 Beds | 1.5 Baths'), 'EN')));
});
test('COMPACT: it is OFF by default, so posts keep the previous layout until you accept a style', () => {
  const env = makeEnv();
  const out = run(env, `fromBoldSansSerif(assembleListing(parseListingText(${JSON.stringify(sourcePost)}), 'EN'))`);
  assert.ok(/UNIT DETAILS\n🛏 1 Bed \| 🛁 1 Bath\n/.test(out) && !/Features:/.test(out) && /G10-09/.test(out), out);
});
test('COMPACT: not used for a promotion or a post without bedrooms and bathrooms, which keep the old layout', () => {
  const env = makeEnv();
  const promo = '#ForSale $99,000\n\nTIME SQUARE 7 | NEW LAYOUT\n📍 Toul Kork, Phnom Penh\n\nPROMOTION\n✅ 1 Bedroom Duplex\n✅ 65㎡ Gross Area\n✅ Up to 35-Month Installment';
  const out = asm(env, promo, 'EN');
  assert.ok(/UNIT DETAILS/.test(out) && /1 Bedroom Duplex/.test(out) && !/Features:|🛏/.test(out), out);
});
test('COMPACT: your old and new bed and bath wording both give the same compact line, and the old layout still gets the emoji line first', () => {
  const env = makeEnv();
  const a = asm(env, sourcePost, 'EN'), b = asm(env, sourcePost.replace('✅ 1 Bedroom | 1 Bathroom', '🛏 1 Bed | 🛁 1 Bath'), 'EN');
  assert.strictEqual(a, b);
  const noHashtag = sourcePost.replace('#ForSale $35,000\n\n', '');
  assert.ok(/UNIT DETAILS\n🛏 1 Bed \| 🛁 1 Bath\n/.test(asm(env, noHashtag, 'EN')));
});
test('COMPACT: a post forwarded from your own channel is rebuilt the same way, other forwards keep the whole text path', () => {
  const env = makeEnv();
  run(env, 'COMPACT_LISTING_LAYOUT = true');
  env.ctx.__post = '#ForSale $35,000\n\n𝗥𝗘𝗦𝗜𝗗𝗘𝗡𝗖𝗘 𝗟 | 𝟭𝗕𝗥 𝗨𝗡𝗜𝗧\n📍 Boeung Tumpun, Phnom Penh\n\nUNIT DETAILS\n✅ Unit G10-09 | 9th Floor\n✅ 1 Bedroom | 1 Bathroom\n✅ 47㎡ Gross | 38㎡ Net\n\n📞 096 96 61 555\n🏠 t.me/NickREAKH';
  run(env, `processChannelListing('${CHAT}', __post, ['F1'], true, 'NickREAKH', null)`);
  const H = JSON.parse(run(env, 'JSON.stringify(HEADERS)'));
  const en = env.sheetData.slice(1).find((r) => r[H.indexOf('language')] === 'EN')[H.indexOf('content')];
  assert.ok(/📍 Residence L, Boeung Tumpun\n\nFloor 9 \| 📐 47 sqm \| 1🛏 \| 1🛁/.test(en) && !/096 96 61 555|NickREAKH|G10-09/.test(en), en);
  env.ctx.__promo = 'TIME SQUARE 7 | NEW LAYOUT\nPromotion for everyone\n📞 096 96 61 555';
  const before = env.sheetData.length;
  run(env, `processChannelListing('${CHAT}', __promo, ['F1'], true, 'NickREAKH', null)`);
  assert.ok(env.sheetData.length > before);
});
test('COMPACT: read back by the website draft reader: building, area, floor, size, bedrooms, bathrooms and features', () => {
  const env = makeEnv();
  const post = '#ForSale $35,000\n\n📍 Residence L, Boeung Tumpun\n\nFloor 9 | 📐 47 sqm | 1🛏 | 1🛁\n\nFeatures:\n✅ Strata Title\n✅ Fully Furnished\n\n🔗 https://www.propertyhubcambodia.com/property/residence-l-1-bedroom-floor-9-1022\n\n――――――――――\n📞 011 666 952\n📱 t.me/PropertyHubCambodia';
  const f = JSON.parse(run(env, `JSON.stringify(parseUnitFacts(${JSON.stringify(post)}))`));
  assert.strictEqual(f.buildingName, 'Residence L'); assert.strictEqual(f.locationText, 'Boeung Tumpun'); assert.strictEqual(f.floor, '9');
  assert.strictEqual(f.sqm, 47); assert.strictEqual(f.bedrooms, 1); assert.strictEqual(f.bathrooms, 1); assert.strictEqual(f.price, 35000);
  assert.deepStrictEqual(f.extraFeatures, ['Strata Title', 'Fully Furnished']);
});
test('REPLY BY LINK: a post with only the page link (no code) still finds its unit for REDUCED and SOLD replies', () => {
  const env = priceEnv();
  chanRow(env, '#ForSale $62,000\n\n🔗 https://www.propertyhubcambodia.com/property/time-square-10-1-bedroom-floor-6-1021\n\n――――――――――\n📞 011 666 952');
  run(env, `handleStatusReply(${CHAT}, 'REDUCED $58,500', 555)`);
  assert.strictEqual(env.intakeLog.filter((p) => p.action === 'lookup')[0].id, 21);
  assert.ok(/Found TS10-1021/.test(env.sent().pop().text));
  chanRow(env, '#ForSale $62,000\n🔗 https://www.propertyhubcambodia.com/property/time-square-10-1-bedroom-floor-6-1021');
  run(env, `handleStatusReply(${CHAT}, 'SOLD', 555)`);
  assert.ok(/Mark it as sold/.test(env.sent().pop().text));
  chanRow(env, '#ForSale $62,000\n🔗 https://www.propertyhubcambodia.com/property/gato-tower');
  run(env, `handleStatusReply(${CHAT}, 'SOLD', 555)`);
  assert.ok(/no page on the website/.test(env.sent().pop().text), 'a project link is not a unit');
});
test('BEDBATH: "1 Bedroom Duplex" stays an ordinary bullet', () => {
  const env = makeEnv();
  const post = sourcePost.replace('✅ 1 Bedroom | 1 Bathroom', '✅ 1 Bedroom Duplex');
  const out = run(env, `fromBoldSansSerif(assembleListing(parseListingText(${JSON.stringify(post)}), 'EN'))`);
  assert.ok(/✅ 1 Bedroom Duplex/.test(out) && !/🛏/.test(out));
});
test('BEDBATH: a post built from the facts puts the line first, and reading it back gives the same bedrooms and bathrooms', () => {
  const env = makeEnv();
  const t = run(env, `unitFactsToChannelText({ buildingName: 'Gato Tower', facts: { price: 185000, listingType: 'resale', bedrooms: 2, bathrooms: 2, floor: '14', sqm: 85 }, features: [], extraFeatures: [], location: 'BKK1', city: 'Phnom Penh' })`);
  const body = t.split('UNIT DETAILS\n')[1].split('\n');
  assert.deepStrictEqual(body.slice(0, 3), ['🛏 2 Beds | 🛁 2 Baths', '✅ 14th Floor', '✅ 85 sqm']);
  const back = JSON.parse(run(env, `JSON.stringify(parseUnitFacts(${JSON.stringify(t)}))`));
  assert.strictEqual(back.bedrooms, 2); assert.strictEqual(back.bathrooms, 2); assert.strictEqual(back.floor, '14'); assert.strictEqual(back.sqm, 85);
});
test('BEDBATH: the website draft reader understands the emoji line, including 1.5 baths', () => {
  const env = makeEnv();
  const f = JSON.parse(run(env, `JSON.stringify(parseTelegramPost('#ForSale $99,000\\nGATO TOWER | 2BR UNIT\\nUNIT DETAILS\\n🛏 2 Beds | 🛁 1.5 Baths\\n✅ 6th Floor\\n✅ 70 sqm'))`));
  assert.strictEqual(f.bedrooms, 2); assert.strictEqual(f.bathrooms, 1.5); assert.strictEqual(f.floor, '6'); assert.strictEqual(f.sqm, 70);
});
test('BEDBATH: a post forwarded from your own channel keeps the line in the JP copy without translating it', () => {
  const env = makeEnv();
  run(env, `LanguageApp.translate = function (t, f, to) { return '[' + to + '] ' + t; }`);
  const out = run(env, `translateWholeText('UNIT DETAILS\\n🛏 2 Beds | 🛁 2 Baths\\n✅ 9th Floor', 'JP')`);
  assert.ok(out.split('\\n').includes('🛏 2ベッドルーム | 🛁 2バスルーム') || out.split('\n').includes('🛏 2ベッドルーム | 🛁 2バスルーム'), out);
});

// ====================== videos (v: prefix) ======================
const videoMsg = (uid, fid, text, extra) => ({ update_id: uid, message: Object.assign({ message_id: uid, chat: { id: CHAT }, caption: text, video: { file_id: fid, mime_type: 'video/mp4' } }, extra || {}) });
const mediaCalls = (env, kind) => env.calls.filter((c) => c.url.includes('/' + kind)).map((c) => c.opts.payload);
// like fastClock, but Date stays a real constructor (the listing flow builds timestamps with new Date())
const tickClock = (env) => run(env, `(function(){ var t = Date.now(); Date.now = function(){ t += 15000; return t; }; })()`);
const finishRoute = (env) => { if (Object.keys(env.cache).some((k) => k.startsWith('unitmenu_'))) menuTap(env, 'chan'); };

test('VIDEO: a listing sent with one video says "1 video" (not "0 photos"), keeps it in the Queue row and sends it with /sendVideo', () => {
  const env = makeEnv(); tickClock(env);
  env.updates = [[videoMsg(1001, 'VID1', residenceL(env))]];
  run(env, `checkForUpdates()`);
  finishRoute(env);
  const rows = env.sheetData.slice(1);
  assert.deepStrictEqual(rows.map((r) => r[2]), ['EN', 'JP', 'RU', 'DE']);
  rows.forEach((r) => assert.strictEqual(r[8], JSON.stringify(['v:VID1'])));
  const texts = env.sent().map((p) => p.text);
  assert.ok(texts.some((t) => /Listing detected \(1 video\)/.test(t)), texts.join(' | '));
  assert.ok(!texts.some((t) => /0 photos/.test(t)), 'must not claim 0 photos');
  const vids = mediaCalls(env, 'sendVideo');
  assert.strictEqual(vids.length, 1, 'one review card sent as a video');
  assert.strictEqual(vids[0].video, 'VID1', 'Telegram gets the bare file_id, never the v: prefix');
  assert.ok(/New listing ready/.test(vids[0].caption) && /Approve All/.test(vids[0].reply_markup), 'review card keeps its text and buttons');
  assert.strictEqual(mediaCalls(env, 'sendPhoto').length, 0, 'a video is never sent through /sendPhoto');
  assert.strictEqual(env.telegramRejected || 0, 0);
});

test('VIDEO: an album with photos and a video keeps both, in order, and the review card uses the first item', () => {
  const env = makeEnv(); tickClock(env);
  const photo = { update_id: 1101, message: { message_id: 1101, chat: { id: CHAT }, media_group_id: 'GV', photo: [{ file_id: 'P1s' }, { file_id: 'P1' }], caption: residenceL(env) } };
  const vid = { update_id: 1102, message: { message_id: 1102, chat: { id: CHAT }, media_group_id: 'GV', video: { file_id: 'V1' } } };
  env.updates = [[photo, vid]];
  run(env, `checkForUpdates()`);
  finishRoute(env);
  const rows = env.sheetData.slice(1);
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0][8], JSON.stringify(['P1', 'v:V1']));
  const texts = env.sent().map((p) => p.text);
  assert.ok(texts.some((t) => /Listing detected \(1 photo and 1 video\)/.test(t)), texts.join(' | '));
  assert.strictEqual(mediaCalls(env, 'sendPhoto').length, 1, 'the first item (a photo) is the review card');
  assert.strictEqual(env.telegramRejected || 0, 0);
});

test('VIDEO: posting to a channel: one video carries the caption and buttons, an album marks each item photo or video with bare ids', () => {
  const env = makeEnv();
  const kb = { inline_keyboard: [[{ text: 'Contact', url: 'https://t.me/x' }]] };
  run(env, `postGalleryWithButtons('-100777', ['v:V9'], 'Caption', ${JSON.stringify(kb)})`);
  const v = mediaCalls(env, 'sendVideo');
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].video, 'V9'); assert.strictEqual(v[0].caption, 'Caption'); assert.ok(/Contact/.test(v[0].reply_markup));
  run(env, `postGalleryWithButtons('-100777', ['P1', 'v:V2', 'P3'], 'Caption', ${JSON.stringify(kb)})`);
  const g = mediaCalls(env, 'sendMediaGroup');
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual(JSON.parse(g[0].media), [{ type: 'photo', media: 'P1' }, { type: 'video', media: 'V2' }, { type: 'photo', media: 'P3' }]);
  const texts = env.sent().map((p) => p.text);
  assert.ok(texts.includes('Caption'), 'the caption follows the album as its own message');
});

test('VIDEO: rows written before videos existed still work exactly as before (JSON list, bare string, empty)', () => {
  const env = makeEnv();
  assert.deepStrictEqual(JSON.parse(run(env, `JSON.stringify(parsePhotoIds('["A","B"]'))`)), ['A', 'B']);
  assert.deepStrictEqual(JSON.parse(run(env, `JSON.stringify(parsePhotoIds('AgACsingle'))`)), ['AgACsingle']);
  assert.deepStrictEqual(JSON.parse(run(env, `JSON.stringify(parsePhotoIds(''))`)), []);
  assert.deepStrictEqual(JSON.parse(run(env, `JSON.stringify(parsePhotoIds('v:VID'))`)), ['v:VID']);
  run(env, `postGalleryWithButtons('-100777', ['AgACsingle'], 'Old row', null)`);
  const p = mediaCalls(env, 'sendPhoto');
  assert.strictEqual(p.length, 1); assert.strictEqual(p[0].photo, 'AgACsingle');
  assert.strictEqual(mediaCalls(env, 'sendVideo').length, 0);
  run(env, `postGalleryWithButtons('-100777', ['A', 'B'], 'Old album', null)`);
  assert.deepStrictEqual(JSON.parse(mediaCalls(env, 'sendMediaGroup')[0].media), [{ type: 'photo', media: 'A' }, { type: 'photo', media: 'B' }]);
});

test('VIDEO: an old photo-only listing still goes through the whole flow with the same row, count text and /sendPhoto review card', () => {
  const env = makeEnv();
  env.ctx.__post = residenceL(env);
  run(env, `handleIncomingMessage(${CHAT}, __post, ['P1', 'P2'], false, null, null, ['P1', 'P2'])`);
  menuTap(env, 'chan');
  const rows = env.sheetData.slice(1);
  rows.forEach((r) => assert.strictEqual(r[8], JSON.stringify(['P1', 'P2'])));
  assert.ok(env.sent().some((p) => /Listing detected \(2 photos\)/.test(p.text)));
  assert.strictEqual(mediaCalls(env, 'sendPhoto').length, 1);
  assert.strictEqual(mediaCalls(env, 'sendVideo').length, 0);
});

test('VIDEO: count wording', () => {
  const env = makeEnv();
  const t = (a) => run(env, `mediaCountText(${JSON.stringify(a)})`);
  assert.strictEqual(t([]), '0 photos'); assert.strictEqual(t(['a']), '1 photo'); assert.strictEqual(t(['a', 'b']), '2 photos');
  assert.strictEqual(t(['v:x']), '1 video'); assert.strictEqual(t(['v:x', 'v:y']), '2 videos');
  assert.strictEqual(t(['a', 'v:x']), '1 photo and 1 video'); assert.strictEqual(t(['a', 'b', 'v:x']), '2 photos and 1 video');
});

test('VIDEO: the #unit website intake never mistakes a video for a photo to upload', () => {
  const env = makeEnv(); fastClock(env);
  env.updates = [[videoMsg(1201, 'VIDU', caption)]];
  run(env, `checkForUpdates()`);
  const key = Object.keys(env.cache).find((k) => k.startsWith('unitdraft_'));
  assert.ok(key, 'a draft starts');
  assert.deepStrictEqual(JSON.parse(env.cache[key]).images, []);
  assert.ok(!env.intakeLog.some((p) => p.action === 'photos'), 'no photo upload for a video');
});

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
