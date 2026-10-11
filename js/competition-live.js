/* 比赛实况页：进行中对局（5s 轮询实时比分）/ 即将上场（每台最近一场）/ 后续预告 / 已结束
 * 公开只读：入口无需权限；比分由 getFixtures 按 fixture 关联对局合并（进行中=实时 frame_score/balances）
 * 轮询：页面隐藏（visibilitychange）时暂停，恢复可见立即刷新 */
;(function () {
  var U = window.AppUI
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  var POLL_MS = 5000
  var DONE_SHOW = 8 // 已结束区展示最近场次数
  var UPCOMING_SHOW = 10 // 后续预告展示场次数
  var timer = null
  var polling = false

  function el(id) { return document.getElementById(id) }

  function compId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search || '')
    return m ? decodeURIComponent(m[1]) : ''
  }

  var STAGE_LABEL = { qualifier: '附加赛', group: '小组赛', r16: '16强赛', qf: '1/4决赛', semi: '半决赛', third: '季军赛', final: '决赛', ko: '淘汰赛' }
  // 卡片阶段 chip 标签（16强/1/4决赛归入淘汰赛）
  var CARD_STAGE_LABEL = { qualifier: '附加赛', group: '小组赛', r16: '淘汰赛', qf: '淘汰赛', semi: '半决赛', third: '季军赛', final: '决赛', ko: '淘汰赛' }

  function p2(n) { return String(n).padStart(2, '0') }

  function fmtDay(ts) {
    var d = new Date(ts)
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + WEEKDAYS[d.getDay()]
  }

  function fmtClock(ts) {
    var d = new Date(ts)
    return p2(d.getHours()) + ':' + p2(d.getMinutes())
  }

  function fmtSyncTime() {
    var d = new Date()
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
  }

  // 排期顺序（与云端 updateFixture 同口径）：已排期按 时间→台号→场次，待定按场次编号排最后
  function cmpSched(a, b) {
    function key(f) {
      return [
        f.slot_at == null ? 9e15 : f.slot_at,
        f.table_no == null ? 99 : f.table_no,
        f.session_no == null ? 99 : f.session_no,
        f.match_no == null ? (f.seq || 0) : f.match_no
      ]
    }
    var x = key(a)
    var y = key(b)
    for (var i = 0; i < 4; i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    }
    return 0
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
    var v = Number(comp['race_' + stageOf(fixtures, f)])
    return Number.isInteger(v) && v > 0 ? '抢' + v : ''
  }

  function isGK(comp) {
    return comp && comp.format === 'groups_knockout' && comp.game_type !== 'nine_ball'
  }

  // 解析 score_text 为与选手同序的分数数组：中八「3:1」按 ':' 拆；九球「王建国 +12 / 李志强 -5」取段尾带符号数
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

  // 对阵卡片组队展示 chips：互选合并「甲⇄乙 0/+2」，单向「甲→乙 +2」；0 分不附分值
  // 口径与小程序 utils/competition.js teamChipsOf 一致
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

  // 对阵展示加工：状态/阶段 chip/时间台号/选手+实时比分（领先侧高亮）
  function decorate(fixtures, comp, f) {
    var st = { text: '预告', cls: 'pending' }
    if (f.match_status === 'ongoing') st = { text: '进行中', cls: 'live' }
    else if (f.match_status === 'done') st = { text: '已结束', cls: 'done' }
    var stage = stageOf(fixtures, f)
    var gk = isGK(comp)
    var plist = f.players || []
    var nums = parseScores(f.score_text, plist.length)
    var leadIdx = -1
    if (nums) {
      var max = Math.max.apply(null, nums.map(function (n) { return n.num }))
      var leaders = nums.map(function (n, i) { return n.num === max ? i : -1 }).filter(function (i) { return i >= 0 })
      if (leaders.length === 1) leadIdx = leaders[0]
    }
    return {
      raw: f,
      statusCls: st.cls,
      isPlaceholder: !plist.length && Array.isArray(f.placeholders) && f.placeholders.length > 0,
      namesText: (plist.length ? plist.map(function (p) { return p.name }) : (f.placeholders || [])).join(' vs '),
      noText: f.match_no ? 'No.' + f.match_no : '',
      stageText: gk ? (CARD_STAGE_LABEL[stage] || '') : '',
      groupText: (gk && stage === 'group') ? (f.group_no || 'A') + '组' : '',
      dateText: f.slot_at ? fmtDay(f.slot_at) : '',
      clockText: f.slot_at ? fmtClock(f.slot_at) : '',
      tableText: f.table_no ? f.table_no + '号台' : '',
      sessionText: f.session_no ? '第' + f.session_no + '场' : '',
      raceText: raceOf(fixtures, comp, f),
      sides: plist.map(function (p, i) {
        return { name: p.name, scoreText: nums ? nums[i].text : '', lead: i === leadIdx }
      }),
      hasScore: !!nums,
      clears: f.clears || 0, // 中八进行中实时一杆清台局数（getFixtures 推导）
      teamChips: teamChipsOf(f),
      matchId: f.match_id || ''
    }
  }

  // 选手 + 比分行（领先侧高亮）
  function sidesHtml(d, sideCls, scoreCls) {
    if (!d.sides.length) return '<div class="' + sideCls + '-row"><div class="' + sideCls + 's ' + sideCls + 's--ph">' + U.escapeHtml(d.namesText) + '</div></div>'
    var sides = d.sides.map(function (s, i) {
      return (i ? '<span class="' + sideCls + '-vs">vs</span>' : '') +
        '<span class="' + sideCls + (s.lead ? ' is-lead' : '') + '">' + U.escapeHtml(s.name) + '</span>'
    }).join('')
    var score = d.hasScore
      ? '<span class="' + scoreCls + '">' + d.sides.map(function (s, i) {
          return (i ? '<span class="' + scoreCls + '-sep">:</span>' : '') +
            '<span class="' + scoreCls + '-num' + (s.lead ? ' is-lead' : '') + '">' + s.scoreText + '</span>'
        }).join('') + '</span>'
      : ''
    return '<div class="' + sideCls + '-row"><div class="' + sideCls + 's">' + sides + '</div>' + score + '</div>'
  }

  function liveCardHtml(d) {
    var chips = (d.stageText ? '<span class="lv-chip stage">' + d.stageText + '</span>' : '') +
      (d.groupText ? '<span class="lv-chip group">' + U.escapeHtml(d.groupText) + '</span>' : '') +
      (d.raceText ? '<span class="lv-chip race">' + d.raceText + '</span>' : '') +
      (d.noText ? '<span class="lv-no">' + d.noText + '</span>' : '')
    // 信息行：一杆清台数（中八，>0 才显示）+ 组队积分 chips
    var extra = ''
    var items = ''
    if (d.clears > 0) items += '<span class="lv-clear">一杆清台 ×' + d.clears + '</span>'
    if (d.teamChips.length) items += d.teamChips.map(function (c) { return '<span class="lv-team">' + U.escapeHtml(c) + '</span>' }).join('')
    if (items) extra = '<div class="lv-extra">' + items + '</div>'
    return '<a class="lv-card" href="./match-detail.html?matchId=' + encodeURIComponent(d.matchId) + '&from=live&cid=' + encodeURIComponent(compId()) + '">' +
      '<div class="lv-head"><span class="lv-table' + (d.tableText ? '' : ' none') + '">' + (d.tableText || '未排台') + '</span>' + chips + '</div>' +
      sidesHtml(d, 'lv-side', 'lv-score') + extra + '</a>'
  }

  function nextCardHtml(d) {
    return '<div class="nx-card">' +
      '<span class="nx-table">' + d.tableText + '</span>' +
      '<div class="nx-main"><div class="nx-time">' + d.dateText + ' ' + d.clockText +
      (d.sessionText ? ' · ' + d.sessionText : '') +
      (d.stageText ? '<span class="nx-stage"> · ' + d.stageText + (d.groupText ? ' ' + U.escapeHtml(d.groupText) : '') + '</span>' : '') +
      '</div><div class="nx-names' + (d.isPlaceholder ? ' ph' : '') + '">' + U.escapeHtml(d.namesText) + '</div></div></div>'
  }

  function upcomingRowHtml(d) {
    var slot = d.dateText
      ? d.dateText + ' ' + d.clockText + (d.tableText ? ' · ' + d.tableText : '') + (d.sessionText ? ' · ' + d.sessionText : '')
      : '时间待定'
    return '<div class="up-row">' +
      '<div class="up-meta">' +
      (d.noText ? '<span class="up-no">' + d.noText + '</span>' : '') +
      '<span class="up-slot">' + slot + '</span>' +
      (d.stageText ? '<span class="up-stage">' + d.stageText + (d.groupText ? ' ' + U.escapeHtml(d.groupText) : '') + '</span>' : '') +
      '</div><div class="up-names' + (d.isPlaceholder ? ' ph' : '') + '">' + U.escapeHtml(d.namesText) + '</div></div>'
  }

  function doneCardHtml(d) {
    return '<a class="dn-card" href="./match-detail.html?matchId=' + encodeURIComponent(d.matchId) + '&from=live&cid=' + encodeURIComponent(compId()) + '">' +
      '<div class="dn-meta">' +
      (d.noText ? '<span class="dn-no">' + d.noText + '</span>' : '') +
      (d.dateText ? '<span class="dn-slot">' + d.dateText + (d.tableText ? ' · ' + d.tableText : '') + '</span>' : '') +
      (d.stageText ? '<span class="dn-stage">' + d.stageText + (d.groupText ? ' ' + U.escapeHtml(d.groupText) : '') + '</span>' : '') +
      '</div>' + sidesHtml(d, 'dn-side', 'dn-score') + '</a>'
  }

  function render(d) {
    var comp = d.competition || {}
    var fixtures = d.fixtures || []

    el('lv-name').textContent = (comp.name || '比赛') + ' · 比赛实况'
    var sub = []
    if (comp.start_date || comp.end_date) sub.push((comp.start_date || '未定') + ' 至 ' + (comp.end_date || '未定'))
    if (comp.venue) sub.push(comp.venue)
    el('lv-subtitle').textContent = sub.join(' · ')
    document.title = (comp.name || '比赛') + '实况 - 台球协会'
    el('lv-back').href = './competition-detail.html?id=' + encodeURIComponent(comp._id || compId())
    el('lv-fixtures-link').href = './fixtures.html?id=' + encodeURIComponent(comp._id || compId())

    var real = fixtures.filter(function (f) { return f.status !== 'bye' })
    if (!real.length) {
      el('lv-empty').style.display = ''
      el('lv-live-section').style.display = 'none'
      el('lv-next-section').style.display = 'none'
      el('lv-upcoming-section').style.display = 'none'
      el('lv-done-section').style.display = 'none'
      el('lv-sync').style.display = 'none'
      return
    }
    el('lv-empty').style.display = 'none'

    var ds = real.map(function (f) { return decorate(fixtures, comp, f) })

    // 进行中：按台号→时间排序（未排台落最后）
    var live = ds.filter(function (f) { return f.statusCls === 'live' }).sort(function (a, b) {
      var ta = a.raw.table_no == null ? 99 : a.raw.table_no
      var tb = b.raw.table_no == null ? 99 : b.raw.table_no
      if (ta !== tb) return ta - tb
      return (a.raw.slot_at || 0) - (b.raw.slot_at || 0)
    })

    // 预告（排期顺序）→ 即将上场 = 每个台号最近一场；其余入后续预告
    var pending = ds.filter(function (f) { return f.statusCls === 'pending' }).sort(function (a, b) { return cmpSched(a.raw, b.raw) })
    var byTable = {}
    pending.forEach(function (f) {
      var t = f.raw.table_no
      if (t != null && f.raw.slot_at && !byTable[t]) byTable[t] = f
    })
    var next = Object.keys(byTable).map(function (k) { return byTable[k] }).sort(function (a, b) { return a.raw.table_no - b.raw.table_no })
    var nextIds = {}
    next.forEach(function (f) { nextIds[f.raw._id] = true })
    var upcomingAll = pending.filter(function (f) { return !nextIds[f.raw._id] })

    // 已结束：排期时间近者在前
    var doneAll = ds.filter(function (f) { return f.statusCls === 'done' }).sort(function (a, b) { return (b.raw.slot_at || 0) - (a.raw.slot_at || 0) })

    // 同步状态行
    el('lv-sync').innerHTML = '<span class="sync-dot' + (live.length ? ' on' : '') + '"></span>' +
      (live.length ? '实时比分轮询中 · ' : '') + '更新于 ' + fmtSyncTime()
    el('lv-sync').style.display = ''

    // 进行中：最多展示两行四个（左 2/3 区 grid 两列），超出提示见对阵列表
    el('lv-live-count').textContent = live.length
    el('lv-live').innerHTML = live.length
      ? live.slice(0, 4).map(liveCardHtml).join('')
      : '<div class="lv-empty-inline">当前无进行中对局</div>'
    el('lv-live-more').textContent = live.length > 4 ? '还有 ' + (live.length - 4) + ' 台进行中，见「对阵列表」' : ''
    el('lv-live-section').style.display = ''

    // 即将上场
    if (next.length) {
      el('lv-next').innerHTML = next.map(nextCardHtml).join('')
      el('lv-next-section').style.display = ''
    } else {
      el('lv-next-section').style.display = 'none'
    }

    // 后续预告
    if (upcomingAll.length) {
      el('lv-upcoming-count').textContent = upcomingAll.length
      el('lv-upcoming').innerHTML = upcomingAll.slice(0, UPCOMING_SHOW).map(upcomingRowHtml).join('')
      el('lv-upcoming-more').textContent = upcomingAll.length > UPCOMING_SHOW
        ? '仅展示前 ' + UPCOMING_SHOW + ' 场，完整预告见「对阵列表」'
        : ''
      el('lv-upcoming-section').style.display = ''
    } else {
      el('lv-upcoming-section').style.display = 'none'
    }

    // 已结束
    if (doneAll.length) {
      el('lv-done-count').textContent = doneAll.length
      el('lv-done').innerHTML = doneAll.slice(0, DONE_SHOW).map(doneCardHtml).join('')
      el('lv-done-section').style.display = ''
    } else {
      el('lv-done-section').style.display = 'none'
    }
  }

  async function load(silent) {
    var id = compId()
    if (!id) {
      el('lv-error-text').textContent = '缺少比赛参数'
      el('lv-error').style.display = ''
      return
    }
    try {
      var d = await window.AppCloud.call('getFixtures', { competition_id: id })
      el('lv-error').style.display = 'none'
      render(d || {})
    } catch (e) {
      if (silent) return // 轮询失败保留旧数据，下次再试
      el('lv-error-text').textContent = e.message || '加载失败，请稍后重试'
      el('lv-error').style.display = ''
    }
  }

  async function poll() {
    if (polling) return
    polling = true
    try {
      await load(true)
    } finally {
      polling = false
    }
  }

  function startPoll() {
    stopPoll()
    timer = setInterval(function () {
      if (document.hidden) return
      poll()
    }, POLL_MS)
  }

  function stopPoll() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('competitions')
    U.mountCloudBar(load)
    el('lv-retry').addEventListener('click', function () {
      el('lv-error').style.display = 'none'
      load()
    })
    // 页面恢复可见时立即刷新一次
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll()
    })
    load()
    startPoll()
  })
})()
