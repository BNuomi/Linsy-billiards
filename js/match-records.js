/* 对战记录页：分页加载 + 玩法/比赛筛选 + 搜索 + 月份过滤 */
;(function () {
  var PAGE_SIZE = 10
  // 固定类型 tab；比赛 tab 由 getCompetitions 动态拼接（key 带 comp_ 前缀）
  var BASE_TABS = [
    { key: 'all', label: '全部' },
    { key: 'c8', label: '中八' },
    { key: 'nine_ball', label: '九球追分' }
  ]
  var state = { list: [], skip: 0, scopeKey: 'all', scopeTabs: BASE_TABS.slice(), keyword: '', month: '', loading: false, noMore: false }
  var U = window.AppUI

  function el(id) { return document.getElementById(id) }

  var GAME_TYPE_LABEL = { c8: '中八', nine_ball: '九球追分' }
  var MODE_LABEL = { 1: '翻局', 2: '进球数', 3: '逐杆' }
  var STATUS = {
    finished: { text: '已确认', cls: 'confirmed' },
    ongoing: { text: '进行中', cls: 'pending' },
    pending_confirm: { text: '待确认', cls: 'pending' }
  }

  // 当前选中 tab 对应的云端查询参数
  function scopeParams() {
    var tab = null
    state.scopeTabs.forEach(function (t) { if (t.key === state.scopeKey) tab = t })
    if (!tab || tab.key === 'all') return {}
    if (tab.competitionId) return { competition_id: tab.competitionId }
    return { game_type: tab.key }
  }

  // ---------- 类型/比赛维度胶囊 tab ----------
  async function loadCompetitions() {
    try {
      var comps = await window.AppCloud.call('getCompetitions') || []
      state.scopeTabs = BASE_TABS.concat(comps.map(function (c) {
        return { key: 'comp_' + c._id, label: c.name, competitionId: c._id }
      }))
      renderScopeTabs()
    } catch (e) {
      // 比赛列表失败不影响基础类型筛选
      console.warn('[match-records] 比赛列表加载失败', e)
    }
  }

  function renderScopeTabs() {
    var box = el('filter-pills')
    if (!box) return
    box.innerHTML = state.scopeTabs.map(function (t) {
      return '<button class="pill' + (t.key === state.scopeKey ? ' active' : '') +
        '" type="button" role="tab" data-key="' + t.key + '" title="' + U.escapeHtml(t.label) + '">' +
        U.escapeHtml(t.label) + '</button>'
    }).join('')
    box.querySelectorAll('.pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var key = pill.getAttribute('data-key')
        if (!key || key === state.scopeKey) return
        box.querySelectorAll('.pill').forEach(function (p) { p.classList.remove('active') })
        pill.classList.add('active')
        state.scopeKey = key
        state.skip = 0
        state.list = []
        state.noMore = false
        load(false)
      })
    })
  }

  async function load(more) {
    if (state.loading) return
    state.loading = true
    paintLoading(more)
    try {
      var params = Object.assign({ skip: state.skip, limit: PAGE_SIZE }, scopeParams())
      var page = await window.AppCloud.call('getMatches', params)
      page = page || []
      state.noMore = page.length < PAGE_SIZE
      state.list = more ? state.list.concat(page) : page
      state.skip = state.list.length
      render()
    } catch (e) {
      U.toast('加载对战记录失败：' + (e.message || e), 'error')
      if (!state.list.length) {
        el('match-grid').innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted-foreground);">加载失败，请稍后重试</div>'
      }
    } finally {
      state.loading = false
    }
  }

  function paintLoading(more) {
    var grid = el('match-grid')
    if (!more && grid && !state.list.length) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted-foreground);">加载中…</div>'
    }
    var btn = el('load-more')
    if (btn) btn.disabled = true
  }

  function visible() {
    var kw = state.keyword.trim()
    return state.list.filter(function (m) {
      if (kw) {
        var names = (m.players_detail || []).map(function (p) { return p.name }).join(' ')
        if (names.indexOf(kw) < 0) return false
      }
      if (state.month) {
        var d = new Date(m.created_at)
        var ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        if (ym !== state.month) return false
      }
      return true
    })
  }

  function scoreText(m) {
    if (m.game_type === 'c8' && m.frame_score) {
      return (m.players || []).map(function (p) { return m.frame_score[p] != null ? m.frame_score[p] : 0 }).join(' : ')
    }
    if (m.game_type === 'nine_ball' && m.final_scores) {
      return (m.players || []).map(function (p) { return m.final_scores[p] }).join(' / ')
    }
    return ''
  }

  function cardHtml(m) {
    var st = STATUS[m.status] || STATUS.finished
    var detail = m.players_detail || []
    var playersHtml
    if (m.game_type === 'c8') {
      playersHtml = detail.map(function (p, i) {
        var winner = m.winner === p._id ? ' winner' : ''
        return (i ? '<span class="vs-label">VS</span>' : '') +
          '<span class="player-name' + winner + '">' + U.escapeHtml(p.name) + '</span>'
      }).join('') + '<span class="match-score">' + scoreText(m) + '</span>'
    } else {
      playersHtml = detail.map(function (p, i) {
        return (i ? '<span class="vs-label">·</span>' : '') +
          '<span class="player-name">' + U.escapeHtml(p.name) + '</span>'
      }).join('') + '<span class="match-score" style="font-size:1.1rem;">' + scoreText(m) + '</span>'
    }
    var meta = detail.map(function (p) {
      if (p.delta === null || p.delta === undefined) return ''
      var cls = p.delta >= 0 ? 'positive' : 'negative'
      return '<span class="points-change ' + cls + '" title="' + U.escapeHtml(p.name) + '">' + U.fmtDelta(p.delta) + '</span>'
    }).join('')
    var typeLabel = GAME_TYPE_LABEL[m.game_type] || m.game_type
    if (m.game_type === 'c8' && m.mode) typeLabel += ' · ' + (MODE_LABEL[m.mode] || '')
    if (m.game_type === 'nine_ball' && m.ball_count) typeLabel = m.ball_count + '球追分'
    meta += '<span class="status-badge ' + st.cls + '"><span class="dot"></span>' + st.text + '</span>' +
      '<span style="font-size:12px;color:var(--muted-foreground);font-weight:600;">' + typeLabel + '</span>'
    // 关联比赛徽标（对局创建时选中的赛事；点击进比赛详情）+ 阶段徽标（对阵开局落库）
    if (m.competition_name) {
      var compHref = m.competition_id
        ? './competition-detail.html?id=' + encodeURIComponent(m.competition_id)
        : '#'
      meta += '<a class="comp-badge" href="' + compHref + '" title="' + U.escapeHtml(m.competition_name) + '">' + U.escapeHtml(m.competition_name) + '</a>'
    }
    var stageLabel = { group: '小组赛', r16: '16强赛', qf: '1/4决赛', semi: '半决赛', third: '季军赛', final: '决赛', ko: '淘汰赛' }[m.stage] || ''
    if (stageLabel) meta += '<span class="stage-badge">' + stageLabel + '</span>'
    return '<article class="match-card" data-id="' + U.escapeHtml(m._id) + '" role="link" tabindex="0" aria-label="查看对战详情">' +
      '<div class="match-date"><span class="eyebrow">' + U.fmtDate(m.created_at) + '</span></div>' +
      '<div class="match-body"><div class="match-players">' + playersHtml + '</div>' +
      '<div class="match-meta">' + meta + '</div></div>' +
      '<div class="match-chevron"><i data-lucide="chevron-right" style="width:20px;height:20px;"></i></div>' +
      '</article>'
  }

  function render() {
    var grid = el('match-grid')
    var rows = visible()
    if (!rows.length) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted-foreground);">' +
        (state.list.length ? '没有符合条件的对战' : '暂无对战记录，点击右下角「生成演示数据」开始体验') + '</div>'
    } else {
      grid.innerHTML = rows.map(cardHtml).join('')
    }
    var count = el('filter-count')
    if (count) count.textContent = '共 ' + rows.length + ' 场对战'
    var pageText = el('pagination-text')
    if (pageText) pageText.textContent = state.noMore ? '已加载全部 ' + state.list.length + ' 场' : '已加载 ' + state.list.length + ' 场'
    var btn = el('load-more')
    if (btn) {
      btn.disabled = false
      btn.style.display = state.noMore ? 'none' : ''
    }
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons()
  }

  function bindControls() {
    var input = el('search-input')
    if (input) {
      input.addEventListener('input', function () {
        state.keyword = input.value
        ensureAllLoaded()
      })
    }
    renderScopeTabs()
    var month = el('month-filter')
    if (month) {
      month.addEventListener('change', function () {
        state.month = month.value || ''
        ensureAllLoaded()
      })
    }
    var more = el('load-more')
    if (more) {
      more.addEventListener('click', function () { load(true) })
    }
    bindCardClick()
    bindQrModal()
  }

  // 卡片点击：进行中 → 观看模式（详情页 5s 轮询）；已完成 → 静态详情
  function bindCardClick() {
    var grid = el('match-grid')
    if (!grid) return
    function go(card) {
      var id = card && card.getAttribute('data-id')
      if (id) location.href = './match-detail.html?matchId=' + encodeURIComponent(id)
    }
    grid.addEventListener('click', function (e) {
      // 卡片内嵌链接（如比赛徽标）走自身跳转，不触发卡片跳转
      var innerLink = e.target && e.target.closest ? e.target.closest('a') : null
      if (innerLink) {
        if (innerLink.getAttribute('href') === '#') e.preventDefault()
        e.stopPropagation()
        return
      }
      var card = e.target && e.target.closest ? e.target.closest('.match-card') : null
      if (card) go(card)
    })
    grid.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return
      var card = e.target && e.target.closest ? e.target.closest('.match-card') : null
      if (card) {
        e.preventDefault()
        go(card)
      }
    })
  }

  // ---------- 小程序码弹窗：扫码直达「新建对局」 ----------
  var qrState = { url: '', loading: false }

  function paintQr(mode) {
    var img = el('qr-img')
    var loading = el('qr-loading')
    var error = el('qr-error')
    if (img) img.style.display = mode === 'img' ? '' : 'none'
    if (loading) loading.style.display = mode === 'loading' ? '' : 'none'
    if (error) error.style.display = mode === 'error' ? 'flex' : 'none'
  }

  function isQrOpen() {
    var pop = el('qr-pop')
    return !!(pop && pop.classList.contains('open'))
  }

  function openQrModal() {
    var pop = el('qr-pop')
    if (!pop) return
    if (isQrOpen()) {
      closeQrModal()
      return
    }
    pop.classList.add('open')
    loadQr(false)
  }

  function closeQrModal() {
    var pop = el('qr-pop')
    if (pop) pop.classList.remove('open')
  }

  async function loadQr(force) {
    if (qrState.loading) return
    if (qrState.url && !force) {
      paintQr('img')
      return
    }
    qrState.loading = true
    paintQr('loading')
    try {
      var d = await window.AppCloud.call('getEntryQrcode')
      var url = d && d.url
      if (!url) throw new Error('云端未返回二维码')
      await preloadImg(url)
      qrState.url = url
      var img = el('qr-img')
      if (img) img.src = url
      paintQr('img')
    } catch (e) {
      var t = el('qr-error-text')
      if (t) t.textContent = '二维码加载失败：' + (e.message || e)
      paintQr('error')
    } finally {
      qrState.loading = false
    }
  }

  function preloadImg(url) {
    return new Promise(function (resolve, reject) {
      var im = new Image()
      im.onload = function () { resolve() }
      im.onerror = function () { reject(new Error('二维码图片加载失败')) }
      im.src = url
    })
  }

  function bindQrModal() {
    var create = el('create-match')
    if (create) {
      create.addEventListener('click', function (e) {
        e.stopPropagation()
        openQrModal()
      })
    }
    // 浮层内部点击不冒泡（避免触发外部点击关闭）
    var pop = el('qr-pop')
    if (pop) pop.addEventListener('click', function (e) { e.stopPropagation() })
    // 类右键菜单交互：点击页面任意空白处关闭
    document.addEventListener('click', function () { closeQrModal() })
    var close = el('qr-close')
    if (close) close.addEventListener('click', closeQrModal)
    var retry = el('qr-retry')
    if (retry) retry.addEventListener('click', function () { loadQr(true) })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeQrModal()
    })
  }

  // 关键词/月份属于全库筛选：自动把剩余分页拉完再渲染（数据量大时后续可升级为云端查询）
  async function ensureAllLoaded() {
    render()
    while (!state.noMore && !state.loading) {
      await load(true)
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('matches')
    U.mountCloudBar(function () {
      state.skip = 0
      state.list = []
      state.noMore = false
      loadCompetitions()
      load(false)
    })
    bindControls()
    loadCompetitions()
    load(false)
  })
})()
