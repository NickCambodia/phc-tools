#!/usr/bin/env python3
"""Voice clips for PHC Agent Training: free, offline Kokoro voices (the same engine as Speak Like a Leader).

Run on the Mac that has the Speak Like a Leader voice tools:
    "~/Desktop/Speak Like A Leader/tools/.venv/bin/python" agent-training/tools/make_voice.py

It reads TRAINING and COACH_FX from agent-training/index.html and writes agent-training/audio/*.m4a plus
audio/manifest.js. Only changed lines are regenerated; clips for removed lines are deleted.
Cast: the coach reads cards and quizzes (af_heart), the client speaks the client's lines (am_fenrir), and your
model lines use the lesson voice (am_michael, a little slower). Set SLA_DIR if Speak Like a Leader lives elsewhere.
"""
import hashlib, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); OUT = os.path.join(ROOT, "audio")
SLA_DIR = os.environ.get("SLA_DIR", os.path.expanduser("~/Desktop/Speak Like A Leader"))
sys.path.insert(0, os.path.join(SLA_DIR, "tools"))
import make_voice as mv   # Kokoro engine, pauses, loudness and the 150 ms lead-in

YOU, COACH, CLIENT, NICK = ("am_michael", 0.92), ("af_heart", 1.0), ("am_fenrir", 1.0), ("bm_george", 1.0)   # NICK: the manager in review roleplays

# ---- say numbers the way people do: "$1,000" is "one thousand dollars", not "dollar one thousand" ----
_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
def words(n):
    n = int(n)
    if n < 20: return _ONES[n]
    if n < 100: return _TENS[n // 10] + ("-" + _ONES[n % 10] if n % 10 else "")
    if n < 1000: return _ONES[n // 100] + " hundred" + (" and " + words(n % 100) if n % 100 else "")
    for size, name in ((10**9, "billion"), (10**6, "million"), (1000, "thousand")):
        if n >= size: return words(n // size) + " " + name + ((" and " if n % size < 100 else " ") + words(n % size) if n % size else "")
def number(txt):
    txt = txt.replace(",", "")
    if "." in txt:
        i, d = txt.split("."); return words(i) + " point " + " ".join(_ONES[int(c)] for c in d)
    return words(txt)
def speakable(t):
    t = t.replace("–", " to ").replace("&", " and ").replace("G.A.T.O", "Gato").replace("~", "about ")
    def money(m):
        v = float(m.group(1).replace(",", "")) * {"K": 1000, "k": 1000, "M": 1000000}.get(m.group(2) or "", 1)
        return (number(f"{v:g}") if v != int(v) else words(v)) + " dollars"
    t = re.sub(r"\$([\d,]*\d(?:\.\d+)?)([KkM])?(?![A-Za-z])", money, t)
    t = re.sub(r"/sqm\b", " per square meter", t); t = re.sub(r"\bper sqm\b", "per square meter", t); t = re.sub(r"\bsqm\b", "square meters", t)
    t = re.sub(r"(\d+(?:\.\d+)?)\s?%", lambda m: number(m.group(1)) + " percent", t)
    t = re.sub(r"/yr\b", " a year", t)
    t = re.sub(r"\b([1-4])BR\b", lambda m: words(m.group(1)) + "-bedroom", t)
    t = re.sub(r"(?<![\d,$])\b(19|20)(\d\d)\b(?!,\d)", lambda m: words(m.group(1)) + " " + (words(m.group(2)) if m.group(2) != "00" else "hundred") if int(m.group(2)) >= 10 else words(m.group(1) + m.group(2)), t)
    t = re.sub(r"\b(\d{1,3}(?:,\d{3})+|\d+)\+", lambda m: number(m.group(1)) + " plus", t)
    t = re.sub(r"\bSPA\b", "S P A", t); t = re.sub(r"\bCGT\b", "C G T", t); t = re.sub(r"\bREAKH\b", "Realestate dot com dot K H", t)
    return re.sub(r"\s+", " ", t).strip()
plain = lambda h: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h)).strip()
dot = lambda t: t if re.search(r'[.?!"”]$', t.strip()) else t.strip() + "."

def block(src, name):
    i = src.index(name) + len(name)
    return json.JSONDecoder().raw_decode(src, i)[0]

def jobs():
    src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    T, FX, out = block(src, "const TRAINING = "), block(src, "const COACH_FX = "), []
    add = lambda lid, v, text: out.append((lid, v[0], v[1], text))
    for k, v in FX.items(): add(f"c-fx-{k}", COACH, v)
    for i, l in enumerate(T["lessons"]):
        if l.get("stub"): continue
        if l.get("decision"):   # a tough call: situation, choices, what happens, the PHC way
            d = l["decision"]; add(f"c-at{i}-intro", COACH, f"{dot(l['title'])} {d['situation']}")
            for k, x in enumerate(d["steps"]):
                add(f"c-dc{i}-s{k}", COACH, dot(x["prompt"]) + " " + " Or: ".join(dot(o["t"]) for o in x["options"]))
                for n, o in enumerate(x["options"]): add(f"c-dc{i}-s{k}-o{n}", COACH, o["result"])
            add(f"c-dc{i}-pr", COACH, "The PHC way: " + d["principle"]); continue
        add(f"c-at{i}-intro", COACH, f"{dot(l['title'])} In this lesson: " + " ".join(dot(o) for o in l["objectives"]))
        for k, p in enumerate(l.get("pics", [])):
            add(f"c-at{i}-pq{k}", COACH, p["prompt"]); add(f"c-at{i}-pq{k}-why", COACH, p["why"])
        pk = 0
        for k, x in enumerate(l["sections"]):
            add(f"c-at{i}-s{k}", COACH, dot(plain(x["heading"])) + " " + plain(x["body"]))
            if x.get("before") and x.get("now"):
                add(f"c-lesson{i}-ask" if pk == 0 else f"c-lesson{i}-p{pk}-ask", COACH, dot(x["heading"]) + " Which is the PHC way?")
                add(f"qz{i}-a", COACH, x["before"]["text"]); add(f"qz{i}-b", COACH, x["now"]["text"])
                add(f"c-lesson{i}-p{pk}-note", COACH, x.get("pairWhy") or (x["rules"][0]["detail"] if x.get("rules") else plain(x["body"]))); pk += 1
            for j, r in enumerate(x.get("rules", [])):
                add(f"c-at{i}-s{k}-r{j}", COACH, f"{dot(r['title'])} {r['detail']}" + (f" Do this: {r['action']}" if r.get("action") else ""))
        rp = l["roleplay"]
        w = next((t for t in rp["turns"] if t["client"]), None)   # same wording as rpHow() in index.html
        how = rp.get("context") or ("Hear the model line, then say it yourself." if not w else f"You're the agent. Hear {w.get('who') or 'the client'}, hear the model answer, then say it yourself.")
        add(f"c-at{i}-rp", COACH, dot(rp["scenario"]) + " " + how)
        for j, tn in enumerate(rp["turns"]):
            for m, c in enumerate(tn["client"]): add(f"at{i}-t{j}-c{m}", NICK if tn.get("who") == "Nick" else CLIENT, c)
            add(f"at{i}-t{j}", YOU, tn["agent"])
        add(f"c-at{i}-db", COACH, dot(rp["note"]) + " " + rp["debrief"])
        for k, q in enumerate(l["quiz"]):
            if q.get("type"):   # tap quizzes (pause, stress, weak words): the sentence in the lesson voice
                add(f"c-lesson{i}-q{k}", COACH, q["prompt"]); add(f"c-lesson{i}-q{k}-why", COACH, q["why"]); add(f"qz{i}-{k}-t", YOU, q["text"]); continue
            add(f"c-lesson{i}-q{k}", COACH, q["q"]); add(f"c-lesson{i}-q{k}-why", COACH, q["explain"])
            for n, o in enumerate(q["opts"]): add(f"qz{i}-{k}-o{n}", COACH, o)
        add(f"c-at{i}-rf", COACH, l["reflection"])
    return out

def main():
    os.makedirs(OUT, exist_ok=True)
    engine = mv.Kokoro()
    mf, old, manifest, made, kept = os.path.join(OUT, "manifest.js"), {}, {}, 0, 0
    if os.path.exists(mf):
        m = re.search(r"=\s*(\{.*\})\s*;?\s*$", open(mf, encoding="utf-8").read(), re.S)
        if m: old = json.loads(m.group(1))
    for lid, voice, speed, text in jobs():
        text = speakable(text)
        h = hashlib.sha1(f"kokoro|norm1|lead{mv.LEAD}|{voice}|{speed}|{mv.SHORT}|{mv.LONG}|{text}".encode()).hexdigest()[:12]
        fn = f"{lid}.m4a"; path = os.path.join(OUT, fn)
        if old.get(lid, {}).get("h") == h and os.path.exists(path):
            manifest[lid] = old[lid]; kept += 1; continue
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "clip.wav"); engine.render(voice, speed, text, wav)
            subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "64000", wav, path], check=True)
        manifest[lid] = {"url": f"audio/{fn}", "voice": voice, "h": h}; made += 1
        print(f"  {lid:<18} {voice:<10} {text[:60]}")
    removed = 0
    for f in os.listdir(OUT):
        if f.endswith(".m4a") and f[:-4] not in manifest: os.remove(os.path.join(OUT, f)); removed += 1
    with open(mf, "w", encoding="utf-8") as fh:
        fh.write("// Generated by tools/make_voice.py. Do not edit by hand.\nwindow.AUDIO_FILES = " + json.dumps(manifest, indent=0, ensure_ascii=False) + ";\n")
    print(f"Done (kokoro): {made} generated, {kept} unchanged, {removed} removed, {len(manifest)} clips in audio/manifest.js")

if __name__ == "__main__":
    main()
