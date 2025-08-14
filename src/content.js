// Brightspace Helper – Phase 1+2 (UNG)
// Phase 1: Hover a course card -> show current grade
// Phase 2: Also show upcoming items from Calendar List view (course-filtered), with correct status labels.

(function () {
  // ===== Config / state =====
  const CFG = {
    gradesPath: (ou) => `/d2l/lms/grades/my_grades/main.d2l?ou=${encodeURIComponent(ou)}`,
    labels: ["Final Calculated Grade", "Final Adjusted Grade", "Current Grade"],
    gradeCacheMinutes: 30,
    upcomingCacheMinutes: 10,
    maxUpcoming: 3
  };

  const gradeCache    = new Map(); // ou -> { value, ts }
  const upcomingCache = new Map(); // ou -> { items[], ts }

  // ===== Tooltip =====
  const tip = (() => {
    let el;
    function ensure() {
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = `
          position:absolute;z-index:2147483647;padding:8px 10px;border-radius:8px;
          background:rgba(20,22,30,.95);color:#fff;border:1px solid rgba(255,255,255,.08);
          box-shadow:0 6px 20px rgba(0,0,0,.25);display:none;
          max-width: 360px; word-break: break-word;
          font:600 12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,Arial,sans-serif;`;
        document.documentElement.appendChild(el);
      }
      return el;
    }
    function show(target, html) {
      const t = ensure();
      t.innerHTML = html;
      t.style.display = 'block';
      const w = target.ownerDocument.defaultView || window;
      const r = target.getBoundingClientRect();
      t.style.top  = Math.max(0, (w.scrollY||0) + r.top - t.offsetHeight - 8) + 'px';
      t.style.left = Math.max(0, (w.scrollX||0) + r.left + 8) + 'px';
    }
    function hide(){ if (el) el.style.display = 'none'; }
    return { show, hide };
  })();

  // ===== Helpers =====
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const ouFrom = (href) => (String(href||'').match(/\/d2l\/home\/(\d+)/)||[])[1] || null;

  function extractGradeLike(text){
    const m = text.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
    if (!m) return null;
    const win = text.slice(Math.max(0, m.index-20), m.index + m[0].length + 20);
    const letter = win.match(/\b([A-F][+-]?)\b/);
    return letter ? `${m[1]}% (${letter[1]})` : `${m[1]}%`;
  }
  function parseFinal(html){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // try near headings first
    for (const lbl of CFG.labels) {
      const hs = [...doc.querySelectorAll('h1,h2,h3,.vui-heading-2,.vui-heading-3')]
        .filter(h => (h.textContent||'').trim().toLowerCase() === lbl.toLowerCase());
      for (const h of hs) {
        const local = `${h.textContent} ${(h.nextElementSibling?.textContent)||''} ${(h.parentElement?.textContent)||''}`.replace(/\s+/g,' ');
        const ex = extractGradeLike(local);
        if (ex) return ex;
      }
    }
    // fallback: whole body
    const body = (doc.body.textContent||'').replace(/\s+/g,' ');
    return extractGradeLike(body) || 'Not posted';
  }

  async function fetchGrade(ou){
    const now = Date.now();
    const hit = gradeCache.get(ou);
    if (hit && now - hit.ts < CFG.gradeCacheMinutes*60*1000) return hit.value;

    const res = await fetch(CFG.gradesPath(ou), { credentials:'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const val = parseFinal(html);
    gradeCache.set(ou, { value: val, ts: now });
    return val;
  }

  // ===== Nice due-date formatting =====
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  function parseWhenLoose(s){
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  function formatAbs(d){
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZone: tz
      }).format(d);
    } catch { return d.toLocaleString(); }
  }
  function formatRel(d){
    const ms = d.getTime() - Date.now();
    const sign = Math.sign(ms);
    const abs = Math.abs(ms);
    const mins = Math.round(abs / 60000);
    if (mins < 1) return sign >= 0 ? 'now' : 'just now';
    if (mins < 60) return (sign >= 0 ? 'in ' : '') + `${mins} min` + (mins>1?'s':'');
    const hrs = Math.round(mins/60);
    if (hrs < 24) return (sign >= 0 ? 'in ' : '') + `${hrs} hr` + (hrs>1?'s':'');
    const days = Math.round(hrs/24);
    return (sign >= 0 ? 'in ' : '') + `${days} day` + (days>1?'s':'');
  }
  function formatWhenWithLabel(when, labelFallback){
    if (!when) return labelFallback ? `${labelFallback}` : '';
    return `${labelFallback} ${formatAbs(when)} (${formatRel(when)})`;
  }

  // ===== Phase 2: Calendar List view → Upcoming items (with status) =====
  function calendarListUrlForOU(ou, refDate = new Date()) {
    const y = refDate.getFullYear();
    const m = refDate.getMonth() + 1; // 1-based
    const d = refDate.getDate();
    return `/d2l/le/calendar/${encodeURIComponent(ou)}/home/list?year=${y}&month=${m}&day=${d}`;
  }

  // Extracts: title (cleaned), status ('Available' | 'Due' | 'Availability Ends' | 'Event'), when (Date|null)
  function parseCalendarListHTML(html) {
    const doc  = new DOMParser().parseFromString(html, 'text/html');
    const list = doc.querySelector('#d2l_listViewId ul.d2l-datalist.vui-list');
    if (!list) return [];

    const rows = Array.from(list.querySelectorAll('li.d2l-datalist-item'));
    const out = [];
    const STATUS_RE = /\s*[-–—]\s*(Available|Due|Availability Ends)\b/i;

    for (const li of rows) {
      // Title (prefer title attr)
      const titleAttr = li.querySelector('div.d2l-datalist-item-content[title]')?.getAttribute('title') || '';
      const titleText = titleAttr || (li.querySelector('.d2l-textblock.d2l-textblock-strong')?.textContent || '');
      const rawTitle = (titleText || '').trim();
      if (!rawTitle) continue;

      // Status detection & clean title (strip trailing " - Due/Available/Availability Ends")
      let status = 'Event';
      let cleanTitle = rawTitle;
      const m = rawTitle.match(STATUS_RE);
      if (m) {
        const s = m[1].toLowerCase();
        if (s === 'available') status = 'Available';
        else if (s === 'due') status = 'Due';
        else status = 'Availability Ends';
        cleanTitle = rawTitle.replace(STATUS_RE, '').trim();
      }

      // Date/time text: first textblock that looks like a date/time
      let dateText = '';
      for (const tb of Array.from(li.querySelectorAll('.d2l-textblock'))) {
        const txt = (tb.textContent || '').trim();
        if (!txt) continue;
        if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(txt) || /\d{1,2}:\d{2}/.test(txt)) {
          dateText = txt; break;
        }
      }
      const when = dateText ? parseWhenLoose(dateText) : null;

      // Type inference from title
      const tLower = cleanTitle.toLowerCase();
      let kind = 'Event';
      if (tLower.includes('quiz')) kind = 'Quiz';
      else if (tLower.includes('assignment') || tLower.includes('dropbox')) kind = 'Assignment';
      else if (tLower.includes('discussion')) kind = 'Discussion';
      else if (tLower.includes('exam') || tLower.includes('test')) kind = 'Exam';

      out.push({ title: cleanTitle, dateText, when, kind, status });
    }

    // Sort by time; keep next N upcoming (allow items without parsable time as last)
    const now = new Date();
    return out
      .filter(e => !e.when || e.when >= now)
      .sort((a,b) => (a.when?.getTime?.() || Infinity) - (b.when?.getTime?.() || Infinity))
      .slice(0, CFG.maxUpcoming);
  }

  async function fetchUpcoming(ou){
    const now = Date.now();
    const hit = upcomingCache.get(ou);
    if (hit && now - hit.ts < CFG.upcomingCacheMinutes*60*1000) return hit.items;

    const url = calendarListUrlForOU(ou);
    const res = await fetch(url, { credentials:'same-origin' });
    if (!res.ok) throw new Error(`Calendar HTTP ${res.status}`);
    const html = await res.text();
    const items = parseCalendarListHTML(html);

    upcomingCache.set(ou, { items, ts: now });
    return items;
  }

  // ===== Resolve OU from a card (shadowRoot first), retry briefly in case it renders late
  async function resolveOUFromCard(card, retries = 12, delayMs = 120){
    const tryOnce = () => {
      if (card.shadowRoot){
        const el = card.shadowRoot.querySelector('[href*="/d2l/home/"]'); // <a> or custom element with href
        if (el){
          const href = el.getAttribute('href') || el.href || '';
          const ou = ouFrom(href);
          if (ou) return { el, ou };
        }
      }
      const el2 = card.querySelector?.('[href*="/d2l/home/"]');
      if (el2){
        const href = el2.getAttribute('href') || el2.href || '';
        const ou = ouFrom(href);
        if (ou) return { el: el2, ou };
      }
      const hostHref = card.getAttribute('href') || card.href || '';
      const hostOU = ouFrom(hostHref);
      if (hostOU) return { el: card, ou: hostOU };
      return null;
    };

    let hit = tryOnce();
    for (let i=0; !hit && i<retries; i++){
      await new Promise(r=>setTimeout(r, delayMs));
      hit = tryOnce();
    }
    return hit;
  }

  // ===== Find & wire cards (crawl page + open shadow roots)
  function allCards(){
    const cards = [];
    (function crawl(root){
      root.querySelectorAll('d2l-enrollment-card').forEach(el => cards.push(el));
      root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) crawl(el.shadowRoot); });
    })(document);
    return cards;
  }

  const wired = new WeakSet();
  function wireCard(card){
    if (wired.has(card)) return;
    wired.add(card);

    if (!card.hasAttribute('tabindex')) { card.setAttribute('tabindex','0'); card.setAttribute('role','link'); }

    const enter = async () => {
      const info = await resolveOUFromCard(card);
      if (!info) return;

      // quick initial UI
      tip.show(card, 'Current Grade · Loading…');

      // Fetch grade + upcoming in parallel
      let grade = '…';
      let upcoming = [];
      try {
        const [g, up] = await Promise.all([
          fetchGrade(info.ou),
          fetchUpcoming(info.ou).catch(() => [])
        ]);
        grade = g;
        upcoming = up;
      } catch {}

      // Build tooltip with correct status verbs
      let html = `<div><strong>Current Grade</strong> · ${escapeHtml(grade)}</div>`;
      if (upcoming.length) {
        html += `<div style="margin-top:6px;"><strong>Next</strong>:</div>`;
        for (const item of upcoming) {
          // Label by status
          let label = '';
          if (item.status === 'Available') label = 'Opens:';
          else if (item.status === 'Availability Ends') label = 'Closes:';
          else if (item.status === 'Due') label = 'Due:';
          // Fallback if we didn’t detect status (should be rare)
          else label = 'When:';

          const whenStr = item.when
            ? formatWhenWithLabel(item.when, label)
            : (item.dateText ? `${label} ${escapeHtml(item.dateText)}` : '');

          const kindStr = item.kind ? ` (${escapeHtml(item.kind)})` : '';
          html += `<div>• ${escapeHtml(item.title)}${whenStr ? ' — ' + whenStr : ''}${kindStr}</div>`;
        }
      } else {
        html += `<div style="margin-top:6px;color:rgba(255,255,255,.7)">No upcoming items found.</div>`;
      }
      tip.show(card, html);
    };

    const leave = () => tip.hide();

    // host-level listeners = any entry vector works
    card.addEventListener('pointerenter', enter, { capture:true });
    card.addEventListener('focusin',      enter, { capture:true });
    card.addEventListener('pointerleave', leave, { capture:true });
    card.addEventListener('focusout',     leave, { capture:true });

    // light prefetch to warm caches
    card.addEventListener('pointerover', async () => {
      const info = await resolveOUFromCard(card, 3, 80);
      if (info) {
        fetchGrade(info.ou).catch(()=>{});
        fetchUpcoming(info.ou).catch(()=>{});
      }
    }, { capture:true, passive:true });
  }

  function wireAll(){
    allCards().forEach(wireCard);
  }

  // initial + observe late renders
  wireAll();
  const mo = new MutationObserver(() => wireAll());
  mo.observe(document.documentElement, { childList:true, subtree:true });
})();
