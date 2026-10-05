/* 会员详情页：按 ?id= 展示会员资料、积分趋势、近期对战与交手记录 */
;(function () {
  var U = window.AppUI
  var chart = null
  var selfId = null
  var lastTrend = [] // 缓存最近一次积分趋势，供主题切换后重绘图表配色

  function el(id) { return document.getElementById(id) }

  function queryId() {
    var m = window.location.search.match(/[?&]id=([^&]+)/)
    return m ? decodeURIComponent(m[1]) : null
  }

  async function load() {
    try {
      var id = queryId()
      if (!id) {
        var rankings = await window.AppCloud.call('getRankings')
        if (!rankings.length) throw new Error('暂无会员数据')
        id = rankings[0]._id
      }
      var d = await window.AppCloud.call('getMemberDetail', { id: id })
      selfId = id
      // 未公开信息：仅展示用户名与头像（云端已过滤统计/趋势/对局数据）
      if (d.infoHidden) {
        renderHidden(d.member || {})
        return
      }
      renderProfile(d)
      renderStats(d)
      renderChart(d.trend || [])
      renderMatches(d.matches || [])
      renderH2h(d.h2h || [])
    } catch (e) {
      U.toast('加载会员详情失败：' + (e.message || e), 'error')
    }
  }

  // 未公开信息：只保留用户名 + 头像，隐藏其余区块
  function renderHidden(m) {
    var avatar = el('md-avatar')
    if (avatar) avatar.textContent = (m.name || '未')[0]
    setText('md-name', m.name || '未命名会员')
    document.title = (m.name || '会员') + ' - 会员详情'
    hide('md-rank-badge')
    hide('md-profile-meta')
    hide('md-edit')
    hide('md-stats-grid')
    hide('md-trend-section')
    hide('md-matches-section')
    hide('md-h2h-section')
    var tip = el('md-hidden-tip')
    if (tip) tip.style.display = ''
  }

  function hide(id) {
    var n = el(id)
    if (n) n.style.display = 'none'
  }

  function renderProfile(d) {
    var m = d.member || {}
    var avatar = el('md-avatar')
    if (avatar) avatar.textContent = (m.name || '未')[0]
    setText('md-name', m.name || '未命名')
    setText('md-rank', '排名第 ' + d.rank + ' / ' + d.totalMembers)
    setText('md-join', U.fmtDate(m.created_at) + ' 加入')
    setText('md-id', String(m._id || '').slice(-6).toUpperCase())
    document.title = (m.name || '会员') + ' - 会员详情'
  }

  function renderStats(d) {
    var m = d.member || {}
    var total = (m.wins || 0) + (m.losses || 0)
    var winRate = total ? Math.round(((m.wins || 0) / total) * 100) : 0
    setText('md-points', m.points != null ? m.points : 0)
    setText('md-wins', (m.wins || 0) + ' / ' + total)
    setText('md-winrate', winRate + '%')
    setText('md-clears', m.clears || 0)
  }

  function renderChart(trend) {
    var canvas = el('pointsChart')
    if (!canvas || !window.Chart) return
    lastTrend = trend
    if (!trend.length) {
      canvas.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted-foreground);">暂无积分变动记录</div>'
      return
    }
    var labels = trend.map(function (p) { return U.fmtMonthDay(p.t) })
    var data = trend.map(function (p) { return p.points })
    var min = Math.min.apply(null, data)
    var max = Math.max.apply(null, data)
    var pad = Math.max(2, Math.round((max - min) * 0.2))

    function varValue(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    }
    function hexToRgba(hex, alpha) {
      var h = hex.replace('#', '')
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      var r = parseInt(h.substring(0, 2), 16)
      var g = parseInt(h.substring(2, 4), 16)
      var b = parseInt(h.substring(4, 6), 16)
      return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')'
    }
    var chartColor = varValue('--chart-2')
    var gridColor = varValue('--border')
    var textColor = varValue('--muted-foreground')
    var tooltipBg = varValue('--foreground')
    var tooltipFg = varValue('--background')

    if (chart) chart.destroy()
    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: '积分',
          data: data,
          borderColor: chartColor,
          backgroundColor: hexToRgba(chartColor, 0.08),
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: chartColor,
          pointHoverBorderColor: tooltipFg,
          pointHoverBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltipBg,
            titleColor: tooltipFg,
            bodyColor: tooltipFg,
            padding: 12,
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              label: function (ctx) { return '积分: ' + ctx.parsed.y },
              afterLabel: function (ctx) {
                var t = trend[ctx.dataIndex]
                return t && t.remark ? t.remark : ''
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, border: { color: gridColor }, ticks: { color: textColor, font: { size: 12 } } },
          y: {
            min: min - pad,
            max: max + pad,
            grid: { color: gridColor, drawTicks: false },
            border: { display: false },
            ticks: { color: textColor, font: { size: 12 }, padding: 8 }
          }
        }
      }
    })
  }

  function matchRowHtml(m) {
    var others = (m.players_detail || []).filter(function (p) { return p._id !== selfId })
    // 比分以"自己"视角展示：自己的分数永远排在最前
    var order = (m.players || []).slice().sort(function (x, y) {
      return x === selfId ? -1 : y === selfId ? 1 : 0
    })
    var scoreText = ''
    var resultHtml = ''
    if (m.game_type === 'c8' && m.frame_score) {
      scoreText = order.map(function (p) { return m.frame_score[p] != null ? m.frame_score[p] : 0 }).join(' : ')
      var win = m.winner === selfId
      resultHtml = '<span class="match-result ' + (win ? 'win">胜' : 'lose">负') + '</span>'
    } else if (m.game_type === 'nine_ball' && m.final_scores) {
      scoreText = order.map(function (p) { return m.final_scores[p] }).join(' / ')
      // v2 积分恒为正，净胜/净负按场内终分与初始分比较
      var mine = m.final_scores[selfId] != null ? m.final_scores[selfId] : 0
      var init = m.init_score || 100
      resultHtml = mine > init
        ? '<span class="match-result win">净胜</span>'
        : mine < init
          ? '<span class="match-result lose">净负</span>'
          : '<span class="match-result">持平</span>'
    }
    var d = m.my_delta || 0
    var dCls = d >= 0 ? 'positive' : 'negative'
    var typeTag = m.game_type === 'nine_ball' && m.ball_count ? ' · ' + m.ball_count + '球' : ''
    return '<div class="match-row">' +
      '<span class="match-date">' + U.fmtDate(m.created_at) + '</span>' +
      '<span class="match-opponent">vs ' + U.escapeHtml(others.map(function (p) { return p.name }).join(' / ')) + typeTag + '</span>' +
      '<span class="match-score">' + scoreText + '</span>' +
      resultHtml +
      '<span class="match-points ' + dCls + '">' + U.fmtDelta(d) + '</span>' +
      '</div>'
  }

  function renderMatches(matches) {
    var box = el('md-matches')
    if (!box) return
    if (!matches.length) {
      box.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted-foreground);">暂无对战记录</div>'
      return
    }
    box.innerHTML = matches.map(matchRowHtml).join('')
  }

  function renderH2h(h2h) {
    var box = el('md-h2h')
    if (!box) return
    var head = '<div class="c h"><span class="k">对手</span></div>' +
      '<div class="c h"><span class="k">对战场次</span></div>' +
      '<div class="c h"><span class="k">胜场</span></div>' +
      '<div class="c h"><span class="k">负场</span></div>' +
      '<div class="c h b"><span class="k">胜率</span></div>'
    if (!h2h.length) {
      box.innerHTML = head + '<div class="c" style="grid-column:1/-1;text-align:center;color:var(--muted-foreground);">暂无中八交手记录</div>'
      return
    }
    box.innerHTML = head + h2h.map(function (h) {
      return '<div class="c opp">' + U.escapeHtml(h.opponent) + '</div>' +
        '<div class="c v">' + h.total + '</div>' +
        '<div class="c v">' + h.wins + '</div>' +
        '<div class="c v">' + h.losses + '</div>' +
        '<div class="c v">' + h.winRate + '%</div>'
    }).join('')
  }

  function setText(id, val) {
    var n = el(id)
    if (n) n.textContent = val
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('member')
    U.mountCloudBar(load)
    // 编辑资料按钮已隐藏（网页版只读），不再绑定点击
    load()
    // 主题切换后按新配色重绘积分趋势图（图表颜色读取自 CSS 变量）
    document.addEventListener('themechange', function () {
      if (lastTrend.length) renderChart(lastTrend)
    })
  })
})()
