/*
 * 离线兜底演示数据：云端未连接（未开启匿名登录 / 网络异常）时，
 * 页面退化为展示本文件内置的演示数据，保证网页版始终可浏览。
 * 数据结构与云函数返回保持一致。
 */
window.FallbackData = (function () {
  var DAY = 86400000
  var now = Date.now()

  var members = [
    { _id: 'demo_m01', name: '王建国', points: 2840, wins: 30, losses: 12, clears: 18, created_at: now - 560 * DAY },
    { _id: 'demo_m02', name: '李志强', points: 2655, wins: 26, losses: 12, clears: 15, created_at: now - 540 * DAY },
    { _id: 'demo_m03', name: '张明远', points: 2480, wins: 23, losses: 12, clears: 13, created_at: now - 520 * DAY },
    { _id: 'demo_m04', name: '陈伟东', points: 2310, wins: 19, losses: 12, clears: 11, created_at: now - 500 * DAY },
    { _id: 'demo_m05', name: '刘海洋', points: 2195, wins: 18, losses: 12, clears: 10, created_at: now - 480 * DAY },
    { _id: 'demo_m06', name: '赵天宇', points: 2080, wins: 16, losses: 12, clears: 8, created_at: now - 460 * DAY },
    { _id: 'demo_m07', name: '孙鹏飞', points: 1965, wins: 14, losses: 12, clears: 7, created_at: now - 440 * DAY },
    { _id: 'demo_m08', name: '周建华', points: 1850, wins: 13, losses: 11, clears: 6, created_at: now - 420 * DAY },
    { _id: 'demo_m09', name: '吴志远', points: 1735, wins: 11, losses: 11, clears: 5, created_at: now - 20 * DAY },
    { _id: 'demo_m10', name: '郑伟', points: 1620, wins: 10, losses: 10, clears: 4, created_at: now - 15 * DAY },
    { _id: 'demo_m11', name: '钱永康', points: 1505, wins: 8, losses: 10, clears: 3, created_at: now - 10 * DAY },
    { _id: 'demo_m12', name: '冯学林', points: 1390, wins: 7, losses: 9, clears: 2, created_at: now - 5 * DAY }
  ]
  var nameOf = {}
  members.forEach(function (m) { nameOf[m._id] = m.name })

  function c8(id, daysAgo, p1, p2, s1, s2, d1, d2, mode) {
    var t = now - daysAgo * DAY
    var fs = {}
    fs[p1] = s1
    fs[p2] = s2
    return {
      _id: id, game_type: 'c8', mode: mode || 1, players: [p1, p2],
      winner: s1 > s2 ? p1 : p2, frame_score: fs, status: 'finished',
      created_at: t, finished_at: t + 3600000
    }
  }
  function nine(id, daysAgo, ps, scores, ballCount) {
    var t = now - daysAgo * DAY
    var fs = {}
    ps.forEach(function (p, i) { fs[p] = scores[i] })
    return {
      _id: id, game_type: 'nine_ball', players: ps,
      seats: { A: ps[0], B: ps[1], C: ps[2] }, ball_count: ballCount || 9, init_score: 100,
      final_scores: fs, status: 'finished', created_at: t, finished_at: t + 7200000
    }
  }

  var matches = [
    c8('demo_g01', 2, 'demo_m01', 'demo_m02', 4, 2, 15, -10),
    nine('demo_g02', 3, ['demo_m01', 'demo_m03', 'demo_m05'], [136, 92, 72], 9),
    c8('demo_g03', 4, 'demo_m03', 'demo_m04', 3, 4, 12, -8),
    c8('demo_g04', 5, 'demo_m05', 'demo_m06', 4, 1, 18, -12),
    c8('demo_g05', 6, 'demo_m07', 'demo_m08', 2, 4, 10, -7),
    c8('demo_g06', 7, 'demo_m09', 'demo_m10', 4, 3, 14, -9),
    nine('demo_g07', 8, ['demo_m02', 'demo_m04', 'demo_m06'], [118, 105, 77], 7),
    c8('demo_g08', 9, 'demo_m01', 'demo_m03', 4, 0, 20, -15),
    c8('demo_g09', 10, 'demo_m02', 'demo_m05', 4, 2, 15, -10),
    c8('demo_g10', 11, 'demo_m04', 'demo_m06', 3, 4, 12, -8),
    c8('demo_g11', 12, 'demo_m07', 'demo_m09', 4, 3, 14, -9),
    c8('demo_g12', 13, 'demo_m08', 'demo_m10', 4, 1, 18, -12)
  ]
  // 每场积分变动（展示用，v2.2 算法：参与即得分 × 球数难度系数 + 一杆清台奖励，无负分）
  var deltas = {
    demo_g01: { demo_m01: 3, demo_m02: 1 },
    demo_g02: { demo_m01: 6.9, demo_m03: 0.5, demo_m05: 0.5 },
    demo_g03: { demo_m03: 1, demo_m04: 3 },
    demo_g04: { demo_m05: 3, demo_m06: 1 },
    demo_g05: { demo_m07: 1, demo_m08: 3 },
    demo_g06: { demo_m09: 3, demo_m10: 1 },
    demo_g07: { demo_m02: 3.6, demo_m04: 2, demo_m06: 0.5 },
    demo_g08: { demo_m01: 3, demo_m03: 1 },
    demo_g09: { demo_m02: 3, demo_m05: 1 },
    demo_g10: { demo_m04: 1, demo_m06: 3 },
    demo_g11: { demo_m07: 3, demo_m09: 1 },
    demo_g12: { demo_m08: 3, demo_m10: 1 }
  }

  // 王建国积分趋势（演示）
  var trendBase = [
    [160, 2100], [130, 2250], [100, 2400], [70, 2350], [40, 2600], [9, 2800], [2, 2840]
  ]

  function clone(x) { return JSON.parse(JSON.stringify(x)) }

  function rankings() {
    return members.map(function (m, i) {
      var total = m.wins + m.losses
      var last = null
      var lastResult = null
      for (var j = 0; j < matches.length; j++) {
        var g = matches[j]
        if (deltas[g._id] && deltas[g._id][m._id] !== undefined) {
          last = deltas[g._id][m._id]
          if (g.game_type === 'c8') {
            lastResult = g.winner === m._id ? 'win' : 'lose'
          } else {
            var mine = g.final_scores[m._id] || 0
            lastResult = mine > g.init_score ? 'win' : mine < g.init_score ? 'lose' : 'draw'
          }
          break
        }
      }
      return Object.assign({}, m, {
        rank: i + 1,
        winRate: total ? Math.round((m.wins / total) * 100) : 0,
        clears: m.clears || 0,
        lastDelta: last,
        lastResult: lastResult
      })
    })
  }

  function matchList(opt) {
    var list = matches.slice().sort(function (a, b) { return b.created_at - a.created_at })
    if (opt.game_type) list = list.filter(function (m) { return m.game_type === opt.game_type })
    // 离线演示数据无比赛（赛事）概念：赛事维度下无对局
    if (opt.competition_id) list = []
    var skip = opt.skip || 0
    var limit = opt.limit || 20
    return list.slice(skip, skip + limit).map(function (m) {
      return Object.assign({}, m, {
        players_detail: m.players.map(function (pid) {
          return {
            _id: pid,
            name: nameOf[pid] || '未命名',
            delta: deltas[m._id] && deltas[m._id][pid] !== undefined ? deltas[m._id][pid] : null
          }
        })
      })
    })
  }

  function memberDetail(id) {
    var m = members.filter(function (x) { return x._id === id })[0] || members[0]
    var idx = members.indexOf(m)
    var my = matchList({ limit: 100 }).filter(function (g) {
      return g.players.indexOf(m._id) >= 0
    }).map(function (g) {
      return Object.assign({}, g, { my_delta: deltas[g._id] && deltas[g._id][m._id] !== undefined ? deltas[g._id][m._id] : 0 })
    })
    var h2hMap = {}
    my.forEach(function (g) {
      if (g.game_type !== 'c8') return
      var opp = g.players.filter(function (p) { return p !== m._id })[0]
      if (!opp) return
      if (!h2hMap[opp]) h2hMap[opp] = { opponent_id: opp, opponent: nameOf[opp], total: 0, wins: 0, losses: 0 }
      h2hMap[opp].total += 1
      if (g.winner === m._id) h2hMap[opp].wins += 1
      else h2hMap[opp].losses += 1
    })
    var trend
    if (m._id === 'demo_m01') {
      trend = trendBase.map(function (p, i) {
        return { t: now - p[0] * DAY, points: p[1], delta: i === 0 ? 0 : p[1] - trendBase[i - 1][1], remark: '演示趋势' }
      })
    } else {
      trend = [{ t: now - 30 * DAY, points: Math.round(m.points * 0.7), delta: 0, remark: '演示趋势' },
        { t: now, points: m.points, delta: Math.round(m.points * 0.3), remark: '演示趋势' }]
    }
    return {
      member: clone(m),
      rank: idx + 1,
      totalMembers: members.length,
      trend: trend,
      matches: my,
      h2h: Object.keys(h2hMap).map(function (k) {
        var h = h2hMap[k]
        h.winRate = h.total ? Math.round((h.wins / h.total) * 100) : 0
        return h
      }).sort(function (a, b) { return b.total - a.total })
    }
  }

  // 对战详情兜底：基于演示 match 反推 frames/rounds/logs，仅供离线浏览
  function matchDetail(matchId) {
    var m = matches.filter(function (x) { return x._id === matchId })[0]
    if (!m) return { match: null, members: {}, frames: [], rounds: [], logs: [], creator_name: '' }
    var memberMap = {}
    m.players.forEach(function (pid) {
      memberMap[pid] = { _id: pid, name: nameOf[pid] || '未命名', avatar: '' }
    })
    var frames = []
    var rounds = []
    var logs = []
    var ds = deltas[m._id] || {}
    if (m.game_type === 'c8') {
      // 按 frame_score 反推逐局：胜方局数胜，负方局数负，按 seq 顺序填充
      var a = m.players[0]
      var b = m.players[1]
      var aWin = (m.frame_score || {})[a] || 0
      var bWin = (m.frame_score || {})[b] || 0
      var total = aWin + bWin
      var aRemain = aWin
      var bRemain = bWin
      for (var i = 1; i <= total; i++) {
        // 末局必胜方锁定
        var winner
        if (i === total) winner = m.winner
        else if (aRemain > 0 && (bRemain === 0 || i % 2 === 1)) { winner = a; aRemain-- }
        else { winner = b; bRemain-- }
        if (i === total && winner === a && aRemain > 0) aRemain--
        if (i === total && winner === b && bRemain > 0) bRemain--
        frames.push({
          match_id: m._id, seq: i, winner: winner,
          is_clear: i === total, // 末局演示为一杆清台
          remaining_balls: m.mode === 2 ? Math.floor(Math.random() * 4) : undefined
        })
      }
      Object.keys(ds).forEach(function (pid) {
        logs.push({
          match_id: m._id, player: pid, delta: ds[pid],
          points_after: null, remark: '中八对战 · ' + aWin + ' : ' + bWin
        })
      })
    } else if (m.game_type === 'nine_ball') {
      // 按 final_scores 反推 3 条主流水 + 1 条犯规
      var fs = m.final_scores || {}
      var seatIds = ['A', 'B', 'C'].map(function (s) { return (m.seats || {})[s] }).filter(Boolean)
      var ids = seatIds.length ? seatIds : m.players
      var init = m.init_score || 100
      var ts = m.created_at
      var types = ['kaiqiu_dajin', 'pusheng', 'dajin']
      for (var seq = 1; seq <= 3; seq++) {
        var scorer = ids[(seq - 1) % ids.length]
        var deltasRow = {}
        var v = seq === 1 ? 20 : seq === 2 ? 10 : 10
        ids.forEach(function (pid) { deltasRow[pid] = pid === scorer ? v : (ids.length === 3 ? -v / 2 : -v) })
        rounds.push({
          match_id: m._id, round_seq: seq, score_type: types[seq - 1],
          scorer: scorer, deltas: deltasRow, created_at: ts + seq * 600000
        })
      }
      // 一条犯规流水
      var fanguiDeltas = {}
      var fanguiScorer = ids[1] || ids[0]
      ids.forEach(function (pid) { fanguiDeltas[pid] = pid === fanguiScorer ? -1 : 1 })
      rounds.push({
        match_id: m._id, round_seq: 4, score_type: 'fangui',
        scorer: fanguiScorer, deltas: fanguiDeltas, created_at: ts + 4 * 600000
      })
      Object.keys(ds).forEach(function (pid) {
        logs.push({
          match_id: m._id, player: pid, delta: ds[pid],
          points_after: null,
          remark: '九球追分 · 净胜 ' + ((fs[pid] || init) - init)
        })
      })
    }
    return {
      match: clone(m),
      members: memberMap,
      frames: frames,
      shots: [],
      rounds: rounds,
      logs: logs,
      creator_name: ''
    }
  }

  function respond(name, data) {
    switch (name) {
      case 'getRankings':
        // 组队榜离线无演示数据：返回空，避免把个人榜误渲染为组队榜
        if (data && data.scope === 'competition_team') return Promise.resolve([])
        return Promise.resolve(rankings())
      case 'getOverview': {
        var monthStart = new Date()
        monthStart.setDate(1)
        monthStart.setHours(0, 0, 0, 0)
        var active = {}
        matches.forEach(function (g) {
          if (g.created_at >= monthStart.getTime()) g.players.forEach(function (p) { active[p] = 1 })
        })
        return Promise.resolve({
          membersCount: members.length,
          matchesCount: matches.length,
          monthActive: Object.keys(active).length
        })
      }
      case 'getMatches':
        return Promise.resolve(matchList(data || {}))
      case 'getCompetitions':
        // 离线演示数据无比赛（赛事）概念：返回空列表，榜单页仅展示基础三个 tab
        return Promise.resolve([])
      case 'getCompetitionDetail':
        // 离线兜底：详情页直访时给出演示比赛，榜单走 getRankings 演示数据
        return Promise.resolve({
          competition: { _id: (data && data.competition_id) || 'demo_comp', name: '演示赛事', description: '离线演示数据：连接云端后展示真实比赛信息。', created_at: now - 30 * DAY },
          match_count: matches.length,
          signup_count: 8
        })
      case 'getFixtures': {
        // 离线兜底：1 轮 3 场（已结束/进行中/预告各一）+ 1 人轮空，覆盖全部展示态
        var fxMembers = members.slice(0, 8)
        var fxP = function (i) { return { id: fxMembers[i].id || fxMembers[i]._id, name: fxMembers[i].name } }
        return Promise.resolve({
          competition: { _id: (data && data.competition_id) || 'demo_comp', name: '演示赛事', game_type: 'c8', match_days: [{ date: '2026-10-08', start_time: '19:00', slot_minutes: 40, slot_count: 3 }], created_at: now - 30 * DAY },
          participants: fxMembers.map(function (m, i) { return { member_id: m.id || m._id, name: m.name, at: now - i * 3600000 } }),
          fixtures: [
            { _id: 'fx1', round: 1, seq: 1, players: [fxP(0), fxP(1)], status: 'pending', slot_at: now - 86400000, match_id: 'demo_m1', match_status: 'done', winner_id: fxP(0).id, score_text: '3:1' },
            { _id: 'fx2', round: 1, seq: 2, players: [fxP(2), fxP(3)], status: 'pending', slot_at: now + 3600000, match_id: 'demo_m2', match_status: 'ongoing', winner_id: null, score_text: '' },
            { _id: 'fx3', round: 1, seq: 3, players: [fxP(4), fxP(5)], status: 'pending', slot_at: now + 2 * 86400000, match_id: null, match_status: null, winner_id: null, score_text: '' },
            { _id: 'fx4', round: 1, seq: 4, players: [fxP(6)], status: 'bye', slot_at: null, match_id: null, match_status: null, winner_id: null, score_text: '' }
          ]
        })
      }
      case 'getMemberDetail':
        return Promise.resolve(memberDetail(data && data.id))
      case 'getMatchDetail':
        return Promise.resolve(matchDetail(data && data.match_id))
      case 'seedDemoData': {
        var err = new Error('离线状态无法写入云端：请在云开发控制台开启「匿名登录」并配置 Web 安全域名后重试')
        err.code = 'OFFLINE'
        return Promise.reject(err)
      }
      default:
        return Promise.reject(new Error('本地演示数据不支持接口：' + name))
    }
  }

  return { respond: respond }
})()
