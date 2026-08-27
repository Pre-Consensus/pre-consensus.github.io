/* ============================================================
   Pre-Consensus — static front end.

   Reads three things and computes everything else:
     data/portfolio.json  — cash, trades, position metadata (you edit this)
     data/prices.json     — quotes, refreshed by a GitHub Action
     data/theses/<T>.md   — the write-up for each position

   No build step. No server. Edit JSON, push, done.
   ============================================================ */

const state = { portfolio:null, prices:null, theses:{} };

/* ---------- tiny helpers ---------- */

const $ = (sel, root=document) => root.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => (
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
));

const money = (n, dp=2) => (n<0?'-':'') + '$' + Math.abs(n).toLocaleString('en-US',
  { minimumFractionDigits:dp, maximumFractionDigits:dp });

const pct = n => (n>0?'+':'') + (n*100).toFixed(2) + '%';

const dateLong = iso => {
  const d = new Date(iso + (iso.length===10 ? 'T12:00:00Z' : ''));
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
};

const dirClass = n => n > 0.00005 ? 'up' : n < -0.00005 ? 'down' : 'flat';

// Filled chip = up, outlined = down. Arrows carry the meaning for screen readers
// and for anyone printing this in black and white, which is all of it.
const chip = (n, big=false) => {
  const d = dirClass(n);
  const arrow = d==='up' ? '▲' : d==='down' ? '▼' : '–';
  return `<span class="chip ${d}${big?' lg':''}">${arrow} ${pct(n)}</span>`;
};

/* ---------- minimal markdown ----------
   Deliberately small: headings, bold, italic, links, lists, quotes, rules, code.
   Input is escaped first, so a thesis can never inject markup. */

function md(src){
  const lines = esc(src).replace(/\r\n/g,'\n').split('\n');
  const out = [];
  let list = null, para = [];

  const inline = t => t
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g,'$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');

  const flushPara = () => { if(para.length){ out.push('<p>'+inline(para.join(' '))+'</p>'); para=[]; } };
  const flushList = () => { if(list){ out.push('</'+list+'>'); list=null; } };
  const flush = () => { flushPara(); flushList(); };

  for(const raw of lines){
    const line = raw.trim();

    if(!line){ flush(); continue; }

    let m;
    if((m = line.match(/^(#{1,4})\s+(.*)$/))){
      flush();
      const lvl = Math.min(m[1].length + 1, 4);   // '#' in a thesis is an h2 on the page
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if(/^(---|\*\*\*|___)$/.test(line)){
      flush(); out.push('<hr>');
    } else if((m = line.match(/^(?:>|&gt;)\s?(.*)$/))){   // escaping runs first, so '>' arrives as '&gt;'
      flush(); out.push('<blockquote>'+inline(m[1])+'</blockquote>');
    } else if((m = line.match(/^[-*+]\s+(.*)$/))){
      flushPara();
      if(list !== 'ul'){ flushList(); out.push('<ul>'); list='ul'; }
      out.push('<li>'+inline(m[1])+'</li>');
    } else if((m = line.match(/^\d+[.)]\s+(.*)$/))){
      flushPara();
      if(list !== 'ol'){ flushList(); out.push('<ol>'); list='ol'; }
      out.push('<li>'+inline(m[1])+'</li>');
    } else {
      flushList();
      para.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/* ---------- portfolio math ----------
   One pass over the trade ledger produces everything the site displays.
   Realised P&L uses average cost, which is what a taxable US brokerage
   account reports by default. */

function computePosition(pos, price){
  let qty = 0, costBasis = 0, realized = 0, invested = 0, proceeds = 0;

  const trades = [...(pos.trades||[])].sort((a,b) => a.date.localeCompare(b.date));

  for(const t of trades){
    const fees = t.fees || 0;
    if(t.action === 'buy'){
      qty       += t.qty;
      costBasis += t.qty * t.price + fees;
      invested  += t.qty * t.price + fees;
    } else {
      const avg = qty > 0 ? costBasis / qty : 0;
      realized  += t.qty * t.price - avg * t.qty - fees;
      costBasis -= avg * t.qty;
      qty       -= t.qty;
      proceeds  += t.qty * t.price - fees;
    }
  }

  const avgCost   = qty > 0 ? costBasis / qty : 0;
  const last      = price ?? avgCost;              // fall back to cost if no quote yet
  const mktValue  = qty * last;
  const unrealized= mktValue - costBasis;
  const openRet   = costBasis > 0 ? unrealized / costBasis : 0;
  const isOpen    = qty > 0.00000001;

  return {
    ...pos, trades, qty, avgCost, last, mktValue, costBasis,
    unrealized, realized, openRet, isOpen, invested, proceeds,
    firstBuy: trades.find(t => t.action==='buy')?.date || null,
    hasQuote: price != null
  };
}

function computePortfolio(){
  const p = state.portfolio;
  const quotes = state.prices?.quotes || {};

  const positions = (p.positions||[]).map(pos =>
    computePosition(pos, quotes[pos.ticker]?.price)
  );

  let cash = p.startingCash;
  for(const pos of positions){
    for(const t of pos.trades){
      const fees = t.fees || 0;
      cash += t.action === 'buy' ? -(t.qty*t.price + fees) : (t.qty*t.price - fees);
    }
  }
  for(const c of (p.cashFlows||[])) cash += c.amount;

  const open      = positions.filter(x => x.isOpen);
  const closed    = positions.filter(x => !x.isOpen);
  const invested  = open.reduce((s,x) => s + x.mktValue, 0);
  const equity    = cash + invested;
  const contributed = p.startingCash + (p.cashFlows||[]).reduce((s,c)=>s+c.amount,0);
  const totalRet  = contributed > 0 ? equity/contributed - 1 : 0;

  for(const x of open) x.weight = equity > 0 ? x.mktValue/equity : 0;

  // Benchmark: bought once at inception, held. Apples to apples on the same dollars.
  const bench = p.benchmark;
  const benchLast = quotes[bench?.symbol]?.price;
  const benchRet = (bench && benchLast) ? benchLast/bench.startPrice - 1 : null;

  return { positions, open, closed, cash, invested, equity, contributed,
           totalRet, benchRet, bench, benchLast };
}

/* ---------- data loading ---------- */

async function loadJSON(path){
  const res = await fetch(path + '?t=' + Date.now());
  if(!res.ok) throw new Error(path + ' — ' + res.status);
  return res.json();
}

async function loadThesis(ticker){
  if(state.theses[ticker] !== undefined) return state.theses[ticker];
  try{
    const res = await fetch(`data/theses/${ticker}.md?t=${Date.now()}`);
    state.theses[ticker] = res.ok ? await res.text() : null;
  }catch{ state.theses[ticker] = null; }
  return state.theses[ticker];
}

function stampPrices(){
  const el = $('#price-stamp');
  const asOf = state.prices?.asOf;
  if(!asOf){ el.textContent = 'Prices unavailable'; return; }
  const t = new Date(asOf);
  const src = state.prices.delayed === false ? 'Real time' : 'Delayed 15 min';
  el.textContent = `${src} · Updated ${t.toLocaleString('en-US',
    {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`;
}

/* ---------- views ---------- */

function viewPortfolio(){
  const p = state.portfolio;
  const c = computePortfolio();

  const seedWarning = p.seedData ? `
    <div class="notice">
      <strong>PLACEHOLDER DATA.</strong> The positions below are examples, not real trades.
      Replace <code>data/portfolio.json</code> with your actual Public.com fills and delete
      <code>"seedData": true</code> before you point anyone at this site.
    </div>` : '';

  const rows = c.open
    .sort((a,b) => b.mktValue - a.mktValue)
    .map(x => `
      <tr onclick="location.hash='#/p/${encodeURIComponent(x.ticker)}'">
        <td>
          <span class="tkr">${esc(x.ticker)}</span>
          <span class="tkr-name">${esc(x.name||'')}</span>
        </td>
        <td class="mono">${x.firstBuy ? dateLong(x.firstBuy) : '—'}</td>
        <td class="mono">${money(x.avgCost)}</td>
        <td class="mono">${x.hasQuote ? money(x.last) : '—'}</td>
        <td>${chip(x.openRet)}</td>
        <td class="mono">${(x.weight*100).toFixed(1)}%<span class="wbar"><span style="width:${Math.min(x.weight*100,100).toFixed(1)}%"></span></span></td>
      </tr>`).join('');

  const closedBlock = c.closed.length ? `
    <section class="section">
      <div class="section-head">
        <h2>Closed</h2>
        <span class="note">Realised, and left on the record</span>
      </div>
      <div class="table-wrap">
        <table class="holdings">
          <thead><tr>
            <th>Position</th><th>Held</th><th>Avg cost</th><th>Exit</th><th>Result</th><th>P&amp;L</th>
          </tr></thead>
          <tbody>
            ${c.closed.map(x => {
              const exits = x.trades.filter(t=>t.action==='sell');
              const exitAvg = exits.reduce((s,t)=>s+t.price*t.qty,0) / Math.max(exits.reduce((s,t)=>s+t.qty,0),1);
              const ret = x.invested > 0 ? x.realized / x.invested : 0;
              const held = x.firstBuy && exits.length
                ? Math.round((new Date(exits.at(-1).date) - new Date(x.firstBuy)) / 86400000) + 'd' : '—';
              return `<tr onclick="location.hash='#/p/${encodeURIComponent(x.ticker)}'">
                <td><span class="tkr">${esc(x.ticker)}</span><span class="tkr-name">${esc(x.name||'')}</span></td>
                <td class="mono">${held}</td>
                <td class="mono">${money(x.invested / Math.max(x.trades.filter(t=>t.action==='buy').reduce((s,t)=>s+t.qty,0),1))}</td>
                <td class="mono">${money(exitAvg)}</td>
                <td>${chip(ret)}</td>
                <td class="mono">${money(x.realized)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>` : '';

  const benchStat = c.benchRet != null
    ? `<div class="stat-v">${pct(c.totalRet - c.benchRet).replace('+','+')}</div>
       <div class="stat-sub">${esc(c.bench.symbol)} ${pct(c.benchRet)} over the same window</div>`
    : `<div class="stat-v">—</div><div class="stat-sub">Benchmark quote pending</div>`;

  return `
    <section class="hero">
      <h1>${esc(p.headline || 'Conviction, priced in public.')}</h1>
      <p class="lede">${esc(p.subhead || '')}</p>
    </section>
    ${seedWarning}

    <div class="stats">
      <div class="stat">
        <div class="stat-k">Total return</div>
        <div class="stat-v">${pct(c.totalRet)}</div>
        <div class="stat-sub">Since ${dateLong(p.inceptionDate)}</div>
      </div>
      <div class="stat">
        <div class="stat-k">vs ${esc(c.bench?.symbol||'benchmark')}</div>
        ${benchStat}
      </div>
      <div class="stat">
        <div class="stat-k">Account value</div>
        <div class="stat-v">${money(c.equity, 0)}</div>
        <div class="stat-sub">${money(c.cash,0)} cash · ${((c.invested/Math.max(c.equity,1))*100).toFixed(0)}% invested</div>
      </div>
      <div class="stat">
        <div class="stat-k">Positions</div>
        <div class="stat-v">${c.open.length}</div>
        <div class="stat-sub">${c.closed.length} closed to date</div>
      </div>
    </div>

    <section class="section">
      <div class="section-head">
        <h2>Open positions</h2>
        <span class="note">Real money · Public.com · Click any row for the thesis</span>
      </div>
      <div class="table-wrap">
        <table class="holdings">
          <thead><tr>
            <th>Position</th><th>Entered</th><th>Avg cost</th><th>Last</th><th>Return</th><th>Weight</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="6" style="padding:40px 0;color:var(--mute)">No open positions yet.</td></tr>'}</tbody>
        </table>
      </div>
    </section>

    ${closedBlock}
  `;
}

/* ---------- video + documents ----------
   YouTube's real player is a heavy, colourful thing that would wreck both the
   load time and the look of the page. So we render a still frame ourselves and
   only load YouTube once the reader actually clicks. Nothing from Google is
   requested until then. */

function videoBlock(video){
  if(!video) return '';
  const id = String(video.id || video).trim();
  if(!/^[A-Za-z0-9_-]{11}$/.test(id)) return '';   // a YouTube id is exactly 11 chars
  const title = esc(video.title || 'Watch the walkthrough');
  const note  = video.note ? `<p class="video-note">${esc(video.note)}</p>` : '';
  return `
    <section class="section">
      <div class="section-head"><h2>Video</h2><span class="note">Plays here · hosted on YouTube</span></div>
      <div class="video" data-yt="${id}" role="button" tabindex="0"
           aria-label="Play video: ${title}">
        <img class="video-thumb" loading="lazy" alt=""
             src="https://i.ytimg.com/vi/${id}/maxresdefault.jpg"
             onerror="this.src='https://i.ytimg.com/vi/${id}/hqdefault.jpg'">
        <span class="video-play" aria-hidden="true"></span>
        <span class="video-title">${title}</span>
      </div>
      ${note}
    </section>`;
}

// Swap the still frame for the real player, once, on click.
function armVideos(root=document){
  root.querySelectorAll('.video[data-yt]').forEach(el => {
    const play = () => {
      const id = el.dataset.yt;
      el.classList.add('is-playing');
      el.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1"
        title="Video" frameborder="0" allow="accelerometer; autoplay; clipboard-write;
        encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    };
    el.addEventListener('click', play, { once:true });
    el.addEventListener('keydown', e => {
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); play(); }
    }, { once:true });
  });
}

function reportsBlock(reports){
  if(!reports || !reports.length) return '';
  return `
    <div class="side side-block">
      <h3>Reports</h3>
      ${reports.map(r => {
        const href = esc(r.file || r);
        const kind = href.split('.').pop().toUpperCase();
        return `<a class="doc" href="${href}" target="_blank" rel="noopener">
          <span class="doc-kind">${esc(kind)}</span>
          <span class="doc-body">
            <span class="doc-title">${esc(r.title || href.split('/').pop())}</span>
            ${r.date ? `<span class="doc-date">${dateLong(r.date)}</span>` : ''}
          </span>
        </a>`;
      }).join('')}
    </div>`;
}

async function viewPosition(ticker){
  const c = computePortfolio();
  const x = c.positions.find(p => p.ticker.toLowerCase() === ticker.toLowerCase());
  if(!x) return `<a class="back" href="#/">← Portfolio</a>
    <section class="hero"><h1>Not found</h1>
    <p class="lede">No position named &ldquo;${esc(ticker)}&rdquo; in this portfolio.</p></section>`;

  const thesis = await loadThesis(x.ticker);

  const ledger = x.trades.map(t => `
    <div class="entry">
      <div class="entry-date">${dateLong(t.date)}</div>
      <div class="entry-title">
        <span class="tag ${t.action==='buy'?'solid':''}">${t.action}</span>
        ${t.qty} @ ${money(t.price)}
      </div>
      ${t.note ? `<div class="entry-body">${md(t.note)}</div>` : ''}
    </div>`).join('');

  const updates = (x.updates||[])
    .slice().sort((a,b) => b.date.localeCompare(a.date))
    .map(u => `
      <div class="entry">
        <div class="entry-date">${dateLong(u.date)}</div>
        ${u.title ? `<div class="entry-title">${esc(u.title)}</div>` : ''}
        <div class="entry-body">${md(u.body||'')}</div>
      </div>`).join('');

  const pnl = x.isOpen ? x.unrealized : x.realized;
  const ret = x.isOpen ? x.openRet : (x.invested>0 ? x.realized/x.invested : 0);

  return `
    <a class="back" href="#/">← Portfolio</a>
    <section class="pos-head">
      <h1>${esc(x.ticker)}</h1>
      <p class="co">${esc(x.name||'')}${x.isOpen?'':' · closed'}</p>
      ${chip(ret, true)}
      <div class="pos-facts">
        <div><div class="fact-k">Entered</div><div class="fact-v">${x.firstBuy?dateLong(x.firstBuy):'—'}</div></div>
        <div><div class="fact-k">Avg cost</div><div class="fact-v">${money(x.isOpen ? x.avgCost : x.invested/Math.max(x.trades.filter(t=>t.action==='buy').reduce((s,t)=>s+t.qty,0),1))}</div></div>
        <div><div class="fact-k">${x.isOpen?'Last':'Exit'}</div><div class="fact-v">${x.isOpen ? (x.hasQuote?money(x.last):'—') : money(x.proceeds/Math.max(x.trades.filter(t=>t.action==='sell').reduce((s,t)=>s+t.qty,0),1))}</div></div>
        <div><div class="fact-k">${x.isOpen?'Unrealised':'Realised'} P&amp;L</div><div class="fact-v">${money(pnl)}</div></div>
        ${x.isOpen?`<div><div class="fact-k">Weight</div><div class="fact-v">${(x.weight*100).toFixed(1)}%</div></div>`:''}
      </div>
    </section>

    <div class="layout">
      <div>
        <div class="prose">
          ${thesis ? md(thesis) : `<p style="color:var(--mute)">No thesis written yet. Create
            <code>data/theses/${esc(x.ticker)}.md</code> and it appears here.</p>`}
        </div>

        ${videoBlock(x.video)}

        ${updates ? `<section class="section">
          <div class="section-head"><h2>Updates</h2><span class="note">Newest first</span></div>
          <div class="ledger">${updates}</div>
        </section>` : ''}
      </div>

      <aside>
        <div class="side side-block">
          <h3>Position</h3>
          <dl style="margin:0">
            <div class="kv"><dt>Shares</dt><dd>${x.qty.toLocaleString('en-US')}</dd></div>
            <div class="kv"><dt>Cost basis</dt><dd>${money(x.costBasis)}</dd></div>
            ${x.isOpen?`<div class="kv"><dt>Market value</dt><dd>${money(x.mktValue)}</dd></div>`:''}
            <div class="kv"><dt>Capital at risk</dt><dd>${money(x.invested)}</dd></div>
          </dl>
        </div>

        ${x.thesisIn ? `<div class="side side-block">
          <h3>One line</h3>
          <p style="margin:0;font-size:15px;line-height:1.6">${esc(x.thesisIn)}</p>
        </div>`:''}

        ${x.falsifiers?.length ? `<div class="side side-block">
          <h3>What proves me wrong</h3>
          <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.6">
            ${x.falsifiers.map(f=>`<li style="margin-bottom:8px">${esc(f)}</li>`).join('')}
          </ul>
        </div>`:''}

        ${reportsBlock(x.reports)}

        <div class="side side-block">
          <h3>Trade ledger</h3>
          <div class="ledger" style="border-top:0">${ledger}</div>
        </div>
      </aside>
    </div>
  `;
}

function viewLog(){
  const c = computePortfolio();
  const events = [];

  for(const x of c.positions){
    for(const t of x.trades){
      events.push({
        date:t.date, ticker:x.ticker, kind:t.action,
        title:`${t.action==='buy'?'Bought':'Sold'} ${esc(x.ticker)} — ${t.qty} @ ${money(t.price)}`,
        body:t.note || ''
      });
    }
    for(const u of (x.updates||[])){
      events.push({ date:u.date, ticker:x.ticker, kind:'note', title:u.title||`Update on ${x.ticker}`, body:u.body||'' });
    }
  }
  events.sort((a,b) => b.date.localeCompare(a.date));

  return `
    <section class="hero">
      <h1>Everything, in order.</h1>
      <p class="lede">Every action and every revision, oldest at the bottom. This page is the
      whole argument: if a call was made late, it shows here.</p>
    </section>
    <section class="section">
      ${events.map(e => `
        <div class="logrow">
          <div class="when">${dateLong(e.date)}</div>
          <div>
            <h3><span class="tag ${e.kind==='buy'?'solid':''}">${e.kind}</span>
              <a href="#/p/${encodeURIComponent(e.ticker)}">${esc(e.title)}</a></h3>
            ${e.body ? `<p>${esc(e.body).slice(0,260)}${e.body.length>260?'…':''}</p>` : ''}
          </div>
        </div>`).join('') || '<p style="color:var(--mute)">Nothing logged yet.</p>'}
    </section>`;
}

function viewMethod(){
  const p = state.portfolio;
  return `
    <section class="hero">
      <h1>How this works.</h1>
      <p class="lede">${esc(p.methodLede || 'The rules I hold myself to, written down before they were inconvenient.')}</p>
    </section>
    <div class="layout">
      <div class="prose">${md(p.method || '*Write your method in `portfolio.json` under `method`.*')}</div>
      <aside>
        <div class="side side-block">
          <h3>Ground rules</h3>
          <dl style="margin:0">
            <div class="kv"><dt>Capital</dt><dd>${money(p.startingCash,0)}</dd></div>
            <div class="kv"><dt>Inception</dt><dd>${dateLong(p.inceptionDate)}</dd></div>
            <div class="kv"><dt>Broker</dt><dd>${esc(p.broker||'Public.com')}</dd></div>
            <div class="kv"><dt>Benchmark</dt><dd>${esc(p.benchmark?.symbol||'—')}</dd></div>
          </dl>
        </div>
      </aside>
    </div>`;
}

/* ---------- router ---------- */

async function render(){
  const app = $('#app');
  const hash = location.hash.replace(/^#/,'') || '/';
  const [,route,arg] = hash.split('/');

  let html;
  if(route === 'p' && arg)       html = await viewPosition(decodeURIComponent(arg));
  else if(route === 'log')       html = viewLog();
  else if(route === 'method')    html = viewMethod();
  else                           html = viewPortfolio();

  app.innerHTML = html;
  armVideos(app);
  window.scrollTo(0,0);

  document.querySelectorAll('.nav a').forEach(a => {
    const target = a.getAttribute('href').replace(/^#/,'');
    a.classList.toggle('is-active', target === '/' ? (route===undefined||route==='') : target === '/'+route);
  });
}

/* ---------- boot ---------- */

async function boot(){
  $('#footer-year').textContent = new Date().getFullYear();

  try{
    state.portfolio = await loadJSON('data/portfolio.json');
  }catch(err){
    $('#app').innerHTML = `<div class="notice" style="margin-top:60px">
      <strong>Could not load data/portfolio.json.</strong><br><br>
      ${esc(err.message)}<br><br>
      If you opened this file directly from Finder, the browser blocks local fetches.
      Run <code>python3 -m http.server 8080</code> in this folder and visit
      <code>localhost:8080</code> instead.</div>`;
    return;
  }

  try{ state.prices = await loadJSON('data/prices.json'); }
  catch{ state.prices = { quotes:{}, asOf:null }; }

  if(state.portfolio.repoUrl){
    // Point at the history of the decision files, not the whole repo — the price
    // bot commits every half hour and would otherwise bury the trades.
    const base = state.portfolio.repoUrl.replace(/\/+$/,'');
    const branch = state.portfolio.repoBranch || 'main';
    $('#repo-link').href = /github\.com/.test(base)
      ? `${base}/commits/${branch}/data`
      : base;
    $('#repo-link-wrap').hidden = false;
  }
  if(state.portfolio.siteTitle) document.title = state.portfolio.siteTitle;

  stampPrices();
  await render();
  window.addEventListener('hashchange', render);

  // Keep the page live without a reload: re-pull quotes every 60s.
  setInterval(async () => {
    try{
      const fresh = await loadJSON('data/prices.json');
      if(fresh.asOf !== state.prices.asOf){
        state.prices = fresh;
        stampPrices();
        await render();
      }
    }catch{ /* offline or mid-deploy; keep showing the last good quotes */ }
  }, 60000);
}

boot();
