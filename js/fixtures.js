/* 比赛对阵列表页（只读）：报名名单 / 比赛日 / 抽签对阵与赛程进程 */
;(function () {
  var U = window.AppUI
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  function el(id) { return document.getElementById(id) }

  function compId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search || '')
    return m ? decodeURIComponent(m[1]) : ''
  }

  var STAGE_LABEL = { group: '小组赛', r16: '16强赛', qf: '1/4决赛', semi: '半决赛', final: '决赛', ko: '淘汰赛' }

  function p2(n) { return String(n).padStart(2, '0') }

  function fmtDay(ts) {
    var d = new Date(ts)
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + WEEKDAYS[d.getDay()]
  }

  function fmtClock(ts) {
    var d = new Date(ts)
    return p2(d.getHours()) + ':' + p2(d.getMinutes())
  }

  function statusOf(f) {
    if (f.match_status === 'ongoing') return { text: '进行中', cls: 'live' }
    if (f.match_status === 'done') return { text: '已结束', cls: 'done' }
    return { text: '预告', cls: 'pending' }
  }

  // 对阵阶段：fixture.stage 显式优先（小组赛制落库），结构推导兜底（逐轮抽签旧数据）
  function stageOf(fixtures, f) {
    if (f.stage && STAGE_LABEL[f.stage]) return f.stage
    var count = fixtures.filter(function (x) {
      return x.round === f.round && x.status !== 'bye' && (x.players || []).length >= 2
    }).length
    return count <= 1 ? 'final' : (count === 2 ? 'semi' : 'group')
  }

  // 局数设定标记：读取比赛 race_*（中八）
  function raceOf(fixtures, comp, f) {
    if (!comp || comp.game_type === 'nine_ball') return ''
    var stage = stageOf(fixtures, f)
    var v = Number(comp['race_' + stage])
    return Number.isInteger(v) && v > 0 ? '抢' + v : ''
  }

  function isGK(comp) {
    return comp && comp.format === 'groups_knockout' && comp.game_type !== 'nine_ball'
  }

  // 赛制说明：「4 人小组 × 4 组 · 前 2 出线 · 共 31 场（小组 24 + 淘汰 7）」
  function formatDesc(comp, participantCount) {
    if (!isGK(comp)) return ''
    var gs = Number(comp.group_size) > 1 ? Number(comp.group_size) : 4
    var adv = Number(comp.advance_count) > 0 ? Number(comp.advance_count) : 2
    if (!participantCount) return gs + ' 人小组循环 · 前 ' + adv + ' 出线进淘汰赛'
    var nGroups = Math.max(1, Math.round(participantCount / gs))
    var base = Math.floor(participantCount / nGroups)
    var rem = participantCount - base * nGroups
    var groupMatches = 0
    for (var i = 0; i < nGroups; i++) {
      var size = base + (rem-- > 0 ? 1 : 0)
      groupMatches += size * (size - 1) / 2
    }
    var qualified = nGroups * adv
    var ko = Math.max(qualified - 1, 0)
    return gs + ' 人小组 × ' + nGroups + ' 组 · 前 ' + adv + ' 出线 · 共 ' + (groupMatches + ko) + ' 场（小组 ' + groupMatches + ' + 淘汰 ' + ko + '）'
  }

  function showError(msg) {
    el('fx-error-text').textContent = msg || '加载失败，请稍后重试'
    el('fx-error').style.display = ''
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons()
  }

  function render(d) {
    var comp = d.competition || {}
    var participants = d.participants || []
    var fixtures = d.fixtures || []

    el('fx-name').textContent = (comp.name || '比赛') + ' · 对阵列表'
    var sub = []
    if (comp.start_date || comp.end_date) sub.push((comp.start_date || '未定') + ' 至 ' + (comp.end_date || '未定'))
    if (comp.venue) sub.push(comp.venue)
    el('fx-subtitle').textContent = sub.join(' · ')
    document.title = (comp.name || '比赛') + '对阵 - 台球协会'
    el('fx-back').href = './competition-detail.html?id=' + encodeURIComponent(comp._id || compId())

    // 报名名单
    el('fx-part-count').textContent = participants.length
    el('fx-participants').innerHTML = participants.length
      ? participants.map(function (p) { return '<span class="fx-chip">' + U.escapeHtml(p.name) + '</span>' }).join('')
      : '<div class="fx-empty-inline">暂无报名</div>'
    el('fx-part-section').style.display = ''
    // 赛制说明（小组赛制）
    var fd = formatDesc(comp, participants.length)
    if (fd) {
      el('fx-participants').insertAdjacentHTML('afterend', '<div class="fx-format">赛制：' + U.escapeHtml(fd) + '</div>')
    }

    // 比赛日
    var days = comp.match_days || []
    if (days.length) {
      var tables = Number(comp.table_count) > 0 ? Number(comp.table_count) : 4
      el('fx-days').innerHTML = days.map(function (d0) {
        return '<div class="fx-day-row"><span class="fx-day-date">' + U.escapeHtml(d0.date) + '</span>' +
          '<span class="fx-day-desc">' + U.escapeHtml(d0.start_time) + ' 起 · 每场 ' + d0.slot_minutes + ' 分钟 · ' + d0.slot_count + ' 场</span></div>'
      }).join('') + '<div class="fx-day-row"><span class="fx-day-date">同时开赛</span>' +
        '<span class="fx-day-desc">' + tables + ' 个球台 · 每台每日约 ' + (days[0].slot_count || 3) + ' 场</span></div>'
      el('fx-days-section').style.display = ''
    }

    // 对阵：未抽签
    if (!fixtures.length) {
      el('fx-empty').style.display = ''
      refreshIcons()
      return
    }

    // 赛程进度
    var real = fixtures.filter(function (f) { return f.status !== 'bye' })
    if (real.length) {
      var done = real.filter(function (f) { return f.match_status === 'done' }).length
      var live = real.filter(function (f) { return f.match_status === 'ongoing' }).length
      var unscheduled = real.filter(function (f) { return !f.match_id && !f.slot_at }).length
      el('fx-progress').innerHTML = '共 <b>' + real.length + '</b> 场 · 已结束 <b>' + done + '</b> · 进行中 <b>' + live + '</b> · 预告 <b>' + (real.length - done - live) + '</b>' +
        (unscheduled ? '<span class="warn">（' + unscheduled + ' 场待排期）</span>' : '')
      el('fx-progress').style.display = ''
    }

    // 分区：GK = 小组赛按组 / 淘汰赛按轮；rounds = 按轮
    var gk = isGK(comp)
    var sections = new Map()
    fixtures.forEach(function (f) {
      var key, title, order
      if (gk && f.stage === 'group') {
        key = 'group_' + (f.group_no || 'A')
        title = '小组赛 · ' + (f.group_no || 'A') + '组'
        order = 1 + (f.group_no || 'A').charCodeAt(0) - 65
      } else if (gk) {
        key = 'ko_' + f.round
        title = '淘汰赛 · ' + (STAGE_LABEL[f.stage] || ('第' + f.round + '轮'))
        order = 100 + f.round
      } else {
        key = 'round_' + f.round
        title = '第 ' + f.round + ' 轮'
        order = f.round
      }
      if (!sections.has(key)) sections.set(key, { title: title, order: order, byes: [], items: [] })
      var sec = sections.get(key)
      if (f.status === 'bye') {
        sec.byes.push(U.escapeHtml((f.players[0] && f.players[0].name) || ''))
      } else {
        sec.items.push(f)
      }
    })

    var html = [...sections.values()].sort(function (a, b) { return a.order - b.order }).map(function (sec) {
      var dayMap = new Map()
      sec.items.forEach(function (f) {
        var key = f.slot_at ? U.fmtDate(f.slot_at) : '时间待定'
        if (!dayMap.has(key)) dayMap.set(key, [])
        dayMap.get(key).push(f)
      })
      var dayHtml = [...dayMap.entries()].map(function ([day, items]) {
        var cards = items.map(function (f) {
          var st = statusOf(f)
          var race = raceOf(fixtures, comp, f)
          var names = (f.players || []).map(function (p) { return U.escapeHtml(p.name) }).join('<span class="fx-vs">vs</span>')
          var winner = f.winner_id ? ((f.players.find(function (p) { return p.id === f.winner_id }) || {}).name || '') : ''
          var result = st.cls === 'done'
            ? '<div class="fx-result"><span class="fx-winner">胜：' + U.escapeHtml(winner) + '</span>' +
              (f.score_text ? '<span class="fx-score">' + U.escapeHtml(f.score_text) + '</span>' : '') + '</div>'
            : ''
          var slotChips = f.slot_at
            ? '<span class="fx-chip-slot date">' + fmtDay(f.slot_at) + '</span>' +
              '<span class="fx-chip-slot time">' + fmtClock(f.slot_at) + '</span>' +
              (f.table_no ? '<span class="fx-chip-slot table">' + f.table_no + '号台</span>' : '') +
              (f.session_no ? '<span class="fx-chip-slot session">第' + f.session_no + '场</span>' : '')
            : '<span class="fx-chip-slot tbd">时间待定</span>'
          return '<div class="fx-card">' +
            '<div class="fx-card-top">' + slotChips +
            (race ? '<span class="fx-race">' + race + '</span>' : '') +
            '<span class="fx-status ' + st.cls + '">' + st.text + '</span></div>' +
            '<div class="fx-players">' + names + '</div>' + result + '</div>'
        }).join('')
        return '<div class="fx-day-group"><div class="fx-day-label">' + day + '</div><div class="fx-grid">' + cards + '</div></div>'
      }).join('')
      var byeHtml = sec.byes.length ? '<div class="fx-bye">轮空：' + sec.byes.join('、') + '</div>' : ''
      return '<section class="section"><div class="section-eyebrow">' + sec.title + '</div>' + byeHtml + dayHtml + '</section>'
    }).join('')

    el('fx-rounds').innerHTML = html
    refreshIcons()
  }

  async function load() {
    var id = compId()
    if (!id) {
      showError('缺少比赛参数')
      return
    }
    try {
      var d = await window.AppCloud.call('getFixtures', { competition_id: id })
      render(d || {})
    } catch (e) {
      showError(e.message || '加载失败，请稍后重试')
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('competitions')
    U.mountCloudBar(load)
    el('fx-retry').addEventListener('click', function () {
      el('fx-error').style.display = 'none'
      load()
    })
    load()
  })
})()
