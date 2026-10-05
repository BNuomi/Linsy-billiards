/* 对战详情页：渲染中八逐局 / 九球流水 / 积分变动；进行中进入观看模式（5s 轮询） */
;(function () {
  var WATCH_INTERVAL = 5000
  var state = { matchId: '', loading: false, watch: false, timer: null, lastStatus: '' }
  var U = window.AppUI

  function el(id) { return document.getElementById(id) }

  var GAME_TYPE_LABEL = { c8: '中八', nine_ball: '九球追分' }
  var MODE_LABEL = { 1: '模式一 · 简易翻局', 2: '模式二 · 进球数记录', 3: '模式三 · 逐杆记录' }
  var SCORE_TYPE_NAMES = {
    kaiqiu_dajin: '开球大金',
    dajin: '大金',
    xiaojin: '小金',
    kaiqiu_hj9: '黄金九',
    pusheng: '普胜',
    fangui: '犯规',
    heibai: '黑白双下'
  }

  function parseMatchId() {
    var m = /[?&]matchId=([^&]+)/.exec(location.search || '')
    return m ? decodeURIComponent(m[1]) : ''
  }

  function fmtClock(ts) {
    if (!ts) return ''
    var d = new Date(ts)
    var p = function (n) { return String(n).padStart(2, '0') }
    return p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function fmtDateTime(ts) {
    if (!ts) return '-'
    var d = new Date(ts)
    var p = function (n) { return String(n).padStart(2, '0') }
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function statusBadge(status) {
    if (status === 'ongoing') {
      return '<span class="status-badge pending"><span class="dot"></span>进行中</span>'
    }
    if (status === 'pending_confirm') {
      return '<span class="status-badge pending"><span class="dot"></span>待确认</span>'
    }
    return '<span class="status-badge confirmed"><span class="dot"></span>已完成</span>'
  }

  function buildHeadHint(match) {
    if (match.game_type === 'c8') {
      var modeText = MODE_LABEL[match.mode] || ''
      var best = match.best_of || 0
      var winNeed = best ? Math.floor(best / 2) + 1 : 0
      return modeText + (best ? ' · ' + best + ' 局 ' + winNeed + ' 胜' : '')
    }
    if (match.game_type === 'nine_ball') {
      return '初始分 ' + (match.init_score || 100) + ' · 共 ' + (match.round_count || 0) + ' 局'
    }
    return ''
  }

  function nameOf(members, id) {
    var m = members && members[id]
    return m ? (m.name || '未命名') : '未知选手'
  }

  /* ---------- 中八 ---------- */
  function renderC8(container, match, members, frames, shots) {
    // 犯规累计（与九球 foulCount 同口径：由流水聚合，仅技术统计）
    var foulCount = {}
    ;(shots || []).forEach(function (s) {
      if (s.foul) foulCount[s.player] = (foulCount[s.player] || 0) + 1
    })
    var players = (match.players || []).map(function (id) {
      return {
        id: id,
        name: nameOf(members, id),
        score: (match.frame_score || {})[id] || 0,
        isWinner: match.winner === id,
        foul: foulCount[id] || 0
      }
    })
    el('md-players').innerHTML = players.map(function (p) {
      return '<div class="md-player-card' + (p.isWinner ? ' is-winner' : '') + '">' +
        '<div class="md-player-head">' +
          '<span class="md-player-name">' + U.escapeHtml(p.name) + '</span>' +
          (p.isWinner ? '<span class="md-winner-tag"><i data-lucide="trophy" style="width:12px;height:12px;"></i>胜方</span>' : '') +
        '</div>' +
        '<div class="md-player-score">' + p.score + '</div>' +
        '<div class="md-player-meta">' +
          (match.status === 'ongoing' ? '当前局分' : '终场局分') +
          (p.foul > 0 ? ' · 犯规 ' + p.foul + ' 次' : '') +
        '</div>' +
      '</div>'
    }).join('')

    // 模式三：逐杆按局分组（shots.frame_id → frames._id），仅技术统计展示
    var shotsByFrame = {}
    ;(shots || []).forEach(function (s) {
      ;(shotsByFrame[s.frame_id] = shotsByFrame[s.frame_id] || []).push(s)
    })
    var playerIds = match.players || []

    var rows = (frames || []).map(function (f) {
      if (match.mode === 3) {
        var lines = playerIds.map(function (pid) {
          var mine = shotsByFrame[f._id] || []
          var ballsHtml = mine
            .filter(function (s) { return !s.foul && s.made && s.player === pid })
            .map(function (s) { return '<span class="md-ball md-ball--' + s.ball_no + '"><i>' + s.ball_no + '</i></span>' })
            .join('')
          var miss = mine.filter(function (s) { return !s.foul && !s.made && s.player === pid }).length
          var foul = mine.filter(function (s) { return s.foul && s.player === pid }).length
          return '<div class="md-m3-line">' +
            '<span class="md-m3-name' + (f.winner === pid ? ' is-winner' : '') + '">' + U.escapeHtml(nameOf(members, pid)) + '</span>' +
            '<span class="md-m3-balls">' + (ballsHtml || '<span class="md-m3-none">—</span>') + '</span>' +
            (miss > 0 ? '<span class="md-m3-miss">未进 ×' + miss + '</span>' : '') +
            (foul > 0 ? '<span class="md-m3-foul">犯规 ×' + foul + '</span>' : '') +
          '</div>'
        }).join('')
        return '<div class="md-frame-row md-frame-row--m3">' +
          '<span class="md-frame-seq">第 ' + f.seq + ' 局</span>' +
          '<div class="md-m3-lines">' + lines + '</div>' +
          '<span class="md-frame-clear' + (f.is_clear ? ' on' : '') + '">' + (f.is_clear ? '一杆清台' : '—') + '</span>' +
        '</div>'
      }
      var detail = ''
      if (match.mode === 2 && typeof f.remaining_balls === 'number') {
        detail = '胜方进 8 球 · 负方进 ' + (7 - f.remaining_balls) + ' 球'
      }
      return '<div class="md-frame-row">' +
        '<span class="md-frame-seq">第 ' + f.seq + ' 局</span>' +
        '<span class="md-frame-winner">' + U.escapeHtml(nameOf(members, f.winner)) + '</span>' +
        '<span class="md-frame-clear' + (f.is_clear ? ' on' : '') + '">' + (f.is_clear ? '一杆清台' : '—') + '</span>' +
        (detail ? '<span class="md-frame-detail">' + detail + '</span>' : '<span></span>') +
      '</div>'
    }).join('')
    el('md-frames').innerHTML = rows || '<div class="md-empty">暂无逐局记录</div>'
    var clearTotal = (frames || []).filter(function (f) { return f.is_clear }).length
    el('md-clear-total').textContent = clearTotal > 0 ? '共 ' + clearTotal + ' 次一杆清台' : ''
    el('md-frames-section').style.display = ''
    el('md-rounds-section').style.display = 'none'
  }

  /* ---------- 九球 ---------- */
  function renderPursuit(container, match, members, rounds) {
    var seats = match.seats || {}
    var seatLetters = ['A', 'B', 'C'].filter(function (s) { return seats[s] })
    var orderedIds = seatLetters.length ? seatLetters.map(function (s) { return seats[s] }) : (match.players || [])
    var foulCount = {}
    ;(rounds || []).forEach(function (r) {
      if (r.score_type === 'fangui') foulCount[r.scorer] = (foulCount[r.scorer] || 0) + 1
    })
    var players = orderedIds.map(function (id, i) {
      return {
        id: id,
        seat: seatLetters[i] || '',
        name: nameOf(members, id),
        score: (match.final_scores || match.balances || {})[id] || 0,
        foul: foulCount[id] || 0
      }
    })
    el('md-players').innerHTML = players.map(function (p) {
      return '<div class="md-player-card">' +
        '<div class="md-player-head">' +
          (p.seat ? '<span class="md-seat">' + p.seat + '</span>' : '') +
          '<span class="md-player-name">' + U.escapeHtml(p.name) + '</span>' +
        '</div>' +
        '<div class="md-player-score">' + p.score + '</div>' +
        '<div class="md-player-meta">' +
          (match.status === 'ongoing' ? '当前余额' : '终场得分') +
          (p.foul > 0 ? ' · 犯规 ' + p.foul + ' 次' : '') +
        '</div>' +
      '</div>'
    }).join('')

    // 倒序：最新一局在前，同局主事件+犯规保持写入顺序
    var rows = (rounds || []).map(function (r, i) {
      var typeName = SCORE_TYPE_NAMES[r.score_type] || r.score_type
      if (r.score_type === 'heibai' && r.negated_type && SCORE_TYPE_NAMES[r.negated_type]) {
        typeName += '（原' + SCORE_TYPE_NAMES[r.negated_type] + '）'
      }
      var flags = []
      if (r.doubled) flags.push('翻倍')
      if (r.let_ball) flags.push('让球')
      if (r.let_ball_foul) flags.push('让球犯规')
      var changes = Object.keys(r.deltas || {})
        .map(function (pid) { return { pid: pid, v: r.deltas[pid] } })
        .filter(function (c) { return c.v !== 0 })
        .map(function (c) {
          return '<span class="md-round-change">' +
            '<span class="name">' + U.escapeHtml(nameOf(members, c.pid)) + '</span>' +
            '<span class="delta ' + (c.v > 0 ? 'pos' : 'neg') + '">' + U.fmtDelta(c.v) + '</span>' +
          '</span>'
        }).join('')
      return '<div class="md-round-row">' +
        '<div class="md-round-head">' +
          '<span class="md-round-seq">第 ' + r.round_seq + ' 局</span>' +
          '<span class="md-round-type">' + U.escapeHtml(typeName) + '</span>' +
          flags.map(function (f) { return '<span class="md-round-flag">' + f + '</span>' }).join('') +
          '<span class="md-round-time">' + fmtClock(r.created_at) + '</span>' +
        '</div>' +
        '<div class="md-round-changes">' + changes + '</div>' +
      '</div>'
    })
    // 同局分组 → 倒序展示
    var groups = []
    rows.forEach(function (row, i) {
      var r = rounds[i]
      var g = groups[groups.length - 1]
      if (g && g.seq === r.round_seq) g.rows.push(row)
      else groups.push({ seq: r.round_seq, rows: [row] })
    })
    var html = ''
    for (var i = groups.length - 1; i >= 0; i--) html += groups[i].rows.join('')
    el('md-rounds').innerHTML = html || '<div class="md-empty">暂无得分流水</div>'
    el('md-rounds-section').style.display = ''
    el('md-frames-section').style.display = 'none'
  }

  /* ---------- 积分流水 ---------- */
  function renderLogs(members, logs) {
    var rows = (logs || []).map(function (l) {
      return '<div class="md-log-row">' +
        '<div class="md-log-name">' + U.escapeHtml(nameOf(members, l.player)) +
          (l.remark ? '<span class="remark">' + U.escapeHtml(l.remark) + '</span>' : '') +
        '</div>' +
        '<span class="md-log-delta ' + (l.delta >= 0 ? 'pos' : 'neg') + '">' + U.fmtDelta(l.delta) + '</span>' +
        '<span class="md-log-after">余额 ' + (l.points_after != null ? l.points_after : '-') + '</span>' +
      '</div>'
    }).join('')
    el('md-logs').innerHTML = rows || '<div class="md-empty">暂无积分变动</div>'
    el('md-logs-section').style.display = ''
  }

  function render(data) {
    var match = data.match || {}
    var members = data.members || {}
    state.lastStatus = match.status || ''

    // 头部
    var typeLabel = GAME_TYPE_LABEL[match.game_type] || match.game_type || '对战'
    if (match.game_type === 'nine_ball' && match.ball_count) typeLabel = match.ball_count + '球追分'
    el('md-title').textContent = typeLabel
    var sub = []
    sub.push(fmtDateTime(match.created_at))
    var hint = buildHeadHint(match)
    if (hint) sub.push(hint)
    if (data.creator_name) sub.push('记录人：' + data.creator_name)
    el('md-subtitle').textContent = sub.join(' · ')
    el('md-status').innerHTML = statusBadge(match.status)

    // 选手区
    el('md-players-section').style.display = ''
    if (match.game_type === 'c8') {
      renderC8(el('md-players'), match, members, data.frames || [], data.shots || [])
    } else if (match.game_type === 'nine_ball') {
      renderPursuit(el('md-players'), match, members, data.rounds || [])
    }

    // 积分流水（仅已结束展示）
    if (match.status === 'finished' && (data.logs || []).length) {
      renderLogs(members, data.logs)
    } else {
      el('md-logs-section').style.display = 'none'
    }

    // 观看模式：进行中启动轮询
    if (match.status === 'ongoing') startWatch()
    else stopWatch()

    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons()
  }

  async function load(silent) {
    if (state.loading) return
    state.loading = true
    if (!silent) {
      el('md-error').style.display = 'none'
      el('md-subtitle').textContent = '加载中…'
    }
    try {
      var data = await window.AppCloud.call('getMatchDetail', { match_id: state.matchId })
      render(data || {})
    } catch (e) {
      if (!silent) {
        el('md-error-text').textContent = '加载失败：' + (e.message || e)
        el('md-error').style.display = ''
        el('md-subtitle').textContent = '无法加载对战详情'
      }
    } finally {
      state.loading = false
    }
  }

  function startWatch() {
    if (state.timer) return
    state.watch = true
    el('md-watch-tip').style.display = ''
    state.timer = setInterval(function () { load(true) }, WATCH_INTERVAL)
  }

  function stopWatch() {
    state.watch = false
    el('md-watch-tip').style.display = 'none'
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('matches')
    U.mountCloudBar(function () { load(false) })
    state.matchId = parseMatchId()
    if (!state.matchId) {
      el('md-error-text').textContent = '缺少 matchId 参数'
      el('md-error').style.display = ''
      el('md-subtitle').textContent = '请从对战记录列表进入'
      return
    }
    var retry = el('md-retry')
    if (retry) retry.addEventListener('click', function () { load(false) })
    load(false)
    // 页面隐藏时停止轮询，回到前台时若是观看模式则立即同步一次
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (state.timer) { clearInterval(state.timer); state.timer = null }
      } else if (state.watch) {
        load(true)
        if (!state.timer) state.timer = setInterval(function () { load(true) }, WATCH_INTERVAL)
      }
    })
  })

  window.addEventListener('beforeunload', stopWatch)
})()
