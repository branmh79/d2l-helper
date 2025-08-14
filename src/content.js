// Brightspace Helper – Phase 1+2+3 (UNG)
// Phase 1: Grade on hover
// Phase 2: Upcoming items from Calendar (with status + due formatting)
// Phase 3: What-If (points-based MVP) — opens from tooltip, AND from a button on the Grades page
// Notes:
// - What-If parsing on the Grades page now crawls Shadow DOM and maps the "Points" column via ARIA.

(function () {
  // ===== Config / state =====
  const CFG = {
    gradesPath: (ou) => `/d2l/lms/grades/my_grades/main.d2l?ou=${encodeURIComponent(ou)}`,
    labels: ["Final Calculated Grade", "Final Adjusted Grade", "Current Grade"],
    gradeCacheMinutes: 30,
    upcomingCacheMinutes: 10,
    parsedCacheMinutes: 10,
    maxUpcoming: 3,
    tipHideDelayMs: 350
  };

  const gradeCache     = new Map();   // ou -> { value, ts }
  const upcomingCache  = new Map();   // ou -> { items[], ts }
  const parsedCache    = new Map();   // ou -> { model, ts }

  // ===== Tooltip (sticky) =====
  const tip = (() => {
    let el, hideTimer = null, hoverTip = false, anchorHover = false;

    function ensure() {
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = `
          position:absolute;z-index:2147483647;padding:8px 10px;border-radius:8px;
          background:rgba(20,22,30,.95);color:#fff;border:1px solid rgba(255,255,255,.08);
          box-shadow:0 6px 20px rgba(0,0,0,.25);display:none;
          max-width: 380px; word-break: break-word;
          font:600 12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,Arial,sans-serif;`;
        document.documentElement.appendChild(el);
        el.addEventListener('pointerenter', () => { hoverTip = true; clearTimeout(hideTimer); });
        el.addEventListener('pointerleave', () => { hoverTip = false; scheduleHide(); });
      }
      return el;
    }
    function positionNear(target) {
      const t = ensure();
      const w = target.ownerDocument.defaultView || window;
      const r = target.getBoundingClientRect();
      t.style.top  = Math.max(0, (w.scrollY||0) + r.top - t.offsetHeight - 8) + 'px';
      t.style.left = Math.max(0, (w.scrollX||0) + r.left + 8) + 'px';
    }
    function show(target, html) {
      const t = ensure();
      t.innerHTML = html;
      t.style.display = 'block';
      positionNear(target);
    }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!hoverTip && !anchorHover) hide(); }, CFG.tipHideDelayMs);
    }
    function hide(){ if (el) el.style.display = 'none'; }
    function onAnchorEnter(){ anchorHover = true; clearTimeout(hideTimer); }
    function onAnchorLeave(){ anchorHover = false; scheduleHide(); }

    return { show, hide, getEl: () => el ?? ensure(), onAnchorEnter, onAnchorLeave, reposition: positionNear };
  })();

  // ===== Helpers =====
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const ouFrom = (href) => (String(href||'').match(/\/d2l\/home\/(\d+)/)||[])[1] || null;
  const getQueryParam = (name, url=location.href) => new URL(url, location.origin).searchParams.get(name);

  // Deep DOM crawl (includes Shadow DOM)
  function crawlDeep(root, visit) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      visit(n);
      if (n.shadowRoot) stack.push(n.shadowRoot);
      for (let i = n.children?.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }
  function deepQueryAll(selector, scope=document) {
    const out = [];
    crawlDeep(scope, node => {
      if (node.querySelectorAll) out.push(...node.querySelectorAll(selector));
    });
    return out;
  }
  function deepClosest(start, pred) {
    let n = start;
    while (n) { if (pred(n)) return n; n = n.parentNode || n.host || n.parentElement; }
    return null;
  }
  const getText = (el) => (el?.textContent || '').replace(/\s+/g,' ').trim();

  // ===== Grade % parsing (hover) =====
  function extractGradeLike(text){
    const m = text.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
    if (!m) return null;
    const win = text.slice(Math.max(0, m.index-20), m.index + m[0].length + 20);
    const letter = win.match(/\b([A-F][+-]?)\b/);
    return letter ? `${m[1]}% (${letter[1]})` : `${m[1]}%`;
  }
  function parseFinal(html){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const lbl of CFG.labels) {
      const hs = [...doc.querySelectorAll('h1,h2,h3,.vui-heading-2,.vui-heading-3')]
        .filter(h => (h.textContent||'').trim().toLowerCase() === lbl.toLowerCase());
      for (const h of hs) {
        const local = `${h.textContent} ${(h.nextElementSibling?.textContent)||''} ${(h.parentElement?.textContent)||''}`.replace(/\s+/g,' ');
        const ex = extractGradeLike(local);
        if (ex) return ex;
      }
    }
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

  // ===== Date formatting (Phase 2) =====
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  const parseWhenLoose = (s) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d; };
  function formatAbs(d){
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: tz
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
  const formatWhenWithLabel = (when, labelFallback) => !when ? (labelFallback || '') : `${labelFallback} ${formatAbs(when)} (${formatRel(when)})`;

  // ===== Phase 2: Calendar List view → Upcoming (with status) =====
  function calendarListUrlForOU(ou, refDate = new Date()) {
    const y = refDate.getFullYear();
    const m = refDate.getMonth() + 1;
    const d = refDate.getDate();
    return `/d2l/le/calendar/${encodeURIComponent(ou)}/home/list?year=${y}&month=${m}&day=${d}`;
  }

  function parseCalendarListHTML(html) {
    const doc  = new DOMParser().parseFromString(html, 'text/html');
    const list = doc.querySelector('#d2l_listViewId ul.d2l-datalist.vui-list');
    if (!list) return [];
    const rows = Array.from(list.querySelectorAll('li.d2l-datalist-item'));
    const out = [];
    const STATUS_RE = /\s*[-–—]\s*(Available|Due|Availability Ends)\b/i;

    for (const li of rows) {
      const titleAttr = li.querySelector('div.d2l-datalist-item-content[title]')?.getAttribute('title') || '';
      const titleText = titleAttr || (li.querySelector('.d2l-textblock.d2l-textblock-strong')?.textContent || '');
      const rawTitle = (titleText || '').trim();
      if (!rawTitle) continue;

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

      let dateText = '';
      for (const tb of Array.from(li.querySelectorAll('.d2l-textblock'))) {
        const txt = (tb.textContent || '').trim();
        if (!txt) continue;
        if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(txt) || /\d{1,2}:\d{2}/.test(txt)) {
          dateText = txt; break;
        }
      }
      const when = dateText ? parseWhenLoose(dateText) : null;

      const tLower = cleanTitle.toLowerCase();
      let kind = 'Event';
      if (tLower.includes('quiz')) kind = 'Quiz';
      else if (tLower.includes('assignment') || tLower.includes('dropbox')) kind = 'Assignment';
      else if (tLower.includes('discussion')) kind = 'Discussion';
      else if (tLower.includes('exam') || tLower.includes('test')) kind = 'Exam';

      out.push({ title: cleanTitle, dateText, when, kind, status });
    }

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

  // ===== Phase 3: What-If (points MVP) =====

  // Robust Grades parser (works on Grades page by crawling Shadow DOM)
  function parseGradesItemsFromDocument(doc){
    
    // 1) Find the table that contains headers including "Grade Item" and "Points"
    const tables = [];
    crawlDeep(doc, node => {
      // Look for D2L tables specifically
      if (node.getAttribute && (
        node.getAttribute('role') === 'table' ||
        (node.className && String(node.className).includes('d2l-table')) ||
        (node.className && String(node.className).includes('d_gl')) ||
        node.tagName === 'TABLE'
      )) {
        tables.push(node);
      }
    });

    let pointsCol = null;
    let targetTable = null;

    for (const tbl of tables) {
      // Look for headers in multiple ways
      let headers = [];
      
      // Try ARIA headers first
      headers = deepQueryAll('[role="columnheader"]', tbl);
      
      // If no ARIA headers, look for D2L table headers
      if (headers.length === 0) {
        headers = deepQueryAll('th, .d_hch, .d2l-table-header', tbl);
      }
      
      // If still no headers, look for any header-like elements
      if (headers.length === 0) {
        headers = deepQueryAll('[class*="header"], [class*="hch"]', tbl);
      }
      
      const hasGI = headers.some(h => /grade item/i.test(getText(h)));
      const pointsHeader = headers.find(h => /points/i.test(getText(h)));
      
             // More flexible detection - look for any table that might contain grades
       const hasGradeContent = headers.some(h => /grade|points|score|earned/i.test(getText(h)));
       const hasAnyHeaders = headers.length > 0;
       
       if (hasGI && pointsHeader) {
         targetTable = tbl;
         // Try to get column index from header position
         const headerIndex = headers.indexOf(pointsHeader);
         pointsCol = headerIndex >= 0 ? headerIndex : null;
         break;
       } else if (hasGradeContent || hasAnyHeaders) {
         // Fallback: any table with grade-related content
         targetTable = tbl;
         pointsCol = null; // We'll find the points column by content
         break;
       }
    }

    const items = [];
    if (targetTable && pointsCol) {
      // Look for rows in multiple ways
      let rows = [];
      
      // Try ARIA rows first
      rows = deepQueryAll('[role="row"]', targetTable)
        .filter(r => !/columnheader/i.test(r.getAttribute('role') || ''));
      
      // If no ARIA rows, look for D2L table rows
      if (rows.length === 0) {
        rows = deepQueryAll('tr, .d2l-table-row, .d_ggl1, .d_ggl2, .d_gd', targetTable)
          .filter(r => !(r.classList && r.classList.contains('d_gh'))); // Exclude header rows
      }
      
      for (const row of rows) {
        // Look for cells in multiple ways
        let cells = [];
        
        // Try ARIA cells first
        cells = deepQueryAll('[role="cell"]', row);
        
                 // If no ARIA cells, look for D2L table cells
         if (cells.length === 0) {
           cells = deepQueryAll('td, .d2l-table-cell, .d_gc, .d_gn, .d_gr, .d_gt', row);
         }
        
                 if (!cells.length) continue;

         // Name: find the first non-empty cell that looks like a grade name
         let name = '';
         let nameCellIndex = 0;
         
         for (let i = 0; i < cells.length; i++) {
           const cellText = getText(cells[i]);
           if (cellText && !cellText.match(/^- \/ \d+/) && !cellText.match(/^-%$/)) {
             // This cell has content and doesn't look like grade data
             name = cellText;
             nameCellIndex = i;
             break;
           }
         }
         
         // If still no name, try to extract from row text
         if (!name) {
           const rowText = getText(row);
           const nameMatch = rowText.match(/^([^-]+?)\s*- \/ \d+/);
           if (nameMatch) {
             name = nameMatch[1].trim();
           }
         }
        
        // Clean up the name - remove extra whitespace and common suffixes
        name = name.replace(/\s*[-–—]\s*(Score|Grade)\b.*$/i, '').trim();
        name = name.replace(/\s*[-–—]\s*$/, '').trim(); // Remove trailing dashes
        
        if (!name) {
          continue;
        }
        
                 // Only skip if it's clearly a category header (like "Quizzes", "Projects") AND has no grade data
         const isCategoryHeader = /^(quizzes|projects|attendance|discussions|written_discussions|oral_discussions|midterm exam)$/i.test(name);
         if (isCategoryHeader) {
           const rowText = getText(row);
           if (!/\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(rowText)) {
             continue;
           }
         }
         
         // Points cell: find the cell with grade data (like "10/10" or "- / 40")
         let pointsCell = null;
         
         // Look for ANY grade pattern in any cell - prioritize existing grades first
         for (let i = 0; i < cells.length; i++) {
           const cellText = getText(cells[i]);
           
           // First priority: existing grades like "10/10", "85%", etc.
           if (/\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(cellText) || 
               /\d+(?:\.\d+)?\s*%/.test(cellText) ||
               /[A-F][+-]?\s*\(\d+(?:\.\d+)?\)/.test(cellText)) {
             pointsCell = cells[i];
             break;
           }
           
           // Second priority: ungraded items like "- / 40"
           if (/- \/ \d+(?:\.\d+)?/.test(cellText)) {
             pointsCell = cells[i];
             break;
           }
           
           // Third priority: bonus items with just "-" (no possible points)
           if (cellText === '-' && /bonus/i.test(getText(row))) {
             pointsCell = cells[i];
             break;
           }
         }
         
         // If still no points cell, try by column position
         if (!pointsCell && pointsCol !== null) {
           pointsCell = cells[pointsCol];
           
           // Also try by aria-colindex
           if (!pointsCell) {
             pointsCell = cells.find(c => Number(c.getAttribute('aria-colindex')) === pointsCol);
           }
         }
         
         // If still no points cell, try to find it by looking for the pattern in any cell
         if (!pointsCell) {
           for (let i = 0; i < cells.length; i++) {
             const cellText = getText(cells[i]);
             if (/- \/ \d+(?:\.\d+)?/.test(cellText)) {
               pointsCell = cells[i];
               break;
             }
           }
         }
         
         // If still no points cell, try to extract from the entire row text
         if (!pointsCell) {
           const rowText = getText(row);
           
           // Look for the "- / (number)" pattern in the row text
           if (/- \/ \d+(?:\.\d+)?/.test(rowText)) {
             // We'll handle this case in the parsing section below
           }
         }
                 if (!pointsCell) {
           continue;
         }
         
         // Debug: show which cell was selected for points
         const pointsCellIndex = cells.indexOf(pointsCell);

                 let ptText = '';
         let earned = null, possible = null;
         
         if (pointsCell) {
           ptText = getText(pointsCell);
         } else {
           // No points cell found, try to parse from row text
           const rowText = getText(row);
           
           // Look for the "- / (number)" pattern in the row text
           const ungradedMatch = rowText.match(/- \/ (\d+(?:\.\d+)?)/);
           if (ungradedMatch) {
             earned = 0; // No points earned yet
             possible = parseFloat(ungradedMatch[1]);
           } else {
             // Try other patterns in row text
             const m = rowText.match(/\b(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\b/);
             const pOnly = rowText.match(/\b(?:out of)\s+(\d+(?:\.\d+)?)\b/i);
             const percentMatch = rowText.match(/(\d+(?:\.\d+)?)\s*%/);
             const letterGradeMatch = rowText.match(/([A-F][+-]?)\s*\((\d+(?:\.\d+)?)\)/);
             
             if (m) { 
               earned = parseFloat(m[1]); 
               possible = parseFloat(m[2]); 
             } else if (pOnly) { 
               earned = 0; 
               possible = parseFloat(pOnly[1]); 
             } else if (percentMatch) {
               earned = parseFloat(percentMatch[1]);
               possible = 100;
             } else if (letterGradeMatch) {
               earned = parseFloat(letterGradeMatch[2]);
               possible = 100;
             }
           }
         }
         
         // If we still don't have points, try to parse from the points cell text
         if (possible == null && pointsCell) {
           ptText = getText(pointsCell);
           
           const m = ptText.match(/\b(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\b/);
           const ungradedMatch = ptText.match(/- \/ (\d+(?:\.\d+)?)/);
           const pOnly = ptText.match(/\b(?:out of)\s+(\d+(?:\.\d+)?)\b/i);
           const percentMatch = ptText.match(/(\d+(?:\.\d+)?)\s*%/);
           const letterGradeMatch = ptText.match(/([A-F][+-]?)\s*\((\d+(?:\.\d+)?)\)/);

           if (ungradedMatch) {
             earned = 0;
             possible = parseFloat(ungradedMatch[1]);
           } else if (ptText === '-' && /bonus/i.test(getText(row))) {
             // Bonus item with just "-" - give it a default possible value
             earned = 0;
             possible = 10; // Default bonus assignment value
           } else if (m) { 
             earned = parseFloat(m[1]); 
             possible = parseFloat(m[2]); 
           } else if (pOnly) { 
             earned = 0; 
             possible = parseFloat(pOnly[1]); 
           } else if (percentMatch) {
             earned = parseFloat(percentMatch[1]);
             possible = 100;
           } else if (letterGradeMatch) {
             earned = parseFloat(letterGradeMatch[2]);
             possible = 100;
           }
         }

        if (possible == null) {
          continue;
        }

        const rowText = getText(row);
        const isBonus = /bonus/i.test(rowText);
        const isExempt = /exempt/i.test(rowText);

        items.push({ id: name.toLowerCase(), name, earned: earned ?? 0, possible, isBonus, isExempt });
      }
      
    }
     
     // Only run fallback if we didn't find any items in the main table
     if (items.length === 0) {
       
       // Enhanced fallback: look for D2L-specific patterns
       const candidateNodes = [];
       
       // First, try to find the specific D2L table structure you have
       const d2lTable = doc.querySelector('table.d2l-table.d2l-grid.d_gl');
       if (d2lTable) {
         const d2lRows = d2lTable.querySelectorAll('tr.d_gd');
         
         d2lRows.forEach((row, i) => {
           const rowText = getText(row);
           
           // Extract name from row text (everything before "- /")
           const nameMatch = rowText.match(/^([^-]+?)\s*- \/ \d+/);
           if (nameMatch) {
             const name = nameMatch[1].trim();
             const pointsMatch = rowText.match(/- \/ (\d+(?:\.\d+)?)/);
             if (pointsMatch) {
               const possible = parseFloat(pointsMatch[1]);
               items.push({ id: name.toLowerCase(), name, earned: 0, possible, isBonus: false, isExempt: false });
             }
           }
         });
         
         if (items.length > 0) {
           return { scheme: 'points', items };
         }
       }
      
             // Look for D2L grade item components
       crawlDeep(doc, node => {
         if (!node.querySelectorAll) return;
         
         // Look for D2L-specific selectors
         const d2lSelectors = [
           'd2l-grade-item',
           'd2l-grade',
           '.d2l-grade-item',
           '.d2l-grade',
           '[data-testid*="grade"]',
           '[class*="grade"]',
           'tr[data-testid*="grade"]',
           'div[class*="grade"]',
           // Add specific D2L table structure
           'table.d2l-table.d2l-grid.d_gl',
           'tr.d_gd'
         ];
        
        d2lSelectors.forEach(selector => {
          try {
            const elements = node.querySelectorAll(selector);
            elements.forEach(el => candidateNodes.push(el));
          } catch (e) {
            // Ignore selector errors
          }
        });
        
                 // Look for table rows that might contain grades
         node.querySelectorAll('tr').forEach(tr => {
           const cells = tr.querySelectorAll('td');
           if (cells.length >= 2) {
             // Check if this looks like a grade row
             const firstCell = cells[0];
             const secondCell = cells[1];
             
             // Look for grade labels in first cell
             const hasGradeLabel = firstCell.querySelector?.('label, .d2l-label, [class*="grade"]');
             const firstCellText = getText(firstCell);
             
             // Look for grade values in second cell
             const secondCellText = getText(secondCell);
             
             // Also check the entire row text for D2L patterns
             const rowText = getText(tr);
             const hasD2LPattern = /- \/ \d+(?:\.\d+)?/.test(rowText) || 
                                   /\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(rowText);
             
             if (hasGradeLabel || 
                 /grade|assignment|quiz|exam|test|project|discussion/i.test(firstCellText) ||
                 /- \/ \d+(?:\.\d+)?/.test(secondCellText) || // Look for ungraded items specifically
                 /\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(secondCellText) ||
                 /\d+(?:\.\d+)?\s*%/.test(secondCellText) ||
                 /[A-F][+-]?\s*\(\d+(?:\.\d+)?\)/.test(secondCellText) ||
                 /out of/i.test(secondCellText) ||
                 hasD2LPattern) {
               candidateNodes.push(tr);
             }
           }
         });
        
                 // Also look for any elements with grade-like content
         node.querySelectorAll('tr,li,div,span').forEach(el => {
           const t = getText(el);
           
           // Look for ANY grade pattern - prioritize existing grades first
           if (/\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(t) || 
               /\d+(?:\.\d+)?\s*%/.test(t) ||
               /[A-F][+-]?\s*\(\d+(?:\.\d+)?\)/.test(t)) {
             candidateNodes.push(el);
           } else if (/- \/ \d+(?:\.\d+)?/.test(t)) {
             candidateNodes.push(el);
           } else if (/Not graded/i.test(t) || 
               /out of/i.test(t) ||
               /points/i.test(t) ||
               /\d+(?:\.\d+)?\s*points/i.test(t)) {
             candidateNodes.push(el);
           }
         });
      });

      for (const node of candidateNodes) {
        if (/Final (Calculated|Adjusted) Grade/i.test(getText(node))) continue;
        if (/^Total\b/i.test(getText(node))) continue;

        let name = '';
        let earned = null, possible = null;
        
        // Handle table rows specifically
        if (node.tagName === 'TR') {
          const cells = node.querySelectorAll('td');
          if (cells.length >= 2) {
            // First cell contains the grade name
            const firstCell = cells[0];
            name = getText(firstCell.querySelector?.('label, .d2l-label')) || 
                   getText(firstCell.querySelector?.('span')) ||
                   getText(firstCell);
            
            // Second cell contains the grade value
            const secondCell = cells[1];
            const secondCellText = getText(secondCell);
            
                         // Parse different grade formats
             const m = secondCellText.match(/\b(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\b/);
             const ungradedMatch = secondCellText.match(/- \/ (\d+(?:\.\d+)?)/);
             const pOnly = secondCellText.match(/\b(?:Out of|out of)\s+(\d+(?:\.\d+)?)\b/);
             const percentMatch = secondCellText.match(/(\d+(?:\.\d+)?)\s*%/);
             const letterGradeMatch = secondCellText.match(/([A-F][+-]?)\s*\((\d+(?:\.\d+)?)\)/);
             
             if (ungradedMatch) {
               // This is an ungraded item: "- / (number)"
               earned = 0; // No points earned yet
               possible = parseFloat(ungradedMatch[1]);
             } else if (secondCellText === '-' && /bonus/i.test(getText(node))) {
               // Bonus item with just "-" - give it a default possible value
               earned = 0;
               possible = 10; // Default bonus assignment value
             } else if (m) { 
               earned = parseFloat(m[1]); 
               possible = parseFloat(m[2]); 
             } else if (pOnly) { 
               earned = 0; 
               possible = parseFloat(pOnly[1]); 
             } else if (percentMatch) {
               // Convert percentage to points (assume out of 100)
               earned = parseFloat(percentMatch[1]);
               possible = 100;
             } else if (letterGradeMatch) {
               // Letter grade with points
               earned = parseFloat(letterGradeMatch[2]);
               possible = 100;
             }
          }
        } else {
          // Handle non-table elements (fallback)
          name =
            getText(node.querySelector?.('.d2l-textblock-strong')) ||
            getText(node.querySelector?.('strong,b')) ||
            getText(node.querySelector?.('a')) ||
            getText(node.querySelector?.('[class*="name"]')) ||
            getText(node.querySelector?.('[class*="title"]')) ||
            (getText(node).split(/\d+\s*\/\s*\d+/)[0] || '').trim();
          
                     const m = getText(node).match(/\b(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\b/);
           const ungradedMatch = getText(node).match(/- \/ (\d+(?:\.\d+)?)/);
           const pOnly = getText(node).match(/\b(?:Out of|out of)\s+(\d+(?:\.\d+)?)\b/);
           const percentMatch = getText(node).match(/(\d+(?:\.\d+)?)\s*%/);
           const letterGradeMatch = getText(node).match(/([A-F][+-]?)\s*\((\d+(?:\.\d+)?)\)/);
           
                        if (ungradedMatch) {
               // This is an ungraded item: "- / (number)"
               earned = 0; // No points earned yet
               possible = parseFloat(ungradedMatch[1]);
             } else if (getText(node) === '-' && /bonus/i.test(getText(node))) {
               // Bonus item with just "-" - give it a default possible value
               earned = 0;
               possible = 10; // Default bonus assignment value
             } else if (m) { 
               earned = parseFloat(m[1]); 
               possible = parseFloat(m[2]); 
             } else if (pOnly) { 
               earned = 0; 
               possible = parseFloat(pOnly[1]); 
             } else if (percentMatch) {
               earned = parseFloat(percentMatch[1]);
               possible = 100;
             } else if (letterGradeMatch) {
               earned = parseFloat(letterGradeMatch[2]);
               possible = 100;
             }
        }
        
        name = name.replace(/\s*[-–—]\s*(Score|Grade)\b.*$/i, '').trim();
        if (!name || possible == null) continue;

        const isBonus = /bonus/i.test(getText(node));
        const isExempt = /exempt/i.test(getText(node));

        items.push({ id: name.toLowerCase(), name, earned: earned ?? 0, possible, isBonus, isExempt });
      }
    }

         // Deduplicate items by name to prevent duplicates
     const uniqueItems = [];
     const seenNames = new Set();
     
     for (const item of items) {
       const normalizedName = item.name.toLowerCase().trim();
       if (!seenNames.has(normalizedName)) {
         seenNames.add(normalizedName);
         uniqueItems.push(item);
       } else {
         continue;
       }
     }
     
     return { scheme: 'points', items: uniqueItems };
  }

  // Parse from fetched HTML (no Shadow DOM in fetched text)
  function parseGradesItemsFromHTML(html){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return parseGradesItemsFromDocument(doc);
  }

  function computeWhatIf(model, overrides){
    let num = 0, den = 0;
    
    // Process regular grade items (skip bonus items)
    for (const it of model.items) {
      if (it.isBonus) continue; // Skip bonus items here, handle separately
      
      const ov = overrides?.[it.id] || {};
      const earned = (ov.earned != null ? Number(ov.earned) : it.earned) || 0;
      const possible = (ov.possible != null ? Number(ov.possible) : it.possible);
      let useNum = earned, useDen = possible;
      
      if (it.isExempt) { useNum = 0; useDen = 0; }
      
      num += useNum; 
      den += useDen;
    }
    
    // Add bonus points to numerator only (doesn't affect denominator)
    const bonusPoints = overrides?.bonusPoints || 0;
    num += bonusPoints;
    
    const pct = den > 0 ? (num / den) * 100 : 0;
    return { percent: pct };
  }

  // ===== Overrides storage (robust to frames) =====
  function storageKey(ou){ return `tmWhatIf:${ou}`; }
  function getOverrides(ou){
    return new Promise(resolve => {
      const cs = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync);
      if (cs && cs.get) {
        cs.get({ [storageKey(ou)]: {} }, s => resolve(s?.[storageKey(ou)] || {}));
      } else {
        try {
          const raw = localStorage.getItem(storageKey(ou));
          resolve(raw ? JSON.parse(raw) : {});
        } catch { resolve({}); }
      }
    });
  }
  function setOverrides(ou, data){
    return new Promise(resolve => {
      const cs = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync);
      if (cs && cs.set) {
        cs.set({ [storageKey(ou)]: data }, () => resolve());
      } else {
        try { localStorage.setItem(storageKey(ou), JSON.stringify(data)); } catch {}
        resolve();
      }
    });
  }

  // ===== Modal UI =====
  function ensureModal(){
    let host = document.getElementById('tm-whatif-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tm-whatif-host';
      host.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(host);

      const style = document.createElement('style');
      style.textContent = `
        .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646;}
        .wrap{position:fixed;inset:auto 16px 16px auto;right:16px;bottom:16px;z-index:2147483647;}
        .panel{width:min(560px, calc(100vw - 32px));max-height:min(80vh, 640px);overflow:auto;background:#0f1116;color:#fff;border:1px solid rgba(255,255,255,.08);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.5);font:500 13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,Arial,sans-serif;}
        .hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);position:sticky;top:0;background:#0f1116}
        .title{font-weight:700}
        .body{padding:12px}
                 .row{display:grid;grid-template-columns:1fr 100px 100px;gap:12px;align-items:center;margin:6px 0;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,.08)}
         .row.existing-grade{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.3)}
         .row.hypothetical-grade{background:rgba(59,130,246,.1);border-color:rgba(59,130,246,.3)}
         .row input{width:80px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:#171a22;color:#fff;font-size:13px;text-align:center;font-family:monospace;letter-spacing:0.5px}
         .item-name{display:flex;align-items:center;gap:6px}
         .status-indicator{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;font-size:10px;font-weight:700}
         .existing-grade .status-indicator{background:#22c55e;color:#000}
         .hypothetical-grade .status-indicator{background:#3b82f6;color:#fff}
        .subtle{color:rgba(255,255,255,.7)}
        .footer{display:flex;gap:8px;justify-content:flex-end;padding:12px;border-top:1px solid rgba(255,255,255,.08);position:sticky;bottom:0;background:#0f1116}
        .btn{padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#1b1f29;color:#fff;cursor:pointer}
        .btn.primary{background:#2b67f6;}
        .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1b1f29;border:1px solid rgba(255,255,255,.15);margin-left:8px;font-weight:700}
                 .gridHdr{display:grid;grid-template-columns:1fr 100px 100px;gap:12px;margin:4px 0;color:rgba(255,255,255,.7);font-weight:600}
        .empty{padding:8px 0;color:rgba(255,255,255,.6)}
        .fab{position:fixed;right:16px;bottom:16px;z-index:2147483645;padding:10px 14px;border-radius:999px;background:#2b67f6;color:#fff;border:none;box-shadow:0 10px 24px rgba(0,0,0,.35);font:600 13px system-ui;cursor:pointer}
      `;
      host.shadowRoot.appendChild(style);

      const backdrop = document.createElement('div'); backdrop.className = 'backdrop'; backdrop.style.display = 'none';
      const wrap = document.createElement('div'); wrap.className = 'wrap'; wrap.style.display = 'none';
      const panel = document.createElement('div'); panel.className = 'panel';
      wrap.appendChild(panel);

      host.shadowRoot.appendChild(backdrop);
      host.shadowRoot.appendChild(wrap);

      host.show = (html) => { panel.innerHTML = html; backdrop.style.display = 'block'; wrap.style.display = 'block'; };
      host.hide = () => { backdrop.style.display = 'none'; wrap.style.display = 'none'; };
      backdrop.addEventListener('click', host.hide);
      host.shadowRoot.addEventListener('keydown', (e)=>{ if(e.key==='Escape') host.hide(); });
    }
    return host;
  }

  function renderWhatIf(ou, model, overrides){
    
    const host = ensureModal();
    const result = computeWhatIf(model, overrides);
    const pctStr = `${result.percent.toFixed(2)}%`;
    
    // Separate bonus items from regular grade items
    const regularItems = model.items.filter(item => !item.isBonus);
    const bonusItems = model.items.filter(item => item.isBonus);
    
    // Get current bonus points from overrides or default to 0
    const currentBonusPoints = overrides?.bonusPoints || 0;
  
    const rows = regularItems.map(it => {
      const ov = overrides?.[it.id] || {};
      const earned = ov.earned != null ? ov.earned : it.earned;
      const possible = ov.possible != null ? ov.possible : it.possible;
      
      // Determine if this is an existing grade or hypothetical
      const isExistingGrade = it.earned > 0;
      const statusClass = isExistingGrade ? 'existing-grade' : 'hypothetical-grade';
      const statusText = isExistingGrade ? '✓' : '?';
      const statusTitle = isExistingGrade ? 'Existing grade' : 'Hypothetical grade';
      
      return `
        <div class="row ${statusClass}" data-id="${escapeHtml(it.id)}">
          <div class="item-name">
            ${escapeHtml(it.name)}
            <span class="status-indicator" title="${statusTitle}">${statusText}</span>
          </div>
          <input type="number" step="0.01" inputmode="decimal" class="in-earned" value="${escapeHtml(earned)}" placeholder="earned">
          <input type="number" step="0.01" inputmode="decimal" class="in-possible" value="${escapeHtml(possible)}" placeholder="possible">
        </div>`;
    }).join('');
  
    const html = `
      <div class="hdr">
        <div class="title">What-If Calculator<span class="pill">${pctStr}</span></div>
        <button class="btn" id="tm-close">Close</button>
      </div>
      <div class="body">
        <div class="subtle" style="margin-bottom:8px">
          <strong>How it works:</strong> Shows your current grades (✓) and hypothetical grades (?). 
          Edit any values to see how they affect your overall score. 
          Bonus items add to numerator; exempt items don't count.
        </div>
        
        ${(() => {
          const currentItems = regularItems.filter(item => item.earned > 0);
          const hypotheticalItems = regularItems.filter(item => item.earned === 0);
          const currentTotal = currentItems.reduce((sum, item) => sum + item.earned, 0);
          const currentPossible = currentItems.reduce((sum, item) => sum + item.possible, 0);
          const hypotheticalPossible = hypotheticalItems.reduce((sum, item) => sum + item.possible, 0);
          
          return `
            <div class="summary-section" style="margin-bottom:12px;padding:8px;background:rgba(255,255,255,.05);border-radius:6px;font-size:12px;">
              <div style="margin-bottom:4px;"><strong>Current Performance:</strong> ${currentTotal.toFixed(1)} / ${currentPossible.toFixed(1)} points (${currentPossible > 0 ? ((currentTotal/currentPossible)*100).toFixed(1) : 0}%)</div>
              <div style="margin-bottom:4px;"><strong>Hypothetical Items:</strong> ${hypotheticalItems.length} assignments worth ${hypotheticalPossible.toFixed(1)} points</div>
              <div style="margin-bottom:4px;"><strong>Total Possible:</strong> ${(currentPossible + hypotheticalPossible).toFixed(1)} points</div>
              ${bonusItems.length > 0 ? `<div><strong>Bonus Items:</strong> ${bonusItems.length} bonus assignments available</div>` : ''}
            </div>
          `;
        })()}
        
        <div class="gridHdr"><div>Item</div><div>Earned</div><div>Possible</div></div>
        ${rows || `<div class="empty">No grade items found on the page yet.</div>`}
        
        ${bonusItems.length > 0 ? `
  <div class="bonus-section" style="margin-top:16px;padding:12px;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.3);border-radius:8px;">
    <div style="margin-bottom:8px;font-weight:600;color:#a855f7;">🎁 Bonus Points</div>
    <div style="display:grid;grid-template-columns:1fr 80px;gap:20px;align-items:center;">
      <div style="color:rgba(255,255,255,.8);font-size:12px;">
        Enter how many bonus points you earned:
      </div>
      <div style="display:flex;justify-content:flex-end;padding-right:4px;">
        <input type="number" step="0.01" inputmode="decimal" class="in-bonus-total" value="${escapeHtml(currentBonusPoints)}" placeholder="0" style="width:70px;padding:6px 8px;border-radius:6px;border:1px solid rgba(168,85,247,.5);background:#171a22;color:#fff;font-size:13px;text-align:center;font-family:monospace;letter-spacing:0.5px">
      </div>
    </div>
  </div>
` : ''}
      </div>
      <div class="footer">
        <button class="btn" id="tm-reset">Reset</button>
        <button class="btn primary" id="tm-save">Save</button>
      </div>
    `;
    host.show(html);
  
    const $ = (sel) => host.shadowRoot.querySelector(sel);
    $('#tm-close').addEventListener('click', host.hide);
    $('#tm-reset').addEventListener('click', async () => { await setOverrides(ou, {}); host.hide(); renderWhatIf(ou, model, {}); });
    $('#tm-save').addEventListener('click', async () => {
      const ov = {};
      
      // Get regular grade overrides
      host.shadowRoot.querySelectorAll('.row').forEach(row => {
        const id = row.getAttribute('data-id');
        const e = row.querySelector('.in-earned').value;
        const p = row.querySelector('.in-possible').value;
        ov[id] = { earned: e === '' ? null : Number(e), possible: p === '' ? null : Number(p) };
      });
      
      // Get bonus points override
      const bonusInput = host.shadowRoot.querySelector('.in-bonus-total');
      if (bonusInput) {
        ov.bonusPoints = bonusInput.value === '' ? 0 : Number(bonusInput.value);
      }
      
      await setOverrides(ou, ov);
      host.hide();
    });
    
    // Real-time calculation updates
    const updateCalculation = () => {
      const ov = {};
      
      // Get regular grade overrides
      host.shadowRoot.querySelectorAll('.row').forEach(row => {
        const id = row.getAttribute('data-id');
        const e = row.querySelector('.in-earned').value;
        const p = row.querySelector('.in-possible').value;
        ov[id] = { earned: e === '' ? null : Number(e), possible: p === '' ? null : Number(p) };
      });
      
      // Get bonus points override
      const bonusInput = host.shadowRoot.querySelector('.in-bonus-total');
      if (bonusInput) {
        ov.bonusPoints = bonusInput.value === '' ? 0 : Number(bonusInput.value);
      }
      
      const r = computeWhatIf(model, ov);
      host.shadowRoot.querySelector('.pill').textContent = `${r.percent.toFixed(2)}%`;
    };
    
    // Listen for changes in regular grade inputs
    host.shadowRoot.querySelectorAll('.row input').forEach(inp => {
      inp.addEventListener('input', updateCalculation);
    });
    
    // Listen for changes in bonus points input
    const bonusInput = host.shadowRoot.querySelector('.in-bonus-total');
    if (bonusInput) {
      bonusInput.addEventListener('input', updateCalculation);
    }
  }

  async function getModelForOU(ou){
    const now = Date.now();
    const hit = parsedCache.get(ou);
    if (hit && now - hit.ts < CFG.parsedCacheMinutes*60*1000) return hit.model;
    const res = await fetch(CFG.gradesPath(ou), { credentials:'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const model = parseGradesItemsFromHTML(html);
    parsedCache.set(ou, { model, ts: now });
    return model;
  }

  // ===== Resolve OU from a card (shadowRoot first), retry briefly =====
  async function resolveOUFromCard(card, retries = 12, delayMs = 120){
    const tryOnce = () => {
      if (card.shadowRoot){
        const el = card.shadowRoot.querySelector('[href*="/d2l/home/"]');
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

    const openWhatIfForOU = async (ou) => {
      const [model, overrides] = await Promise.all([getModelForOU(ou), getOverrides(ou)]);
      renderWhatIf(ou, model, overrides);
    };

    const enter = async () => {
      tip.onAnchorEnter();
      const info = await resolveOUFromCard(card);
      if (!info) return;

      tip.show(card, 'Current Grade · Loading…');

      let grade = '…';
      let upcoming = [];
      try {
        const [g, up] = await Promise.all([
          fetchGrade(info.ou),
          fetchUpcoming(info.ou).catch(() => [])
        ]);
        grade = g; upcoming = up;
      } catch {}

      let html = `<div><strong>Current Grade</strong> · ${escapeHtml(grade)}</div>`;
      if (upcoming.length) {
        html += `<div style="margin-top:6px;"><strong>Next</strong>:</div>`;
        for (const item of upcoming) {
          let label = 'When:'; if (item.status === 'Available') label = 'Opens:'; else if (item.status === 'Availability Ends') label = 'Closes:'; else if (item.status === 'Due') label = 'Due:';
          const whenStr = item.when ? formatWhenWithLabel(item.when, label) : (item.dateText ? `${label} ${escapeHtml(item.dateText)}` : '');
          const kindStr = item.kind ? ` (${escapeHtml(item.kind)})` : '';
          html += `<div>• ${escapeHtml(item.title)}${whenStr ? ' — ' + whenStr : ''}${kindStr}</div>`;
        }
      } else {
        html += `<div style="margin-top:6px;color:rgba(255,255,255,.7)">No upcoming items found.</div>`;
      }
      html += `<div style="margin-top:8px"><a href="#" id="tm-whatif-link" style="color:#9ec5ff;text-decoration:underline;">What-If…</a></div>`;
      tip.show(card, html);

      const tEl = tip.getEl();
      const link = tEl.querySelector('#tm-whatif-link');
      if (link) link.addEventListener('click', async (e) => {
        e.preventDefault();
        await openWhatIfForOU(info.ou);
      });

      new ResizeObserver(() => tip.reposition(card)).observe(card);
    };

    const leave = () => { tip.onAnchorLeave(); };

    // Hover listeners (tooltip stays if you move onto it)
    card.addEventListener('pointerenter', enter, { capture:true });
    card.addEventListener('focusin',      enter, { capture:true });
    card.addEventListener('pointerleave', leave, { capture:true });
    card.addEventListener('focusout',     leave, { capture:true });

    // Prefetch
    card.addEventListener('pointerover', async () => {
      const info = await resolveOUFromCard(card, 3, 80);
      if (info) { fetchGrade(info.ou).catch(()=>{}); fetchUpcoming(info.ou).catch(()=>{}); }
    }, { capture:true, passive:true });
  }

  function wireAll(){ allCards().forEach(wireCard); }

  // ===== Inject a What-If button directly on the Grades page =====
  function maybeInjectGradesPageButton(){
    const isGradesPage = location.pathname.includes('/d2l/lms/grades/my_grades/main.d2l');
    if (!isGradesPage) return;
    const ou = getQueryParam('ou');
    if (!ou) return;

    if (document.getElementById('tm-whatif-fab')) return;

    const btnHost = document.createElement('div');
    btnHost.id = 'tm-whatif-fab';
    btnHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `.fab{position:fixed;right:16px;bottom:16px;z-index:2147483645;padding:10px 14px;border-radius:999px;background:#2b67f6;color:#fff;border:none;box-shadow:0 10px 24px rgba(0,0,0,.35);font:600 13px system-ui;cursor:pointer}`;
    const btn = document.createElement('button');
    btn.className = 'fab'; btn.textContent = 'What-If…';
    btnHost.shadowRoot.appendChild(style);
    btnHost.shadowRoot.appendChild(btn);
    document.documentElement.appendChild(btnHost);

    btn.addEventListener('click', async () => {
      
      let model = { scheme: 'points', items: [] };
      let attempts = 0;
      const maxAttempts = 3;
      
      while (attempts < maxAttempts && model.items.length === 0) {
        if (attempts > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts)); // Progressive delay
        }
        
        model = parseGradesItemsFromDocument(document);
        attempts++;
      }
      
      if (model.items.length === 0) {
        return;
      }
      
      const overrides = await getOverrides(ou);
      
      renderWhatIf(ou, model, overrides);
    });
  }

  // ===== Run =====
  wireAll();
  const mo = new MutationObserver(() => { wireAll(); maybeInjectGradesPageButton(); });
  mo.observe(document.documentElement, { childList:true, subtree:true });
  maybeInjectGradesPageButton();
  
  // Add keyboard shortcut for debugging (Ctrl+Shift+G)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'G') {
      debugPageStructure();
      dumpGradeElements();
    }
  });
})();
