import json, os, re, sys, html, unicodedata
from difflib import SequenceMatcher

SC = sys.argv[1]            # scratchpad dir
OUT = sys.argv[2]           # report path
INFO = os.path.join(SC, 'pl', 'info')
flat = json.load(open(os.path.join(SC, 'pl', 'flat.json')))
order = [e['id'] for e in flat['entries']]
flat_titles = {e['id']: e.get('title') for e in flat['entries']}

# ---------- archive ----------
TR = dict([("а","a"),("б","b"),("в","v"),("г","g"),("д","d"),("е","e"),("ё","jo"),("ж","zh"),("з","z"),("и","i"),
  ("к","k"),("л","l"),("м","m"),("н","n"),("ң","ng"),("ӊ","ng"),("о","o"),("ө","ö"),("п","p"),("р","r"),("с","s"),
  ("т","t"),("у","u"),("ү","ü"),("ф","f"),("х","kh"),("ц","ts"),("ч","ch"),("ш","sh"),("щ","sh"),
  ("ъ",""),("ы","y"),("ь",""),("э","e"),("ю","ju"),("я","ja"),("й","i")])
def fold(s):
    s = s.replace('ϴ','Ө').lower().replace('ӊ','ң')
    s = re.sub(r'\([^)]*\)|\[[^\]]*\]', ' ', s)
    s = ''.join(TR.get(c, c) for c in s)
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.replace('ŋ','ng').replace('x','kh').replace("'",'').replace('’','')
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    return s

def strip_html(h):
    if not h: return ''
    h = re.sub(r'<sup[^>]*>.*?</sup>', '', h)
    h = re.sub(r'<br\s*/?>|</p>', '\n', h)
    h = re.sub(r'<[^>]+>', '', h)
    return html.unescape(h)

songs = []   # (display name, [names...], set(folded lines))
for fn, local in (('archive_mirror.json', False), ('archive_local.json', True)):
    for s in json.load(open(os.path.join(SC, fn))):
        names = [s['name']]
        for k in ('english_name', 'alternate_titles', 'alternate_spellings'):
            if s.get(k): names += [x.strip() for x in s[k].split(',') if x.strip()]
        lines = set()
        if s.get('cyr'):
            for ln in strip_html(s['cyr']).split('\n'):
                f = fold(ln)
                if len(f) >= 8: lines.add(f)
        songs.append({'name': s['name'] + (' (local)' if local else ''), 'names': [fold(n) for n in names if fold(n)], 'lines': lines})
line_index = {}
for i, s in enumerate(songs):
    for ln in s['lines']: line_index.setdefault(ln, set()).add(i)

def sim(a, b): return SequenceMatcher(None, a, b).ratio()

# ---------- parse descriptions ----------
GENRES = ['Кожамык','Ыр','Узун ыр','Кыска ыр','Песня','Частушка','Колыбельная','Өпей ыры','Хөөмей','Сыгыт','Каргыраа']
def parse(d):
    desc = (d.get('description') or '').replace('\r','').replace('ϴ','Ө').replace('ϴ','Ө')
    paras = [p.strip() for p in re.split(r'\n\s*\n', desc) if p.strip()]
    r = {'id': d['id'], 'title': d.get('title'), 'duration': d.get('duration'), 'upload_date': d.get('upload_date'),
         'genre': None, 'tuvan_title': None, 'russian_title': None, 'performer': None, 'meta': None,
         'tuvan': [], 'russian': [], 'other': [], 'has_lyrics': False, 'genre_ru': None, 'tune_type': None}
    body = []
    for p in paras:
        if p.startswith('Проект ') and 'Российским научным фондом' in p: continue
        if r['meta'] is None and ('Исполня' in p or 'Записан' in p):
            r['meta'] = p
            first = p.split('\n')[0]
            first = re.sub(r'^\s*№\s*\d+\w?\.?\s*', '', first)
            Q = '"«»“”'
            qs = [i for i, ch in enumerate(first) if ch in Q]
            head = first[:qs[0]] if qs else first.split('.')[0]
            g = head.strip().rstrip('.').strip()
            g = re.split(r'\s+на слова|\s*\(', g)[0].strip()
            if g.startswith('Кожамык ') : g = 'Кожамык'
            if g == 'КЫры': g = 'Ыры'
            if g and not g.startswith('Исполня') and len(g) < 40: r['genre'] = g
            if len(qs) >= 2:
                r['tuvan_title'] = first[qs[0]+1:qs[1]].strip()
                rest = first[qs[1]+1:]
                sm = re.match(r'\s*/\s*([^"«»“”]*?)\s*["«“](.+?)["»”]', rest)
                if sm:
                    if sm.group(1).strip(): r['genre_ru'] = sm.group(1).strip()
                    r['russian_title'] = sm.group(2).strip()
            pm = re.search(r'Исполня\w+\s+([^.]+?)\.', p)
            if pm: r['performer'] = pm.group(1).strip()
            tm = re.search(r'Типовой напев\s*([\w.]+)', p)
            if tm: r['tune_type'] = tm.group(1).rstrip('.')
            continue
        if r['meta'] is None and ('Исполня' in p or 'Записан' in p):
            r['meta'] = p; continue
        body.append(p)
    # classify body paragraphs: Tuvan vs Russian by letters
    def is_tuvan(p):
        t = sum(p.count(c) for c in 'өүңӊӨҮҢӉ')
        if t: return True
        # Russian has lots of common Russian words
        ru = len(re.findall(r'\b(и|в|на|не|с|что|как|мой|моя|меня|мне|ты|он|она|когда|если|же|ли|по|за|от|у|из|к|о|бы|для|это|так|все|то|но|я|ах|ой)\b', p.lower()))
        words = max(1, len(p.split()))
        return ru / words < 0.08
    for p in body:
        if (re.search(r'[A-Za-z]{4,}', p) and not re.search(r'[А-яӨүӊң]', p)) or re.search(r'Тирон\s*Е\.\s*Л\.|Новосибирск|Расшифровка|Записано|Институт', p):
            r['other'].append(p); continue
        (r['tuvan'] if is_tuvan(p) else r['russian']).append(p)
    r['has_lyrics'] = bool(r['tuvan'])
    if not r['tuvan_title'] and r['tuvan']:
        r['tuvan_title'] = '[' + r['tuvan'][0].split('\n')[0].strip().rstrip(',;!.…') + ']'
    if not r['tuvan_title']:
        m = re.search(r'[«"](.+?)[»"]\s*/\s*[«"](.+?)[»"]', r['title'] or '')
        if m: r['tuvan_title'], r['russian_title'] = m.group(1), m.group(2)
        pm = re.search(r'\((?:исп\.\s*)?([^)]+)\)\s*$', r['title'] or '')
        if pm and not r['performer']: r['performer'] = pm.group(1)
    m = re.match(r'^\s*(?:№\s*)?(\d+[а-яa-z]?)\b', r['title'] or '')
    r['number'] = m.group(1) if m else None
    return r

def match(r):
    """Return list of (song name, reason, score) sorted by strength."""
    hits = {}
    tt = fold(r['tuvan_title'] or '')
    # title match
    if tt:
        for i, s in enumerate(songs):
            best = max((1.0 if (len(n) >= 8 and ' ' in n and (tt.startswith(n + ' ') or n.startswith(tt + ' '))) else sim(tt, n) for n in s['names']), default=0)
            if best >= 0.85: hits.setdefault(i, []).append(('title', best))
    # line match
    tlines = [fold(l) for p in r['tuvan'] for l in p.split('\n')]
    tlines = [l for l in tlines if len(l) >= 8]
    counts = {}
    for l in tlines:
        if l in line_index:
            for i in line_index[l]: counts[i] = counts.get(i, 0) + 1
        else:
            # fuzzy against lines sharing the first 4 chars
            for al, idxs in line_index.items():
                if al[:4] == l[:4] and sim(al, l) >= 0.88:
                    for i in idxs: counts[i] = counts.get(i, 0) + 1
    for i, c in counts.items():
        hits.setdefault(i, []).append(('lines', c))
    r['n_lines'] = len(tlines)
    out = []
    for i, rs in hits.items():
        title = max([v for k, v in rs if k == 'title'], default=0)
        n = max([v for k, v in rs if k == 'lines'], default=0)
        if title >= 0.85 or (n >= 2 and n / max(1, len(tlines)) >= 0.5): tier = 'strong'
        elif n >= 2: tier = 'partial'
        else: tier = 'weak'
        out.append({'song': songs[i]['name'], 'title': round(title, 2), 'lines': n, 'tier': tier})
    out.sort(key=lambda h: ({'strong': 0, 'partial': 1, 'weak': 2}[h['tier']], -h['lines']))
    return out

recs = []
for pos, vid in enumerate(order, 1):
    p = os.path.join(INFO, vid + '.info.json')
    if not os.path.exists(p):
        recs.append({'id': vid, 'title': flat_titles.get(vid), 'missing': True, 'pos': pos}); continue
    d = json.load(open(p))
    r = parse(d); r['pos'] = pos; r['matches'] = match(r); recs.append(r)

json.dump(recs, open(os.path.join(SC, 'parsed.json'), 'w'), ensure_ascii=False, indent=1)

# ---------- report ----------
fetched = [r for r in recs if not r.get('missing')]
with_lyrics = [r for r in fetched if r['has_lyrics']]
no_lyrics = [r for r in fetched if not r['has_lyrics']]
def tier(r): return r['matches'][0]['tier'] if r['matches'] else None
strong = [r for r in with_lyrics if tier(r) == 'strong']
partial = [r for r in with_lyrics if tier(r) == 'partial']
new = [r for r in with_lyrics if tier(r) in (None, 'weak')]
unfetched = [r for r in recs if r.get('missing')]
perf = {}
for r in new: perf[r['performer'] or '?'] = perf.get(r['performer'] or '?', 0) + 1
genre = {}
for r in new: genre[r['genre'] or '?'] = genre.get(r['genre'] or '?', 0) + 1

L = []
w = L.append
w('# Lyrics in the Institute of Philology (SB RAS) Ovyur playlist that the archive does not have\n')
w('Source: YouTube playlist [Народные песни тувинцев Овюрского района Тувы](https://www.youtube.com/playlist?list=PLudNgvipb2tmvRC5a97eiDZUopd8RWc5v), channel «Институт филологии СО РАН», project «Песенная традиция овюрских тувинцев XXI в. в условиях сельско-городской миграции» (RSF grant 22-28-01475, 2022–2023, led by E. L. Tiron). Only video descriptions were read; no videos were downloaded.\n')
w('Compared against the Mirror (%d Songs, every Version\'s Cyrillic lyrics) and the Local Songs (%d) in library.db on 2026-10-11. A video counts as **already in the archive** when its Tuvan title is close (Jaro-style ratio ≥ 0.85 after folding) to an archive Song name or alternate spelling, or when at least two of its Tuvan lines, and at least half of them, equal lines of an archive Version. A video sharing two or more lines but less than half is a **variant** and its full text is kept below. A single shared line (kozhamyk reuse stock lines) is only noted. Everything else is **new**. Matching is mechanical; the Tuvan transcriptions use ӊ for ң and sometimes ϴ for Ө, both folded before comparing.\n' % (len(json.load(open(os.path.join(SC,'archive_mirror.json')))), len(json.load(open(os.path.join(SC,'archive_local.json'))))))
w('## Summary\n')
w('| | Count |\n|---|---|')
w('| Videos in playlist | %d |' % len(order))
w('| Descriptions fetched | %d |' % len(fetched))
w('| With Tuvan lyrics in the description | %d |' % len(with_lyrics))
w('| Already in the archive (title match, or at least half the lines) | %d |' % len(strong))
w('| Variant of an archive song (some shared lines, mostly new text) | %d |' % len(partial))
w('| **New lyrics, not in the archive** | **%d** |' % len(new))
w('| No lyrics in the description | %d |' % len(no_lyrics))
if unfetched: w('| Could not fetch | %d |' % len(unfetched))
w('')
w('New lyrics by genre: ' + ', '.join('%s %d' % kv for kv in sorted(genre.items(), key=lambda x: -x[1])) + '\n')
w('New lyrics by performer:\n')
for k, v in sorted(perf.items(), key=lambda x: -x[1]): w('- %s — %d' % (k, v))
w('')
def entry(r, show_lyrics=True):
    hd = '#%d · %s' % (r['pos'], r['tuvan_title'] or r['title'])
    if r['russian_title']: hd += ' / %s' % r['russian_title']
    w('### ' + hd + '\n')
    bits = []
    if r['genre']: bits.append(r['genre'] + (' (%s)' % r['genre_ru'] if r.get('genre_ru') else ''))
    if r['performer']: bits.append('performer: ' + r['performer'])
    if r.get('tune_type'): bits.append('tune type ' + r['tune_type'])
    if r['duration']: bits.append('%d:%02d' % divmod(int(r['duration']), 60))
    bits.append('[youtube.com/watch?v=%s](https://www.youtube.com/watch?v=%s)' % (r['id'], r['id']))
    w(' · '.join(bits) + '\n')
    if r['meta']:
        m = r['meta']
        m = re.sub(r'^.*?Исполня', 'Исполня', m, count=1, flags=re.S)
        w('> ' + m.replace('\n', ' ') + '\n')
    for h in r['matches']:
        w('> Archive: %s — %s (%s)\n' % ({'strong': 'matches', 'partial': 'shares %d of %d lines with' % (h['lines'], r['n_lines']), 'weak': 'shares 1 line with'}[h['tier']], h['song'], 'title %.2f, %d/%d lines' % (h['title'], h['lines'], r['n_lines'])))
    if not show_lyrics: return
    w('**Tuvan text**\n')
    for p in r['tuvan']: w('\n'.join(l.rstrip() + '  ' for l in p.split('\n')) + '\n')
    if r['russian']:
        w('**Russian translation**\n')
        for p in r['russian']: w('\n'.join(l.rstrip() + '  ' for l in p.split('\n')) + '\n')
    for p in r['other']: w('_' + p.replace('\n', ' ') + '_\n')

if strong:
    w('## Already in the archive (%d)\n' % len(strong))
    w('Matched by title or by most lines; verify by hand before dismissing. Lyrics not repeated here.\n')
    w('| # | Video | Archive Song | Evidence |\n|---|---|---|---|')
    for r in strong:
        h = r['matches'][0]
        w('| %d | [%s](https://www.youtube.com/watch?v=%s) | %s | title %.2f, %d/%d lines |' % (r['pos'], (r['tuvan_title'] or r['title'] or '').replace('|','/'), r['id'], ' / '.join(x['song'] for x in r['matches'] if x['tier']=='strong'), h['title'], h['lines'], r['n_lines']))
    w('')
if no_lyrics:
    w('## Videos without lyrics in the description (%d)\n' % len(no_lyrics))
    for r in no_lyrics: w('- #%d [%s](https://www.youtube.com/watch?v=%s)' % (r['pos'], r['title'], r['id']))
    w('')
if unfetched:
    w('## Could not fetch (%d)\n' % len(unfetched))
    for r in unfetched: w('- #%d [%s](https://www.youtube.com/watch?v=%s) — private video' % (r['pos'], r['title'] or r['id'], r['id']))
    w('')
w('## New lyrics (%d)\n' % len(new))
w('In playlist order (# is the position in the playlist). Each entry gives the Tuvan text as transcribed in the description, then the Russian translation from the description. The quoted recording note is the description\'s own.\n')
for r in new: entry(r)
if partial:
    w('## Variants of archive songs (%d)\n' % len(partial))
    w('These share some lines with an archive Version but most of the text is different, so the full text is kept.\n')
    for r in partial: entry(r)
open(OUT, 'w').write('\n'.join(L))
print('fetched', len(fetched), 'lyrics', len(with_lyrics), 'strong', len(strong), 'partial', len(partial), 'new', len(new), 'nolyrics', len(no_lyrics), 'unfetched', len(unfetched))
