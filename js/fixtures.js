/* 比赛对阵列表页（只读）：报名名单 / 比赛日 / 抽签对阵与赛程进程 */
;(function () {
  var U = window.AppUI
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  function el(id) { return document.getElementById(id) }

  function compId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search || '')
    return m ? decodeURIComponent(m[1]) : ''
  }

  function fmtSlot(ts) {
    var d = new Date(ts)
    function p(n) { return String(n).padStart(2, '0') }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + WEEKDAYS[d.getDay()] + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function statusOf(f) {
    if (f.match_status === 'ongoing') return { text: '进行中', cls: 'live' }
    if (f.match_status === 'done') return { text: '已结束', cls: 'done' }
    return { text: '预告', cls: 'pending' }
  }

  // 局数设定标记：按所在轮次的非轮空对阵数推导阶段（1 场=决赛 / 2 场=半决赛 / 其余=小组赛），读取比赛 race_*
  function raceOf(fixtures, comp, f) {
    if (!comp || comp.game_type === 'nine_ball') return ''
    var count = fixtures.filter(function (x) {
      return x.round === f.round && x.status !== 'bye' && (x.players || []).length >= 2
    }).length
    var stage = count <= 1 ? 'final' : (count === 2 ? 'semi' : 'group')
    var v = Number(comp['race_' + stage])
    return Number.isInteger(v) && v > 0 ? '抢' + v : ''
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

    // 比赛日
    var days = comp.match_days || []
    if (days.length) {
      el('fx-days').innerHTML = days.map(function (d0) {
        return '<div class="fx-day-row"><span class="fx-day-date">' + U.escapeHtml(d0.date) + '</span>' +
          '<span class="fx-day-desc">' + U.escapeHtml(d0.start_time) + ' 起 · 每场 ' + d0.slot_minutes + ' 分钟 · ' + d0.slot_count + ' 场</span></div>'
      }).join('')
      el('fx-days-section').style.display = ''
    }

    // 对阵：轮次 → 日期分组
    if (!fixtures.length) {
      el('fx-empty').style.display = ''
      refreshIcons()
      return
    }
    var rounds = new Map()
    fixtures.forEach(function (f) {
      if (!rounds.has(f.round)) rounds.set(f.round, { byes: [], items: [] })
      var r = rounds.get(f.round)
      if (f.status === 'bye') {
        r.byes.push(U.escapeHtml((f.players[0] && f.players[0].name) || ''))
      } else {
        r.items.push(f)
      }
    })

    var html = [...rounds.entries()].map(function ([roundNo, r]) {
      var dayMap = new Map()
      r.items.forEach(function (f) {
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
          return '<div class="fx-card">' +
            '<div class="fx-card-top"><span class="fx-time">' + (f.slot_at ? fmtSlot(f.slot_at) : '时间待定') + '</span>' +
            (race ? '<span class="fx-race">' + race + '</span>' : '') +
            '<span class="fx-status ' + st.cls + '">' + st.text + '</span></div>' +
            '<div class="fx-players">' + names + '</div>' + result + '</div>'
        }).join('')
        return '<div class="fx-day-group"><div class="fx-day-label">' + day + '</div><div class="fx-grid">' + cards + '</div></div>'
      }).join('')
      var byeHtml = r.byes.length ? '<div class="fx-bye">轮空：' + r.byes.join('、') + '</div>' : ''
      return '<section class="section"><div class="section-eyebrow">第 ' + roundNo + ' 轮</div>' + byeHtml + dayHtml + '</section>'
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
