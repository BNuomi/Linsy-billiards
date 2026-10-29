/* 同时观看看板：对阵列表多选进入，轮询所选对局实时比分（15s；页面隐藏暂停，恢复可见立即刷新）
 * 数据源 getFixtures（比分由云端按 fixture 关联对局合并：进行中 = 实时 frame_score / balances）
 * 已结束的对局保留灰化展示最终比分；卡片点击进对局详情观看模式
 * 对局被移除（重新抽签等）自动出板；全部移除后展示空态 */
;(function () {
  var U = window.AppUI
  var POLL_MS = 15000
  var timer = null
  var polling = false
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  var STAGE_LABEL = { qualifier: '附加赛', group: '小组赛', r16: '16强赛', qf: '1/4决赛', semi: '半决赛', third: '季军赛', final: '决赛', ko: '淘汰赛' }

  function el(id) { return document.getElementById(id) }

  function param(key) {
    var m = new RegExp('[?&]' + key + '=([^&]*)').exec(window.location.search || '')
    return m ? decodeURIComponent(m[1]) : ''
  }

  var CID = param('cid')
  var FIX_IDS = param('fix').split(',').filter(Boolean)

  function p2(n) { return String(n).padStart(2, '0') }

  function fmtDay(ts) {
    var d = new Date(ts)
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + WEEKDAYS[d.getDay()]
  }

  function fmtClock(ts) {
    var d = new Date(ts)
    return p2(d.getHours()) + ':' + p2(d.getMinutes())
  }

  function fmtSync() {
    var d = new Date()
    return '已同步 ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
  }

  // 解析 score_text 为与选手同序的分数数组（与 fixtures/competition-live 同口径）：
  // 中八/斯诺克「3:1」按 ':' 拆；九球「王建国 +12 / 李志强 -5」取段尾带符号数
  function parseScores(scoreText, playerCount) {
    if (!scoreText) return null
    var nums
    if (scoreText.indexOf(' / ') >= 0) {
      nums = scoreText.split(' / ').map(function (seg) {
        var m = seg.match(/([+-]?\d+)\s*$/)
        return m ? { num: parseInt(m[1], 10), text: m[1] } : { num: 0, text: '0' }
      })
    } else {
      nums = scoreText.split(':').map(function (t) {
        var n = parseInt(t, 10) || 0
        return { num: n, text: String(n) }
      })
    }
    return nums.length === playerCount ? nums : null
  }

  // 组队展示 chips：互选合并「甲⇄乙 0/+2」，单向「甲→乙 +2」（与 fixtures 同口径）
  function teamChipsOf(f) {
    var entries = ((f && f.teams) || []).filter(function (t) { return t && t.pid && t.tid })
    var used = {}
    var chips = []
    function fmt(v) { return (v > 0 ? '+' : '') + v }
    entries.forEach(function (t) {
      if (used[t.pid]) return
      var back = entries.find(function (x) { return x.pid === t.tid && x.tid === t.pid && !used[x.pid] })
      if (back) {
        used[t.pid] = true; used[back.pid] = true
        var hasPts = (t.points || 0) !== 0 || (back.points || 0) !== 0
        var pts = hasPts ? ' ' + fmt(t.points || 0) + '/' + fmt(back.points || 0) : ''
        chips.push(t.name + '⇄' + t.tname + pts)
      } else {
        used[t.pid] = true
        chips.push(t.name + '→' + t.tname + (t.points ? ' ' + fmt(t.points) : ''))
      }
    })
    return chips
  }

  function cardHtml(f) {
    var ongoing = f.match_status === 'ongoing'
    var done = f.match_status === 'done'
    var st = ongoing ? '<span class="mw-status live">进行中</span>'
      : done ? '<span class="mw-status done">已结束</span>'
      : '<span class="mw-status done">未开赛</span>'
    var stage = STAGE_LABEL[f.stage] || ''
    var chips = (f.match_no ? '<span class="mw-chip no">No.' + f.match_no + '</span>' : '') +
      (stage ? '<span class="mw-chip stage">' + stage + '</span>' : '') +
      (f.stage === 'group' && f.group_no ? '<span class="mw-chip group">' + U.escapeHtml(f.group_no) + '组</span>' : '') +
      (f.table_no ? '<span class="mw-chip table">' + f.table_no + '号台</span>' : '')
    var time = f.slot_at ? fmtDay(f.slot_at) + ' ' + fmtClock(f.slot_at) + (f.session_no ? ' · 第' + f.session_no + '场' : '') : '时间待定'
    var plist = f.players || []
    var nums = parseScores(f.score_text, plist.length)
    var leadIdx = -1
    if (nums) {
      var max = Math.max.apply(null, nums.map(function (n) { return n.num }))
      var leaders = nums.map(function (n, i) { return n.num === max ? i : -1 }).filter(function (i) { return i >= 0 })
      if (leaders.length === 1) leadIdx = leaders[0]
    }
    var sides = plist.map(function (p, i) {
      return (i ? '<span class="mw-vs">vs</span>' : '') +
        '<span class="mw-side' + (i === leadIdx ? ' is-lead' : '') + '">' + U.escapeHtml(p.name) + '</span>'
    }).join('')
    // 分隔符随玩法：中八/斯诺克「:」，九球追分「/」（与 score_text 风格一致）
    var sep = (f.score_text || '').indexOf(' / ') >= 0 ? '/' : ':'
    var score = nums
      ? '<span class="mw-score">' + nums.map(function (n, i) {
          return (i ? '<span class="mw-score-sep">' + sep + '</span>' : '') +
            '<span class="' + (i === leadIdx ? 'is-lead' : '') + '">' + n.text + '</span>'
        }).join('') + '</span>'
      : '<span class="mw-score" style="font-size:14px;font-weight:600;">比分待记</span>'
    var extras = []
    if (f.clears > 0) extras.push('<span class="mw-clear">一杆清台 ×' + f.clears + '</span>')
    teamChipsOf(f).forEach(function (c) { extras.push('<span class="mw-team">' + U.escapeHtml(c) + '</span>') })
    var extraHtml = extras.length ? '<div class="mw-extra">' + extras.join('') + '</div>' : ''
    // 已有关联对局的卡片可点进详情观看模式；未关联（异常状态）保持静态
    var hasMatch = !!f.match_id
    var cls = 'mw-card' + (done ? ' is-done' : '') + (hasMatch ? '' : ' is-static')
    var inner = '<div class="mw-head">' + chips + st + '</div>' +
      '<div class="mw-time">' + time + '</div>' +
      '<div class="mw-row"><div class="mw-sides">' + sides + '</div>' + score + '</div>' + extraHtml
    return hasMatch
      ? '<a class="' + cls + '" href="./match-detail.html?matchId=' + encodeURIComponent(f.match_id) + '&from=live&cid=' + encodeURIComponent(CID) + '">' + inner + '</a>'
      : '<div class="' + cls + '">' + inner + '</div>'
  }

  function render(d) {
    var comp = d.competition || {}
    var all = d.fixtures || []
    var byId = {}
    FIX_IDS.forEach(function (id) { byId[id] = true })
    // 仅保留仍在签表中的所选对局（重新抽签后被移除的自动出板）
    var picked = FIX_IDS.map(function (id) {
      return all.find(function (f) { return f._id === id })
    }).filter(Boolean)

    el('mw-name').textContent = (comp.name || '比赛') + ' · 同时观看'
    el('mw-sub').textContent = picked.length + ' 场对局 · 比分每 15 秒自动刷新'
    document.title = (comp.name || '比赛') + '同时观看 - 台球协会'
    el('mw-back').href = './fixtures.html?id=' + encodeURIComponent(CID || comp._id || '')

    var liveN = picked.filter(function (f) { return f.match_status === 'ongoing' }).length
    el('mw-dot').style.display = liveN ? '' : 'none'
    el('mw-live-text').innerHTML = '进行中 <b>' + liveN + '</b> / 共 ' + picked.length + ' 场'
    el('mw-sync-text').textContent = fmtSync()
    el('mw-meta').style.display = ''

    var grid = el('mw-grid')
    if (picked.length) {
      grid.innerHTML = picked.map(cardHtml).join('')
      grid.style.display = ''
      el('mw-empty').style.display = 'none'
    } else {
      grid.style.display = 'none'
      el('mw-empty').style.display = ''
      el('mw-empty').textContent = '所选对局不在当前签表中（可能已被重新抽签移除），请返回对阵列表重新选择'
    }
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons()
  }

  function showError(msg) {
    el('mw-error-text').textContent = msg || '加载失败，请稍后重试'
    el('mw-error').style.display = ''
  }

  async function load() {
    if (!CID || !FIX_IDS.length) {
      showError('缺少观看参数，请从对阵列表选择对局后进入')
      return
    }
    try {
      var d = await window.AppCloud.call('getFixtures', { competition_id: CID })
      render(d || {})
    } catch (e) {
      showError(e.message || '加载失败，请稍后重试')
    }
  }

  function startPoll() {
    stopPoll()
    timer = setInterval(function () { load() }, POLL_MS)
  }

  function stopPoll() {
    if (timer) { clearInterval(timer); timer = null }
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('competitions')
    U.mountCloudBar(load)
    el('mw-retry').addEventListener('click', function () {
      el('mw-error').style.display = 'none'
      load()
    })
    el('mw-refresh').addEventListener('click', load)
    // 页面隐藏暂停轮询，恢复可见立即刷新（与比赛实况页同口径）
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPoll()
      else { load(); startPoll() }
    })
    load()
    startPoll()
  })
})()
