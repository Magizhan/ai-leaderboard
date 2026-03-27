  const API_BASE = window.location.origin;
  // Config: highlight users on outdated extension versions
  // Set to true once Chrome Web Store v1.8 is published and ready
  const SHOW_OUTDATED_EXTENSION_NUDGE = true;
  const REQUIRED_EXTENSION_VERSION = '1.8';
  let currentTab = 'all';
  let boardType = 'session';
  let cachedData = null;

  // ============================================================
  // SETUP SECTION - collapsible, remember state
  // ============================================================
  function toggleSetup() {
    const el = document.getElementById('setupSection');
    el.classList.toggle('open');
    localStorage.setItem('claude_lb_setup_seen', el.classList.contains('open') ? '' : '1');
  }
  // Auto-open for first-time visitors, auto-collapse once they've synced at least once
  if (!localStorage.getItem('claude_lb_setup_seen')) {
    document.getElementById('setupSection').classList.add('open');
  }
  // Also collapse if there are users (meaning someone has synced)
  function maybeCollapseSetup() {
    if (cachedData && cachedData.users && cachedData.users.length > 0) {
      localStorage.setItem('claude_lb_setup_seen', '1');
    }
  }

  // ============================================================
  // CONSOLE PASTE CODE
  // ============================================================
  function generateConsoleCode() {
    return "(function(){" +
      "var n=localStorage.getItem('claude_lb_name');" +
      "if(!n){n=prompt('Enter your leaderboard name:');if(!n)return;localStorage.setItem('claude_lb_name',n);}" +
      "var t=localStorage.getItem('claude_lb_team');" +
      "if(!t){t=prompt('Enter your team (NY, NC, Xyne, HS, or JP):');if(!t)return;localStorage.setItem('claude_lb_team',t);}" +
      "var b=document.body.innerText,re=/(\\d{1,3})%\\s*used/g,all=[],m;" +
      "while((m=re.exec(b))!==null)all.push(parseInt(m[1]));" +
      "var sp=all[0]||null,wp=all[1]||null;" +
      "if(!sp&&!wp){alert('No usage data found. Open claude.ai/settings/usage first.');return;}" +
      // Session reset timer — only match in text before "Weekly limits" to avoid Sonnet's timer
      "var sb=b.split(/Weekly limits/i)[0]||b;" +
      "var sra=null,srHM=sb.match(/in\\s+(\\d+)\\s*hr?\\s+(\\d+)\\s*min/i)," +
      "srM=sb.match(/in\\s+(\\d+)\\s*min/i),srH=sb.match(/in\\s+(\\d+)\\s*hr/i);" +
      "if(srHM)sra=new Date(Date.now()+(parseInt(srHM[1])*3600+parseInt(srHM[2])*60)*1000).toISOString();" +
      "else if(srM)sra=new Date(Date.now()+parseInt(srM[1])*60000).toISOString();" +
      "else if(srH)sra=new Date(Date.now()+parseInt(srH[1])*3600000).toISOString();" +
      // Weekly reset timer: "Sat 5:29 PM" pattern
      "var wra=null,wrm=b.match(/(sun|mon|tue|wed|thu|fri|sat)\\w*\\s+(\\d+):(\\d+)\\s*(am|pm)/i);" +
      "if(wrm){var dn=['sun','mon','tue','wed','thu','fri','sat']," +
      "td=dn.indexOf(wrm[1].toLowerCase().slice(0,3)),hr=parseInt(wrm[2]),mn=parseInt(wrm[3])," +
      "pm=wrm[4].toLowerCase()==='pm';if(pm&&hr!==12)hr+=12;if(!pm&&hr===12)hr=0;" +
      "var nw=new Date(),rs=new Date(nw),da=(td-nw.getDay()+7)%7;" +
      "if(da===0){var tt=new Date(nw);tt.setHours(hr,mn,0,0);if(tt<=nw)da=7;}" +
      "rs.setDate(rs.getDate()+da);rs.setHours(hr,mn,0,0);wra=rs.toISOString();}" +
      // Extra usage
      "var esm=b.match(/\\$(\\d+(?:\\.\\d{1,2})?)\\s*spent/i),es=esm?parseFloat(esm[1]):null;" +
      "var elm=b.match(/\\$(\\d+(?:,\\d{3})*)\\s*\\n?\\s*Monthly spend limit/i),el=elm?parseFloat(elm[1].replace(/,/g,'')):null;" +
      "var ep=(esm&&all.length>=4)?all[3]:null;" +
      // Confirm
      "var msg='Sync as '+n+' ('+t+')?\\nSession: '+(sp||'--')+'%  Weekly: '+(wp||'--')+'%';" +
      "if(es!==null)msg+='\\nExtra usage: $'+es.toFixed(2)+' spent';" +
      "if(!confirm(msg))return;" +
      // Detect plan type — look for 20x or 5x on page
      "var pt=null;if(/\\b20\\s*[×x]\\b/i.test(b))pt='max20';else if(/\\b5\\s*[×x]\\b/i.test(b))pt='max5';" +
      // Build payload — send raw values, server handles per-plan tracking
      "var p={name:n,team:t,source:'console'};if(pt)p.planType=pt;if(sp!==null)p.sessionPct=sp;if(wp!==null)p.weeklyPct=wp;" +
      "if(sra)p.sessionResetsAt=sra;if(wra)p.weeklyResetsAt=wra;" +
      "if(es!==null)p.extraUsageSpent=es;if(el!==null)p.extraUsageLimit=el;if(ep!==null)p.extraUsagePct=ep;" +
      "var ok=navigator.sendBeacon('" + API_BASE + "/api/usage',new Blob([JSON.stringify(p)],{type:'text/plain'}));" +
      "if(ok)alert('Synced! '+n+' ('+t+') - Session: '+(sp||'--')+'%, Weekly: '+(wp||'--')+'%');" +
      "else alert('Sync failed. Please try again.')" +
      "})()";
  }

  function copyConsoleCode() {
    navigator.clipboard.writeText(generateConsoleCode());
    toast('Copied to clipboard!');
  }

  // ============================================================
  // RANK SYSTEM (works with whole percentages, e.g., 100 = 100%)
  // ============================================================
  function getRank(val) {
    if (val > 100)  return { title: 'MYTHIC',     icon: '\u{1f525}', cls: 'rank-mythic' };
    if (val >= 100) return { title: 'LEGENDARY',  icon: '\u{1f451}', cls: 'rank-legendary' };
    if (val >= 80)  return { title: 'DIAMOND',    icon: '\u{1f48e}', cls: 'rank-diamond' };
    if (val >= 60)  return { title: 'PLATINUM',   icon: '\u{2b50}',  cls: 'rank-platinum' };
    if (val >= 40)  return { title: 'GOLD',       icon: '\u{1f31f}', cls: 'rank-gold' };
    if (val >= 20)  return { title: 'SILVER',     icon: '\u{26a1}',  cls: 'rank-silver' };
    return                   { title: 'BRONZE',    icon: '\u{1f6e1}\u{fe0f}',  cls: 'rank-bronze' };
  }

  function getNextRank(pct) {
    const thresholds = [
      { threshold: 20, title: 'SILVER' },
      { threshold: 40, title: 'GOLD' },
      { threshold: 60, title: 'PLATINUM' },
      { threshold: 80, title: 'DIAMOND' },
      { threshold: 100, title: 'LEGENDARY' },
    ];
    if (pct > 100) return null;
    if (pct >= 100) return { nextTitle: 'MYTHIC', threshold: 101, progress: pct / 101, remaining: 1 };
    for (let i = 0; i < thresholds.length; i++) {
      if (pct < thresholds[i].threshold) {
        const prev = i > 0 ? thresholds[i - 1].threshold : 0;
        const progress = (pct - prev) / (thresholds[i].threshold - prev);
        return { nextTitle: thresholds[i].title, remaining: thresholds[i].threshold - pct, progress, threshold: thresholds[i].threshold };
      }
    }
    return null;
  }

  function getBarClass(pct) {
    if (pct > 100) return 'overflow';
    if (pct >= 90) return 'max';
    if (pct >= 60) return 'high';
    if (pct >= 30) return 'mid';
    return 'low';
  }

  function pctColor(pct) {
    if (pct > 100) return '#ff6b6b';
    if (pct >= 90) return '#ef4444';
    if (pct >= 70) return 'var(--accent-orange)';
    if (pct >= 50) return 'var(--accent-purple)';
    if (pct >= 30) return 'var(--accent-blue)';
    return 'var(--text-secondary)';
  }

  function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  const TEAM_CSS = {NY:'ny',NC:'nc',Xyne:'xyne',HS:'hs',JP:'jp'};

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  // ============================================================
  // API
  // ============================================================
  async function apiFetch(path, options = {}, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(API_BASE + path, {
          headers: { 'Content-Type': 'application/json' },
          ...options,
        });
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error('Non-JSON response (status ' + res.status + ')');
        }
        return await res.json();
      } catch (e) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  // ============================================================
  // RENDER
  // ============================================================
  let lastDataHash = '';
  async function render(force = false) {
    try {
      const data = await apiFetch('/api/data');
      // Skip re-render if data hasn't changed (prevents flicker on auto-refresh)
      const hash = JSON.stringify(data);
      if (!force && hash === lastDataHash) return;
      lastDataHash = hash;
      cachedData = data;
      renderData(data);
    } catch (err) {
      console.error('Failed to fetch data:', err);
      if (!cachedData) {
        document.getElementById('leaderboardSession').innerHTML =
          '<div class="empty-state"><div class="icon">&#9888;&#65039;</div><p>Failed to load data.</p></div>';
        document.getElementById('leaderboardWeekly').innerHTML =
          '<div class="empty-state"><div class="icon">&#9888;&#65039;</div><p>Failed to load data.</p></div>';
      }
    }
  }

  // ============================================================
  // SPARKLINE RENDERER (SVG)
  // ============================================================
  function renderSparkline(data, color = '#a855f7', w = 72, h = 20) {
    if (!data || data.length < 2) {
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="#1e293b" stroke-width="1"/></svg>`;
    }
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const points = data.map((v, i) => {
      const x = (i / (data.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - min) / range) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const last = data[data.length - 1];
    const lastX = w - 1;
    const lastY = h - 2 - ((last - min) / range) * (h - 4);
    // Gradient fill area
    const firstPoint = points.split(' ')[0];
    const areaPoints = `${firstPoint.split(',')[0]},${h} ${points} ${lastX},${h}`;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="sg_${color.replace('#','')}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${areaPoints}" fill="url(#sg_${color.replace('#','')})" />
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2" fill="${color}"/>
    </svg>`;
  }

  /**
   * Normalize usage relative to one Max 20x plan (the base).
   * Returns a multiplier: 1.0x = 100% of one Max 20x plan.
   *
   * Max 5x = 1/4 capacity of Max 20x → normFactor = 4.
   * Display: "0.25x" for Max 5x at 100%, "1.0x" for Max 20x at 100%.
   */
  function planNormFactor(u) {
    return u.planType === 'max5' ? 4 : 1;
  }

  /** Returns effective usage as a percentage (for internal sorting/ranking) */
  function effectivePct(u, key) {
    const raw = u[key] || 0;
    const nf = planNormFactor(u);
    return raw / nf;
    // Extra usage shown as a tag, not baked into the percentage
  }

  /** Format percentage as multiplier: 100% → "1.0x", 25% → "0.25x" */
  function fmtMultiplier(pct) {
    const x = pct / 100;
    if (x >= 10) return Math.round(x) + 'x';
    if (x >= 1) return x.toFixed(1) + 'x';
    return x.toFixed(2) + 'x';
  }

  function buildRowHTML(u, i, pctKey, otherPctKey, otherLabel, sparkKey) {
    const pct = effectivePct(u, pctKey);
    const otherPct = effectivePct(u, otherPctKey);
    const rank = getRank(pct);
    const pos = i + 1;
    const posClass = pos <= 3 ? 'p' + pos : 'px';
    const rowClass = pos <= 3 ? 'rank-' + pos : '';
    const barClass = getBarClass(pct);
    const barWidth = Math.min(pct, 100);
    const fire = pct >= 80 ? '<span class="fire-icon">\u{1f525}</span> ' : '';
    const ago = timeAgo(u.lastUpdated);
    const teamCls = TEAM_CSS[u.team] || 'ny';
    const rawSparkData = u[sparkKey] || [];
    const nf = planNormFactor(u);
    const sparkData = nf > 1 ? rawSparkData.map(v => v / nf) : rawSparkData;
    const sparkColor = pctColor(pct);
    const safeId = escAttr(u.id);
    const isStale = u.isStale || false;
    const isInactive = u.isInactive || false;
    const staleClass = isInactive ? ' stale inactive' : isStale ? ' stale' : '';
    const staleTag = isInactive ? '<span class="lb-stale-tag inactive">INACTIVE</span>' : isStale ? '<span class="lb-stale-tag">STALE</span>' : '';
    const streakHtml = u.streak > 0 ? `<span class="lb-streak" title="${u.streak}-day streak">\u{1f525}${u.streak}</span>` : '';
    const nextRank = getNextRank(pct);
    const progressHtml = nextRank ? `<span class="rank-progress"><span class="rank-progress-fill" style="width:${Math.round(nextRank.progress * 100)}%;background:${pctColor(pct)};"></span></span>` : '';

    return `
      <div class="lb-row clickable ${rowClass}${staleClass}" data-uid="${safeId}" onclick="openDetail('${safeId}')">
        <div class="lb-position ${posClass}">#${pos}</div>
        <div class="lb-user-info">
          <div class="lb-name">${fire}${escHtml(u.name)}</div>
          <div class="lb-meta">
            <span class="lb-team-tag ${teamCls}">${escHtml(u.team)}</span>
            ${u.planType ? `<span class="lb-plan-tag ${u.planType === 'max5' ? 'max5' : 'max20'}">${u.planType === 'max5' ? 'M5' : 'M20'}</span>` : ''}
            ${SHOW_OUTDATED_EXTENSION_NUDGE && u.extensionVersion && u.extensionVersion < REQUIRED_EXTENSION_VERSION ? `<span class="lb-outdated-tag" title="Extension v${escAttr(u.extensionVersion)} — update to v${REQUIRED_EXTENSION_VERSION}">update</span>` : ''}
            ${SHOW_OUTDATED_EXTENSION_NUDGE && !u.planType && u.source !== 'extension' ? `<span class="lb-outdated-tag" title="Plan type unknown. Install/update extension to detect automatically." style="background:rgba(255,159,28,0.15);color:#ff9f1c;">sync</span>` : ''}
            <span class="lb-rank-badge ${rank.cls}">${rank.icon} ${rank.title}</span>${progressHtml}${streakHtml}
            ${ago ? `<span class="lb-updated">${ago}</span>` : ''}${staleTag}
            ${pctKey === 'sessionPct' && u.sessionResetsAt ? `<span class="lb-reset session"><span data-reset-session="${escAttr(u.sessionResetsAt)}"></span>${u.sessionResetSource === 'estimated' ? '<span class="reset-estimated">i<span class="reset-tooltip">Estimated from usage drop. Update extension for accurate data.</span></span>' : ''}</span>` : ''}
            ${pctKey === 'weeklyPct' && u.weeklyResetsAt ? `<span class="lb-reset weekly"><span data-reset-weekly="${escAttr(u.weeklyResetsAt)}"></span>${u.weeklyResetSource === 'estimated' ? '<span class="reset-estimated">i<span class="reset-tooltip">Estimated from usage drop. Update extension for accurate data.</span></span>' : ''}</span>` : ''}
          </div>
        </div>
        <div class="lb-sparkline">${renderSparkline(sparkData, sparkColor)}</div>
        <div class="lb-plans">
          ${fmtMultiplier(pct)} <span class="sub">(${otherLabel}: ${fmtMultiplier(otherPct)})</span>${u.extraUsageSpent ? `<span class="extra-usage-tag">+$${u.extraUsageSpent.toFixed(0)}</span>` : ''}
          <div class="lb-updated">${u.numPlans} plan${u.numPlans > 1 ? 's' : ''} &middot; $${u.budget}${u.extraUsageLimit ? ' &middot; $' + u.extraUsageLimit + ' extra limit' : ''}</div>
        </div>
        <div class="lb-usage-bar"><div class="lb-usage-fill ${barClass}" style="width:${Math.min(barWidth, 100)}%"></div></div>
        <div class="lb-pct" style="color:${pctColor(pct)}">${fmtMultiplier(pct)}</div>
      </div>
    `;
  }

  function renderLeaderboard(users, containerId, pctKey, otherPctKey, otherLabel) {
    const sparkKey = pctKey === 'sessionPct' ? 'sessionSparkline' : 'weeklySparkline';
    // Exclude Pro/Free plans — leaderboard is for Max plan GPU utilization only
    const maxUsers = users.filter(u => !u.planType || u.planType.startsWith('max'));
    const sorted = [...maxUsers].sort((a, b) => effectivePct(b, pctKey) - effectivePct(a, pctKey));

    let filtered = sorted;
    if (currentTab === 'ny') filtered = sorted.filter(u => u.team === 'NY');
    else if (currentTab === 'nc') filtered = sorted.filter(u => u.team === 'NC');
    else if (currentTab === 'xyne') filtered = sorted.filter(u => u.team === 'Xyne');
    else if (currentTab === 'hs') filtered = sorted.filter(u => u.team === 'HS');
    else if (currentTab === 'jp') filtered = sorted.filter(u => u.team === 'JP');
    else if (currentTab === 'top5') filtered = sorted.slice(0, 5);
    else if (currentTab === 'top10') filtered = sorted.slice(0, 10);

    const lb = document.getElementById(containerId);
    if (filtered.length === 0) {
      lb.innerHTML = '<div class="empty-state"><div class="icon">&#128202;</div><p>No users yet. Click "+ Add User" to get started.</p></div>';
      return;
    }

    const existingRows = lb.querySelectorAll('.lb-row[data-uid]');
    const existingIds = [...existingRows].map(r => r.dataset.uid);
    const newIds = filtered.map(u => u.id);

    // If user list or order changed, do a full rebuild
    if (existingIds.length !== newIds.length || existingIds.some((id, i) => id !== newIds[i])) {
      lb.innerHTML = filtered.map((u, i) => buildRowHTML(u, i, pctKey, otherPctKey, otherLabel, sparkKey)).join('');
      return;
    }

    // Same users, same order — update each row in-place
    filtered.forEach((u, i) => {
      const row = existingRows[i];
      const pct = effectivePct(u, pctKey);
      const otherPct = effectivePct(u, otherPctKey);
      const rank = getRank(pct);
      const rawSparkData = u[sparkKey] || [];
      const nf = planNormFactor(u);
      const sparkData = nf > 1 ? rawSparkData.map(v => v / nf) : rawSparkData;
      const sparkColor = pctColor(pct);
      const ago = timeAgo(u.lastUpdated);
      const barClass = getBarClass(pct);

      // Update percentage
      const pctEl = row.querySelector('.lb-pct');
      if (pctEl) { pctEl.textContent = fmtMultiplier(pct); pctEl.style.color = pctColor(pct); }

      // Update plans/details
      const plansEl = row.querySelector('.lb-plans');
      if (plansEl) {
        plansEl.innerHTML = `${fmtMultiplier(pct)} <span class="sub">(${otherLabel}: ${fmtMultiplier(otherPct)})</span>${u.extraUsageSpent ? `<span class="extra-usage-tag">+$${u.extraUsageSpent.toFixed(0)}</span>` : ''}
          <div class="lb-updated">${u.numPlans} plan${u.numPlans > 1 ? 's' : ''} &middot; $${u.budget}${u.extraUsageLimit ? ' &middot; $' + u.extraUsageLimit + ' extra limit' : ''}</div>`;
      }

      // Update usage bar
      const barFill = row.querySelector('.lb-usage-fill');
      if (barFill) { barFill.style.width = Math.min(pct, 100) + '%'; barFill.className = 'lb-usage-fill ' + barClass; }

      // Update sparkline
      const sparkEl = row.querySelector('.lb-sparkline');
      if (sparkEl) sparkEl.innerHTML = renderSparkline(sparkData, sparkColor);

      // Update rank badge
      const rankEl = row.querySelector('.lb-rank-badge');
      if (rankEl) { rankEl.className = 'lb-rank-badge ' + rank.cls; rankEl.innerHTML = rank.icon + ' ' + rank.title; }

      // Update time ago
      const agoEl = row.querySelector('.lb-meta .lb-updated');
      if (agoEl) agoEl.textContent = ago;
    });
  }

  // Try to auto-detect user from CF Access JWT cookie
  function getEmailFromJWT() {
    try {
      const cookie = document.cookie.split(';').find(c => c.trim().startsWith('CF_Authorization='));
      if (!cookie) return null;
      const token = cookie.split('=')[1];
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.email || null;
    } catch (e) { return null; }
  }

  function renderMyStatus(data) {
    const container = document.getElementById('myStatusCard');
    if (!container) return;

    // Auto-detect: try localStorage name, then CF JWT email match
    let myName = localStorage.getItem('claude_lb_name');
    let me = myName ? data.users.find(u => u.name.toLowerCase() === myName.toLowerCase()) : null;

    if (!me) {
      const email = getEmailFromJWT();
      if (email) {
        // Match by first name from email (e.g., "magizhan@..." → find user "Mags" or "Magizhan")
        const emailName = email.split('@')[0].toLowerCase();
        me = data.users.find(u => u.name.toLowerCase().includes(emailName) || emailName.includes(u.name.toLowerCase()));
        if (me) {
          localStorage.setItem('claude_lb_name', me.name);
          myName = me.name;
        }
      }
    }

    if (!me) {
      container.innerHTML = `<div style="text-align:center;padding:12px;font-size:0.8rem;color:var(--text-dim);background:var(--bg-card);border:1px dashed var(--border);border-radius:12px;margin-bottom:16px;cursor:pointer;" onclick="var n=prompt('Enter your leaderboard name:');if(n){localStorage.setItem('claude_lb_name',n);if(cachedData)renderData(cachedData);}">Click here to set your name and see your personal status card</div>`;
      return;
    }

    const sorted = [...data.users].sort((a, b) => effectivePct(b, 'weeklyPct') - effectivePct(a, 'weeklyPct'));
    const myPos = sorted.findIndex(u => u.id === me.id) + 1;
    const total = sorted.length;
    const pct = effectivePct(me, 'weeklyPct');
    const rank = getRank(pct);
    const nextRank = getNextRank(pct);

    let nextRankHtml = '';
    if (nextRank) {
      nextRankHtml = `<div class="my-status-next">
        <span>\u2192 ${nextRank.nextTitle}: ${Math.round(nextRank.remaining)}% to go</span>
        <div class="my-status-next-bar"><div class="my-status-next-fill" style="width:${Math.round(nextRank.progress * 100)}%"></div></div>
      </div>`;
    }

    // Financial summary — base usage separate from extra
    const budget = me.amountSpent || me.budget || 0;
    const extraSpent = me.extraUsageSpent || 0;
    const basePct = me.baseWeeklyPct || me.weeklyPct || 0;
    const baseUtilized = Math.round((basePct / 100) * budget);
    const hoursLeft = me.weeklyResetHoursLeft;
    const daysLeft = hoursLeft !== null ? Math.floor(hoursLeft / 24) : null;
    const hrsLeft = hoursLeft !== null ? hoursLeft % 24 : null;

    let timeHtml = '';
    if (daysLeft !== null) {
      timeHtml = `<span class="urgency">${daysLeft > 0 ? daysLeft + 'd ' : ''}${hrsLeft}h left this week</span>`;
    }

    const inrRate = 94.24;
    const lostPct = me.lostPct || 0;
    const oppPct = me.opportunityPct || 0;
    const lostDollars = Math.round((lostPct / 100) * budget);
    const oppDollars = Math.round((oppPct / 100) * budget);
    const toINR = (usd) => '\u20B9' + Math.round(usd * inrRate).toLocaleString('en-IN');
    const financialHtml = `<div class="my-status-financial">
      <span class="spent">${toINR(baseUtilized)} / ${toINR(budget)}</span>
      <span style="color:var(--text-dim);font-size:0.65rem">($${baseUtilized}/$${budget})</span>
      ${extraSpent > 0 ? `<span style="color:var(--accent-orange)">+${toINR(extraSpent)} extra</span>` : ''}
      ${lostDollars > 0 ? `<span style="color:#ef4444;font-size:0.7rem" title="From ${me.completedWeeks || 0} completed week(s) not fully used">${toINR(lostDollars)} lost</span>` : ''}
      ${timeHtml}
    </div>
    ${oppDollars > 0 ? `<div style="font-size:0.65rem;color:var(--accent-green);margin-top:2px;">${toINR(oppDollars)} still achievable this month</div>` : ''}`;

    container.innerHTML = `<div class="my-status-card">
      <div class="my-status-card-inner">
        <div>
          <div class="my-status-name">${escHtml(me.name)}</div>
          <div class="my-status-rank-info">Rank #${myPos} of ${total}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="lb-rank-badge ${rank.cls}">${rank.icon} ${rank.title}</span>
          <span class="my-status-pct" style="color:${pctColor(pct)}">${fmtMultiplier(pct)}</span>
        </div>
        ${nextRankHtml}
        ${financialHtml}
        <span class="my-status-change" onclick="var n=prompt('Enter your leaderboard name:');if(n){localStorage.setItem('claude_lb_name',n);if(cachedData)renderData(cachedData);}">Not you? Change</span>
      </div>
    </div>`;
  }

  function renderData(data) {
    const { users, stats, teams } = data;
    const scrollY = window.scrollY;

    // Render personal status card
    renderMyStatus(data);

    // Render both leaderboards (Individual tab)
    renderLeaderboard(users, 'leaderboardSession', 'sessionPct', 'weeklyPct', 'mo');
    renderLeaderboard(users, 'leaderboardWeekly', 'weeklyPct', 'sessionPct', 'sess');

    // Render team leaderboards (Team tab) — same data, same filter
    if (document.getElementById('teamLeaderboardSession')) {
      renderLeaderboard(users, 'teamLeaderboardSession', 'sessionPct', 'weeklyPct', 'mo');
      renderLeaderboard(users, 'teamLeaderboardWeekly', 'weeklyPct', 'sessionPct', 'sess');
    }

    // Utilisation Gauge
    const INR_RATE = 94.24;
    const fmtINR = (v) => '\u20B9' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
    const totalExtraSpent = data.users.reduce((s, u) => s + (u.extraUsageSpent || 0), 0);
    const budgetUSD = data.users.reduce((s, u) => s + (u.budget || 0), 0);
    // Utilised = each user's monthly multiplier × their plan cost + extra usage
    // Overall utilised = base usage only (no extra usage — we advise additional plans instead)
    const utilisedUSD = data.users.reduce((s, u) => {
      const basePct = u.baseWeeklyPct || 0;
      return s + (basePct / 100) * (u.budget || 0);
    }, 0);
    const pct = budgetUSD > 0 ? Math.round((utilisedUSD / budgetUSD) * 100) : 0;
    const sessionsActive = data.users.filter(u => (u.sessionPct || 0) > 0).length;

    document.getElementById('gaugeUtilised').textContent = fmtINR(utilisedUSD * INR_RATE);
    document.getElementById('gaugeBudget').textContent = fmtINR(budgetUSD * INR_RATE);
    document.getElementById('gaugeUSD').textContent = '[$' + Math.round(utilisedUSD).toLocaleString('en-US') + ' / $' + budgetUSD.toLocaleString('en-US') + ']';

    const bar = document.getElementById('gaugeBarFill');
    const barWidth = Math.min(pct, 150); // allow visual overflow past 100%
    bar.style.width = barWidth + '%';
    // Color: red < 25%, orange 25-50%, yellow 50-75%, green > 75%, purple > 100%
    if (pct > 100) bar.style.background = 'linear-gradient(90deg, #2DC653, #a855f7)';
    else if (pct >= 75) bar.style.background = 'linear-gradient(90deg, #2DC653, #22c55e)';
    else if (pct >= 50) bar.style.background = 'linear-gradient(90deg, #ffd166, #2DC653)';
    else if (pct >= 25) bar.style.background = 'linear-gradient(90deg, #ff9f1c, #ffd166)';
    else bar.style.background = 'linear-gradient(90deg, #ef476f, #ff9f1c)';

    const pctEl = document.getElementById('gaugePct');
    pctEl.textContent = pct + '%';
    pctEl.style.color = pct > 100 ? '#a855f7' : pct >= 50 ? '#2DC653' : pct >= 25 ? '#ff9f1c' : '#ef476f';

    // 100% marker position: if pct > 100, marker moves left proportionally
    const marker = document.getElementById('gaugeBar100');
    if (pct > 100) marker.style.left = (100 / pct * 100) + '%';
    else marker.style.left = '100%';

    document.getElementById('gaugeUsers').textContent = sessionsActive + ' active / ' + stats.totalUsers + ' users';
    document.getElementById('gaugeAvg').textContent = fmtMultiplier(stats.avgWeeklyPct || 0);

    // Overall lost & achievable (base usage only, no extra)
    const totalLostUSD = data.users.reduce((s, u) => s + ((u.lostPct || 0) / 100) * (u.budget || 0), 0);
    const totalOppUSD = data.users.reduce((s, u) => s + ((u.opportunityPct || 0) / 100) * (u.budget || 0), 0);

    // Max possible = budget - lost (can't recover lost weeks)
    const maxPossiblePct = budgetUSD > 0 ? Math.round(((budgetUSD - totalLostUSD) / budgetUSD) * 100) : 0;
    document.getElementById('gaugeBarPossible').style.width = Math.min(maxPossiblePct, 100) + '%';
    document.getElementById('gaugeMaxPossible').textContent = maxPossiblePct + '%';
    const lostEl = document.getElementById('gaugeLost');
    if (lostEl) {
      if (totalLostUSD > 0) {
        lostEl.textContent = fmtINR(totalLostUSD * INR_RATE) + ' lost forever';
        lostEl.style.display = '';
      } else {
        lostEl.style.display = 'none';
      }
    }
    const oppEl = document.getElementById('gaugeOpportunity');
    if (oppEl) {
      if (totalOppUSD > 0) {
        oppEl.textContent = fmtINR(totalOppUSD * INR_RATE) + ' still achievable';
        oppEl.style.display = '';
      } else {
        oppEl.style.display = 'none';
      }
    }

    // Teams - use weekly for team battle (or could use session)
    const teamNames = ['NY', 'NC', 'Xyne', 'HS', 'JP'];
    const teamIds = ['ny', 'nc', 'xyne', 'hs', 'jp'];
    const maxTeamPct = Math.max(...teamNames.map(t => teams[t] ? teams[t].avgWeeklyPct || 0 : 0), 1);

    teamNames.forEach((t, idx) => {
      const tid = teamIds[idx];
      const teamData = teams[t] || { members: 0, avgSessionPct: 0, avgWeeklyPct: 0 };
      const weeklyPct = teamData.avgWeeklyPct || 0;
      const sessionPct = teamData.avgSessionPct || 0;

      // Full team battle (elements may not exist if tab not rendered)
      const pctEl = document.getElementById(tid + 'Pct');
      const detEl = document.getElementById(tid + 'Details');
      const barEl = document.getElementById(tid + 'Bar');
      const barValEl = document.getElementById(tid + 'BarVal');
      if (pctEl) pctEl.textContent = fmtMultiplier(weeklyPct);
      if (detEl) detEl.textContent = `${teamData.members} member${teamData.members !== 1 ? 's' : ''}`;
      if (barEl) barEl.style.width = (weeklyPct / maxTeamPct * 100) + '%';
      if (barValEl) barValEl.textContent = fmtMultiplier(weeklyPct);

      // Mini team battle (show session — more dynamic/real-time)
      const miniEl = document.getElementById(tid + 'MiniPct');
      if (miniEl) miniEl.textContent = fmtMultiplier(sessionPct);
    });

    const updatedText = 'Last updated: ' + new Date().toLocaleString();
    document.getElementById('lastUpdated').textContent = updatedText;
    document.getElementById('lastUpdatedTop').textContent = updatedText;

    // Restore scroll position after DOM update (prevents iOS Safari scroll jump)
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }

  // ============================================================
  // ACTIONS
  // ============================================================
  async function addUser() {
    const name = document.getElementById('newUserName').value.trim();
    const team = document.getElementById('newUserTeam').value;
    const numPlans = parseInt(document.getElementById('newUserPlans').value) || 1;
    if (!name) return toast('Enter a name', true);

    const d = await apiFetch('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name, team, numPlans }),
    });
    if (d.id) {
      closeModal('addUser');
      document.getElementById('newUserName').value = '';
      render(true);
      toast(name + ' added to ' + team + '!');
      confetti();
    } else {
      toast(d.error || 'Failed', true);
    }
  }

  async function logUsageManual() {
    const userId = document.getElementById('logUsageUser').value;
    const sessionPct = parseFloat(document.getElementById('logSessionPct').value);
    const weeklyPct = parseFloat(document.getElementById('logWeeklyPct').value);
    const extraSpent = parseFloat(document.getElementById('logExtraSpent').value);
    const extraLimit = parseFloat(document.getElementById('logExtraLimit').value);
    if (!userId) return toast('Select a user', true);

    const payload = { userId, source: 'manual' };
    if (!isNaN(sessionPct)) payload.sessionPct = sessionPct;
    if (!isNaN(weeklyPct)) payload.weeklyPct = weeklyPct;
    if (!isNaN(extraSpent)) payload.extraUsageSpent = extraSpent;
    if (!isNaN(extraLimit)) payload.extraUsageLimit = extraLimit;
    if (isNaN(sessionPct) && isNaN(weeklyPct) && isNaN(extraSpent) && isNaN(extraLimit)) return toast('Enter at least one value', true);

    const d = await apiFetch('/api/usage', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (d.ok) {
      closeModal('logUsage');
      document.getElementById('logSessionPct').value = '';
      document.getElementById('logWeeklyPct').value = '';
      document.getElementById('logExtraSpent').value = '';
      document.getElementById('logExtraLimit').value = '';
      render(true);
      toast('Updated!');
    } else {
      toast(d.error || 'Failed', true);
    }
  }

  async function addPlanAction() {
    const userId = document.getElementById('addPlanUser').value;
    const count = parseInt(document.getElementById('addPlanCount').value) || 1;
    if (!userId) return toast('Select a user', true);

    try {
      const d = await apiFetch('/api/users/' + userId + '/plans', {
        method: 'POST',
        body: JSON.stringify({ count }),
      });
      if (d && d.ok) {
        closeModal('addPlan');
        render(true);
        toast('Added ' + count + ' plan(s). Now ' + d.numPlans + ' plans.');
      } else {
        toast((d && d.error) || 'Failed to add plans', true);
      }
    } catch (e) {
      toast('Error: ' + e.message, true);
    }
  }

  function onManageUserChange() {
    const sel = document.getElementById('manageUserSelect');
    const opt = sel.selectedOptions[0];
    if (opt && opt.dataset.team) {
      document.getElementById('manageUserTeam').value = opt.dataset.team;
      document.getElementById('manageUserName').value = opt.text.split(' (')[0];
    }
  }

  async function updateUser() {
    const userId = document.getElementById('manageUserSelect').value;
    if (!userId) return toast('Select a user', true);
    const team = document.getElementById('manageUserTeam').value;
    const name = document.getElementById('manageUserName').value.trim();
    try {
      const d = await apiFetch('/api/users/' + userId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team, name: name || undefined }),
      });
      if (d && d.ok) {
        closeModal('manageUser');
        render(true);
        toast('Updated ' + (d.user?.name || 'user'));
      } else {
        toast((d && d.error) || 'Failed', true);
      }
    } catch (e) {
      toast('Error: ' + e.message, true);
    }
  }

  async function removeUser() {
    const userId = document.getElementById('manageUserSelect').value;
    if (!userId) return toast('Select a user', true);
    const userName = document.getElementById('manageUserSelect').selectedOptions[0]?.text || 'user';
    if (!confirm('Are you sure you want to permanently remove ' + userName + '? This cannot be undone.')) return;

    try {
      const d = await apiFetch('/api/users/' + userId, { method: 'DELETE' });
      if (d && d.ok) {
        closeModal('manageUser');
        render(true);
        toast('Removed ' + (d.removed || 'user'));
      } else {
        toast((d && d.error) || 'Failed', true);
      }
    } catch (e) {
      toast('Error: ' + e.message, true);
    }
  }

  // ============================================================
  // EXPORT / IMPORT
  // ============================================================
  async function exportData() {
    const data = await apiFetch('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'claude_leaderboard_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Data exported!');
  }

  function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
      try {
        const imported = JSON.parse(e.target.result);
        const d = await apiFetch('/api/import', {
          method: 'POST',
          body: JSON.stringify(imported),
        });
        if (d.ok) {
          render(true);
          toast('Imported ' + d.imported + ' users!');
          confetti();
        } else {
          toast(d.error || 'Import failed', true);
        }
      } catch { toast('Failed to parse file', true); }
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  // ============================================================
  // MODALS
  // ============================================================
  function openModal(name) {
    if (cachedData) {
      const users = cachedData.users || [];
      ['logUsageUser', 'addPlanUser', 'manageUserSelect'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.innerHTML = users.map(u =>
            '<option value="' + escAttr(u.id) + '" data-team="' + escAttr(u.team) + '">' + escHtml(u.name) + ' (' + escHtml(u.team) + ')</option>'
          ).join('');
        }
      });
    }
    document.getElementById('modal-' + name).classList.add('active');
    if (name === 'manageUser') onManageUserChange();
  }

  function closeModal(name) {
    document.getElementById('modal-' + name).classList.remove('active');
  }

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('active'); });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  });

  // ============================================================
  // TABS
  // ============================================================
  function setMainTab(tab, btn) {
    document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('mainTabIndividual').style.display = tab === 'individual' ? '' : 'none';
    document.getElementById('mainTabTeam').style.display = tab === 'team' ? '' : 'none';
    document.getElementById('mainTabSettings').style.display = tab === 'settings' ? '' : 'none';
    if (tab === 'team') {
      const firstTeamBtn = document.querySelector('#teamTabs .tab:first-child');
      if (firstTeamBtn) firstTeamBtn.click();
    }
  }

  function setTab(tab, el) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    if (cachedData) renderData(cachedData);
    if (['ny','nc','xyne','hs','jp'].includes(tab) && cachedData) {
      const teamKey = tab === 'ny' ? 'NY' : tab === 'nc' ? 'NC' : tab === 'xyne' ? 'Xyne' : tab === 'hs' ? 'HS' : 'JP';
      const td = cachedData.teams[teamKey] || {};
      const teamUsers = cachedData.users.filter(u => u.team === teamKey);
      document.getElementById('teamMetricUtil').textContent = fmtMultiplier(td.avgWeeklyPct || 0);
      document.getElementById('teamMetricMembers').textContent = (td.activeMembers || 0) + ' active / ' + (td.members || 0);
      const tBudget = teamUsers.reduce((s,u) => s + (u.budget || 200), 0);
      document.getElementById('teamMetricBudget').textContent = '$' + tBudget.toLocaleString();
      // Team financials
      const _R = 94.24;
      const _fI = (v) => '\u20B9' + Math.round(v).toLocaleString('en-IN');
      const tUtilized = teamUsers.reduce((s,u) => s + ((u.baseWeeklyPct || 0) / 100) * (u.budget || 0), 0);
      const tLost = teamUsers.reduce((s,u) => s + ((u.lostPct || 0) / 100) * (u.budget || 0), 0);
      const tAchievable = Math.max(0, tBudget - tUtilized - tLost);
      document.getElementById('teamMetricUtilized').textContent = _fI(tUtilized * _R);
      document.getElementById('teamMetricLost').textContent = _fI(tLost * _R);
      document.getElementById('teamMetricAchievable').textContent = _fI(tAchievable * _R);
      document.getElementById('teamMetrics').style.display = '';
    }
  }

  // ============================================================
  // TOAST & CONFETTI
  // ============================================================
  function toast(msg, isError) {
    const t = document.createElement('div');
    t.className = 'toast';
    if (isError) t.style.borderColor = '#ef4444';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  function confetti() {
    const colors = ['#f97316', '#a855f7', '#3b82f6', '#22c55e', '#ec4899', '#fbbf24', '#06b6d4'];
    for (let i = 0; i < 40; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.top = '-10px';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      piece.style.width = (Math.random() * 8 + 4) + 'px';
      piece.style.height = (Math.random() * 8 + 4) + 'px';
      document.body.appendChild(piece);
      const dur = Math.random() * 2000 + 1500;
      const xd = (Math.random() - 0.5) * 200;
      piece.animate([
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${xd}px,${window.innerHeight + 20}px) rotate(${Math.random() * 720}deg)`, opacity: 0 }
      ], { duration: dur, easing: 'cubic-bezier(0.25,0.46,0.45,0.94)' }).onfinish = () => piece.remove();
    }
  }

  // ============================================================
  // LINE CHART RENDERER (SVG)
  // ============================================================
  let chartIdCounter = 0;

  function renderLineChart(data, valueKey, labelKey, options = {}) {
    const {
      width = 440, height = 180, color = '#a855f7', color2 = null, valueKey2 = null,
      label = '', label2 = '', showDots = true
    } = options;

    const chartId = 'chart_' + (chartIdCounter++);

    if (!data || data.length === 0) {
      return `<div style="position:relative;"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <text x="${width/2}" y="${height/2}" fill="#475569" font-size="12" text-anchor="middle">No data yet</text>
      </svg></div>`;
    }

    const padL = 40, padR = 10, padT = 20, padB = 30;
    const cw = width - padL - padR, ch = height - padT - padB;

    const allVals = data.map(d => d[valueKey] || 0);
    if (valueKey2) allVals.push(...data.map(d => d[valueKey2] || 0));
    const maxV = Math.max(...allVals, 1);
    const minV = Math.min(...allVals, 0);
    const range = maxV - minV || 1;

    function toX(i) { return padL + (data.length === 1 ? cw / 2 : (i / (data.length - 1)) * cw); }
    function toY(v) { return padT + ch - ((v - minV) / range) * ch; }

    let svg = `<svg id="${chartId}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="font-family:'JetBrains Mono',monospace;">`;

    // Grid lines
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (i / gridLines) * ch;
      const val = maxV - (i / gridLines) * range;
      svg += `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#1e293b" stroke-width="1"/>`;
      svg += `<text x="${padL - 4}" y="${y + 3}" fill="#475569" font-size="9" text-anchor="end">${Math.round(val)}%</text>`;
    }

    // Render line(s)
    function drawLine(vKey, clr, lbl) {
      const pts = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d[vKey] || 0).toFixed(1)}`).join(' ');
      const areaStart = `${toX(0).toFixed(1)},${(padT + ch).toFixed(1)}`;
      const areaEnd = `${toX(data.length - 1).toFixed(1)},${(padT + ch).toFixed(1)}`;
      svg += `<defs><linearGradient id="lcg_${clr.replace('#','')}_${vKey}_${chartId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${clr}" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="${clr}" stop-opacity="0"/>
      </linearGradient></defs>`;
      svg += `<polygon points="${areaStart} ${pts} ${areaEnd}" fill="url(#lcg_${clr.replace('#','')}_${vKey}_${chartId})" />`;
      svg += `<polyline points="${pts}" fill="none" stroke="${clr}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
      if (showDots && data.length <= 30) {
        data.forEach((d, i) => {
          const x = toX(i), y = toY(d[vKey] || 0);
          svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${clr}" stroke="var(--bg-secondary)" stroke-width="1.5" class="chart-dot" data-idx="${i}" data-key="${vKey}" style="cursor:pointer;"/>`;
        });
      }
    }

    // Invisible hover zones for each data point (full-height vertical strips)
    data.forEach((d, i) => {
      const x = toX(i);
      const stripW = data.length > 1 ? cw / (data.length - 1) : cw;
      const stripX = x - stripW / 2;
      const val1 = Math.round(d[valueKey] || 0) + '%';
      const val2 = valueKey2 ? Math.round(d[valueKey2] || 0) + '%' : null;
      const lbl = d[labelKey] || '';
      let tooltipText = `${lbl}\\n${label || valueKey}: ${val1}`;
      if (val2 !== null) tooltipText += `\\n${label2 || valueKey2}: ${val2}`;
      svg += `<rect x="${Math.max(0, stripX).toFixed(1)}" y="0" width="${stripW.toFixed(1)}" height="${height}" fill="transparent" class="chart-hover-zone" data-idx="${i}" data-tooltip="${escHtml(tooltipText)}" data-x="${x.toFixed(1)}" style="cursor:crosshair;"/>`;
    });

    drawLine(valueKey, color, label);
    if (valueKey2 && color2) drawLine(valueKey2, color2, label2);

    // Vertical hover line (hidden by default)
    svg += `<line class="chart-hover-line" x1="0" y1="${padT}" x2="0" y2="${padT + ch}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3" style="display:none;"/>`;

    // X-axis labels
    const labelCount = Math.min(data.length, 6);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor(i * (data.length - 1) / Math.max(labelCount - 1, 1));
      const d = data[idx];
      const lbl = d[labelKey] || '';
      const shortLbl = lbl.length > 8 ? lbl.slice(5) : lbl;
      svg += `<text x="${toX(idx).toFixed(1)}" y="${height - 6}" fill="#475569" font-size="8" text-anchor="middle">${shortLbl}</text>`;
    }

    // Legend
    if (label) {
      svg += `<rect x="${padL}" y="4" width="8" height="8" rx="2" fill="${color}"/>`;
      svg += `<text x="${padL + 12}" y="12" fill="#94a3b8" font-size="9">${label}</text>`;
    }
    if (label2 && color2) {
      const lx = padL + 12 + label.length * 5.5 + 16;
      svg += `<rect x="${lx}" y="4" width="8" height="8" rx="2" fill="${color2}"/>`;
      svg += `<text x="${lx + 12}" y="12" fill="#94a3b8" font-size="9">${label2}</text>`;
    }

    svg += '</svg>';

    return `<div style="position:relative;" class="chart-wrap">
      ${svg}
      <div class="chart-tooltip" id="tooltip_${chartId}"></div>
    </div>`;
  }

  // ============================================================
  // USER DETAIL PANEL
  // ============================================================
  let detailPanelOpen = false;

  async function openDetail(userId) {
    const panel = document.getElementById('detailPanel');
    const overlay = document.getElementById('detailOverlay');
    const body = document.getElementById('detailBody');

    // Find user from cached data
    const user = cachedData && cachedData.users ? cachedData.users.find(u => u.id === userId) : null;
    if (!user) return;

    // Set header
    const rank = getRank(user.sessionPct || 0);
    const teamCls = TEAM_CSS[user.team] || 'ny';
    document.getElementById('detailName').textContent = user.name;
    document.getElementById('detailMeta').innerHTML = `
      <span class="lb-team-tag ${teamCls}">${escHtml(user.team)}</span>
      <span class="lb-rank-badge ${rank.cls}">${rank.icon} ${rank.title}</span>
      <span class="lb-updated">${parseInt(user.numPlans) || 1} plan${user.numPlans > 1 ? 's' : ''} &middot; $${parseInt(user.budget) || 0}</span>
    `;

    body.innerHTML = '<div class="empty-state"><p>Loading history...</p></div>';
    panel.classList.add('open');
    overlay.classList.add('open');
    detailPanelOpen = true;

    // Fetch history and weekly data
    try {
      const [history, weekly, config] = await Promise.all([
        apiFetch('/api/history/' + userId + '?limit=200'),
        apiFetch('/api/weekly/' + userId + '?limit=26'),
        apiFetch('/api/users/' + userId + '/config'),
      ]);

      renderDetailBody(body, user, history, weekly, config);
    } catch (err) {
      body.innerHTML = '<div class="empty-state"><p>Failed to load history.</p></div>';
    }
  }

  function renderDetailBody(container, user, history, weekly, config) {
    // Compute summary metrics
    const sessionPcts = history.map(h => h.sessionPct || 0);
    const weeklyPcts = history.map(h => h.weeklyPct || 0);
    const peakSession = sessionPcts.length > 0 ? Math.max(...sessionPcts) : 0;
    const avgSession = sessionPcts.length > 0 ? sessionPcts.reduce((a, b) => a + b, 0) / sessionPcts.length : 0;
    const peakWeekly = weeklyPcts.length > 0 ? Math.max(...weeklyPcts) : 0;
    const avgWeekly = weeklyPcts.length > 0 ? weeklyPcts.reduce((a, b) => a + b, 0) / weeklyPcts.length : 0;
    const totalSessions = history.length;

    // Trend direction (last 3 vs previous 3)
    let trend = '--';
    if (sessionPcts.length >= 6) {
      const recent = sessionPcts.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const prev = sessionPcts.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
      trend = recent > prev ? 'Trending Up' : recent < prev ? 'Trending Down' : 'Stable';
    } else if (sessionPcts.length >= 2) {
      trend = sessionPcts[sessionPcts.length - 1] >= sessionPcts[sessionPcts.length - 2] ? 'Trending Up' : 'Trending Down';
    }
    const trendColor = trend === 'Trending Up' ? 'var(--accent-green)' : trend === 'Trending Down' ? '#ef4444' : 'var(--text-secondary)';

    const weekStartDay = (config && config.weekStartDay) || 'monday';

    let html = '';

    // Per-user countdown timers
    html += renderCountdownBar(user);

    // Current stats
    html += `<div class="detail-section">
      <div class="detail-section-title">Current</div>
      <div class="detail-stats-grid">
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-orange)">${Math.round(user.sessionPct)}%</div><div class="detail-stat-label">Session</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-blue)">${Math.round(user.currentWeeklyPct || 0)}%</div><div class="detail-stat-label">This Week</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-purple)">${Math.round(user.weeklyPct)}%</div><div class="detail-stat-label">Monthly</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:${trendColor}">${trend === 'Trending Up' ? '&#9650;' : trend === 'Trending Down' ? '&#9660;' : '&#9654;'}</div><div class="detail-stat-label">${trend}</div></div>
        ${user.extraUsageSpent ? `<div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-orange)">$${user.extraUsageSpent.toFixed(2)}</div><div class="detail-stat-label">Extra $ Spent</div></div>` : ''}
        ${user.extraUsageLimit ? `<div class="detail-stat"><div class="detail-stat-value" style="color:var(--text-secondary)">$${user.extraUsageLimit}</div><div class="detail-stat-label">Spend Limit</div></div>` : ''}
      </div>
    </div>`;

    // Financial summary
    const _R = 94.24;
    const _fI = (v) => '\u20B9' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
    const _bgt = user.budget || 0;
    const _bPct = user.baseWeeklyPct || 0;
    const _bUtil = Math.round((_bPct / 100) * _bgt);
    const _ext = user.extraUsageSpent || 0;
    const _lPct = user.lostPct || 0;
    const _oPct = user.opportunityPct || 0;
    const _lDol = Math.round((_lPct / 100) * _bgt);
    const _oDol = Math.round((_oPct / 100) * _bgt);
    html += `<div class="detail-section">
      <div class="detail-section-title">Financials</div>
      <div class="detail-stats-grid">
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-green)">${_fI(_bUtil * _R)}</div><div class="detail-stat-label">Utilized (of ${_fI(_bgt * _R)})</div></div>
        ${_ext > 0 ? `<div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-orange)">${_fI(_ext * _R)}</div><div class="detail-stat-label">Extra Usage</div></div>` : ''}
        ${_lDol > 0 ? `<div class="detail-stat"><div class="detail-stat-value" style="color:#ef4444">${_fI(_lDol * _R)}</div><div class="detail-stat-label">Lost Forever (${user.completedWeeks || 0} wk)</div></div>` : ''}
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-cyan)">${_fI(_oDol * _R)}</div><div class="detail-stat-label">Still Achievable</div></div>
      </div>
    </div>`;

    // Individual utilisation bar
    const userMult = (user.weeklyPct || 0) / 100;
    const userScale = user.planType === 'max5' ? 0.25 : 1.0;
    const userMaxCapacity = 4 * userScale * (user.numPlans || 1);
    const userUtilPct = userMaxCapacity > 0 ? Math.round((userMult / userMaxCapacity) * 100) : 0;
    const barColor = userUtilPct >= 75 ? '#2DC653' : userUtilPct >= 50 ? '#ffd166' : userUtilPct >= 25 ? '#ff9f1c' : '#ef476f';
    html += `<div style="margin:12px 0 4px;"><div style="display:flex;align-items:center;gap:8px;">
      <div style="flex:1;height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;">
        <div style="width:${Math.min(userUtilPct,100)}%;height:100%;border-radius:4px;background:${barColor};transition:width 0.5s;"></div>
      </div>
      <span style="font-size:0.7rem;font-weight:700;color:${barColor};">${userUtilPct}%</span>
    </div>
    <div style="font-size:0.6rem;color:rgba(255,255,255,0.35);text-align:center;margin-top:2px;">${fmtMultiplier(user.weeklyPct || 0)} of ${userMaxCapacity.toFixed(1)}x monthly capacity</div></div>`;

    // Summary metrics
    html += `<div class="detail-section">
      <div class="detail-section-title">Summary</div>
      <div class="detail-stats-grid">
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-cyan)">${Math.round(peakSession)}%</div><div class="detail-stat-label">Peak Session</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-blue)">${Math.round(avgSession)}%</div><div class="detail-stat-label">Avg Session</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-green)">${totalSessions}</div><div class="detail-stat-label">Total Sessions</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-pink)">${Math.round(peakWeekly)}%</div><div class="detail-stat-label">Peak Weekly</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-purple)">${Math.round(avgWeekly)}%</div><div class="detail-stat-label">Avg Weekly</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--text-secondary)">${weekly.length}</div><div class="detail-stat-label">Weeks Tracked</div></div>
      </div>
    </div>`;

    // Session history chart
    html += `<div class="detail-section">
      <div class="detail-section-title">Session History</div>
      <div class="detail-chart-container">${renderLineChart(history, 'sessionPct', 'sessionSlot', {
        color: '#f97316', color2: '#a855f7', valueKey2: 'weeklyPct',
        label: 'Session', label2: 'Weekly'
      })}</div>
    </div>`;

    // Session history table
    html += `<div class="detail-section">
      <div class="detail-section-title">Session History Log</div>
      ${renderSessionHistoryTable(history, 20, user)}
    </div>`;

    // Weekly history chart
    if (weekly.length > 0) {
      html += `<div class="detail-section">
        <div class="detail-section-title">Weekly History</div>
        <div class="detail-chart-container">${renderLineChart(weekly, 'avgSessionPct', 'weekKey', {
          color: '#3b82f6', color2: '#22c55e', valueKey2: 'avgWeeklyPct',
          label: 'Avg Session', label2: 'Avg Weekly'
        })}</div>
      </div>`;

      // Weekly history table
      html += `<div class="detail-section">
        <div class="detail-section-title">Weekly History Log</div>
        ${renderWeeklyHistoryTable(weekly)}
      </div>`;
    }

    // Settings
    html += `<div class="detail-section">
      <div class="detail-section-title">Settings</div>
      <div class="detail-config">
        <label>Plans:</label>
        <select onchange="updateNumPlans('${escAttr(user.id)}', this.value)">
          ${[1,2,3,4,5].map(n =>
            `<option value="${n}" ${n === (user.numPlans || 1) ? 'selected' : ''}>${n} plan${n > 1 ? 's' : ''} ($${n * 200}/mo)</option>`
          ).join('')}
        </select>
      </div>
      <div class="detail-config">
        <label>Week starts on:</label>
        <select onchange="updateWeekStart('${escAttr(user.id)}', this.value)">
          ${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d =>
            `<option value="${d.toLowerCase()}" ${d.toLowerCase() === weekStartDay ? 'selected' : ''}>${d}</option>`
          ).join('')}
        </select>
      </div>
    </div>`;

    container.innerHTML = html;
  }

  function closeDetail() {
    document.getElementById('detailPanel').classList.remove('open');
    document.getElementById('detailOverlay').classList.remove('open');
    detailPanelOpen = false;
  }

  async function updateNumPlans(userId, numPlans) {
    try {
      const users = await apiFetch('/api/users');
      const user = users.find(u => u.id === userId);
      if (!user) return toast('User not found', true);
      const diff = parseInt(numPlans) - (user.numPlans || 1);
      if (diff > 0) {
        await apiFetch('/api/users/' + userId + '/plans', {
          method: 'POST',
          body: JSON.stringify({ count: diff }),
        });
      } else if (diff < 0) {
        // Set directly via config endpoint
        await apiFetch('/api/users/' + userId + '/config', {
          method: 'PUT',
          body: JSON.stringify({ numPlans: parseInt(numPlans) }),
        });
      }
      toast('Plans updated to ' + numPlans);
      render(true);
    } catch (e) {
      toast('Error: ' + e.message, true);
    }
  }

  async function updateWeekStart(userId, day) {
    try {
      await apiFetch('/api/users/' + userId + '/config', {
        method: 'PUT',
        body: JSON.stringify({ weekStartDay: day }),
      });
      toast('Week start updated to ' + day);
    } catch (e) {
      toast('Error: ' + e.message, true);
    }
  }

  // ============================================================
  // TEAM DETAIL PANEL
  // ============================================================
  async function openTeamDetail(teamName) {
    const panel = document.getElementById('detailPanel');
    const overlay = document.getElementById('detailOverlay');
    const body = document.getElementById('detailBody');

    const teamColors = { NY: 'var(--ny-color)', NC: 'var(--nc-color)', Xyne: 'var(--xyne-color)', HS: 'var(--hs-color)', JP: 'var(--jp-color)' };
    const teamData = cachedData && cachedData.teams ? cachedData.teams[teamName] : null;

    document.getElementById('detailName').textContent = teamName + ' Team';
    document.getElementById('detailMeta').innerHTML = `
      <span class="lb-team-tag ${TEAM_CSS[teamName] || 'ny'}">${escHtml(teamName)}</span>
      <span class="lb-updated">${teamData ? teamData.members : 0} members</span>
    `;

    body.innerHTML = '<div class="empty-state"><p>Loading team history...</p></div>';
    panel.classList.add('open');
    overlay.classList.add('open');
    detailPanelOpen = true;

    try {
      const [teamHistory, teamWeekly] = await Promise.all([
        apiFetch('/api/team-history/' + encodeURIComponent(teamName) + '?limit=200'),
        apiFetch('/api/team-weekly/' + encodeURIComponent(teamName) + '?limit=26'),
      ]);

      renderTeamDetailBody(body, teamName, teamData, teamHistory, teamWeekly);
    } catch (err) {
      body.innerHTML = '<div class="empty-state"><p>Failed to load team history.</p></div>';
    }
  }

  function renderTeamDetailBody(container, teamName, teamData, history, weekly) {
    const teamMembers = cachedData && cachedData.users ? cachedData.users.filter(u => u.team === teamName) : [];
    const avgSession = teamData ? teamData.avgSessionPct : 0;
    const avgWeekly = teamData ? teamData.avgWeeklyPct : 0;

    const sessionPcts = history.map(h => h.sessionPct || 0);
    const peakSession = sessionPcts.length > 0 ? Math.max(...sessionPcts) : 0;
    const overallAvg = sessionPcts.length > 0 ? sessionPcts.reduce((a, b) => a + b, 0) / sessionPcts.length : 0;

    let html = '';

    // Current team stats
    html += `<div class="detail-section">
      <div class="detail-section-title">Current</div>
      <div class="detail-stats-grid">
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-orange)">${Math.round(avgSession)}%</div><div class="detail-stat-label">Avg Session</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-purple)">${Math.round(avgWeekly)}%</div><div class="detail-stat-label">Avg Weekly</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-green)">${teamMembers.length}</div><div class="detail-stat-label">Members</div></div>
      </div>
    </div>`;

    // Summary
    html += `<div class="detail-section">
      <div class="detail-section-title">Summary</div>
      <div class="detail-stats-grid">
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-cyan)">${Math.round(peakSession)}%</div><div class="detail-stat-label">Peak Session</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--accent-blue)">${Math.round(overallAvg)}%</div><div class="detail-stat-label">Avg Session</div></div>
        <div class="detail-stat"><div class="detail-stat-value" style="color:var(--text-secondary)">${history.length}</div><div class="detail-stat-label">Data Points</div></div>
      </div>
    </div>`;

    // Team session history chart
    html += `<div class="detail-section">
      <div class="detail-section-title">Session History</div>
      <div class="detail-chart-container">${renderLineChart(history, 'sessionPct', 'sessionSlot', {
        color: '#f97316', color2: '#a855f7', valueKey2: 'weeklyPct',
        label: 'Avg Session', label2: 'Avg Weekly'
      })}</div>
    </div>`;

    // Team weekly chart
    if (weekly.length > 0) {
      html += `<div class="detail-section">
        <div class="detail-section-title">Weekly History</div>
        <div class="detail-chart-container">${renderLineChart(weekly, 'avgSessionPct', 'weekKey', {
          color: '#3b82f6', color2: '#22c55e', valueKey2: 'avgWeeklyPct',
          label: 'Avg Session', label2: 'Avg Weekly'
        })}</div>
      </div>`;
    }

    // Members breakdown
    html += `<div class="detail-section">
      <div class="detail-section-title">Members</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${teamMembers.sort((a, b) => (b.sessionPct || 0) - (a.sessionPct || 0)).map(m => {
          const sPct = m.sessionPct || 0;
          const wPct = m.weeklyPct || 0;
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;cursor:pointer;" onclick="closeDetail();setTimeout(()=>openDetail('${escAttr(m.id)}'),350)">
            <div style="flex:1;font-weight:600;font-size:0.85rem;">${escHtml(m.name)}</div>
            <div style="width:72px;">${renderSparkline(m.sessionSparkline || [], pctColor(sPct))}</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:${pctColor(sPct)};min-width:50px;text-align:right;">${Math.round(sPct)}%</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

    container.innerHTML = html;
  }

  // ============================================================
  // AUTO-REFRESH (silent, no loading bar)
  // ============================================================
  const REFRESH_INTERVAL_MS = 30000; // 30 seconds
  setInterval(() => render(), REFRESH_INTERVAL_MS);

  // ============================================================
  // KEYBOARD SHORTCUTS
  // ============================================================
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape' && detailPanelOpen) { closeDetail(); return; }
    if (e.key === 'a') openModal('addUser');
    if (e.key === 'u') openModal('logUsage');
    if (e.key === 'r') render(true);
  });

  // ============================================================
  // CHART HOVER TOOLTIPS (event delegation)
  // ============================================================
  document.addEventListener('mousemove', e => {
    const zone = e.target.closest('.chart-hover-zone');
    if (!zone) {
      // Hide all tooltips
      document.querySelectorAll('.chart-tooltip.visible').forEach(t => t.classList.remove('visible'));
      document.querySelectorAll('.chart-hover-line').forEach(l => l.style.display = 'none');
      return;
    }
    const wrap = zone.closest('.chart-wrap');
    const tooltip = wrap.querySelector('.chart-tooltip');
    const hoverLine = wrap.querySelector('.chart-hover-line');
    const svgRect = zone.closest('svg').getBoundingClientRect();
    const x = parseFloat(zone.dataset.x);

    // Position tooltip
    const tooltipText = zone.dataset.tooltip.replace(/\\n/g, '\n');
    tooltip.textContent = '';
    tooltipText.split('\n').forEach((line, i) => {
      if (i > 0) tooltip.appendChild(document.createElement('br'));
      tooltip.appendChild(document.createTextNode(line));
    });
    tooltip.classList.add('visible');

    // Place tooltip near cursor but within bounds
    const tipX = e.clientX - svgRect.left + 12;
    const tipY = e.clientY - svgRect.top - 10;
    tooltip.style.left = Math.min(tipX, svgRect.width - 160) + 'px';
    tooltip.style.top = Math.max(tipY, 0) + 'px';

    // Show hover line
    if (hoverLine) {
      hoverLine.setAttribute('x1', x);
      hoverLine.setAttribute('x2', x);
      hoverLine.style.display = '';
    }
  });

  // ============================================================
  // HISTORY DATA TABLE
  // ============================================================
  function renderSessionHistoryTable(history, maxRows = 20, user = null) {
    if (!history || history.length === 0) return '<p style="color:var(--text-dim);font-size:0.75rem;">No data yet</p>';
    const rows = history.slice(-maxRows).reverse();
    // Compute effective session for entries at 100% with extra usage
    const planCost = (user && user.budget && user.numPlans) ? user.budget / user.numPlans : 200;
    const extraSpent = user ? (user.extraUsageSpent || 0) : 0;
    let html = `<div class="detail-table-wrap"><table class="detail-table">
      <thead><tr><th>Time</th><th>Session Slot</th><th>Session</th><th>Weekly (cumul.)</th><th>Source</th></tr></thead><tbody>`;
    rows.forEach((h, i) => {
      const ts = h.timestamp ? new Date(h.timestamp).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '--';
      let sessionDisplay = Math.round(h.sessionPct || 0);
      // Apply extra usage to the most recent entry if at 100%
      if (i === 0 && extraSpent > 0 && sessionDisplay >= 100) {
        sessionDisplay = Math.round(100 + (extraSpent / planCost) * 100);
      }
      html += `<tr>
        <td>${ts}</td>
        <td style="color:var(--text-dim)">${h.sessionSlot || '--'}</td>
        <td style="color:var(--accent-orange)">${sessionDisplay}%</td>
        <td style="color:var(--accent-purple)">${Math.round(h.weeklyPct || 0)}%</td>
        <td>${h.source || '--'}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    return html;
  }

  function renderWeeklyHistoryTable(weekly, maxRows = 20) {
    if (!weekly || weekly.length === 0) return '<p style="color:var(--text-dim);font-size:0.75rem;">No data yet</p>';
    const rows = weekly.slice(-maxRows).reverse();
    let html = `<div class="detail-table-wrap"><table class="detail-table">
      <thead><tr><th>Week</th><th>Avg Session</th><th>Peak Session</th><th>Avg Weekly</th><th>Peak Weekly</th><th>Points</th></tr></thead><tbody>`;
    rows.forEach(w => {
      html += `<tr>
        <td>${w.weekKey || '--'}</td>
        <td style="color:var(--accent-orange)">${Math.round(w.avgSessionPct || 0)}%</td>
        <td style="color:var(--accent-cyan)">${Math.round(w.peakSessionPct || 0)}%</td>
        <td style="color:var(--accent-purple)">${Math.round(w.avgWeeklyPct || 0)}%</td>
        <td style="color:var(--accent-pink)">${Math.round(w.peakWeeklyPct || 0)}%</td>
        <td>${w.dataPoints || 0}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    return html;
  }

  // ============================================================
  // SESSION & WEEKLY COUNTDOWNS
  // ============================================================
  // Claude Max: 5-hour session windows, weekly resets on user's cycle
  // Per-user countdown from actual scraped reset timestamps
  // Session: if expired, roll forward in 5-hour increments to find next reset
  // Weekly: if expired, roll forward in 7-day increments
  function formatCountdown(isoTimestamp, type = 'session') {
    if (!isoTimestamp) return null;
    let resetTime = new Date(isoTimestamp).getTime();
    const now = Date.now();
    if (resetTime <= now) {
      const interval = type === 'weekly' ? 7 * 86400000 : 5 * 3600000;
      // Roll forward to next cycle
      const elapsed = now - resetTime;
      const cycles = Math.floor(elapsed / interval) + 1;
      resetTime += cycles * interval;
    }
    const diff = resetTime - now;
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    if (d > 0) return { label: `${d}d ${h}h ${m}m` };
    if (h > 0) return { label: `${h}h ${m}m ${s}s` };
    return { label: `${m}m ${s}s` };
  }

  function renderCountdownBar(user) {
    const session = formatCountdown(user.sessionResetsAt, 'session');
    const weekly = formatCountdown(user.weeklyResetsAt, 'weekly');
    const sessionLabel = session ? session.label : '--';
    const weeklyLabel = weekly ? weekly.label : '--';
    const sessionSub = session ? '5-hour window' : 'no data yet';
    const weeklySub = weekly ? 'next billing cycle' : 'no data yet';
    const sessionEst = user.sessionResetSource === 'estimated';
    const weeklyEst = user.weeklyResetSource === 'estimated';
    const estHint = '<span class="reset-estimated" style="margin-left:6px;">i<span class="reset-tooltip">Estimated from usage drop. Update extension for accurate data.</span></span>';
    return `<div class="countdown-bar">
      <div class="countdown-card">
        <div class="countdown-label">Session Resets In ${sessionEst ? estHint : ''}</div>
        <div class="countdown-value" data-countdown-session="${escAttr(user.id)}">${sessionLabel}</div>
        <div class="countdown-sub">${sessionSub}</div>
      </div>
      <div class="countdown-card">
        <div class="countdown-label">Weekly Resets In ${weeklyEst ? estHint : ''}</div>
        <div class="countdown-value" data-countdown-weekly="${escAttr(user.id)}">${weeklyLabel}</div>
        <div class="countdown-sub">${weeklySub}</div>
      </div>
    </div>`;
  }

  // Update all countdowns every second (per-user in detail panel + inline headers)
  function updateCountdowns() {
    // Per-user countdowns in detail panel
    document.querySelectorAll('[data-countdown-session]').forEach(el => {
      const userId = el.dataset.countdownSession;
      const user = cachedData && cachedData.users ? cachedData.users.find(u => u.id === userId) : null;
      if (user && user.sessionResetsAt) {
        const cd = formatCountdown(user.sessionResetsAt, 'session');
        el.textContent = cd ? cd.label : '--';
      }
    });
    document.querySelectorAll('[data-countdown-weekly]').forEach(el => {
      const userId = el.dataset.countdownWeekly;
      const user = cachedData && cachedData.users ? cachedData.users.find(u => u.id === userId) : null;
      if (user && user.weeklyResetsAt) {
        const cd = formatCountdown(user.weeklyResetsAt, 'weekly');
        el.textContent = cd ? cd.label : '--';
      }
    });
    // Per-user countdowns in leaderboard rows
    document.querySelectorAll('[data-reset-session]').forEach(el => {
      const ts = el.dataset.resetSession;
      if (ts) {
        const cd = formatCountdown(ts, 'session');
        if (cd) el.textContent = cd.label;
      }
    });
    document.querySelectorAll('[data-reset-weekly]').forEach(el => {
      const ts = el.dataset.resetWeekly;
      if (ts) {
        const cd = formatCountdown(ts, 'weekly');
        if (cd) el.textContent = cd.label;
      }
    });
  }
  setInterval(updateCountdowns, 1000);
  updateCountdowns();

  // ============================================================
  // INIT
  // ============================================================
  // ============================================================
  // FAB (mobile actions)
  // ============================================================
  function toggleFab() {
    const fab = document.getElementById('fab');
    const menu = document.getElementById('fabMenu');
    fab.classList.toggle('open');
    menu.classList.toggle('open');
  }
  function closeFab() {
    document.getElementById('fab').classList.remove('open');
    document.getElementById('fabMenu').classList.remove('open');
  }

  document.getElementById('consolePaste').textContent = generateConsoleCode();
  render(true);
