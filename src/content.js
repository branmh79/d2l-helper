// Brightspace Helper – Phase 1 (UNG)
// Hover a course card -> show current grade
// Works with Brightspace web components by wiring each <d2l-enrollment-card>
// and resolving the internal /d2l/home/{OU} link from its shadowRoot.

(function () {
  // ===== Config / state =====
  const CFG = {
    gradesPath: (ou) => `/d2l/lms/grades/my_grades/main.d2l?ou=${encodeURIComponent(ou)}`,
    labels: ["Final Calculated Grade", "Final Adjusted Grade", "Current Grade"],
    cacheMinutes: 30
  };

  const cache = new Map(); // ou -> { value, ts }

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
          font:600 12px/1 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,Arial,sans-serif;`;
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
    const hit = cache.get(ou);
    if (hit && now - hit.ts < CFG.cacheMinutes*60*1000) return hit.value;

    const res = await fetch(CFG.gradesPath(ou), { credentials:'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const val = parseFinal(html);
    cache.set(ou, { value: val, ts: now });
    return val;
  }

  // Resolve OU from a card (shadowRoot first), retry briefly in case it renders late
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

  // Find & wire cards (crawl page + open shadow roots)
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
      try {
        tip.show(card, 'Current Grade · Loading…');
        const grade = await fetchGrade(info.ou);
        tip.show(card, `Current Grade · ${escapeHtml(grade)}`);
      } catch {
        tip.show(card, 'Current Grade · error');
      }
    };
    const leave = () => tip.hide();

    // host-level listeners = any entry vector works
    card.addEventListener('pointerenter', enter, { capture:true });
    card.addEventListener('focusin',      enter, { capture:true });
    card.addEventListener('pointerleave', leave, { capture:true });
    card.addEventListener('focusout',     leave, { capture:true });

    // light prefetch to warm cache
    card.addEventListener('pointerover', async () => {
      const info = await resolveOUFromCard(card, 3, 80);
      if (info) fetchGrade(info.ou).catch(()=>{});
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
