# CLAUDE.md — Property Hub Cambodia (PHC) Internal OS

## SESSION MEMORY

Persistent context for Nick's Cowork sessions is stored in `claude-memory/`. At the start of any new session, read `claude-memory/MEMORY.md` to load full context — video workflow, content system, style rules, and file references.

> **2026-09-13 — this folder does not exist in git history.** Checked `git log --all -- claude-memory/` and `git ls-tree HEAD claude-memory/` — both empty. It's not `.gitignore`'d either. Whatever populates it (Cowork sessions, presumably) has never committed it to this repo, so it does not sync between machines. Don't assume a session on a different machine can see anything written there on this one. If this is meant to be a real shared resource, it needs to actually be committed at some point — right now it's aspirational text pointing at nothing.

---

## WHO WE ARE

**Company:** Property Hub Cambodia (PHC) — premium multilingual real estate advisory, BKK1 Phnom Penh  
**Website:** https://propertyhubcambodia.com  
**Team (internal):** Nick (CEO) · Monika (Co-Founder, Japanese/Russian/EN market) · Reza (Co-Founder, European/German market)
**Team (website/public):** Monika (CEO, EN/KH) · Reza (Co-Founder, DE/EU) · Leif (Partner, Marketing & Content, EN) · Nick (Advisor, JP/EN — temporary, while employed at Realestate.com.kh; see phc-website/CLAUDE.md Key Decisions Log)
*Note: Different team structures are intentional — do not "correct" the website to match internal roles.*  
**Main line:** 011 666 952 · t.me/PropertyHubCambodia
**Email:** invest@propertyhubcambodia.com
**Office:** Time Square 5, St. 306, BKK1, Phnom Penh, Cambodia

**7 buyer segments:** English/Western · Japanese · German/European · Russian · Cambodian Local · Cambodian Overseas · VIP ($500K+)

---

## TWO SEPARATE CODEBASES

| Codebase | Path | Stack | Hosting |
|----------|------|-------|---------|
| **PHC Tools** (this repo) | `~/Desktop/phc-tools/` | Single-file HTML · Vanilla JS · Google Sheets | GitHub Pages |
| **PHC Website** | `~/Desktop/phc-website/` | React · Vite · TypeScript · shadcn-ui · Tailwind · Supabase | Vercel |

This CLAUDE.md is for **PHC Tools** only.  
The website has its own CLAUDE.md at `~/Desktop/phc-website/CLAUDE.md`.

---

## PHC TOOLS — OVERVIEW

**Rule:** Every tool is a single self-contained `.html` file. No frameworks. No build step. Google Fonts CDN is the only external resource.

**Repo:** narithkgame2/phc-tools  
**Live hub:** https://narithkgame2.github.io/phc-tools/  
**Mirror repo:** NickCambodia/phc-tools (manual fork — sync via "Sync fork" on GitHub when ready)  
**Mirror live hub:** https://nickcambodia.github.io/phc-tools/  
**Local path:** /Users/narithk/Desktop/phc-tools/

### File Inventory

| File | Status | Live URL |
|------|--------|----------|
| `index.html` | ✅ Live | /phc-tools/ |
| `PHC_Task_Manager_v4.html` | ✅ Live + Sheets | /phc-tools/PHC_Task_Manager_v4.html |
| `PHC_Lead_Tracker.html` | ✅ Live + Sheets | /phc-tools/PHC_Lead_Tracker.html |
| `PHC_Sales_Desk.html` | ✅ Live | /phc-tools/PHC_Sales_Desk.html |
| `PHC_Agent_Training_v3.html` | ✅ Live | /phc-tools/PHC_Agent_Training_v3.html |
| `PHC_Proposal_Generator.html` | ✅ Live | /phc-tools/PHC_Proposal_Generator.html |
| `PHC_Client_Manager.html` | ✅ Live | /phc-tools/PHC_Client_Manager.html |
| `PHC_Message_Builder.html` | ✅ Live | /phc-tools/PHC_Message_Builder.html |
| `PHC_Investment_Explorer.html` | ✅ Live | /phc-tools/PHC_Investment_Explorer.html |
| `PHC_Setup_Tracker.html` | ✅ Live | /phc-tools/PHC_Setup_Tracker.html |
| `PHC_Lead_Magnet.html` | ✅ Live | /phc-tools/PHC_Lead_Magnet.html |
| `PHC_Market_Intelligence_Cheat_Sheet.html` | ✅ Live | /phc-tools/PHC_Market_Intelligence_Cheat_Sheet.html |
| `PHC_CEO_Dashboard.html` | ✅ Live | /phc-tools/PHC_CEO_Dashboard.html |
| `PHC_Commission_Tracker.html` | ✅ Live | /phc-tools/PHC_Commission_Tracker.html |
| `PHC_CEO_Business_Plan.html` | ✅ Live | /phc-tools/PHC_CEO_Business_Plan.html — **the company-level roadmap/phase plan**. Redesigned July 2026 from sidebar+dense-text into System Map's cascading click-to-expand layout (5 layers, 12 clickable section nodes — same `toggle()` pattern, same password gate/session key as PHC_System_Map.html). Every node carries a freshness pill: `REFRESHED JUL 2026` (Mission Control, 90-Day Sprint) vs `Q2 DRAFT` (the other 10 sections — content unchanged since the original plan, still useful as reference but not current-state fact). Section 01's revenue/lead-count stats are still placeholders pending Nick's real numbers. |
| `PHC_System_Map.html` | ✅ Live | /phc-tools/PHC_System_Map.html — Nick's living progress tracker; update its "Focus Next" panel + node statuses whenever something ships |
| `PHC_Progress_Dashboard.html` | ✅ Live | /phc-tools/PHC_Progress_Dashboard.html — % built per System Map section (Live/Manual/Planned breakdown + overall ring). Update its `pcts` array and item lists in lockstep with PHC_System_Map.html whenever something ships. **"Live" = deployed, not finished** — add an `.item-comment` line (amber, italic) under any item that's live-but-rough/unoptimized/not-yet-in-real-use, don't just flip the dot. Ask Nick which specific PHC tools need this before marking the Team & Tools section fully polished. |
| `PHC_AppsScript.gs` | ✅ Deployed | Google Apps Script (bound to PHC CRM sheet) — also contains the Payment Reminder Bot (@PHC_ClientCare_Bot) |
| `PHC_ContentBot_AppsScript.gs` | ✅ Deployed | Google Apps Script (bound to PHC Content Queue sheet) — @PHC_Content_Bot |
| `PHC_Bridge_Script.gs` | ✅ Done | Apps Script bound to lead inquiry sheet |
| `docs/PHC_Telegram_Bots_Reference.html` | ✅ Done | Technical reference — both Telegram bots, architecture, Script Properties, gotchas |

---

## PASSWORD PROTECTION

Every tool has an inline password gate (sessionStorage — clears when browser closes).

| Level | Password | Who |
|-------|----------|-----|
| Agent | `PHC2026` | All team — Monika, Reza, Marina |
| Director | `Nick@PHC2026` | Nick only |

- Nick's director password also unlocks all agent tools automatically
- Gate check pattern (agent tools): `sessionStorage.getItem('phc_agent_auth')==='1' || sessionStorage.getItem('phc_ceo_auth')==='1'`
- Gate check pattern (director tools): `sessionStorage.getItem('phc_ceo_auth')==='1'`

---

## GOOGLE SHEETS DATABASE

**Spreadsheet name:** PHC CRM  
**Spreadsheet ID:** `1XAfvcbv86E2PgGInaYVr2c9QTOLIFHfDEYFLkRPAjHw`  
**URL:** https://docs.google.com/spreadsheets/d/1XAfvcbv86E2PgGInaYVr2c9QTOLIFHfDEYFLkRPAjHw/

### Tab schemas

**Tasks** (Task Manager v4)
`id, name, status, priority, category, due, assignees, memo, link, createdAt, updatedAt`

**Leads** (Lead Tracker)
`id, createdAt, updatedAt, fullName, nationality, phone, telegram, email, source, budget, timeline, interestedIn, stage, score, agent, notes, lastContact, followUpDate, followUpAction, activities, languages, unitType`

> **Note:** `telegram` was added after the initial schema. Run `migrateLeadsSchema()` once in Apps Script to add this column to an existing Leads sheet without losing data. `languages` (free text, e.g. "EN, DE") and `unitType` (Studio/1BR/2BR/3BR/4BR+/Villa/Penthouse/Land/Commercial) were added 2026-09-11 the same way — no migration function was needed since both are plain new columns the Apps Script `insert`/`update` handlers pass through automatically via `Object.assign`.

**Clients**
`id, createdAt, updatedAt, name, nat, telegram, phone, project, unit, floor, bookingDate, spa, titleStatus, payDay, payAmount, payTotal, payMade, bank, status, notes`

**Deals** (Commission Tracker — run `initializeAll()` if tab missing)
`id, createdAt, updatedAt, closedDate, clientName, project, unit, salePrice, commissionRate, commissionTotal, nickPct, monikaPct, rezaPct, nickAmt, monikaAmt, rezaAmt, agent, notes`

---

## APPS SCRIPT API (PHC_AppsScript.gs)

**Web App URL:** `https://script.google.com/macros/s/AKfycbzlAxcJqEI3upZ18sm-mj2Gxd3w2XSkD_YYqgkZ4kdw2_AV3V8f2B4qVcPESHZTOq2k8Q/exec`  
**Settings:** Execute as Me · Anyone can access  
**CORS strategy:** POST uses `mode:'no-cors'` + `Content-Type: text/plain` (avoids preflight; response is opaque — do not try to read it)

```
GET  ?action=ping                       → { ok: true, ts: "..." }
GET  ?action=getAll&sheet=Tasks         → [ ...row objects ]
GET  ?action=getAll&sheet=Leads         → [ ...row objects ]
GET  ?action=getAll&sheet=Clients       → [ ...row objects ]
GET  ?action=getAll&sheet=Deals         → [ ...row objects ]

POST { action: "insert", sheet: "Leads", data: { id, ... } }      → { success: true, id }
POST { action: "update", sheet: "Clients", id: "...", data: {} }   → { success: true }
POST { action: "delete", sheet: "Deals", id: "..." }               → { success: true }
```

```javascript
// GET — reads are fine, response is JSON
const res = await fetch(API_URL + '?action=getAll&sheet=Leads');
const leads = await res.json();

// POST — writes use no-cors; NEVER call .json() on the response
await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },  // MUST be text/plain
  body: JSON.stringify({ action: 'insert', sheet: 'Leads', data: leadObject }),
  mode: 'no-cors'  // MUST be no-cors
});
```

### Apps Script setup (when redeploying)
1. Open PHC CRM sheet → Extensions → Apps Script → paste full `PHC_AppsScript.gs`
2. Run `initializeAll()` once — creates/formats all 4 tabs
3. Deploy → New Deployment → Web App → Execute as Me · Anyone → copy URL

---

## TASK MANAGER v4 — ARCHITECTURE

**File:** `PHC_Task_Manager_v4.html`

### localStorage keys
```javascript
const LS_API   = 'phc_tasks_api';    // Web App URL (DEFAULT_API pre-baked)
const LS_CACHE = 'phc_tasks_cache';  // Task array JSON cache
const LS_DOCS  = 'phc_tasks_docs';   // Doc tab notes, keyed by nav section
```

### Data shape mapping (CRITICAL — never mix these)
Sheets stores `priority` + `category`. JS object uses `pri` + `cat`.

```javascript
function taskToRow(t) {          // JS → Sheets
  return { ..., priority: t.pri, category: t.cat, assignees: t.assignees.join(',') };
}
function rowToTask(row) {        // Sheets → JS
  return { ..., pri: row.priority, cat: row.category, assignees: row.assignees.split(',').filter(Boolean) };
}
```

### Task ID rule (CRITICAL)
New tasks: `'T' + Date.now()` — string with letter prefix.  
**Always quote IDs in event handlers:**
```javascript
onclick="openEditModal('${t.id}')"    // CORRECT
onclick="openEditModal(${t.id})"      // WRONG — breaks on T-prefixed IDs
```
This applies everywhere: `openEditModal`, `toggleDone`, `cycleStatus`, `deleteTask`, `onDragStart`, `schedDragStart`.

### Views
- **List** — grouped by status (Overdue → In Progress → Review → To Do → Done → Stuck)
- **Board** — Kanban drag & drop
- **Schedule** — calendar month view, drag chips to reschedule
- **Doc** — rich text notepad per nav section, persisted to `LS_DOCS`

### Values
- **Priority:** `urgent` / `high` / `normal`
- **Status:** `To Do` / `In Progress` / `Review` / `Done` / `Stuck`
- **Category:** `Sales & Listings` / `Content & Marketing` / `Admin & Operations` / `Training` / `Japanese Market`
- **Assignees:** `N` (Nick) · `M` (Monika) · `R` (Reza) · `Ma` (Marina/Support & Content). Legacy code `Me` (formerly Mey) still resolves in the UI, relabeled to Marina — she absorbed Content responsibilities after Mey's departure — but is no longer offered for new tasks.

---

## LEAD TRACKER v3 — ARCHITECTURE

**File:** `PHC_Lead_Tracker.html`  
**localStorage:** `phc_api_v3` (URL), `phc_leads_v3` (cache)

**Stage flow:** `New Lead → Contacted → Viewing → Negotiating → Closed → Hold → Released`

**Lead scoring:**
```
Score = Math.round((nationalityScore + budgetScore + timelineScore) / 3)
VIP=5, A=4, B=3, C≤2

Nationality: Japanese=5, German=4, Singaporean=4, British=3, Cambodian=3, Russian=3, Chinese=3, Other=2
Budget:      $500K+=5, $300K-500K=4, $200K-300K=3, $100K-200K=2, Under $100K=1
Timeline:    0-3m=5, 3-6m=4, 6-12m=2, 12+m=1
```

**Convert Lead → Client:** When stage = Closed, a "→ Convert to Client" button appears in the drawer. Clicking saves `phc_convert_pending` to localStorage and opens Client Manager in a new tab, which pre-fills the new client modal.

**Needs Assignment (added 2026-09-11):** A lead is "unassigned" when `!l.agent || !AGENT_AV[l.agent]` (helper: `needsAssignment(l)`) — covers both a blank agent and a stale/invalid value like the Bridge Script's old `'N'` placeholder (see Bridge Script note below). `isUnassignedActive(l)` adds `stage!=='Closed'&&stage!=='Released'` so old closed deals never get flagged. Unassigned active leads: render with a dashed amber `.k-card-flag` border and a "Suggest {agent}" footer (checkmark = `confirmAssignment(id)`, which sets `l.agent` to `autoAssign(l.nationality)`'s result and logs a `System` activity; the "⋯" reassign button just opens the drawer so a human picks manually from the existing Agent dropdown — nothing is auto-assigned without an explicit click). Surfaced via a sidebar nav item ("Needs Assignment", mirrors the "Overdue" pattern, `stageFilter='__needsassign__'`), a banner, and a live sidebar count. The suggestion logic itself is just `autoAssign()` — no separate routing rules were added.

**Activity Timeline — system vs. real entries:** Auto-generated activity log entries (stage change, follow-up set, agent confirmed) use `type:'System'` and render as a compact grouped line at the bottom of the timeline, separate from real manually-logged entries (WhatsApp/Call/Email/etc., which render as cards with hover-revealed edit/delete). Before 2026-09-11 these auto-entries used `type:'Note'`, which collided with the manual "Note" activity type — if you ever see old data with `type:'Note'` that reads like "Stage: X to Y" or "Follow-up set: ...", it's legacy system noise, not a real note. The Log Activity input is a `<textarea>` (`.act-ta`), not a single-line `<input>` — Enter inserts a newline, Ctrl/Cmd+Enter submits.

---

## CLIENT MANAGER — ARCHITECTURE

**File:** `PHC_Client_Manager.html`  
**localStorage:** `phc_clients_cache`, `phc_clients_api`

**Nationality codes:** `JP=Japanese, DE=German/European, EN=English/Western, RU=Russian, KH=Cambodian, CN=Chinese`

**Payment day clamping:**
```javascript
function clampPayDay(y, m, d) { return Math.min(d, new Date(y, m+1, 0).getDate()); }
```

---

## COMMISSION TRACKER — ARCHITECTURE

**File:** `PHC_Commission_Tracker.html`  
**Requires:** Deals tab in PHC CRM sheet — run `initializeAll()` in Apps Script if missing

**Commission calculation:**
```javascript
commissionTotal = salePrice * (commissionRate / 100)
nickAmt  = commissionTotal * (nickPct  / 100)
monikaAmt = commissionTotal * (monikaPct / 100)
rezaAmt  = commissionTotal * (rezaPct  / 100)
// nickPct + monikaPct + rezaPct must = 100 (validated before save)
```

**Deal IDs:** `'D' + Date.now()`

---

## BRIDGE SCRIPT — LEAD INQUIRY SHEET → PHC CRM

**File:** `PHC_Bridge_Script.gs`  
**Lead inquiry sheet ID:** `1-YtoUwEp-dQfMsl7AHbM1rbaG5rwUpPu9QheLEsyOKI`

- Run `setupTrigger()` once — installs onChange trigger
- Run `syncAllToPHC()` — backfills all existing rows (safe to re-run)
- Bridge IDs are prefixed `B-` (e.g. `B-L-20260202-192549`)
- **Fixed 2026-09-11:** `rowToLead()` used to default a blank Agent Assigned column to the literal string `'N'`, which doesn't match any real agent — Lead Tracker would then silently render it as "Nick" (first `<option>` in an unmatched `<select>`) with nobody having actually decided that. It now defaults to `''` instead, so a bridged lead with no agent typed in the source sheet shows up in Lead Tracker's Needs Assignment queue for a human to confirm. **This requires you to paste the updated file into the Apps Script editor bound to the lead inquiry sheet and redeploy — it does not update itself.**

---

## DESIGN SYSTEM

```css
--navy:       #083467   /* content-area buttons, headers, primary CTA */
--gold:       #cc9d4d   /* accents, hover, badges (light/content areas) */
--gold-light: #e8c47a
--gold-pale:  #fdf3e3
--cream:      #fdf8f0
--g1:         #f5f6f8   /* page background */
--g2:         #e8ecf2   /* borders */
--g3:         #c0c8d4
--g4:         #7a8799   /* secondary text */
--text:       #1a2535
--red:        #d63031
--green:      #00b894
--orange:     #e17055
```

**Fonts:** DM Sans (UI) · DM Serif Display (hero only) · DM Mono (labels/numbers)

### Sidebar shell (standard for every new tool — as of 2026-07-17)

Every tool now uses a persistent left sidebar + main content area, not a topbar-only
layout. The sidebar's colors are pulled directly from the **live website's** actual
dark theme (`propertyhubcambodia.com`'s `src/index.css` HSL tokens), not the light
`--navy`/`--gold` above — the sidebar is deliberately darker/moodier to match the
site's real brand feel, while the main content area stays light for data readability.

```css
--sb:          #0F192E   /* sidebar background */
--sb-deep:     #091120   /* logo text color, darkest shade */
--sb-hover:    rgba(255,255,255,.06)
--sb-active:   rgba(192,154,89,.16)   /* active nav item background */
--sb-text:     rgba(245,243,240,.65) /* default nav item text */
--sb-text-s:   #F5F3F0   /* strong/hover text, tool name */
--sb-icon:     rgba(245,243,240,.4)  /* icons, sub-labels, footer text */
--sb-border:   rgba(255,255,255,.08)
--sb-gold:     #C09A59   /* logo background, active nav accent */
--sb-gold-light: #D9BD8C /* active nav text/icon color */
```

**Structure:** `.app` (flex row) → `.sidebar` (fixed width, collapsible to 52px) +
`.main` (flex column: `.topbar` breadcrumb → `.toolbar` filters/actions →
scrollable content).

**Sidebar contents, top to bottom:**
1. `.ws-header` — logo (gold bg, `--sb-deep` text, 28×28px rounded square) + tool
   identity (`ws-name` = "PHC CRM", `ws-sub` = this tool's name) + collapse toggle button
2. `.sb-nav` — tool-specific nav items grouped under `.sb-section-label`s, each a
   `.sb-item` with icon + label + optional count/badge
3. "Other Tools" section — cross-links to the other CRM tools + "← Back to Hub",
   using the same icon system
4. `.sb-footer` — sync status dot + text

**Icons:** stroke-based SVG only, never emoji/unicode glyphs. `viewBox="0 0 16 16"
fill="none" stroke="currentColor" stroke-width="1.6"`, rendered at 14×14px. Reuse an
existing icon from another tool for the same concept before drawing a new one
(e.g. the people icon, the Lead Tracker grid icon, the home icon are all shared
verbatim across tools already — grep the other `.html` files for `sb-icon` before
inventing a new SVG path).

**Collapse toggle — known gotcha:** when the sidebar collapses to 52px, the logo
(28px) + header padding leaves no room for the toggle button, squeezing it off
invisibly. Every tool's collapsed-state CSS must include:
```css
.sidebar.collapsed .ws-header{padding:14px 0;justify-content:center}
.sidebar.collapsed .ws-logo{display:none}
.sidebar.collapsed .collapse-btn{transform:rotate(180deg)}
```
(in addition to the existing rule hiding `.sb-label`/`.ws-info`/`.sb-section-label`/`.sb-count`).
Verify by collapsing then re-expanding and checking the sidebar returns to its
original width — this bug shipped identically in three tools before being caught.

**Other component patterns:**
- Primary btn (on light content area): navy bg, white text
- Drawer: right panel, navy header
- Toast: navy bg, gold left border, bottom-right, 3s auto-dismiss
- Password gate: navy full-screen overlay, white card

**Stage badge colors:**
```
New Lead:    #dbeafe / #1e40af   Contacted:   #fef3c7 / #92400e
Viewing:     #d1fae5 / #065f46   Negotiating: #ede9fe / #4c1d95
Closed:      #083467 / #cc9d4d   Hold:        #f1f5f9 / #475569
Released:    #fee2e2 / #991b1b
```

---

## CODING STANDARDS

- Single-file HTML — HTML + CSS + JS all in one `.html` file
- Vanilla JS only — no React, Vue, jQuery
- Google Fonts CDN is the only allowed external resource
- `localStorage` keys always prefixed `phc_`
- New IDs: `'T' + Date.now()` (tasks) · `'D' + Date.now()` (deals) · `crypto.randomUUID()` (leads/clients)
- Timestamps: `new Date().toISOString()`
- API writes: `Content-Type: text/plain` + `mode: 'no-cors'` + `try/catch`
- API reads: plain fetch, response is a JSON array
- localStorage always used as cache/fallback
- Mobile responsive required on every tool

---

## PROJECTS REFERENCE (18 properties)

**Phnom Penh (14):**
Time Square 7 (Toul Kork) · Time Square 8 · Time Square 9 (BKK1) · Time Square 11 (BKK3) · Kingston Royale · Le Conde BKK1 · GATO Tower (BKK1) · Odom Living (Tonle Bassac) · Odom Tower (Tonle Bassac, Commercial) · UC88 Wyndham Garden · J Tower 3 (Tonle Bassac) · Diamond Bay Garden (Tonle Bassac) · Norea Square (Tonle Bassac) · Picasso Sky Gemme (BKK1)

**Siem Reap (1):** Angkor Grace
⚠️ Rose Apple Square no longer appears on the live website — may be removed. Confirm before referencing.

**Sihanoukville / Coast (2):** LZ Sea View Premium (Sangkat Buon) · Time Square 10 (Otres Beach)
⚠️ Time Square 10 is on the coast (Otres Beach), NOT in Phnom Penh.

---

## FULL SYSTEM ARCHITECTURE

### Lead Entry Points
Instagram (DMs · comments · ads) · Facebook (DMs · comments · ads) · Telegram (@PHCPropertyBot · channel · project groups) · WhatsApp 011 666 952 · Website propertyhubcambodia.com (lead form + Mailchimp) · Referral/QR

### Automation Layer
- **ManyChat** — qualification flow (budget · timeline · nationality), Lead Magnet delivery, VIP routing ($500K+ → Nick direct), Calendly site visit booking
- **Make.com** — team Telegram alerts on new lead, Mailchimp 3-email nurture (website leads), payment reminders (5 days before due), post-proposal follow-up D1/3/7, SPA checklist (24h after booking), construction milestone broadcasts, handover prep package (90 days out)

### Client Lifecycle
**Before Sale:** Lead captured → qualified → Lead Magnet → team alert → agent follow-up → site visit → proposal → D1/3/7 follow-up

**During Sale:** Booking fee → welcome → SPA checklist → payment schedule → SPA signing → project group → payment reminders

**After Sale:** Monthly reminders → project updates → milestone broadcasts → handover prep (90 days) → key collection → rental management referral

---

## CEO DASHBOARD — ARCHITECTURE

**File:** `PHC_CEO_Dashboard.html`  
Fetches Tasks + Leads + Clients in parallel. Shows: active leads, pipeline value, overdue follow-ups, overdue tasks, payments due this week, pipeline by stage, lead score breakdown, recent leads, agent breakdown.

**Budget → pipeline value mapping:**
`Under $100K→$65K, $100K-$200K→$150K, $200K-$300K→$250K, $300K-$500K→$400K, $500K+→$650K`

---

## BUILD ROADMAP

| # | Tool | Status |
|---|------|--------|
| 1 | Google Sheets connection (4 tabs) | ✅ Done |
| 2 | Task Manager v4 | ✅ Done — list/board/schedule/doc, Sheets sync |
| 3 | Lead Tracker v3 | ✅ Done — kanban, scoring, activity log, dashboard. **2026-09-11/12 additions:** Needs Assignment queue, languages/unit-type/last-updated card fields, multi-line activity log with edit/delete, 248-country phone picker + 242-nationality search. All live and pushed. |
| 4 | CEO Dashboard | ✅ Done — live morning view, pipeline, agent breakdown |
| 5 | Commission Tracker | ✅ Done — deal logging, auto-split |
| 6 | Client Manager | ✅ Done — payment schedules, SPA/title status |
| 7 | Convert Lead → Client | ✅ Done |
| 8 | Password protection | ✅ Done — PHC2026 / Nick@PHC2026 |
| 9 | Lead inquiry bridge | ✅ Done — Bridge Script syncs → PHC CRM |
| 10 | Auto-mirror to NickCambodia | 🔲 Pending — manual sync for now |
| 11 | Content Bot (@PHC_Content_Bot) | ✅ Done — polling, 6-tier format detection, EN/JP/RU/DE translation, Approve-All review. Claude API fallback tier built but inactive (payment pending). |
| 12 | Payment Reminder Bot (@PHC_ClientCare_Bot) | ⚠️ Code working, not final — confirmed in one test run only (2026-07-20). No real clients loaded into it yet, so it isn't reaching anyone day-to-day. Expect adjustments once real client data is in. Daily scan, channel-split (Telegram vs. manual), personalized + translated reminders, Approve/Reject review. |

---

## KNOWN ISSUES / GOTCHAS

1. **ID quoting** — always `'${t.id}'` in onclick, never `${t.id}` (breaks on T-prefixed string IDs)
2. **taskToRow/rowToTask** — Sheets uses `priority`/`category`; JS uses `pri`/`cat`. Always go through the converters, never access directly.
3. **Git lock files** — stale `.git/*.lock` blocks commits: `rm .git/index.lock .git/HEAD.lock`
4. **Apps Script CORS** — POST must use `Content-Type: text/plain` to avoid preflight. Never call `.json()` on a POST response.
5. **Deals tab missing** — Commission Tracker requires Deals tab. Run `initializeAll()` in Apps Script if not there.
6. **NickCambodia fork** — does NOT auto-sync. Nick must click "Sync fork" manually on GitHub.
7. **Phone numbers in Sheets** — Numbers starting with `+` interpreted as formulas. Set phone columns to Plain Text: Leads col F, Clients col G.
8. **Leads telegram column** — If Leads tab was created before telegram field, run `migrateLeadsSchema()` in Apps Script once.
9. **Bridge script IDs** — Leads from inquiry sheet get `B-` prefix IDs to prevent duplicates on re-sync.
10. **Two files named `PHC_AppsScript.gs`** — a stale duplicate lives at `~/Desktop/phc-website/PHC Website (Claude Code)/PHC_AppsScript.gs` (missing referral columns and the whole Payment Reminder Bot). Always edit the one in this repo. See `docs/PHC_Telegram_Bots_Reference.html`.
11. **Telegram chat IDs from Sheets need `normalizeChatId()`** — Sheets converts a typed numeric chat/group ID into a JS `Number`; sent raw to Telegram's API this produces a silent `400 "chat not found"` even though the string form works. Always normalize any Sheets-sourced chat ID before calling `sendMessage`.
12. **A bot can only poll OR use a webhook, never both** — if a webhook URL is ever set, `getUpdates` polling returns empty forever regardless of real activity. Check with `getWebhookInfo` when a bot seems to receive nothing.
13. **File-mode noise after a Mac reset/restore** — a restore can flip every tracked file's executable bit (644→755) without touching content, making `git status` show hundreds of "modified" files that are actually identical. Diagnose with `git -c core.fileMode=false status --short` (if the count drops to near-zero, it's mode noise, not real edits) and fix permanently with `git config core.fileMode false`. Hit this 2026-09-11/12 on both phc-tools and phc-website after Nick's Mac was reset — 1057 "changed" files in phc-website, all but 2 were pure mode flips.
14. **Never `git add -A` without checking `git status` first** — if there's pre-existing uncommitted work sitting in the tree (someone's WIP from another session, a different machine's leftovers), `-A` silently bundles it into your commit. This repo has hit exactly this: a local checkout sat 40 commits behind origin with 88 files of stale/uncommitted local state. Stage specific files by name instead, and if you find unrelated dirty state blocking a merge, `git stash push -u -m "<description>"` it rather than discarding — see the Decisions Log entry for 2026-09-11/12 for how a real recovery played out (2 of ~88 stashed files turned out to be genuine unrecovered work, not stale drafts).

---

## GIT WORKFLOW

```bash
cd /Users/narithk/Desktop/phc-tools

# Standard push — stage specific files, not -A (see Gotcha #14 above)
git add PHC_Task_Manager_v4.html
git commit -m "fix: description"
git push

# If lock files block git
rm .git/index.lock .git/HEAD.lock
```

GitHub Pages auto-deploys ~30 seconds after push.  
All tools live at: https://narithkgame2.github.io/phc-tools/

**Credential gotcha (hit 2026-09-11, likely to recur after any Mac reset):** signing into GitHub Desktop does *not* give command-line `git` push access — GitHub Desktop stores its login under its own macOS Keychain entry (`GitHub - https://api.github.com`), in a format the standard git credential helper doesn't read. Command-line `git push` will still fail with `could not read Username for 'https://github.com'` even with GitHub Desktop fully signed in. Fastest fix: just push from GitHub Desktop's own UI (it has working credentials) instead of fighting a second CLI credential setup — click the repo's "Push origin" button in its toolbar. This applies per-repo (hit it separately on both phc-tools and phc-website).

**Before pushing, always check for divergence first** — `git fetch origin && git log --oneline HEAD..origin/main | wc -l`. A local checkout can silently fall behind while other sessions/machines push (Nick works from a PC too). If it's behind, merge before pushing, and expect real conflicts on any file recently touched from both sides — check `git show --stat <remote-commit>` for the specific commits before assuming a conflict is trivial.

---

## CI + RECURRING AUDIT (added 2026-09-16)

Built after the 40-commit-drift incident above — the goal is catching drift
and regressions automatically instead of by accident.

**`.github/workflows/ci.yml`** — runs on every push/PR. **Never a required or
blocking check** — GitHub Pages keeps deploying straight off `main`
regardless of what this reports, exactly as before. Two jobs:
- `syntax-check` — extracts every tool's `<script>` content, checks it
  parses via `node --check`. Uses `.cjs`, not `.mjs`, deliberately — these
  tools ship as plain non-module `<script>` tags (sloppy-mode semantics),
  and `.mjs`'s strict-module parsing produces false positives on legal
  patterns this codebase actually uses (e.g. `PHC_Sales_Desk.html`'s
  deliberate `doSave()` monkey-patch — two same-named top-level function
  declarations, which is legal in sloppy mode, illegal in a module).
- `smoke-test` — Playwright, pinned to `1.61.0` (bump on purpose, not by
  `@latest` drift — no lockfile exists anywhere in this repo to catch that
  otherwise), loads all 19 tools in a real headless browser, bypasses the
  password gate via `sessionStorage.phc_agent_auth='1'` (same key the app
  itself checks), asserts zero console errors.
  **Non-negotiable safety requirement, already implemented and verified
  working:** several tools (Lead Tracker, Task Manager, ...) fetch the real
  production `PHC_AppsScript.gs` Web App — i.e. the live Google Sheets CRM
  — on load. `.github/scripts/smoke-test.mjs` intercepts every request to
  `script.google.com` and Google Fonts via Playwright's `page.route()` and
  returns a canned response. Verified locally (2026-09-16) that both real
  Lead Tracker calls (`getAll&sheet=Leads`, `getAll&sheet=Partners`) get
  caught by the mock, zero real requests reach Google. If you ever touch
  this file, re-verify that interception still fires before trusting it —
  a silently-broken mock would mean CI starts hitting production data on
  every push.
- Both scripts live in `.github/scripts/` and install their own tooling
  fresh inside the CI runner only (`npm install --no-save playwright@1.61.0`)
  — nothing is committed to the repo beyond the workflow + scripts
  themselves. No `package.json`, no `node_modules`, no build step added to
  the actual product. This was checked deliberately against the repo's
  "single-file HTML, no build step, no framework" rule before building —
  that rule governs the product and its deploy path, both untouched.

**Recurring audit — cloud routines** (via the `schedule` skill /
`RemoteTrigger`, not a local cron job — survives this Mac's credential
issues entirely since each firing is a fresh cloud session with its own git
clone). Two routines, `phc-tools weekly audit` and a matching one on
phc-website. Nick chose **PR-based review** for autonomy: safe/mechanical
findings (stale docs, formatting, zero business-logic risk) get a PR to
review and merge whenever convenient; anything bigger becomes a report
only. Never commits to `main` directly. See the full design rationale in
the plan this was built from if you need it:
`~/.claude/plans/majestic-imagining-moonbeam.md` (local to the Mac that
built this — may not exist on other machines; the summary here is the
durable record).

**Still open as of 2026-09-16:** branch protection (requiring CI green
before merge) was deliberately left out of this pass — it's a GitHub repo
*setting*, not a file, and needs `gh` CLI or the web UI to configure. Worth
turning on once CI has run clean a few times and it's trusted. Also: the
PR-opening capability for the cloud routines needs to be verified with a
throwaway test routine before depending on it — see the plan file.

---

## ⛔ BUILD GUARDRAILS — PHC Tools

These rules apply to every tool in this repo. Do not override without explicit instruction from Nick.

### Hard rules (never break these):
- **Single-file HTML only** — every tool is one `.html` file. No separate CSS, JS, or asset files.
- **Vanilla JS only** — no React, Vue, jQuery, or any framework. No build step.
- **Google Fonts CDN is the only external resource** — no other CDN, no external images, no external scripts.
- **Password gate on every tool** — agent tools use `PHC2026`, director tools use `Nick@PHC2026`. Never remove or weaken the gate.
- **Always use `localStorage` as cache/fallback** — tools must work offline with cached data if the API is unreachable.
- **API writes: always `Content-Type: text/plain` + `mode: 'no-cors'`** — never break this pattern or POST responses will fail silently.
- **Never call `.json()` on a POST response** — it will throw. POST responses are opaque.
- **Always quote IDs in event handlers** — `'${t.id}'` not `${t.id}` (string IDs with prefixes break unquoted).

### Approach rules (how to handle tasks):
- **Make the smallest change that works** — don't refactor surrounding code unless the task requires it.
- **Preserve existing features** — if fixing a bug, don't remove or restructure features nearby.
- **Mobile responsive is non-negotiable** — test every new UI at 390px width before finishing.
- **Don't change the Apps Script web app URL** — it's baked into every tool. If redeploying, update CLAUDE.md first.
- **Don't change password values** — only Nick decides if passwords change.
- **Don't add new tabs to PHC CRM sheet** — the 4-tab schema (Tasks, Leads, Clients, Deals) is fixed. New data types need discussion first.

### Before starting any tool task, confirm:
1. Which file are we editing? (Get the exact filename from the File Inventory above.)
2. Is this a bug fix, a feature addition, or a new tool?
3. If new tool: what data does it need, and is there already a Sheets tab for it?
4. If touching Apps Script: does the web app need redeploying after?

### Design system tokens (use these exactly — don't improvise):
```css
--navy:       #083467   /* topbar, headers, primary CTA */
--gold:       #cc9d4d   /* accents, hover, badges */
--gold-light: #e8c47a
--gold-pale:  #fdf3e3
--cream:      #fdf8f0
--g1:         #f5f6f8   /* page background */
--g2:         #e8ecf2   /* borders */
--g3:         #c0c8d4
--g4:         #7a8799   /* secondary text */
--text:       #1a2535
--red:        #d63031
--green:      #00b894
--orange:     #e17055
```
Fonts: **DM Sans** (UI) · **DM Serif Display** (hero only) · **DM Mono** (labels/numbers)

---

## DECISIONS LOG

*Add key decisions here so future sessions don't re-litigate them.*

| Date | Decision | Reason |
|------|----------|--------|
| Jun 2026 | Task Manager stays as HTML tool, not migrated to website | Single-file tools are faster to build and maintain for internal use |
| Jun 2026 | Apps Script CORS pattern (text/plain + no-cors) is permanent | Avoids preflight; changing it breaks all writes |
| Jun 2026 | No frameworks in phc-tools ever | Build step complexity not worth it for internal tools |
| 2026-07-17 | Every tool uses the sidebar shell pattern (not topbar-only), colored with the live website's actual dark navy/gold theme, not the lighter `--navy`/`--gold` used in content areas | Unifies the whole suite visually; matches PHC's real brand instead of ad-hoc purple/grey placeholders that had crept into Lead Tracker/Client Manager over time. See DESIGN SYSTEM section above for the full spec. |
| 2026-07-20 | Payment Reminder Bot is a separate bot (@PHC_ClientCare_Bot) from @PHC_Content_Bot, code added to `PHC_AppsScript.gs` rather than a new file | Nick's explicit request — this bot lives inside private client groups, kept distinct from the public listing-distribution bot. Reuses the CRM script's existing `Clients` tab rather than duplicating client data. |
| 2026-07-20 | Non-Telegram clients are never auto-sent-to or silently skipped by the Payment Reminder Bot — they're flagged by name in a separate message | Prevents duplicate reminders across platforms (some clients use WhatsApp, not Telegram) while still guaranteeing nobody is missed. |
| 2026-09-11 | PopDeal-parity work rejected Lead Pool and Daily Quota as features | Lead Tracker's existing `autoAssign()` (nationality-based routing, load-balance fallback) already solves what PopDeal's Lead Pool solves, better — a first-come claim queue would be a regression, not an upgrade. Full gap analysis lives in two artifacts published that session (not in this repo). |
| 2026-09-11/12 | This Mac's local `main` had drifted 40 commits behind origin (last real sync predates 2026-08-06) | Root cause: git credentials broke in a Mac reset, silently blocking pushes/pulls for weeks. Merged clean — 1 real conflict (favicon/logo, both sides independently fixed the same placeholder-logo problem; kept origin's version since it was already consistent across 10+ tools). **If you're reading this from a session on the PC or another machine: check `git fetch && git log --oneline HEAD..origin/main` before assuming your checkout is current — this can recur.** |
| 2026-09-12 | Dropped ~86 of ~88 files of stale uncommitted local state found on this Mac (stashed first via `git stash push -u`, never force-discarded) | Verified file-by-file: pre-rebuild snapshots of files the 40 merged commits had already substantially reworked (Message Builder, Commission Tracker, Sales Desk, etc.), or literally empty stub files. **2 files were genuine unrecovered work and are still sitting in `stash@{0}` as of this writing, not yet applied:** (1) `PHC_ContentBot_AppsScript.gs` — a price-drop "repost as new message" feature, dated 2026-08-25, explicitly because Nick disliked the old edit-in-place banner behavior; this is a live deployed script, recovering it means redeploying too. (2) `content-os/docs/ROADMAP.md` — an "Analytics-Driven Content Sourcing" initiative section dated 2026-09-03, newer than HEAD's June 2026 version. Ask Nick before touching `stash@{0}` — don't assume it's safe to drop wholesale just because most of it was. |
