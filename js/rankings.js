/* 积分排行榜页：云端数据渲染 + 搜索 / 筛选 / 榜单维度切换 */
;(function () {
  // 固定榜单 tab；比赛 tab 由 getCompetitions 动态拼接（key 带 comp_ 前缀）
  var BASE_TABS = [
    { key: 'overall', label: '总榜' },
    { key: 'c8', label: '中八' },
    { key: 'nine_ball', label: '九球' }
  ]
  var state = { list: [], filter: 'all', keyword: '', scopeKey: 'overall', scopeTabs: BASE_TABS.slice() }
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

  // 积分列文案随维度切换（维度榜展示的是该维度积分，非总积分）
  function renderPointsLabel() {
    var label = state.scopeKey === 'overall' ? '总积分' : '榜单积分'
    var th = el('th-points')
    if (th) th.textContent = label
    var pl = document.querySelectorAll('.podium-points-label')
    pl.forEach(function (n) { n.textContent = label })
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
    var top3 = state.list.slice(0, 3)
    if (!top3.length) {
      box.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted-foreground);">暂无数据，点击右下角「生成演示数据」开始体验</div>'
      return
    }
    var icons = ['crown', 'medal', 'award']
    box.innerHTML = top3.map(function (m, i) {
      var total = (m.wins || 0) + (m.losses || 0)
      return '<article class="rk-podium-card rank-' + (i + 1) + '" data-id="' + m._id + '" style="cursor:pointer;">' +
        '<div class="podium-rank-icon"><i data-lucide="' + icons[i] + '" style="width:28px;height:28px;"></i></div>' +
        '<div class="podium-name">' + U.escapeHtml(m.name || '未命名') + '</div>' +
        '<div class="podium-points">' + (m.points != null ? m.points : 0) + '</div>' +
        '<div class="podium-points-label">总积分</div>' +
        '<div class="podium-meta">' +
        '<div class="podium-meta-item"><div class="podium-meta-value">' + (m.winRate || 0) + '%</div><div class="podium-meta-label">胜率</div></div>' +
        '<div class="podium-meta-item"><div class="podium-meta-value">' + total + '</div><div class="podium-meta-label">对战场次</div></div>' +
        '<div class="podium-meta-item"><div class="podium-meta-value">' + (m.clears || 0) + '</div><div class="podium-meta-label">一杆清台</div></div>' +
        '</div></article>'
    }).join('')
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
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted-foreground);">没有符合条件的会员</td></tr>'
      refreshIcons()
      return
    }
    tbody.innerHTML = rows.map(function (m) {
      var badge = m.rank <= 3
        ? '<span class="rank-badge ' + ['gold', 'silver', 'bronze'][m.rank - 1] + '">' + m.rank + '</span>'
        : String(m.rank)
      var total = (m.wins || 0) + (m.losses || 0)
      return '<tr data-id="' + m._id + '" style="cursor:pointer;">' +
        '<td class="col-rank">' + badge + '</td>' +
        '<td>' + U.escapeHtml(m.name || '未命名') + '</td>' +
        '<td class="col-points">' + (m.points != null ? m.points : 0) + '</td>' +
        '<td class="col-season">' + (m.wins || 0) + ' / ' + total + '</td>' +
        '<td class="col-clears">' + (m.clears || 0) + '</td>' +
        '<td class="col-winrate">' + (m.winRate || 0) + '%</td>' +
        '<td>' + trendHtml(m) + '</td></tr>'
    }).join('')
    bindMemberLinks(tbody)
    refreshIcons()
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
        renderTable()
      })
      var clear = document.querySelector('.rk-filter-bar .clear')
      if (clear) {
        clear.addEventListener('click', function () {
          input.value = ''
          state.keyword = ''
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
        renderTable()
      })
    })
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
