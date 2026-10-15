# PHC Agent Training (new, in the Speak Like a Leader house style)

Redesign of `PHC_Agent_Training_v4.html` (Nick, 2026-09-30). v3 stays the live training until Nick approves this one.
Style and behaviour follow the house style in `~/.claude/skills/speak-like-an-advisor/references/house-style.md`.

## What's here
- Levels (2026-09-30): Foundation (v4 lessons 1–4 + "coming soon" 5), Professional Presence (6 lessons adapted from
  Speak Like a Leader for PHC clients: calm, introduce yourself, slow down, silence, sound certain, say less), Tough Calls
  (6 decisions, `review: true`: answers drafted from v4's rules, Nick to confirm PHC policy), then Client & Advisory Skills, Advanced Advisory, Operations & Tools (channels), Performance
  (ends with Graduation). 33 steps, all playable (2026-10-01: lessons 5 to 21 written from v3's English, house style); step 1 is the PHC front door.
- Picture questions: `pics[{after: sectionIndex, prompt, options[{svg, cap}], answer, why}]` or `kind:"floors"` (tap the
  floors a foreigner can own). Drawings in `AT_ILL`; `sla:<key>:<a|b>` reuses Speak Like a Leader drawings.
- Decisions: `decision{situation, svg, steps[{prompt, options[{t, v: best|risky|wrong, result}]}], principle}`:
  intro (picture + situation) → one card per step (pick, see what happens) → the PHC way → stars for best picks.
- `index.html`: the whole app (HTML + CSS + JS, no build step). Started from the Speak Like a Leader engine; edit this
  file directly now. Content lives in `const TRAINING = {...}` (JSON): `weeks`, and 33 `lessons` (`stub: true` = "Coming soon", none left;
  the engine still supports it). English only for now; Khmer comes later (v3 has a full Khmer translation).
- Lesson shape (from v4): `objectives`, `sections[]` (label, heading, body HTML, optional dataTitle/data, table, calc,
  analogy, warning, diagrams ["floors","quota"], before/now, rules[{title,detail,action}]), `roleplay` (scenario,
  instructions, `turns[{client:[…], agent:"line with *stress* ‧‧‧ pauses ↘"}]`, note, debrief), `quiz[]`
  ({q, opts, correct, explain}), `reflection`.
- A lesson plays as cards (`lessonCards`): intro → per section: section card, "Which is the PHC way?" (before/now),
  one card per rule → practice the conversation (client line, model line, record, compare) → debrief → quiz →
  your words (saved in `state.refl`) → done with 1–3 stars.
- "Coming soon" steps (`stub`) never block the climb (audit 2026-09-30): `MTN.now` = next playable lesson (Continue, the
  pulsing step), `MTN.edge` = where the flag stands (`now`, or the first unfinished step after your last finished one);
  `climb()` counts only playable lessons, so ranks advance; `playUnlock` walks past stubs; stub nodes are dashed (`.soon`).
- Backups are `app:'phc-agent-training'` (files from Speak Like a Leader are refused). Settings "Test" plays `at0-t0`.
- Section extras (v3 shapes): `box{title,lines}`, `flow[{title,sub}]` (numbered steps), `grid[[title,text]]` (cards),
  `bars{title,bars[{label,valueLabel,pct,dim}]}`, plus `table`, `calc`, `warning`, `analogy`, `data`. A section's
  `before`/`now` pair can carry `pairWhy` (the verdict text). Rules may omit `action` (no "Do this" box). Roleplay turns may
  have `who:"Nick"` (manager voice bm_george, "N" avatar) and the roleplay a `context` line for the intro card.
- Facts (Nick, 2026-10-01): foreigners can't hold the ground floor (or land) IN THEIR OWN NAME; legal routes exist (licensed
  trust company, land-holding company at least 51% Cambodian). Never write "never" for this. Nominees: PHC never arranges.
- Consistent numbers across lessons: net yield "5 to 7%"; $150K / $800 example = 6.4% gross, 4.7% after management and
  rental tax ($593 a month), 3.8% after vacancy; J Tower 2's 6.85% a year is total return (rent plus growth), not net yield.
  J Tower 3 is 3-bedroom, over $330K: don't recommend it for budgets near $200K.
- Text style: sentence case for titles and section labels; no "Rule 1:" / "Step 1:" prefixes (the card shows "1 of 3").
- Home: a glass high-rise (`mtnModel` builds the route up the facade, `mtnArt` draws the city, the tower, lit windows
  for finished weeks, mist above your level). Weeks = levels (`UNIT_DEF`, `CAMPS`, floors in `ALTS`), rooftop =
  "PHC Certified" (`RANKS`).
- `audio/` + `audio/manifest.js`: Kokoro voice clips (coach af_heart, client am_fenrir, model am_michael).
  Regenerate after any text change: `"~/Desktop/Speak Like A Leader/tools/.venv/bin/python" agent-training/tools/make_voice.py`
  (only changed lines are remade).
- `sw.js`: offline copy, scoped to this folder, caches named `phcat-*` (never touches other tools' caches).
- Storage: localStorage `phc-training-v1`, IndexedDB `phc-training` (same origin as other PHC tools and Speak Like a
  Leader, so the names must stay distinct). The PHC password gate uses the shared `phc_agent_auth` session key.

## Writing and voice rules (Nick, 2026-09-30)
- No dashes in content (use . , : or "to" for ranges). Abbreviations written out on first use in a card.
- `tools/make_voice.py` runs every line through `speakable()` (money, %, sqm, years, 1BR, SPA/CGT/REAKH) before the
  voice, so "$1,000" is read "one thousand dollars". Type: Spectral for titles and spoken lines, Inter for reading.
- Market source (2026-10-01): Realestate.com.kh "Cambodia Condo Investment Guide 2026" (3rd edition, the .pptx in this
  folder; keep it out of git). Used for: district buy prices and rents, buyer mix (22% Cambodian), supply (64,000 units
  in 2025), Q1 2026 launches (Time Square 9 and 11 done 2029, G.A.T.O done 2030), taxes (CGT 20% postponed until the end
  of 2026; rental tax 14% non-resident / 10% resident; property tax 0.1% of 80% of value above $25K; transfer 4%), the
  J Tower 2 case (3 years construction + 2 years rent), Trust Law 2019 (1,700+ trusts by 2025), developer "guaranteed
  rental return" contracts (an agent never promises a return; show the developer's terms).
- Still unverified (not in the report): PHC project prices per sqm (Time Square 8/9/10, Peninsula), J Tower 3 and G.A.T.O
  prices, Le Condé / Royal Platinum "from" prices, the "5 to 7% net" yield range, and lead routing (Monika, Reza, Nick).

## Not done yet
- Khmer (text from v3; audio needs recordings, Kokoro has no Khmer voice),
  certificate at graduation, team progress to the PHC CRM sheet, and a link from the PHC Tools hub.
