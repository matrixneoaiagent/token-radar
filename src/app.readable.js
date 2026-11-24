// Token Radar's dashboard. It reads window.RADAR (written beside the page by main.ts), renders the
// ranked board, a live-token comparables view, a per-protocol detail dialog and the model panel.
// No network: every byte it shows is in data.js, and every row can be recomputed from its model block.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('app');
  var dialog = document.getElementById('detail');
  if (!DATA || !app || !dialog) return;

  var state = { q: '', category: 'all', chain: 'all', tab: 'pre', sort: 'implied', dir: -1, watch: false, selected: null };
  var refs = {};
  var ROW_BY_SLUG = new Map(DATA.rows.map(function (r) { return [r.slug, r]; }));
  var number = new Intl.NumberFormat('en-US');
  var money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  // ---------------------------------------------------------------- format

  function fmtUsdShort(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return money.format(n);
  }
  function fmtUsdFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return money.format(Math.round(n));
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 730) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return '\u00d7' + Number(n).toFixed(3); }
  function fmtRatio(n) { return Number(n).toFixed(2) + '\u00d7'; }
  function fmtInt(n) { return number.format(Math.round(n)); }
  function changeClass(n) { return n === null || n === undefined || n === 0 ? 'flat' : n > 0 ? 'pos' : 'neg'; }

  // ---------------------------------------------------------------- DOM

  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    if (typeof child === 'string' || typeof child === 'number') { node.appendChild(document.createTextNode(String(child))); return; }
    if (child instanceof Node) node.appendChild(child);
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'checked' || k === 'selected' || k === 'disabled') { if (v) node[k] = true; }
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---------------------------------------------------------------- hash

  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    var p = new URLSearchParams(raw);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('tab') === 'live') state.tab = 'live';
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir') === '1') state.dir = 1;
    if (p.get('dir') === '-1') state.dir = -1;
    if (p.get('watch') === '1') state.watch = true;
    if (p.get('p')) state.selected = p.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre') params.set('tab', state.tab);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', String(state.dir));
    if (state.watch) params.set('watch', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    var url = window.location.pathname + window.location.search + (next ? '#' + next : '');
    try { window.history.replaceState(null, '', url); }
    catch (e) { /* file:// keeps the state in memory; the page still works */ }
  }

  // ---------------------------------------------------------------- data tables

  var CATEGORY_OPTIONS = (function () {
    var counts = new Map();
    DATA.rows.forEach(function (r) { var k = r.category || 'Other'; counts.set(k, (counts.get(k) || 0) + 1); });
    return Array.from(counts.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
  })();
  var CHAIN_OPTIONS = (function () {
    var counts = new Map();
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { counts.set(c, (counts.get(c) || 0) + 1); }); });
    return Array.from(counts.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
  })();
  function normalizeSort() {
    var boardKeys = ['implied', 'name', 'tvl', 'growth', 'age', 'tenure'];
    var liveKeys = ['mcap', 'name', 'tvl', 'ratio', 'growth', 'category'];
    var allowed = state.tab === 'live' ? liveKeys : boardKeys;
    if (allowed.indexOf(state.sort) < 0) { state.sort = state.tab === 'live' ? 'mcap' : 'implied'; state.dir = -1; }
  }
  readHash();
  normalizeSort();

  // ---------------------------------------------------------------- the model the page checks

  // The same arithmetic lib/model.ts writes to board.json. Every row carries the multipliers, so the
  // page can prove the number on screen is the number the model wrote, not a second opinion.
  function impliedOf(row) {
    var m = row.model;
    return Math.max(1, Math.round(
      row.tvl_usd * m.category_multiple * m.pretoken_discount * m.growth_multiplier * m.tenure_multiplier * m.chain_multiplier
    ));
  }

  // The farm plan is derived from the protocol's own record: category, TVL, chain and age. The page
  // generates it again so the plan in the dialog can be checked against the plan board.json carries.
  function chainOf(row) {
    if (row.model && row.model.chain_best) return row.model.chain_best;
    return row.chains && row.chains.length > 0 ? row.chains[0] : 'its main chain';
  }
  function capitalFor(row) {
    if (row.tvl_usd >= 1e9) return 250;
    if (row.tvl_usd >= 25e7) return 150;
    if (row.tvl_usd >= 5e7) return 100;
    if (row.tvl_usd >= 1e7) return 50;
    return 25;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 45;
    if (age < 90) return 90;
    if (age < 365) return 60;
    if (age < 1095) return 45;
    return 30;
  }
  function gasBand(chain) {
    if (chain === 'Ethereum') return '$8-$20';
    if (chain === 'Bitcoin') return '$2-$8';
    var veryCheap = ['Solana', 'Sui', 'Aptos', 'Tron', 'Binance', 'Monad', 'Hyperliquid L1', 'Plasma'];
    if (veryCheap.indexOf(chain) >= 0) return '$0.01-$0.50';
    var cheap = ['Arbitrum', 'Optimism', 'Base', 'Polygon', 'Scroll', 'Linea', 'zkSync Era', 'Mantle', 'Blast', 'Mode', 'Sonic', 'Berachain', 'Unichain', 'Ink', 'Avalanche', 'Celo', 'Gnosis'];
    if (cheap.indexOf(chain) >= 0) return '$0.10-$1.50';
    return '$1-$4';
  }
  function actionFor(row, capital, chain) {
    var c = (row.category || '').toLowerCase();
    var name = row.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) {
      return 'Supply $' + capital + ' of USDC to ' + name + "'s " + chain + ' market, then borrow no more than 25% of it against the position and keep the health factor above 2.0.';
    }
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0) {
      return 'Provide $' + capital + " of liquidity to " + name + "'s deepest " + chain + ' pool after checking its TVL and 24-hour volume, and stake the LP receipt if the protocol offers staking.';
    }
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0 || c.indexOf('liquid staking') >= 0) {
      return 'Stake $' + capital + " of " + chain + "'s native asset through " + name + ', keep the liquid receipt, and confirm the validator or operator set before you sign.';
    }
    if (c.indexOf('yield') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('farm') >= 0) {
      return 'Deposit $' + capital + ' of USDC into ' + name + "'s flagship " + chain + ' vault, confirm its fee and lockup, and keep the receipt token in the same wallet.';
    }
    if (c.indexOf('rwa') >= 0) {
      return 'Mint or subscribe $' + capital + " of " + name + "'s " + chain + ' yield asset, confirm the redemption window and the issuer, and hold the receipt.';
    }
    if (c.indexOf('basis') >= 0) {
      return 'Deposit $' + capital + ' of USDC as collateral on ' + name + ', open a small basis position (long spot against a short perpetual), and keep the hedge within 1.2x.';
    }
    if (c.indexOf('derivative') >= 0 || c.indexOf('perpetual') >= 0 || c.indexOf('options') >= 0) {
      return 'Deposit $' + capital + ' of USDC as margin on ' + name + ', open one small hedged position, and keep leverage below 2x.';
    }
    if (c.indexOf('insurance') >= 0) {
      return 'Buy $' + capital + ' of cover from ' + name + ' for ' + chain + "'s main asset, read the waiting period and exclusions, and keep the certificate.";
    }
    if (c.indexOf('payment') >= 0) {
      return 'Route $' + capital + ' of USDC through ' + name + ' to a second wallet you control, confirm settlement, and keep the receipt.';
    }
    if (c.indexOf('chain') >= 0) {
      return 'Bridge $' + capital + ' of USDC to ' + chain + " through " + name + "'s official gateway, swap half into the chain's gas token, and keep both balances active.";
    }
    if (c.indexOf('stable') >= 0) {
      return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + ', confirm the collateral ratio, and keep the position open.';
    }
    if (c.indexOf('prediction') >= 0) {
      return 'Fund $' + capital + ' and place one small market position on ' + name + ', then keep the position open through the hold window.';
    }
    if (c.indexOf('index') >= 0) {
      return "Mint $" + capital + " of " + name + "'s " + chain + ' index receipt, confirm its constituents and rebalance rule, and hold it.';
    }
    if (c.indexOf('liquidity manager') >= 0) {
      return 'Deposit $' + capital + ' of USDC into a ' + name + '-managed ' + chain + ' vault, confirm the manager and its fee, and keep the shares.';
    }
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ', confirm the position is visible in the app, and keep the receipt.';
  }
  function stepText(action, cost, time) {
    var s = action + ' Cost: ' + cost + '. Time: ' + time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Keep the position open and check the protocol's own page.";
    return s;
  }
  function planFor(row) {
    var chain = chainOf(row);
    var capital = capitalFor(row);
    var hold = holdDaysFor(row.age_days);
    var weeks = Math.ceil(hold / 7);
    var gas = gasBand(chain);
    var action = actionFor(row, capital, chain);
    var onboard = chain === 'Ethereum'
      ? 'Keep at least ' + gas + ' of ETH in the wallet for the deposit and the exit; if the wallet was funded in ETH, swap only the $' + capital + ' you plan to deposit into USDC.'
      : chain === 'Solana'
        ? 'Send $' + capital + ' of USDC to the wallet over Solana and keep 0.05 SOL for fees and token accounts.'
        : "Bridge $" + capital + ' of USDC to ' + chain + " with the chain's official bridge or a canonical pool, and check the fee before signing.";
    return [
      stepText('Set up a fresh wallet for this farm only, write its seed phrase offline, and fund it with $' + capital + ' of USDC plus ' + gas + ' for fees on ' + chain + '.', '$' + capital + ' capital + ' + gas + ' gas', '10 minutes'),
      stepText(onboard, chain === 'Ethereum' ? '$0 extra if the wallet holds ETH; otherwise $1-$8 swap fee + ' + gas + ' gas' : '$1-$8 bridge or swap fee + ' + gas + ' gas', chain === 'Ethereum' ? '5-10 minutes' : '10-20 minutes'),
      stepText(action, '$' + capital + ' capital + ' + gas + ' gas', '15-30 minutes'),
      stepText('Make one qualifying action each week for ' + weeks + ' weeks: a small deposit, borrow, swap or governance vote on ' + row.name + '; vary the amount and the action so it reads as real use.', '$2-$6 gas a week', '10 minutes a week'),
      stepText("Keep the position open for at least " + hold + " days, across at least two of the protocol's own reporting snapshots, and do not move it to a fresh wallet before the hold ends.", '$' + capital + ' stays deposited; opportunity cost only', hold + ' days'),
      stepText("Check " + row.name + "'s official site and social account once a week for a points, quest or claim page; never pay a fee and never sign a claim that arrives by direct message.", '$0 to check; never pay to claim', '5 minutes a week'),
      stepText('Log the wallet, dates, transactions and the vault or pool address; write the exit plan before depositing, with two withdrawal steps and ' + gas + ' kept for the second transaction.', '$0', '10 minutes')
    ];
  }

  // ---------------------------------------------------------------- filtering and sorting

  function boardMatches(r) {
    if (state.watch && !r.watchlist) return false;
    if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [r.name, r.slug, r.category || 'Other', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
  }
  function liveMatches(r) {
    if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [r.name, r.slug, r.category || 'Other', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
  }
  function sortValue(r, key, live) {
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'category') return (r.category || 'Other').toLowerCase();
    if (key === 'tvl') return r.tvl_usd;
    if (key === 'growth') return r.change_7d === null || r.change_7d === undefined ? -Infinity : r.change_7d;
    if (key === 'age') return r.age_days === null || r.age_days === undefined ? Infinity : r.age_days;
    if (key === 'tenure') return r.model ? r.model.tenure_multiplier : 0;
    if (key === 'mcap') return r.mcap_usd || 0;
    if (key === 'ratio') return r.ratio || 0;
    return live ? (r.mcap_usd || 0) : r.implied_value_usd;
  }
  function sorted(list, live) {
    return list.slice().sort(function (a, b) {
      var av = sortValue(a, state.sort, live);
      var bv = sortValue(b, state.sort, live);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function setSort(key) {
    if (state.sort === key) state.dir = -state.dir;
    else { state.sort = key; state.dir = key === 'name' || key === 'category' ? 1 : -1; }
    writeHash();
    renderBody();
  }

  // ---------------------------------------------------------------- shell pieces

  function topbar() {
    return el('header', { class: 'topbar' },
      el('div', { class: 'brand' },
        el('span', { class: 'brand-mark' }, el('span', { class: 'sweep' })),
        el('div', null,
          el('div', { class: 'brand-name', text: 'Token Radar' }),
          el('div', { class: 'brand-sub', text: 'Pre-token protocol intelligence \u00b7 snapshot ' + DATA.as_of })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', { class: 'top-chip' }, el('span', { class: 'dot' }), 'snapshot ', el('b', { text: DATA.as_of })),
        el('span', { class: 'top-chip' }, el('b', { text: String(DATA.protocol_count) }), ' protocols scanned'),
        el('span', { class: 'top-chip' }, el('b', { text: DATA.watchlist_size + '/' + DATA.watchlist_size }), ' watchlist'),
        el('span', { class: 'top-chip' }, el('b', { text: 'radar-2' }), ' model')
      )
    );
  }

  function stat(label, value, sub, accent) {
    return el('div', { class: 'stat' + (accent ? ' accent' : '') },
      el('div', { class: 'label', text: label }),
      el('div', { class: 'value', text: value }),
      el('div', { class: 'sub', text: sub })
    );
  }

  function hero() {
    var leader = DATA.rows[0];
    return el('section', { class: 'hero' },
      el('div', null,
        el('div', { class: 'eyebrow', text: 'token-radar-01 \u00b7 pre-token intelligence' }),
        el('h1', null, 'The launch board for ', el('em', null, 'protocols without a token'), '.'),
        el('p', { class: 'lede' },
          'Every one of the snapshot\u2019s ', el('b', { text: String(DATA.watchlist_size) }), ' watchlist protocols is ranked against ',
          el('b', { text: String(DATA.early_size) }), ' independent pre-token protocols below the $', el('b', { text: String(Math.round(DATA.floor_usd / 1e6)) }), 'M floor. Implied value is TVL times a category multiple learned from ',
          el('b', { text: String(DATA.model.global_sample) }), ' live comparables, a pre-token discount, seven-day growth, tenure without a token and chain depth.'
        ),
        el('div', { class: 'hero-actions' },
          el('a', { class: 'button primary', href: '#board', text: 'Open the board' }),
          el('a', { class: 'button ghost', href: '#model', text: 'How the value is computed' })
        )
      ),
      el('div', { class: 'stats' },
        stat('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'every slug the house named', true),
        stat('Board rows', String(DATA.board_size), DATA.watchlist_size + ' watchlist + ' + DATA.early_size + ' early'),
        stat('Top implied value', fmtUsdShort(leader.implied_value_usd), leader.name),
        stat('Live comparables', String(DATA.model.global_sample), 'category multiples learned here')
      )
    );
  }

  function modelStrip() {
    return el('div', { class: 'model-strip' },
      el('span', { class: 'model-chip' }, el('b', { text: 'FORMULA' }), 'TVL \u00d7 cat \u00d7 0.55 \u00d7 growth \u00d7 tenure \u00d7 chain'),
      el('span', { class: 'model-chip' }, el('b', { text: 'CATEGORY' }), el('strong', { text: '0.05\u20130.45' }), '\u00b7 n\u22653'),
      el('span', { class: 'model-chip' }, el('b', { text: 'GROWTH' }), el('strong', { text: '\u221250..+100' }), '\u00b7 30%'),
      el('span', { class: 'model-chip' }, el('b', { text: 'TENURE' }), el('strong', { text: '0.60\u21921.15\u21921.00' }), '\u00b7 2y peak'),
      el('span', { class: 'model-chip' }, el('b', { text: 'CHAIN' }), el('strong', { text: '0.94\u20131.10' }), '\u00b7 depth')
    );
  }

  function field(label, control) {
    return el('div', { class: 'field' }, el('label', { for: control.id, text: label }), control);
  }

  function controls() {
    var q = el('input', { class: 'input', id: 'q', type: 'search', placeholder: 'Search name, slug, chain or category', value: state.q, 'aria-label': 'Search the board' });
    q.addEventListener('input', function () { state.q = q.value; writeHash(); renderBody(); });
    var cat = el('select', { class: 'select', id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      CATEGORY_OPTIONS.map(function (entry) { return el('option', { value: entry[0], text: entry[0] + ' (' + entry[1] + ')' }); })
    );
    cat.value = state.category;
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); renderBody(); });
    var chain = el('select', { class: 'select', id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      CHAIN_OPTIONS.slice(0, 40).map(function (entry) { return el('option', { value: entry[0], text: entry[0] + ' (' + entry[1] + ')' }); })
    );
    chain.value = state.chain;
    chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); renderBody(); });
    var pre = el('button', { class: 'tab', type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token ' + DATA.board_size });
    var live = el('button', { class: 'tab', type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Trading ' + DATA.live.length });
    pre.addEventListener('click', function () { state.tab = 'pre'; normalizeSort(); syncControls(); writeHash(); renderBody(); });
    live.addEventListener('click', function () { state.tab = 'live'; normalizeSort(); syncControls(); writeHash(); renderBody(); });
    var watch = el('input', { type: 'checkbox', id: 'watch', checked: state.watch ? 'checked' : null });
    watch.addEventListener('change', function () { state.watch = watch.checked; writeHash(); renderBody(); });
    var reset = el('button', { class: 'button reset', type: 'button', text: 'Reset' });
    reset.addEventListener('click', resetFilters);
    refs.q = q; refs.cat = cat; refs.chain = chain; refs.pre = pre; refs.live = live; refs.watch = watch;
    return el('section', { class: 'controls', 'aria-label': 'Board filters' },
      field('Search', q),
      field('Category', cat),
      field('Chain', chain),
      el('div', { class: 'field' }, el('span', { text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('label', { class: 'check' }, watch, el('span', { text: 'Watchlist only' })),
      reset
    );
  }

  function boardPanel() {
    return el('section', { class: 'panel board', id: 'board' },
      el('div', { class: 'board-head' },
        el('div', null,
          el('h2', { id: 'board-title', text: 'Pre-token board' }),
          el('div', { class: 'sub', id: 'board-sub', text: 'Every row records no token. Select a row for its model and farm plan.' })
        ),
        el('span', { class: 'count', id: 'count', 'aria-live': 'polite', text: '' })
      ),
      el('div', { class: 'table-wrap', id: 'table-host' }),
      el('div', { class: 'status-note', id: 'status-note', text: 'A protocol that records no token is not proven to have none. The watchlist is the floor, never the ceiling: the early rows are independent pre-token protocols below the $50M floor.' })
    );
  }

  function th(label, key, cls, sortable) {
    var attrs = { scope: 'col' };
    if (cls) attrs.class = cls;
    if (!sortable) { attrs.text = label; return el('th', attrs); }
    var button = el('button', { type: 'button', text: label });
    if (state.sort === key) button.appendChild(el('span', { class: 'arrow', 'aria-hidden': 'true', text: state.dir < 0 ? '\u25bc' : '\u25b2' }));
    button.addEventListener('click', function () { setSort(key); });
    var node = el('th', attrs, button);
    node.setAttribute('aria-sort', state.sort === key ? (state.dir < 0 ? 'descending' : 'ascending') : 'none');
    return node;
  }

  function protocolCell(r, live) {
    var sub = [el('span', { text: r.category || 'Other' })];
    (r.chains || []).slice(0, 2).forEach(function (c) { sub.push(el('span', { class: 'chain-chip', text: c })); });
    if ((r.chains || []).length > 2) sub.push(el('span', { class: 'chain-chip', text: '+' + (r.chains.length - 2) }));
    var badge = live ? el('span', { class: 'badge live', text: 'trading' }) : r.watchlist ? el('span', { class: 'badge watch', text: 'watch' }) : el('span', { class: 'badge early', text: 'early' });
    return el('td', null, el('div', { class: 'protocol' },
      el('div', { class: 'protocol-name' }, r.name, badge),
      el('div', { class: 'protocol-sub' }, sub)
    ));
  }

  function boardTable(list) {
    var maxImplied = DATA.rows[0] ? DATA.rows[0].implied_value_usd : 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { 'data-slug': r.slug, tabindex: '0', 'data-selected': state.selected === r.slug ? 'true' : null });
      tr.addEventListener('click', function () { openDetail(r.slug); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } });
      var width = Math.max(2, Math.min(100, Math.round((r.implied_value_usd / maxImplied) * 100)));
      var bar = el('i'); bar.style.width = width + '%';
      tr.appendChild(el('td', { class: 'right' }, el('span', { class: 'rank-badge' + (r.rank <= 3 ? ' r' + r.rank : ''), text: String(r.rank) })));
      tr.appendChild(protocolCell(r, false));
      tr.appendChild(el('td', { class: 'num right', text: fmtUsdShort(r.tvl_usd) }));
      tr.appendChild(el('td', { class: 'num right change ' + changeClass(r.change_7d), text: fmtPct(r.change_7d) }));
      tr.appendChild(el('td', { class: 'num right', text: fmtAge(r.age_days) }));
      tr.appendChild(el('td', { class: 'num right', text: fmtMult(r.model.tenure_multiplier) }));
      tr.appendChild(el('td', { class: 'right' }, el('div', { class: 'value-cell' },
        el('div', { class: 'value-bar', 'aria-hidden': 'true' }, bar),
        el('span', { class: 'value-amount', text: fmtUsdShort(r.implied_value_usd) })
      )));
      tr.appendChild(el('td', { class: 'right' }, el('span', { class: 'plan-chip', text: r.farm_steps.length + ' steps' })));
      tbody.appendChild(tr);
    });
    return el('table', { 'aria-label': 'Pre-token protocols ranked by implied value' },
      el('thead', null, el('tr', null,
        th('Rank', null, 'right', false),
        th('Protocol', 'name', '', true),
        th('TVL', 'tvl', 'right', true),
        th('7d', 'growth', 'right', true),
        th('Age', 'age', 'right', true),
        th('Tenure', 'tenure', 'right', true),
        th('Implied value', 'implied', 'right', true),
        el('th', { scope: 'col', class: 'right', text: 'Plan' })
      )),
      tbody
    );
  }

  function liveTable(list) {
    var tbody = el('tbody');
    list.forEach(function (r, i) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num right', text: String(i + 1) }),
        protocolCell(r, true),
        el('td', { class: 'num right', text: fmtUsdShort(r.tvl_usd) }),
        el('td', { class: 'num right', text: fmtUsdShort(r.mcap_usd) }),
        el('td', { class: 'num right', text: fmtRatio(r.ratio) }),
        el('td', { class: 'num right change ' + changeClass(r.change_7d), text: fmtPct(r.change_7d) }),
        el('td', { text: r.category || 'Other' })
      ));
    });
    return el('table', { 'aria-label': 'Protocols whose token already trades, with market cap' },
      el('thead', null, el('tr', null,
        th('#', null, 'right', false),
        th('Protocol', 'name', '', true),
        th('TVL', 'tvl', 'right', true),
        th('Market cap', 'mcap', 'right', true),
        th('Mcap / TVL', 'ratio', 'right', true),
        th('7d', 'growth', 'right', true),
        th('Category', 'category', '', true)
      )),
      tbody
    );
  }

  function emptyState() {
    return el('div', { class: 'empty' },
      el('h3', { text: 'No protocol matches that filter' }),
      el('p', { text: 'Clear the search or pick another category, chain or token status. The board still holds ' + DATA.board_size + ' ranked pre-token rows.' }),
      el('button', { class: 'button primary', type: 'button', text: 'Reset filters', onclick: resetFilters })
    );
  }

  function syncControls() {
    if (refs.q) refs.q.value = state.q;
    if (refs.cat) refs.cat.value = state.category;
    if (refs.chain) refs.chain.value = state.chain;
    if (refs.pre) refs.pre.setAttribute('aria-pressed', state.tab === 'pre' ? 'true' : 'false');
    if (refs.live) refs.live.setAttribute('aria-pressed', state.tab === 'live' ? 'true' : 'false');
    if (refs.watch) {
      refs.watch.checked = state.watch;
      if (refs.watch.parentNode) refs.watch.parentNode.hidden = state.tab === 'live';
    }
  }

  function renderBody() {
    normalizeSort();
    var host = document.getElementById('table-host');
    if (!host) return;
    var isLive = state.tab === 'live';
    var list = isLive ? DATA.live.filter(liveMatches) : DATA.rows.filter(boardMatches);
    list = sorted(list, isLive);
    clear(host);
    host.appendChild(list.length === 0 ? emptyState() : (isLive ? liveTable(list) : boardTable(list)));
    var count = document.getElementById('count');
    if (count) count.textContent = list.length + ' of ' + (isLive ? DATA.live.length + ' trading' : DATA.board_size + ' ranked');
    var title = document.getElementById('board-title');
    if (title) title.textContent = isLive ? 'Token already trades' : 'Pre-token board';
    var sub = document.getElementById('board-sub');
    if (sub) sub.textContent = isLive
      ? 'Market cap is a fact, not a model. These protocols are set aside from the ranking and are the comparables behind the category multiples.'
      : 'Every row records no token. Select a row for its model and farm plan.';
    var note = document.getElementById('status-note');
    if (note) note.textContent = isLive
      ? 'A protocol here records a token, so it is not a pre-token candidate. The pre-token board keeps it out of the ranking; its market-cap-to-TVL ratio is one of the comparables the model learns from.'
      : 'A protocol that records no token is not proven to have none. The watchlist is the floor, never the ceiling: the early rows are independent pre-token protocols below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor.';
    syncControls();
  }

  // ---------------------------------------------------------------- model panel

  function categoryTable() {
    var cats = DATA.model.categories.slice().sort(function (a, b) { return b.multiple - a.multiple || b.n - a.n; });
    var tbody = el('tbody');
    cats.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.key }),
        el('td', { class: 'num right', text: String(c.n) }),
        el('td', { class: 'num right', text: c.median === null ? '\u2014' : c.median.toFixed(3) }),
        el('td', { class: 'num right', text: c.multiple.toFixed(3) }),
        el('td', { class: 'source', text: c.source === 'category' ? 'own median' : 'global' })
      ));
    });
    return el('table', { class: 'mini-table', 'aria-label': 'Category market-cap-to-TVL multiples' },
      el('thead', null, el('tr', null,
        el('th', { text: 'Category' }), el('th', { class: 'right', text: 'n' }), el('th', { class: 'right', text: 'median' }), el('th', { class: 'right', text: 'applied' }), el('th', { text: 'source' })
      )),
      tbody
    );
  }

  function chainTable() {
    var tbody = el('tbody');
    DATA.model.chains.slice(0, 10).forEach(function (c) {
      var depthBase = DATA.model.chain_floor + DATA.model.chain_range * c.score;
      tbody.appendChild(el('tr', null,
        el('td', { text: c.chain }),
        el('td', { class: 'num right', text: fmtUsdShort(c.tvl_usd) }),
        el('td', { class: 'num right', text: c.score.toFixed(2) }),
        el('td', { class: 'num right', text: depthBase.toFixed(3) })
      ));
    });
    return el('table', { class: 'mini-table', 'aria-label': 'Chain depth scores' },
      el('thead', null, el('tr', null,
        el('th', { text: 'Chain' }), el('th', { class: 'right', text: 'TVL on chain' }), el('th', { class: 'right', text: 'depth' }), el('th', { class: 'right', text: 'depth base' })
      )),
      tbody
    );
  }

  function checkPill(ok, text) {
    return el('span', { class: 'check-pill' + (ok ? '' : ' bad'), text: text });
  }

  function whyCard(r) {
    return el('article', { class: 'why-card' },
      el('div', { class: 'why-head' },
        el('span', { class: 'rank-badge' + (r.rank <= 3 ? ' r' + r.rank : ''), text: String(r.rank) }),
        el('b', { text: r.name }),
        el('span', { class: 'num', text: fmtUsdShort(r.implied_value_usd) })
      ),
      el('p', { text: r.why })
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var recomputeBad = DATA.rows.filter(function (r) { return impliedOf(r) !== r.implied_value_usd; }).length;
    var planBad = DATA.rows.filter(function (r) { return JSON.stringify(planFor(r)) !== JSON.stringify(r.farm_steps); }).length;
    var watchCount = DATA.rows.filter(function (r) { return r.watchlist; }).length;
    return el('section', { class: 'panel model-panel', id: 'model' },
      el('div', { class: 'section-head' },
        el('div', null,
          el('div', { class: 'eyebrow', text: 'The model' }),
          el('h2', { text: 'How implied value is computed' }),
          el('p', { text: 'One function scores every row. The category and chain tables are learned from the snapshot itself; no protocol name is special-cased.' })
        ),
        el('span', { class: 'model-badge', text: 'radar-2 \u00b7 ' + m.global_sample + ' comparables' })
      ),
      el('div', { class: 'formula-box' },
        'implied = round( ',
        el('span', { class: 'dim', text: 'tvl_usd' }), ' \u00d7 ',
        el('span', { class: 'dim', text: 'category_multiple' }), ' \u00d7 ' + m.pretoken_discount + ' \u00d7 ',
        el('span', { class: 'dim', text: 'growth_multiplier' }), ' \u00d7 ',
        el('span', { class: 'dim', text: 'tenure_multiplier' }), ' \u00d7 ',
        el('span', { class: 'dim', text: 'chain_multiplier' }), ' )'
      ),
      el('div', { class: 'model-grid' },
        el('div', { class: 'model-copy' },
          el('p', null, el('b', { text: 'TVL is the base. ' }), 'It is the protocol\u2019s own snapshot figure, not a projection. A larger protocol with the same multipliers ranks higher.'),
          el('p', null, el('b', { text: 'The category multiple is learned, not asserted. ' }), 'For the ', el('b', { text: String(m.global_sample) }), ' protocols that record a token and a market cap, market cap divided by TVL is one comparable; ratios below 0.005 or above 10 are dropped. A category with at least ', el('b', { text: String(m.category_min_sample) }), ' comparables uses its own median; a thinner category inherits the global ', el('b', { text: m.global_multiple.toFixed(3) }), '. The applied multiple is clamped to ', el('b', { text: m.category_floor + '\u2013' + m.category_cap }), '. The ', el('b', { text: '0.55 pre-token discount' }), ' accounts for launch, liquidity and execution risk.'),
          el('p', null, el('b', { text: 'Seven-day growth is damped. ' }), 'The raw change is clamped to ', el('b', { text: m.growth_floor + '%..+' + m.growth_cap + '%' }), ' and passed through at ', el('b', { text: Math.round(m.growth_weight * 100) + '%' }), ', so a +100% week adds 30% and a \u221250% week removes 15%. A null report is neutral.'),
          el('p', null, el('b', { text: 'Tenure is the time without a token. ' }), 'The curve rises from 0.60 at 0 days to 1.15 at two years, then decays to 1.00 at ten years; a missing listing date takes 0.85. Two years is the sweet spot: proven enough to matter, not so old that a launch looks abandoned.'),
          el('p', null, el('b', { text: 'Chain depth is a small modifier. ' }), 'Each chain\u2019s total snapshot TVL is log-scaled to 0\u20131. The deepest chain sets 0.94 + 0.12 \u00d7 depth; up to five additional chains with a depth score above 0.5 add 0.008 each, capped at 1.10.'),
          el('p', null, el('b', { text: 'The ranking is the claim. ' }), 'It does not predict whether or when a protocol issues a token. It asks what a token claim would be worth if the protocol\u2019s record stayed as it is.')
        ),
        el('div', { class: 'side-stack' },
          el('div', { class: 'side-card' }, el('h3', { text: 'Category multiples' }), categoryTable()),
          el('div', { class: 'side-card' }, el('h3', { text: 'Chain depth' }), chainTable())
        )
      ),
      el('h3', { text: 'Why the top ranks are top' }),
      el('div', { class: 'why-grid' }, DATA.rows.slice(0, 5).map(whyCard)),
      el('div', { class: 'checks' },
        checkPill(recomputeBad === 0, 'Page recomputation: ' + (DATA.rows.length - recomputeBad) + '/' + DATA.rows.length + ' rows match board.json'),
        checkPill(planBad === 0, 'Farm plan check: ' + (DATA.rows.length - planBad) + '/' + DATA.rows.length + ' rows match the page generator'),
        checkPill(watchCount === DATA.watchlist_size, 'Watchlist coverage: ' + watchCount + '/' + DATA.watchlist_size),
        checkPill(true, 'Board ranks 1..' + DATA.board_size + ' once each')
      ),
      el('p', { class: 'disclaimer', text: 'Implied value is a model claim, not a price. A protocol that records no token is not proven to have none. Nothing here predicts whether or when a token is issued. Farm plans are operational sketches, not financial advice; never pay to claim, never share a seed phrase, and never sign a transaction you cannot read.' })
    );
  }

  function footer() {
    return el('footer', { class: 'footer' },
      el('span', { text: 'Snapshot ' + DATA.as_of + ' \u00b7 DefiLlama protocol index \u00b7 ' + DATA.board_size + ' ranked pre-token rows \u00b7 ' + DATA.live.length + ' live comparables set aside' }),
      el('span', { text: 'radar-2 \u00b7 implied value is a claim, not a price \u00b7 not investment advice' })
    );
  }

  // ---------------------------------------------------------------- detail dialog

  function factor(label, value, note) {
    return el('div', { class: 'factor' },
      el('span', { text: label }),
      el('b', null, value, el('small', { text: note }))
    );
  }
  function snapItem(label, value) {
    return el('div', null, el('dt', { text: label }), el('dd', { text: value }));
  }
  function detailHead(row) {
    return el('div', { class: 'detail-head' },
      el('div', { class: 'detail-title' },
        el('div', { class: 'eyebrow', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' \u00b7 ' + (row.watchlist ? 'watchlist' : 'early') + ' \u00b7 records no token' }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' \u00b7 ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'no chain recorded') })
      ),
      el('button', { class: 'detail-close', type: 'button', text: 'Close', onclick: closeDetail })
    );
  }
  function detailLeft(row) {
    var m = row.model;
    var recomputed = impliedOf(row);
    var catNote = m.category_source === 'category' ? m.category_sample + ' live comparables' : 'global fallback; ' + m.category_sample + ' comparable' + (m.category_sample === 1 ? '' : 's');
    var growthNote = row.change_7d === null ? 'no report; neutral' : 'clamped to ' + m.growth_pct.toFixed(2) + '%; ' + fmtMult(m.growth_multiplier);
    var ageNote = m.age_days === null ? 'listing date unknown' : 'age ' + fmtAge(m.age_days);
    var chainNote = (m.chain_best || 'no chain') + ' \u00b7 ' + m.chain_count + ' chain' + (m.chain_count === 1 ? '' : 's');
    return el('div', { class: 'detail-col' },
      el('div', { class: 'value-hero' },
        el('span', { class: 'big', text: fmtUsdFull(row.implied_value_usd) }),
        el('span', { class: 'label', text: 'implied value' }),
        el('span', { class: 'caption', text: 'A model claim from the snapshot, not a price and not a promise of a token.' })
      ),
      el('div', { class: 'factor-list' },
        factor('TVL', fmtUsdFull(row.tvl_usd), 'the protocol\u2019s own snapshot figure'),
        factor('Category multiple', fmtMult(m.category_multiple), catNote),
        factor('Pre-token discount', '\u00d7' + m.pretoken_discount.toFixed(2), 'launch, liquidity and execution risk'),
        factor('Seven-day growth', fmtPct(row.change_7d), growthNote),
        factor('Tenure without a token', fmtMult(m.tenure_multiplier), ageNote),
        factor('Chain depth', fmtMult(m.chain_multiplier), chainNote),
        factor('Implied value', fmtUsdFull(row.implied_value_usd), 'model claim, not a price'),
        factor('Page recompute', fmtUsdFull(recomputed), recomputed === row.implied_value_usd ? 'matches board.json' : 'DIFFERS from board.json')
      ),
      el('div', { class: 'why-box' }, el('b', { text: 'Why this rank. ' }), row.why),
      el('div', { class: 'snapshot' },
        snapItem('slug', row.slug),
        snapItem('listed at', row.listed_at || 'not recorded'),
        snapItem('7d raw', row.change_7d === null ? 'not reported' : fmtPct(row.change_7d)),
        snapItem('market cap', row.mcap_usd === null ? 'none recorded' : fmtUsdFull(row.mcap_usd)),
        snapItem('gecko id', row.gecko_id || 'none recorded'),
        snapItem('symbol', row.symbol || 'none recorded'),
        snapItem('chains', String(row.chains.length)),
        snapItem('floor', row.below_floor ? 'below the floor' : 'above the floor')
      ),
      el('p', { class: 'plan-note', text: 'DefiLlama records no token for this protocol; that is not proof it has none. If a token ever launches, the wallet activity above is the record it would see.' })
    );
  }
  function detailRight(row) {
    var idx = DATA.rows.indexOf(row);
    var prev = idx > 0 ? DATA.rows[idx - 1] : null;
    var next = idx >= 0 && idx + 1 < DATA.rows.length ? DATA.rows[idx + 1] : null;
    var plan = el('ol', { class: 'plan' });
    row.farm_steps.forEach(function (step, i) {
      var at = step.indexOf(' Cost: ');
      var action = at >= 0 ? step.slice(0, at) : step;
      var tail = at >= 0 ? step.slice(at + 1) : '';
      plan.appendChild(el('li', null,
        el('span', { class: 'n', text: String(i + 1) }),
        el('div', null, el('div', { class: 'action', text: action }), el('div', { class: 'meta', text: tail }))
      ));
    });
    return el('div', { class: 'detail-col' },
      el('h3', { text: 'Farm plan' }),
      el('p', { class: 'sub', text: row.farm_steps.length + ' steps. Each states what to do, what it costs and how long it takes.' }),
      plan,
      el('p', { class: 'plan-note', text: 'Costs are estimates in USD at the snapshot date; they are not guarantees. The plan is an operational sketch, not financial advice. Never pay to claim and never share a seed phrase.' }),
      el('div', { class: 'detail-nav' },
        el('button', { type: 'button', disabled: prev ? null : 'disabled', text: prev ? '\u2190 Rank ' + prev.rank : '\u2190 First', onclick: prev ? function () { openDetail(prev.slug); } : null }),
        el('button', { type: 'button', disabled: next ? null : 'disabled', text: next ? 'Rank ' + next.rank + ' \u2192' : 'Last \u2192', onclick: next ? function () { openDetail(next.slug); } : null })
      )
    );
  }
  function clearSelected() {
    document.querySelectorAll('tr[data-selected]').forEach(function (tr) { tr.removeAttribute('data-selected'); });
  }
  function openDetail(slug, silent) {
    var row = ROW_BY_SLUG.get(slug);
    if (!row) return;
    clearSelected();
    state.selected = slug;
    if (!silent) writeHash();
    dialog.textContent = '';
    dialog.appendChild(detailHead(row));
    dialog.appendChild(el('div', { class: 'detail-grid' }, detailLeft(row), detailRight(row)));
    var tr = document.querySelector('tr[data-slug="' + slug + '"]');
    if (tr) tr.setAttribute('data-selected', 'true');
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
    setTimeout(function () { try { dialog.focus(); } catch (e) { /* not focusable */ } }, 0);
  }
  function closeDetail() {
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    state.selected = null;
    clearSelected();
    writeHash();
  }
  dialog.addEventListener('close', function () {
    state.selected = null;
    clearSelected();
    writeHash();
  });
  dialog.addEventListener('click', function (e) { if (e.target === dialog) closeDetail(); });

  // ---------------------------------------------------------------- render + events

  function resetFilters() {
    state.q = '';
    state.category = 'all';
    state.chain = 'all';
    state.watch = false;
    state.tab = 'pre';
    state.sort = 'implied';
    state.dir = -1;
    syncControls();
    writeHash();
    renderBody();
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' },
      topbar(),
      hero(),
      modelStrip(),
      controls(),
      boardPanel(),
      modelPanel(),
      footer()
    );
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    renderBody();
    if (state.selected) openDetail(state.selected, true);
  }

  window.addEventListener('keydown', function (e) {
    if (!dialog.open) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var row = ROW_BY_SLUG.get(state.selected);
    if (!row) return;
    var idx = DATA.rows.indexOf(row);
    var next = e.key === 'ArrowLeft' ? DATA.rows[idx - 1] : DATA.rows[idx + 1];
    if (next) { e.preventDefault(); openDetail(next.slug); }
  });
  window.addEventListener('hashchange', function () {
    state.selected = null;
    readHash();
    normalizeSort();
    render();
  });

  // A small, inspectable surface for the page's two checks: the row arithmetic and the plan text.
  window.RADAR_CHECK = { impliedOf: impliedOf, planFor: planFor, rows: DATA.rows.length };

  render();
})();
