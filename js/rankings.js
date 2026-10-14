/* 积分排行榜页：云端数据渲染 + 搜索 / 筛选 / 榜单维度切换 */
;(function () {
  // 固定榜单 tab；比赛 tab 由 getCompetitions 动态拼接（key 带 comp_ 前缀）
  var BASE_TABS = [
    { key: 'overall', label: '总榜' },
    { key: 'c8', label: '中八' },
    { key: 'nine_ball', label: '九球' }
  ]
  var state = { list: [], filter: 'all', keyword: '', scopeKey: 'overall', scopeTabs: BASE_TABS.slice(), page: 1, expandedTies: {} }
  var PAGE_SIZE = 20 // 总榜分页大小（仅总榜分页，维度榜全量展示）
  var TIE_COLLAPSE_SIZE = 3 // 并列组折叠阈值：同一名次并列超过 3 人时默认只显示第一行，点击展开栏查看全部
  var U = window.AppUI

  function el(id) { return document.getElementById(id) }

  async function load() {
    loadStats()
    await loadBoard()
  }

  // 顶部统计卡（总览口径，不随榜单维度切换）
  async function loadStats() {
    try {
      var ov = await window.AppCloud.call('getOverview')
      renderStats(ov || {})
    } catch (e) {
      console.warn('[rankings] 总览加载失败', e)
    }
  }

  async function loadBoard() {
    try {
      state.list = await window.AppCloud.call('getRankings', scopeParams()) || []
      renderPodium()
      renderTable()
      renderPointsLabel()
    } catch (e) {
      U.toast('加载排行榜失败：' + (e.message || e), 'error')
      var tbody = el('ranking-tbody')
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--muted-foreground);">加载失败，请稍后重试</td></tr>'
      }
    }
  }

  // ---------- 榜单维度胶囊 tab ----------
  async function loadCompetitions() {
    try {
      var comps = await window.AppCloud.call('getCompetitions') || []
      state.scopeTabs = BASE_TABS.concat(comps.map(function (c) {
        return { key: 'comp_' + c._id, label: c.name }
      }))
      renderScopeTabs()
    } catch (e) {
      // 比赛列表失败不影响基础榜单 tab
      console.warn('[rankings] 比赛列表加载失败', e)
    }
  }

  function renderScopeTabs() {
    var box = el('scope-tabs')
    if (!box) return
    box.innerHTML = state.scopeTabs.map(function (t) {
      return '<button type="button" role="tab" class="rk-pill rk-scope-tab' +
        (t.key === state.scopeKey ? ' is-active' : '') + '" data-key="' + t.key + '">' +
        U.escapeHtml(t.label) + '</button>'
    }).join('')
    box.querySelectorAll('.rk-scope-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-key')
        if (!key || key === state.scopeKey) return
        state.scopeKey = key
        state.page = 1
        state.expandedTies = {}
        box.querySelectorAll('.rk-scope-tab').forEach(function (b) { b.classList.remove('is-active') })
        btn.classList.add('is-active')
        renderCompEntry()
        loadBoard()
      })
    })
    renderCompEntry()
  }

  // 比赛 tab 激活时显示「查看比赛详情」入口
  function renderCompEntry() {
    var link = el('comp-entry')
    if (!link) return
    var key = state.scopeKey
    if (key.indexOf('comp_') === 0) {
      link.href = './competition-detail.html?id=' + encodeURIComponent(key.slice(5))
      link.style.display = ''
    } else {
      link.style.display = 'none'
    }
  }

  function scopeParams() {
    var key = state.scopeKey
    if (key === 'overall') return {}
    if (key.indexOf('comp_') === 0) return { scope: 'competition', competition_id: key.slice(5) }
    return { scope: 'game_type', game_type: key }
  }

  // 积分列文案随维度切换（维度榜展示的是该维度积分，非总积分）；总榜口径提示仅总榜展示
  function renderPointsLabel() {
    var label = state.scopeKey === 'overall' ? '总积分' : '榜单积分'
    var th = el('th-points')
    if (th) th.textContent = label
    var pl = document.querySelectorAll('.podium-points-label')
    pl.forEach(function (n) { n.textContent = label })
    var tip = el('scope-tip')
    if (tip) tip.style.display = state.scopeKey === 'overall' ? '' : 'none'
  }

  function renderStats(ov) {
    var season = U.seasonLabel()
    setText('stat-members', ov.membersCount != null ? ov.membersCount : state.list.length, '人')
    setText('stat-matches', ov.matchesCount != null ? ov.matchesCount : '-', '场')
    setText('stat-active', ov.monthActive != null ? ov.monthActive : '-', '人')
    var s = el('stat-season')
    if (s) s.textContent = season
    var eyebrow = el('season-eyebrow')
    if (eyebrow) eyebrow.textContent = season.replace('.09 - ', '-') + '赛季 · 实时更新'
  }

  function setText(id, val, unit) {
    var n = el(id)
    if (!n) return
    n.innerHTML = U.escapeHtml(val) + (unit ? '<span style="font-size:14px; color: var(--muted-foreground); font-weight:500; margin-left:4px;">' + unit + '</span>' : '')
  }

  function filtered() {
    var kw = state.keyword.trim()
    var monthStart = U.monthStartTs()
    return state.list.filter(function (m) {
      if (kw && (m.name || '').indexOf(kw) < 0) return false
      if (state.filter === 'active') return (m.wins || 0) + (m.losses || 0) > 0
      if (state.filter === 'new') return (m.created_at || 0) >= monthStart
      return true
    })
  }

  function renderPodium() {
    var box = el('podium')
    if (!box) return
    if (!state.list.length) {
      box.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted-foreground);">暂无数据，点击右下角「生成演示数据」开始体验</div>'
      return
    }
    // 同分并列共享名次：podium 取 rank≤3 全部人选，每档最多展示 3 张卡，超出底部提示
    var icons = { 1: 'crown', 2: 'medal', 3: 'award' }
    var perRank = {}
    var cards = []
    var overflow = 0
    state.list.forEach(function (m) {
      if (m.rank > 3) return
      perRank[m.rank] = (perRank[m.rank] || 0) + 1
      if (perRank[m.rank] <= 3) cards.push(m)
      else overflow++
    })
    box.innerHTML = cards.map(function (m) {
      var total = (m.wins || 0) + (m.losses || 0)
      return '<article class="rk-podium-card rank-' + m.rank + '" data-id="' + m._id + '" style="cursor:pointer;">' +
        '<div class="podium-rank-icon"><i data-lucide="' + icons[m.rank] + '" style="width:28px;height:28px;"></i></div>' +
        '<div class="podium-name">' + U.escapeHtml(m.name || '未命名') + '</div>' +
        '<div class="podium-points">' + (m.points != null ? m.points : 0) + '</div>' +
        '<div class="podium-points-label">总积分</div>' +
        '<div class="podium-meta">' +
        '<div class="podium-meta-item"><div class="podium-meta-value">' + (m.winRate || 0) + '%</div><div class="podium-meta-label">胜率</div></div>' +
        '<div class="podium-meta-item"><div class="podium-meta-value">' + total + '</div><div class="podium-meta-label">对战场次</div></div>' +
        '<div class="podium-meta-item"><div class="podium-meta-value">' + (m.clears || 0) + '</div><div class="podium-meta-label">一杆清台</div></div>' +
        '</div></article>'
    }).join('') + (overflow > 0
      ? '<div class="podium-tie-note">另有 ' + overflow + ' 人并列前三名，可在下方榜单展开查看</div>'
      : '')
    bindMemberLinks(box)
    refreshIcons()
  }

  // 趋势列：按最近一场胜负（win/lose/draw）；v2 起每场积分均为正，不再以积分正负判断
  function trendHtml(m) {
    var r = m.lastResult
    if (!r && (m.lastDelta === null || m.lastDelta === undefined)) {
      return '<span class="trend-flat"><i data-lucide="minus" style="width:16px;height:16px;"></i>暂无</span>'
    }
    if (!r) r = m.lastDelta > 0 ? 'win' : m.lastDelta < 0 ? 'lose' : 'draw'
    if (r === 'win') {
      return '<span class="trend-up"><i data-lucide="arrow-up" style="width:16px;height:16px;"></i>上升</span>'
    }
    if (r === 'lose') {
      return '<span class="trend-down"><i data-lucide="arrow-down" style="width:16px;height:16px;"></i>下降</span>'
    }
    return '<span class="trend-flat"><i data-lucide="minus" style="width:16px;height:16px;"></i>持平</span>'
  }

  function renderTable() {
    var tbody = el('ranking-tbody')
    if (!tbody) return
    var rows = filtered()
    // 每个名次档的完整并列人数（跨分页保持「共 X 人」口径一致）
    var tieCount = {}
    rows.forEach(function (m) { tieCount[m.rank] = (tieCount[m.rank] || 0) + 1 })
    // 仅总榜分页（一页 20 条）；搜索/筛选/切换维度时 page 已重置为 1，此处仅做越界钳制
    var paged = state.scopeKey === 'overall'
    var totalPages = paged ? Math.max(1, Math.ceil(rows.length / PAGE_SIZE)) : 1
    if (state.page > totalPages) state.page = totalPages
    var view = paged ? rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE) : rows
    renderPager(totalPages, rows.length, paged)
    if (!view.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted-foreground);">没有符合条件的会员</td></tr>'
      refreshIcons()
      return
    }
    // 并列组 >3 人折叠：组首行后渲染展开栏，其余行仅在展开时输出
    var html = ''
    for (var i = 0; i < view.length; i++) {
      var m = view[i]
      var size = tieCount[m.rank] || 1
      var collapsible = size > TIE_COLLAPSE_SIZE
      var prevSame = i > 0 && view[i - 1].rank === m.rank
      if (collapsible && prevSame && !state.expandedTies[m.rank]) continue
      var badge = m.rank <= 3
        ? '<span class="rank-badge ' + ['gold', 'silver', 'bronze'][m.rank - 1] + '">' + m.rank + '</span>'
        : String(m.rank)
      var total = (m.wins || 0) + (m.losses || 0)
      html += '<tr data-id="' + m._id + '" style="cursor:pointer;">' +
        '<td class="col-rank">' + badge + '</td>' +
        '<td>' + U.escapeHtml(m.name || '未命名') + '</td>' +
        '<td class="col-points">' + (m.points != null ? m.points : 0) + '</td>' +
        '<td class="col-season">' + (m.wins || 0) + ' / ' + total + '</td>' +
        '<td class="col-clears">' + (m.clears || 0) + '</td>' +
        '<td class="col-winrate">' + (m.winRate || 0) + '%</td>' +
        '<td>' + trendHtml(m) + '</td></tr>'
      if (collapsible && !prevSame) {
        var open = !!state.expandedTies[m.rank]
        html += '<tr class="tie-bar" data-tie="' + m.rank + '"><td colspan="7">' +
          '<i data-lucide="' + (open ? 'chevron-up' : 'chevron-down') + '" style="width:14px;height:14px;"></i>' +
          '并列第 ' + m.rank + ' 名 · 共 ' + size + ' 人，' + (open ? '点击收起' : '点击展开') +
          '</td></tr>'
      }
    }
    tbody.innerHTML = html
    tbody.querySelectorAll('.tie-bar').forEach(function (bar) {
      bar.addEventListener('click', function (e) {
        e.stopPropagation()
        var rank = bar.getAttribute('data-tie')
        state.expandedTies[rank] = !state.expandedTies[rank]
        renderTable()
      })
    })
    bindMemberLinks(tbody)
    refreshIcons()
  }

  // 总榜分页条：≤20 人（单页）或非总榜维度时隐藏
  function renderPager(totalPages, totalCount, paged) {
    var box = el('rk-pagination')
    if (!box) return
    if (!paged || totalCount <= PAGE_SIZE) {
      box.style.display = 'none'
      return
    }
    box.style.display = ''
    el('rk-page-info').textContent = '第 ' + state.page + ' / ' + totalPages + ' 页 · 共 ' + totalCount + ' 人'
    el('rk-page-prev').disabled = state.page <= 1
    el('rk-page-next').disabled = state.page >= totalPages
  }

  function bindMemberLinks(root) {
    root.querySelectorAll('[data-id]').forEach(function (n) {
      n.addEventListener('click', function () {
        var id = n.getAttribute('data-id')
        if (id) window.location.href = './member-detail.html?id=' + encodeURIComponent(id)
      })
    })
  }

  function refreshIcons() {
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons()
  }

  function bindControls() {
    var input = el('search-input')
    if (input) {
      input.addEventListener('input', function () {
        state.keyword = input.value
        state.page = 1
        state.expandedTies = {}
        renderTable()
      })
      var clear = document.querySelector('.rk-filter-bar .clear')
      if (clear) {
        clear.addEventListener('click', function () {
          input.value = ''
          state.keyword = ''
          state.page = 1
          state.expandedTies = {}
          renderTable()
        })
      }
    }
    // 仅筛选胶囊（.rk-pills 容器内）；维度 tab 复用 rk-pill 样式但由 renderScopeTabs 自行绑定
    document.querySelectorAll('.rk-pills .rk-pill').forEach(function (pill) {
      pill.addEventListener('click', function (e) {
        e.preventDefault()
        document.querySelectorAll('.rk-pills .rk-pill').forEach(function (p) { p.classList.remove('is-active') })
        pill.classList.add('is-active')
        state.filter = pill.getAttribute('data-filter') || 'all'
        state.page = 1
        state.expandedTies = {}
        renderTable()
      })
    })
    // 总榜分页翻页
    var prev = el('rk-page-prev')
    var next = el('rk-page-next')
    if (prev) prev.addEventListener('click', function () { state.page--; renderTable() })
    if (next) next.addEventListener('click', function () { state.page++; renderTable() })
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('rankings')
    U.mountCloudBar(load)
    bindControls()
    renderScopeTabs() // 先渲染基础三个 tab，比赛 tab 就绪后重绘
    loadCompetitions()
    load()
  })
})()
