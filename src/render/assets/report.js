/* tokenscope report client - vanilla JS, no dependencies. Data comes from #ts-data. */
(function () {
  'use strict';
  var R = JSON.parse(document.getElementById('ts-data').textContent);
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var usd = function (n) {
    if (!n) return '$0.00';
    if (Math.abs(n) < 0.01) return '<$0.01';
    if (Math.abs(n) >= 10000) return '$' + Math.round(n).toLocaleString('en-US');
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var tok = function (n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  };
  var pct = function (n, d) { return (n * 100).toFixed(d == null ? 1 : d) + '%'; };
  var dshort = function (ts) {
    return ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-';
  };
  var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };
  var metric = 'v'; // 'v' = USD, 't' = tokens
  var fmtM = function (n) { return metric === 'v' ? usd(n) : tok(n) + ' tok'; };

  /* ---------- theme ---------- */
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('ts-theme'); } catch (e) { /* file:// may block */ }
  if (saved) root.setAttribute('data-theme', saved);
  else if (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) root.setAttribute('data-theme', 'light');
  $('#theme').addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('ts-theme', next); } catch (e) { /* ignore */ }
    renderAll();
  });

  /* ---------- KPIs ---------- */
  var T = R.totals;
  var range = dshort(R.range.start) + ' – ' + dshort(R.range.end);
  $('#meta').textContent =
    R.coverage.map(function (c) { return c.name; }).join(' + ') +
    ' · ' + range + ' · generated ' + new Date(R.generatedAt).toLocaleString();
  var allUnchecked = T.uncheckedSessions >= T.sessions;
  var kpis = [
    allUnchecked
      ? { cls: 'hero', label: 'Estimated waste', value: 'n/a', sub: 'these logs lack the data waste detectors need' }
      : {
          cls: 'hero warn', label: 'Looks wasted (est.)', value: usd(T.wasteCost),
          sub: (T.cost ? pct(T.wasteCost / T.cost, 0) + ' of ' + usd(T.cost) + ' · ' : '') + usd(T.avoidableCost) + ' avoidable + ' + usd(T.likelyAvoidableCost) + ' likely avoidable',
        },
    { label: 'Total spend', value: usd(T.cost), sub: tok(T.tokens) + ' tokens' },
    { label: 'Sessions', value: T.sessions.toLocaleString('en-US'), sub: T.subagents ? '+' + T.subagents + ' subagents' : T.turns + ' turns' },
    { label: 'API calls', value: T.calls.toLocaleString('en-US'), sub: T.toolCalls.toLocaleString('en-US') + ' tool calls' },
    { label: 'Cache hit rate', value: pct(T.cacheHitRate), sub: 'saved ' + usd(Math.max(0, T.costWithoutCache - T.cost)) + ' vs uncached' },
    { label: 'Waste findings', value: String(R.findings.length), sub: T.partiallyCheckedSessions ? T.partiallyCheckedSessions + ' sessions only partly checked' : 'all sessions fully checked' },
  ];
  $('#kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi ' + (k.cls || '') + '"><div class="label">' + esc(k.label) + '</div><div class="value">' + esc(k.value) +
      '</div><div class="sub">' + esc(k.sub) + '</div></div>';
  }).join('');

  var KIND = { loop: 'Loops', repeat: 'Repeated calls', reread: 'Unchanged re-reads', 'huge-output': 'Huge outputs', 'cache-miss': 'Cache rebuilds' };

  /* ---------- tooltip ---------- */
  var tip = $('#tip');
  function showTip(html, e) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    var x = e.clientX + 14, y = e.clientY + 14;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }

  /* ---------- tree prep ---------- */
  var nodes = [];
  (function index(n, parent, depth) {
    n.id = nodes.length; n.p = parent; n.depth = depth; nodes.push(n);
    (n.c || []).forEach(function (c) { index(c, n, depth + 1); });
  })(R.tree, null, 0);
  var KIND_LABEL = { root: 'all', project: 'project', session: 'session', turn: 'turn', call: 'API call', agent: 'subagent', more: 'collapsed' };
  var GROUPS = [
    ['shell', 'Shell / Bash'], ['edit', 'Edit / Write'], ['read', 'Read / Search'], ['web', 'Web / MCP'],
    ['agent', 'Subagents'], ['text', 'Thinking / text'], ['other', 'Other tools'],
  ];
  function color(n) {
    if (n.k === 'call' || n.k === 'agent' || n.k === 'more') return 'var(--s-' + (n.g || 'other') + ')';
    return 'var(--lvl-' + Math.min(3, n.depth) + ')';
  }
  $('#flame-legend').innerHTML = GROUPS.map(function (g) {
    return '<span><i style="background:var(--s-' + g[0] + ')"></i>' + g[1] + '</span>';
  }).join('');

  /* ---------- flame graph (icicle) ---------- */
  var zoom = R.tree;
  var ROW = 26;
  function ancestors(n) { var a = []; while (n) { a.unshift(n); n = n.p; } return a; }
  function renderFlame() {
    var el = $('#flame');
    var W = el.clientWidth;
    var html = [];
    var maxDepth = 0;
    var total = zoom[metric] || 1e-12;
    function lay(n, x, w, d) {
      if (w < 0.6) return;
      maxDepth = Math.max(maxDepth, d);
      var light = n.k !== 'call' && n.k !== 'agent' && n.k !== 'more';
      var dark = !light && n.g === 'web' && root.getAttribute('data-theme') === 'light';
      var label = w > 34 ? esc(n.n) + (w > 160 ? ' <span style="opacity:.75">' + fmtM(n[metric]) + '</span>' : '') : '';
      html.push('<div class="n' + (light || dark ? ' l' : '') + '" data-id="' + n.id + '" style="left:' + x.toFixed(2) + 'px;top:' + d * ROW +
        'px;width:' + Math.max(0, w - 1).toFixed(2) + 'px;background:' + color(n) + '">' + label + '</div>');
      var cx = x;
      (n.c || []).forEach(function (c) {
        var cw = (c[metric] / total) * W;
        lay(c, cx, cw, d + 1);
        cx += cw;
      });
    }
    lay(zoom, 0, W, 0);
    el.style.height = (maxDepth + 1) * ROW + 'px';
    el.innerHTML = html.join('');
    var crumbs = ancestors(zoom);
    $('#crumbs').innerHTML = crumbs.map(function (n, i) {
      return (i ? '<span class="sep">›</span>' : '') + '<a data-id="' + n.id + '" title="' + esc(n.n) + '">' + esc(n.n) + '</a>';
    }).join('');
  }
  function zoomTo(n) { zoom = n; renderFlame(); }
  $('#flame').addEventListener('click', function (e) {
    var t = e.target.closest('.n');
    if (!t) return;
    var n = nodes[+t.dataset.id];
    zoomTo(n === zoom && n.p ? n.p : n);
  });
  $('#crumbs').addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (a) zoomTo(nodes[+a.dataset.id]);
  });
  $('#flame').addEventListener('mousemove', function (e) {
    var t = e.target.closest('.n');
    if (!t) return hideTip();
    var n = nodes[+t.dataset.id];
    var share = R.tree[metric] ? n[metric] / R.tree[metric] : 0;
    var zshare = zoom[metric] ? n[metric] / zoom[metric] : 0;
    showTip('<b>' + esc(n.n) + '</b><div class="v">' + usd(n.v) + ' <span class="m" style="font-size:13px">· ' + tok(n.t) + ' tok</span></div>' +
      '<div class="m">' + KIND_LABEL[n.k] + ' · ' + pct(share) + ' of total' + (zoom !== R.tree ? ' · ' + pct(zshare) + ' of view' : '') + '</div>' +
      (n.d ? '<div style="margin-top:6px">' + esc(n.d) + '</div>' : '') +
      '<div class="m" style="margin-top:6px;font-size:11.5px">click to zoom' + (n.c ? '' : '') + '</div>', e);
  });
  $('#flame').addEventListener('mouseleave', hideTip);
  document.querySelectorAll('#metric button').forEach(function (b) {
    b.addEventListener('click', function () {
      metric = b.dataset.m;
      document.querySelectorAll('#metric button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      renderFlame();
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && zoom.p) zoomTo(zoom.p);
  });

  /* ---------- treemap (squarified) ---------- */
  var PROJ_COLORS = ['--s-shell', '--s-edit', '--s-read', '--s-web', '--s-agent', '--s-text'];
  function squarify(items, x, y, w, h) {
    var out = [];
    var total = items.reduce(function (s, i) { return s + i.value; }, 0);
    if (!total) return out;
    var scale = (w * h) / total;
    var rest = items.map(function (i) { return { item: i, area: i.value * scale }; }).filter(function (r) { return r.area > 0; });
    function worst(row, side) {
      var s = 0, mx = 0, mn = Infinity;
      row.forEach(function (r) { s += r.area; mx = Math.max(mx, r.area); mn = Math.min(mn, r.area); });
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    }
    while (rest.length) {
      var side = Math.min(w, h);
      var row = [rest[0]];
      var i = 1;
      while (i < rest.length && worst(row.concat([rest[i]]), side) <= worst(row, side)) { row.push(rest[i]); i++; }
      rest = rest.slice(i);
      var s = row.reduce(function (a, r) { return a + r.area; }, 0);
      if (w >= h) {
        var cw = s / h, cy = y;
        row.forEach(function (r) { var rh = r.area / cw; out.push({ item: r.item, x: x, y: cy, w: cw, h: rh }); cy += rh; });
        x += cw; w -= cw;
      } else {
        var ch = s / w, cx = x;
        row.forEach(function (r) { var rw = r.area / ch; out.push({ item: r.item, x: cx, y: y, w: rw, h: ch }); cx += rw; });
        y += ch; h -= ch;
      }
    }
    return out;
  }
  function renderTreemap() {
    var el = $('#treemap');
    var W = el.clientWidth, H = el.clientHeight;
    var projects = (R.tree.c || []).slice(0, 6);
    var others = (R.tree.c || []).slice(6);
    var items = projects.map(function (p, i) { return { node: p, value: p[metric], color: 'var(' + PROJ_COLORS[i] + ')' }; });
    if (others.length) {
      var ov = others.reduce(function (s, p) { return s + p[metric]; }, 0);
      items.push({ node: R.tree, value: ov, color: 'var(--s-other)', label: others.length + ' other projects', children: others });
    }
    var html = [];
    var legend = [];
    squarify(items, 0, 0, W, H).forEach(function (pr) {
      legend.push('<span><i style="background:' + pr.item.color + '"></i>' + esc(pr.item.label || pr.item.node.n) + ' · ' + fmtM(pr.item.value) + '</span>');
      var kids = (pr.item.children || pr.item.node.c || []).map(function (s) { return { node: s, value: s[metric] }; })
        .sort(function (a, b) { return b.value - a.value; });
      squarify(kids, pr.x + 1, pr.y + 1, Math.max(0, pr.w - 2), Math.max(0, pr.h - 2)).forEach(function (r) {
        var big = r.w > 90 && r.h > 34;
        var dark = pr.item.color === 'var(--s-web)' && root.getAttribute('data-theme') === 'light';
        html.push('<div class="tm" data-id="' + r.item.node.id + '" style="left:' + (r.x + 1) + 'px;top:' + (r.y + 1) + 'px;width:' + Math.max(0, r.w - 2) +
          'px;height:' + Math.max(0, r.h - 2) + 'px;background:' + pr.item.color + (dark ? ';color:#0b0b0b' : '') + '">' +
          (big ? '<b>' + esc(r.item.node.n) + '</b><span>' + fmtM(r.item.value) + '</span>' : '') + '</div>');
      });
    });
    el.innerHTML = html.join('');
    $('#treemap-legend').innerHTML = legend.join('');
  }
  $('#treemap').addEventListener('mousemove', function (e) {
    var t = e.target.closest('.tm');
    if (!t) return hideTip();
    var n = nodes[+t.dataset.id];
    showTip('<b>' + esc(n.n) + '</b><div class="v">' + usd(n.v) + '</div><div class="m">' + esc(n.p ? n.p.n : '') + ' · ' + tok(n.t) + ' tok</div>' +
      (n.d ? '<div style="margin-top:6px">' + esc(n.d) + '</div>' : '') + '<div class="m" style="margin-top:6px;font-size:11.5px">click to open in flame graph</div>', e);
  });
  $('#treemap').addEventListener('mouseleave', hideTip);
  $('#treemap').addEventListener('click', function (e) {
    var t = e.target.closest('.tm');
    if (!t) return;
    zoomTo(nodes[+t.dataset.id]);
    $('#flame-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ---------- daily spend ---------- */
  function renderDaily() {
    var el = $('#daily');
    var days = R.byDay;
    if (!days.length) { el.innerHTML = '<div class="empty">No dated calls</div>'; return; }
    // fill gaps so the time axis is honest
    var filled = [];
    var byName = {};
    days.forEach(function (d) { byName[d.name] = d; });
    var cur = new Date(days[0].name + 'T00:00:00');
    var last = new Date(days[days.length - 1].name + 'T00:00:00');
    while (cur <= last && filled.length < 400) {
      var key = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
      filled.push(byName[key] || { name: key, cost: 0, calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
      cur.setDate(cur.getDate() + 1);
    }
    var W = el.clientWidth, H = 220, padL = 52, padB = 24, padT = 8;
    var max = Math.max.apply(null, filled.map(function (d) { return d.cost; })) || 1;
    var nice = niceMax(max);
    var bw = (W - padL) / filled.length;
    var svg = ['<svg width="' + W + '" height="' + H + '" role="img" aria-label="Daily spend">'];
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (H - padB - padT) * (1 - g / 4);
      svg.push('<line x1="' + padL + '" x2="' + W + '" y1="' + gy + '" y2="' + gy + '" stroke="' + css('--grid') + '" stroke-width="1"/>');
      svg.push('<text x="' + (padL - 8) + '" y="' + (gy + 4) + '" text-anchor="end">' + usd((nice * g) / 4).replace('.00', '') + '</text>');
    }
    var step = Math.ceil(filled.length / Math.max(1, Math.floor((W - padL) / 70)));
    filled.forEach(function (d, i) {
      var h = ((H - padB - padT) * d.cost) / nice;
      var x = padL + i * bw + Math.min(2, bw * 0.15);
      var w = Math.max(1, bw - Math.min(4, bw * 0.3));
      var y = H - padB - h;
      if (h > 0) svg.push('<path d="' + roundTop(x, y, w, h, Math.min(4, w / 2)) + '" fill="' + css('--accent') + '"/>');
      svg.push('<rect class="hit" data-i="' + i + '" x="' + (padL + i * bw) + '" y="' + padT + '" width="' + bw + '" height="' + (H - padB - padT) + '" fill="transparent"/>');
      if (i % step === 0) svg.push('<text x="' + (padL + i * bw + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + dshort(new Date(d.name + 'T12:00:00').getTime()) + '</text>');
    });
    svg.push('<line x1="' + padL + '" x2="' + W + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '" stroke="' + css('--axis') + '"/>');
    svg.push('</svg>');
    el.innerHTML = svg.join('');
    el.onmousemove = function (e) {
      var t = e.target.closest('.hit');
      if (!t) return hideTip();
      var d = filled[+t.dataset.i];
      var u = d.usage;
      showTip('<b>' + new Date(d.name + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + '</b><div class="v">' + usd(d.cost) + '</div>' +
        '<div class="m">' + d.calls.toLocaleString('en-US') + ' API calls · ' + tok(u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h) + ' tok</div>', e);
    };
    el.onmouseleave = hideTip;
  }
  function niceMax(v) {
    // top of axis = 4 x a "nice" step, so every gridline label is a round number
    var raw = v / 4;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var m = [1, 2, 5, 10].find(function (s) { return s * p >= raw; });
    return 4 * m * p;
  }
  function roundTop(x, y, w, h, r) {
    r = Math.min(r, h);
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
  }

  /* ---------- token mix ---------- */
  function renderMix() {
    var c = R.costByType, u = T.usage;
    var rows = [
      ['Input (uncached)', c.input, u.input, '--t-input'],
      ['Cache write', c.cacheWrite, u.cacheWrite5m + u.cacheWrite1h, '--t-cw'],
      ['Cache read', c.cacheRead, u.cacheRead, '--t-cr'],
      ['Output', c.output, u.output, '--t-out'],
    ];
    var tot = rows.reduce(function (s, r) { return s + r[1]; }, 0) || 1;
    $('#mix').innerHTML = '<div class="mix">' + rows.filter(function (r) { return r[1] / tot > 0.002; }).map(function (r) {
      return '<div title="' + esc(r[0]) + ' ' + usd(r[1]) + '" style="flex:' + r[1] + ';background:var(' + r[3] + ')"></div>';
    }).join('') + '</div><div class="mixrows">' + rows.map(function (r) {
      return '<i style="background:var(' + r[3] + ')"></i><span>' + r[0] + '</span><span class="num">' + tok(r[2]) + ' tok</span><span class="num"><b>' + usd(r[1]) + '</b> · ' + pct(r[1] / tot, 0) + '</span>';
    }).join('') + '</div>';
  }

  /* ---------- tables ---------- */

  var wasteFilter = 'all';
  function renderFindings() {
    var counts = {};
    R.findings.forEach(function (f) { counts[f.kind] = (counts[f.kind] || 0) + 1; });
    $('#waste-filters').innerHTML = ['all'].concat(Object.keys(KIND).filter(function (k) { return counts[k]; })).map(function (k) {
      return '<button data-k="' + k + '" aria-pressed="' + (wasteFilter === k) + '">' + (k === 'all' ? 'All ' + R.findings.length : KIND[k] + ' ' + counts[k]) + '</button>';
    }).join('');
    var list = R.findings.filter(function (f) { return wasteFilter === 'all' || f.kind === wasteFilter; }).slice(0, 200);
    if (!list.length) { $('#findings').innerHTML = '<div class="empty">No waste detected. Your agent is running lean.</div>'; return; }
    $('#findings').innerHTML = '<table><thead><tr><th>Severity</th><th>Type</th><th>Finding</th><th>Project</th><th class="num">Tokens</th><th class="num">Est. cost</th></tr></thead><tbody>' +
      list.map(function (f) {
        return '<tr class="click" data-s="' + esc(f.sessionId) + '"><td><span class="chip ' + f.severity + '"><i></i>' + f.severity + '</span>' + (f.certainty === 'likely-avoidable' ? '<div class="d">likely</div>' : '') + '</td><td class="kind">' + KIND[f.kind] +
          '</td><td><div class="t" title="' + esc(f.title) + '">' + esc(f.title) + '</div><div class="d">' + esc(f.detail) + '</div><div class="tipline">↳ ' + esc(f.tip) + '</div></td><td>' + esc(f.project) +
          '</td><td class="num">' + tok(f.tokens) + '</td><td class="num"><b>' + usd(f.cost) + '</b></td></tr>';
      }).join('') + '</tbody></table>';
  }
  $('#waste-filters').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    wasteFilter = b.dataset.k;
    renderFindings();
  });
  function sessionNode(id) {
    return nodes.find(function (n) { return n.k === 'session' && n.s === id; }) || null;
  }
  function gotoSession(id) {
    var n = sessionNode(id);
    if (!n) return;
    zoomTo(n);
    $('#flame-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#findings').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-s]');
    if (tr) gotoSession(tr.dataset.s);
  });

  var sortKey = 'cost', sortDir = -1;
  var COLS = [
    ['cost', 'Cost', true], ['start', 'Date', false], ['project', 'Project', false], ['title', 'Session', false],
    ['calls', 'Calls', true], ['subagents', 'Subagents', true], ['cacheHitRate', 'Cache hit', true], ['waste', 'Waste', true],
  ];
  function renderSessions() {
    var list = R.sessions.slice().sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (typeof x === 'string' || typeof y === 'string') return sortDir * String(x || '').localeCompare(String(y || ''));
      return sortDir * ((x || 0) - (y || 0));
    });
    $('#sessions').innerHTML = '<table><thead><tr>' + COLS.map(function (c) {
      return '<th data-k="' + c[0] + '"' + (c[2] ? ' class="num"' : '') + '>' + c[1] + (sortKey === c[0] ? (sortDir < 0 ? ' ↓' : ' ↑') : '') + '</th>';
    }).join('') + '</tr></thead><tbody>' + list.map(function (s) {
      return '<tr class="click" data-s="' + esc(s.id) + '"><td class="num"><b>' + usd(s.cost) + '</b></td><td>' + dshort(s.start) + '</td><td>' + esc(s.project) +
        '</td><td><div class="t" title="' + esc(s.title || s.id) + '">' + esc(s.title || s.id.slice(0, 8)) + '</div><div class="d">' + esc(s.models.join(', ')) + ' · ' + s.turns + ' turns</div></td><td class="num">' +
        s.calls.toLocaleString('en-US') + '</td><td class="num">' + (s.subagents ? s.subagents + ' · ' + usd(s.subagentCost) : '–') + '</td><td class="num">' + pct(s.cacheHitRate, 0) +
        '</td><td class="num">' + (s.waste === null ? '<span class="d" title="logs lack the data waste checks need">n/a</span>' : s.waste ? usd(s.waste) : '–') + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  $('#sessions').addEventListener('click', function (e) {
    var th = e.target.closest('th');
    if (th) {
      var k = th.dataset.k;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = typeof R.sessions[0][k] === 'string' ? 1 : -1; }
      return renderSessions();
    }
    var tr = e.target.closest('tr[data-s]');
    if (tr) gotoSession(tr.dataset.s);
  });

  function renderSmall() {
    $('#models').innerHTML = '<table><thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Output</th><th class="num">Cost</th></tr></thead><tbody>' +
      R.byModel.map(function (m) {
        return '<tr><td>' + esc(m.name) + '</td><td class="num">' + m.calls.toLocaleString('en-US') + '</td><td class="num">' + tok(m.usage.output) + '</td><td class="num"><b>' + usd(m.cost) + '</b></td></tr>';
      }).join('') + '</tbody></table>' +
      (R.unknownModels.length ? '<p class="d">No pricing for: ' + esc(R.unknownModels.join(', ')) + ' (counted as $0)</p>' : '');
    $('#tools').innerHTML = '<table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Output</th><th class="num">Cost*</th></tr></thead><tbody>' +
      R.byTool.slice(0, 15).map(function (t) {
        return '<tr><td>' + esc(t.name) + '</td><td class="num">' + t.calls.toLocaleString('en-US') + '</td><td class="num">' + (t.errors || '–') + '</td><td class="num">' + tok(t.resultTokens) + '</td><td class="num"><b>' + usd(t.cost) + '</b></td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- waste overview ---------- */
  var KIND_ORDER = ['cache-miss', 'loop', 'repeat', 'reread', 'huge-output'];
  var KIND_COLOR = { 'cache-miss': '--s-edit', loop: '--s-agent', repeat: '--s-web', reread: '--s-read', 'huge-output': '--s-shell' };
  function renderWasteOverview() {
    var by = {};
    R.findings.forEach(function (f) {
      var b = by[f.kind] || (by[f.kind] = { n: 0, cost: 0, tips: {}, likely: f.certainty === 'likely-avoidable' });
      b.n++; b.cost += f.cost;
      // one tip per cache-rebuild cause, one per other kind (agents differ only in the instructions file name)
      var key = f.kind === 'cache-miss' ? f.cause : 'k';
      var cur = b.tips[key];
      if (!cur || f.cost > cur.cost) b.tips[key] = { tip: f.tip, cost: (cur ? cur.cost : 0) + f.cost };
      else cur.cost += f.cost;
    });
    var max = Math.max.apply(null, KIND_ORDER.map(function (k) { return by[k] ? by[k].cost : 0; }).concat([1e-9]));
    var rows = KIND_ORDER.map(function (k) {
      var b = by[k];
      var cov = R.coverage.map(function (c) { return c.detectors.find(function (d) { return d.kind === k; }); });
      var none = cov.every(function (d) { return d && d.status === 'no'; });
      var value = b ? usd(b.cost) : none ? 'not checked' : '$0.00';
      return '<div class="wrow"><div class="wname">' + KIND[k] + (b && b.likely ? ' <span class="d">(likely)</span>' : '') + '<div class="d">' + (b ? b.n + ' finding' + (b.n > 1 ? 's' : '') : none ? 'logs lack the data' : 'none found') + '</div></div>' +
        '<div class="wbar"><div style="width:' + (b ? Math.max(1, (b.cost / max) * 100) : 0) + '%;background:var(' + KIND_COLOR[k] + ')"></div></div><div class="num"><b>' + value + '</b></div></div>' +
        (b ? Object.keys(b.tips).map(function (k) { return b.tips[k]; }).sort(function (x, y) { return y.cost - x.cost; }).slice(0, 2).map(function (t) { return '<div class="wtip">↳ ' + esc(t.tip) + '</div>'; }).join('') : '');
    }).join('');
    var MARK = { yes: '✓', partial: '◐', no: '✗' };
    var cov = '<table class="cov"><thead><tr><th>Agent</th>' + KIND_ORDER.map(function (k) { return '<th>' + KIND[k] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      R.coverage.map(function (c) {
        return '<tr><td>' + esc(c.name) + (c.verified ? '' : ' <span class="d">experimental</span>') + '</td>' + KIND_ORDER.map(function (k) {
          var d = c.detectors.find(function (x) { return x.kind === k; });
          return '<td class="m-' + d.status + '" title="' + esc(d.missing.length ? 'logs don\'t record: ' + d.missing.join(', ') : 'available') + '">' + MARK[d.status] + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
    $('#waste-overview').innerHTML = rows + '<div class="hd" style="margin:18px 0 6px"><h2 style="font-size:13px">Which checks could run</h2><span class="hint">a check only runs when the logs contain the data it needs - missing data is never counted as $0 waste</span></div>' + cov;
  }

  function renderAll() {
    renderFlame();
    renderTreemap();
    renderDaily();
    renderMix();
  }
  renderAll();
  renderWasteOverview();
  renderFindings();
  renderSessions();
  renderSmall();
  var rt;
  addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(renderAll, 120); });
})();
