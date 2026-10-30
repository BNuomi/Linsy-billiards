/*
 * 网页端中八记分页：对齐小程序 create-match + match-live 全量流程
 * - 入口需 match_ops 扫码授权（AppAuth），所有写调用经 callAuthed 携带 web_token
 * - 创建/同步：saveC8Progress（match_id=null 创建，800ms 防抖；局级变化立即同步）
 * - 结算：finishMatch（三模式 frames 结构与小程序一致）
 * - 恢复：?match_id=xxx 经 getOngoingMatch 回填；无编辑权时只读
 */
;(function () {
  var U = window.AppUI
  var AUTH_PURPOSE = 'match_ops'
  var DEFAULT_REMAINING = 3
  var SYNC_DEBOUNCE = 800

  /* ---------- m3 工具（移植自 miniprogram/utils/m3.js，保持推导规则一致） ---------- */
  function ballGroup(b) {
    if (b >= 1 && b <= 7) return 'small'
    if (b >= 9 && b <= 15) return 'big'
    return ''
  }
  function emptyBalls() {
    var arr = []
    for (var i = 0; i < 15; i++) arr.push({ n: i + 1, owner: '', grp: '' })
    return arr
  }
  function m3Groups(shots) {
    for (var i = 0; i < (shots || []).length; i++) {
      var s = shots[i]
      var g = (s.f || !s.m || s.br) ? '' : ballGroup(s.b)
      if (g) {
        var other = s.p === 'A' ? 'B' : 'A'
        var r = {}
        r[s.p] = g
        r[other] = g === 'small' ? 'big' : 'small'
        return r
      }
    }
    return null
  }
  function m3GroupOwner(shots, ball) {
    var groups = m3Groups(shots)
    var g = groups ? ballGroup(ball) : ''
    if (!g) return ''
    return groups.A === g ? 'A' : 'B'
  }
  function buildM3Balls(shots) {
    var balls = emptyBalls()
    var groups = m3Groups(shots)
    ;(shots || []).forEach(function (s) {
      if (!s.f && s.m && s.b >= 1 && s.b <= 15) balls[s.b - 1].owner = s.p
    })
    if (groups) {
      balls.forEach(function (ball) {
        var g = ballGroup(ball.n)
        if (g && !ball.owner) ball.grp = groups.A === g ? 'A' : 'B'
      })
    }
    return balls
  }
  function m3MadeCount(shots, side) {
    return (shots || []).filter(function (s) { return !s.f && s.m && s.p === side }).length
  }
  function m3PotLog(shots) {
    var rows = []
    var defined = false
    ;(shots || []).forEach(function (s) {
      if (s.f) { rows.push({ type: 'foul', p: s.p, balls: [], def: 0, br: 0 }); return }
      if (!s.m || s.b < 1 || s.b > 15) return
      var br = s.br ? 1 : 0
      var def = 0
      if (!br && !defined && ballGroup(s.b)) { def = 1; defined = true }
      var last = rows[rows.length - 1]
      if (last && last.type === 'pot' && last.p === s.p && last.br === br) {
        last.balls.push(s.b)
        if (def) last.def = 1
      } else {
        rows.push({ type: 'pot', p: s.p, balls: [s.b], def: def, br: br })
      }
    })
    return rows
  }
  function m3BreakPending(shots, shooter, breaker) {
    if (shooter !== breaker) return false
    return (shots || []).every(function (s) { return !!s.br })
  }
  function m3RemoveBall(shots, ballNo, breaker) {
    var arr = shots || []
    for (var i = arr.length - 1; i >= 0; i--) {
      var s = arr[i]
      if (!s.f && s.b === ballNo) {
        var rest = arr.slice(0, i).concat(arr.slice(i + 1))
        var lastS = rest[rest.length - 1]
        var shooter = rest.length ? (lastS.s || lastS.p) : (breaker || 'A')
        return { shots: rest, shooter: shooter, breaking: m3BreakPending(rest, shooter, breaker) }
      }
    }
    return null
  }
  function m3ShotView(shots) {
    var groups = m3Groups(shots)
    return {
      m3balls: buildM3Balls(shots),
      m3groupA: groups ? groups.A : '',
      m3groupB: groups ? groups.B : '',
      m3pots: m3PotLog(shots),
      m3curMadeA: m3MadeCount(shots, 'A'),
      m3curMadeB: m3MadeCount(shots, 'B')
    }
  }
  function m3StatText(shots) {
    function of(p) {
      return {
        made: m3MadeCount(shots, p),
        foul: (shots || []).filter(function (s) { return s.f && s.p === p }).length
      }
    }
    function side(label, s) { return label + '进' + s.made + (s.foul ? '犯' + s.foul : '') }
    return side('A', of('A')) + ' · ' + side('B', of('B'))
  }

  /* ---------- 页面状态 ---------- */
  var state = {
    step: 1,
    readOnly: false,
    mode: 1,
    bestOf: 5,
    playerA: null,
    playerB: null,
    competition: null,
    matchId: null,
    scoreA: 0,
    scoreB: 0,
    history: [],
    nextClear: false,
    m2frames: [],
    frameIndex: 0,
    m3frames: [],
    m3current: null,
    m3shooter: 'A',
    m3breaking: false,
    submitting: false
  }
  var members = []
  var syncTimer = null
  var syncFailToastAt = 0

  function el(id) { return document.getElementById(id) }
  function esc(s) { return U.escapeHtml(s) }

  /* ---------- 授权门禁 ---------- */
  function gate() {
    el('gate').classList.remove('ms-hidden')
    el('setup').classList.add('ms-hidden')
    el('scoring').classList.add('ms-hidden')
  }
  function enterApp() {
    el('gate').classList.add('ms-hidden')
    el('setup').classList.remove('ms-hidden')
  }

  /* ---------- 数据加载 ---------- */
  async function loadMembers() {
    try {
      var res = await window.AppCloud.call('getMembers')
      members = (res && res.data) || (Array.isArray(res) ? res : [])
    } catch (e) {
      U.toast('会员列表加载失败：' + (e.message || e), 'error')
      members = []
    }
  }
  async function loadCompetitions() {
    try {
      var comps = await window.AppCloud.call('getCompetitions') || []
      var sel = el('comp-select')
      comps.forEach(function (c) {
        var opt = document.createElement('option')
        opt.value = c._id
        opt.textContent = c.name
        sel.appendChild(opt)
      })
    } catch (e) { /* 比赛列表失败不阻断 */ }
  }

  /* ---------- 选手选择弹层 ---------- */
  function openPicker(side, onDone) {
    var mask = document.createElement('div')
    mask.className = 'picker-mask'
    mask.innerHTML =
      '<div class="picker-card" role="dialog" aria-label="选择选手">' +
      '<div class="picker-head"><input type="search" placeholder="搜索昵称 / 工号" aria-label="搜索选手"></div>' +
      '<div class="picker-list"></div></div>'
    document.body.appendChild(mask)
    var input = mask.querySelector('input')
    var list = mask.querySelector('.picker-list')

    function close() { mask.remove() }
    mask.addEventListener('click', function (e) { if (e.target === mask) close() })

    function renderList() {
      var kw = input.value.trim().toLowerCase()
      var rows = members.filter(function (m) {
        if (state.playerA && m._id === state.playerA._id) return false
        if (state.playerB && m._id === state.playerB._id) return false
        if (!kw) return true
        return (m.name || '').toLowerCase().indexOf(kw) >= 0 ||
          (m.emp_no || '').toLowerCase().indexOf(kw) >= 0
      })
      var html = rows.slice(0, 50).map(function (m) {
        return '<div class="picker-item" data-id="' + esc(m._id) + '"><span>' + esc(m.name || '未命名') +
          (m.is_temp ? ' <span class="pl-tag">临时</span>' : '') + '</span>' +
          '<span class="pi-points">' + (m.points != null ? m.points : 0) + ' 分</span></div>'
      }).join('')
      var kwRaw = input.value.trim()
      var exact = members.some(function (m) { return (m.name || '') === kwRaw })
      if (kwRaw && !exact && kwRaw.length <= 20) {
        html += '<div class="picker-item create" data-create="1">＋ 创建临时选手「' + esc(kwRaw) + '」</div>'
      }
      if (!html) html = '<div class="picker-empty">无匹配选手</div>'
      list.innerHTML = html
      list.querySelectorAll('.picker-item').forEach(function (item) {
        item.addEventListener('click', async function () {
          if (item.getAttribute('data-create')) {
            try {
              var created = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'createMember', { name: kwRaw })
              var m = created && created.data ? created.data : created
              members.push(m)
              onDone({ _id: m._id, name: m.name })
              close()
            } catch (e) {
              U.toast('创建临时选手失败：' + (e.message || e), 'error')
            }
            return
          }
          var id = item.getAttribute('data-id')
          var m = members.filter(function (x) { return x._id === id })[0]
          if (m) { onDone({ _id: m._id, name: m.name }); close() }
        })
      })
    }
    input.addEventListener('input', renderList)
    renderList()
    input.focus()
  }

  /* ---------- 设置步骤 ---------- */
  function paintSlot(side) {
    var slot = el(side === 'A' ? 'slot-a' : 'slot-b')
    var p = side === 'A' ? state.playerA : state.playerB
    slot.classList.toggle('empty', !p)
    slot.querySelector('.ps-name').textContent = p ? p.name : '点击选择'
    el('start-btn').disabled = !(state.playerA && state.playerB)
  }

  function lockModesByCompetition() {
    var locked = !!state.competition
    document.querySelectorAll('#mode-cards .mode-card').forEach(function (card) {
      var m = Number(card.getAttribute('data-mode'))
      card.classList.toggle('disabled', locked && m !== 1)
      if (locked && m !== 1) card.classList.remove('active')
    })
    if (locked && state.mode !== 1) selectMode(1)
    else if (!locked) {
      document.querySelector('#mode-cards .mode-card[data-mode="' + state.mode + '"]').classList.add('active')
    }
    el('comp-lock-tip').classList.toggle('ms-hidden', !locked)
  }

  function selectMode(m) {
    state.mode = m
    document.querySelectorAll('#mode-cards .mode-card').forEach(function (card) {
      card.classList.toggle('active', Number(card.getAttribute('data-mode')) === m)
    })
    if (m === 2 && !state.m2frames.length) {
      state.m2frames = [{ remaining: DEFAULT_REMAINING, winner: 'A', clear: 0 }]
      state.frameIndex = 0
    }
    if (m === 3 && !state.m3current) {
      state.m3current = { breaker: 'A', shots: [], clear: 0 }
      state.m3shooter = 'A'
      state.m3breaking = true
    }
  }

  function compPayload() {
    return {
      competition_id: state.competition ? state.competition._id : null,
      competition_name: state.competition ? state.competition.name : null,
      fixture_id: null,
      stage: null
    }
  }

  /* ---------- 同步 ---------- */
  function displayScore() {
    if (state.mode === 2) {
      var a = state.m2frames.filter(function (f) { return f.winner === 'A' }).length
      return { a: a, b: state.m2frames.length - a }
    }
    if (state.mode === 3) {
      var a3 = state.m3frames.filter(function (f) { return f.winner === 'A' }).length
      return { a: a3, b: state.m3frames.length - a3 }
    }
    return { a: state.scoreA, b: state.scoreB }
  }

  function m3Snapshot() {
    return {
      frames: state.m3frames,
      current: state.m3current,
      shooter: state.m3shooter,
      breaking: state.m3breaking
    }
  }

  function queueSync(immediate) {
    if (state.readOnly) return
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
    if (immediate) { syncProgress(); return }
    syncTimer = setTimeout(function () { syncTimer = null; syncProgress() }, SYNC_DEBOUNCE)
  }

  async function syncProgress() {
    if (!state.playerA || !state.playerB || state.readOnly) return
    var ds = displayScore()
    try {
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'saveC8Progress', {
        match_id: state.matchId || null,
        players: [state.playerA._id, state.playerB._id],
        mode: state.mode,
        best_of: state.bestOf,
        frame_score: (function () {
          var r = {}
          r[state.playerA._id] = ds.a
          r[state.playerB._id] = ds.b
          return r
        })(),
        progress: {
          scoreA: state.scoreA,
          scoreB: state.scoreB,
          history: state.history,
          nextClear: state.nextClear,
          m2frames: state.m2frames,
          m3: m3Snapshot()
        },
        ...compPayload()
      })
      if (!state.matchId && res && res.match_id) {
        state.matchId = res.match_id
      }
    } catch (e) {
      console.warn('[match-score] 进度同步失败', e)
      var now = Date.now()
      if (now - syncFailToastAt > 5000) {
        syncFailToastAt = now
        U.toast('比分同步失败：' + ((e && e.message) || '网络异常'), 'error')
      }
    }
  }

  /* ---------- 渲染 ---------- */
  function nameOf(side) {
    var p = side === 'A' ? state.playerA : state.playerB
    return p ? (p.name || side) : side
  }

  function renderHead() {
    var ds = displayScore()
    el('sh-name-a').textContent = nameOf('A')
    el('sh-name-b').textContent = nameOf('B')
    el('sh-score-a').textContent = ds.a
    el('sh-score-b').textContent = ds.b
    el('sh-meta').textContent = '抢 ' + state.bestOf + (state.competition ? ' · ' + state.competition.name : '')
    var banner = el('race-banner')
    var winner = ''
    if (ds.a >= state.bestOf) winner = nameOf('A')
    if (ds.b >= state.bestOf) winner = nameOf('B')
    if (winner) {
      banner.textContent = winner + ' 已先到 ' + state.bestOf + ' 局，可结束对局'
      banner.classList.remove('ms-hidden')
    } else {
      banner.classList.add('ms-hidden')
    }
  }

  function renderPanels() {
    el('panel-m1').classList.toggle('ms-hidden', state.mode !== 1)
    el('panel-m2').classList.toggle('ms-hidden', state.mode !== 2)
    el('panel-m3').classList.toggle('ms-hidden', state.mode !== 3)
  }

  function renderM1() {
    el('flip-name-a').textContent = nameOf('A')
    el('flip-name-b').textContent = nameOf('B')
    el('flip-score-a').textContent = state.scoreA
    el('flip-score-b').textContent = state.scoreB
    el('m1-clear').classList.toggle('active', state.nextClear)
  }

  function renderM2() {
    var frames = state.m2frames
    var idx = state.frameIndex
    var cur = frames[idx]
    el('m2-title').textContent = '第 ' + (idx + 1) + ' / ' + frames.length + ' 局'
    el('m2-prev').disabled = idx <= 0
    el('m2-next').disabled = idx >= frames.length - 1
    if (cur) {
      el('m2-win-a').textContent = nameOf('A') + ' 胜'
      el('m2-win-b').textContent = nameOf('B') + ' 胜'
      el('m2-win-a').classList.toggle('active', cur.winner === 'A')
      el('m2-win-b').classList.toggle('active', cur.winner === 'B')
      el('m2-remain').textContent = cur.remaining
      el('m2-clear').classList.toggle('active', !!cur.clear)
    }
  }

  var BALL_COLORS = {
    1: '#f5c518', 2: '#2962ff', 3: '#e53935', 4: '#8e24aa', 5: '#fb8c00', 6: '#43a047', 7: '#8d3028', 8: '#212121',
    9: '#f5c518', 10: '#2962ff', 11: '#e53935', 12: '#8e24aa', 13: '#fb8c00', 14: '#43a047', 15: '#8d3028'
  }
  function ballBackground(n) {
    var c = BALL_COLORS[n]
    if (n <= 8) return c
    return 'linear-gradient(180deg,#f7f7f7 0%,#f7f7f7 26%,' + c + ' 26%,' + c + ' 74%,#f7f7f7 74%,#f7f7f7 100%)'
  }

  function renderM3() {
    var view = m3ShotView(state.m3current ? state.m3current.shots : [])
    // 击球者 chip
    el('m3-sw-a').textContent = nameOf('A')
    el('m3-sw-b').textContent = nameOf('B')
    el('m3-sw-a').classList.toggle('active', state.m3shooter === 'A')
    el('m3-sw-b').classList.toggle('active', state.m3shooter === 'B')
    // 开球 / 清台 chip
    el('m3-break').classList.toggle('active', state.m3breaking)
    el('m3-clear').classList.toggle('active', !!(state.m3current && state.m3current.clear))
    // 定组
    var gA = view.m3groupA
    el('m3-groups').textContent = gA
      ? nameOf('A') + '：' + (gA === 'small' ? '小球' : '大球') + ' · ' + nameOf('B') + '：' + (gA === 'small' ? '大球' : '小球')
      : '未定组'
    el('sh-group-a').textContent = gA ? (gA === 'small' ? '小球' : '大球') : ''
    el('sh-group-b').textContent = gA ? (gA === 'small' ? '大球' : '小球') : ''
    // 球网格
    var grid = el('ball-grid')
    grid.innerHTML = view.m3balls.map(function (ball) {
      var cls = 'ball' + (ball.owner ? ' sunk' : '')
      var inner = '<span class="num">' + ball.n + '</span>'
      if (ball.owner) inner += '<span class="owner-tag">' + ball.owner + '</span>'
      else if (ball.grp) inner += '<span class="grp-dot g' + ball.grp.toLowerCase() + '"></span>'
      return '<button class="' + cls + '" data-ball="' + ball.n + '" type="button" style="background:' +
        ballBackground(ball.n) + ';" aria-label="球 ' + ball.n + '">' + inner + '</button>'
    }).join('')
    grid.querySelectorAll('.ball').forEach(function (btn) {
      btn.addEventListener('click', function () { onM3BallTap(Number(btn.getAttribute('data-ball'))) })
    })
    // 进球流水
    var log = el('potlog')
    if (!view.m3pots.length) {
      log.innerHTML = '<div class="potlog-empty">本局暂无进球记录</div>'
    } else {
      log.innerHTML = view.m3pots.map(function (row) {
        if (row.type === 'foul') {
          return '<div class="pl-row"><span class="pl-side">' + esc(nameOf(row.p)) + '</span><span class="pl-foul">犯规</span></div>'
        }
        var tags = (row.def ? '<span class="pl-tag">定组</span>' : '') + (row.br ? '<span class="pl-tag">开球</span>' : '')
        return '<div class="pl-row"><span class="pl-side">' + esc(nameOf(row.p)) + '</span><span>进 ' +
          row.balls.join('、') + '</span>' + tags + '</div>'
      }).join('')
    }
    // 已完成局
    var fr = el('m3-frames')
    fr.innerHTML = state.m3frames.map(function (f, i) {
      return '<div class="fr">第 ' + (i + 1) + ' 局：' + esc(nameOf(f.winner)) + ' 胜' +
        (f.clear ? ' · 一杆清台' : '') + (f.statText ? ' · ' + esc(f.statText) : '') + '</div>'
    }).join('')
  }

  function renderAll() {
    renderHead()
    renderPanels()
    if (state.mode === 1) renderM1()
    if (state.mode === 2) renderM2()
    if (state.mode === 3) renderM3()
  }

  /* ---------- 变更入口 ---------- */
  function afterChange(immediate) {
    renderAll()
    queueSync(immediate)
  }

  /* ---------- 模式一 ---------- */
  function addWin(side) {
    if (state.readOnly) return
    if (side === 'A') state.scoreA++
    else state.scoreB++
    state.history.push({ w: side, c: state.nextClear ? 1 : 0 })
    state.nextClear = false
    afterChange(true)
  }

  function undoM1() {
    var last = state.history.pop()
    if (!last) return false
    if (last.w === 'A') state.scoreA--
    else state.scoreB--
    return true
  }

  /* ---------- 模式二 ---------- */
  function renderM2Frame(patch) {
    state.m2frames = state.m2frames.map(function (f, i) {
      return i === state.frameIndex ? Object.assign({}, f, patch) : f
    })
    afterChange(false)
  }

  /* ---------- 模式三 ---------- */
  function onM3BallTap(ball) {
    if (state.readOnly) return
    var cur = state.m3current
    if (!cur) return
    var view = m3ShotView(cur.shots)
    // 再次点击已落袋球：撤销该球进球流水
    if (view.m3balls[ball - 1].owner) {
      var removed = m3RemoveBall(cur.shots, ball, cur.breaker)
      if (!removed) { U.toast('该球已落袋'); return }
      state.m3current = Object.assign({}, cur, { shots: removed.shots })
      state.m3shooter = removed.shooter
      state.m3breaking = removed.breaking
      afterChange(false)
      return
    }
    var shooter = state.m3shooter
    var shot, nextShooter = shooter, potter = shooter
    if (state.m3breaking) {
      shot = { p: cur.breaker, b: ball, m: 1, br: 1, s: cur.breaker }
      potter = cur.breaker
    } else {
      var owner = m3GroupOwner(cur.shots, ball)
      var credit = owner || shooter
      shot = { p: credit, b: ball, m: 1, s: shooter }
      if (owner && owner !== shooter) nextShooter = owner
    }
    var shots = cur.shots.concat([shot])
    if (ball === 8 && state.m3breaking) {
      // 开球下 8：先落数据同步多端，三态弹窗确认分支再做渲染
      state.m3current = Object.assign({}, cur, { shots: shots })
      afterChange(false)
      var bname = nameOf(potter)
      black8ThreeModal(bname).then(function (choice) {
        if (choice === 'win') {
          endM3Frame(potter)
        } else if (choice === 'continue') {
          // 撤销黑球杆，恢复黑球可点
          state.m3current = Object.assign({}, state.m3current, { shots: cur.shots.slice() })
          afterChange(false)
          U.toast('请将黑球重置到开球点')
        }
        // close：保留落袋态，稍后点撤销纠正
      })
      return
    }
    state.m3current = Object.assign({}, cur, { shots: shots })
    state.m3shooter = nextShooter
    afterChange(false)
    if (ball === 8) {
      var pname = nameOf(potter)
      var other = potter === 'A' ? 'B' : 'A'
      black8TwoModal(pname, nameOf(other)).then(function (confirmWin) {
        endM3Frame(confirmWin ? potter : other)
      })
    }
  }

  function onM3Foul() {
    if (state.readOnly) return
    var cur = state.m3current
    if (!cur) return
    var shooter = state.m3shooter
    state.m3current = Object.assign({}, cur, { shots: cur.shots.concat([{ p: shooter, b: 0, m: 0, f: 1 }]) })
    state.m3shooter = shooter === 'A' ? 'B' : 'A'
    state.m3breaking = false
    afterChange(false)
    U.toast(nameOf(shooter) + ' 犯规，交换击球权')
  }

  function onM3Undo() {
    if (state.readOnly) return
    var cur = state.m3current
    if (cur && cur.shots.length > 0) {
      var shots = cur.shots.slice(0, -1)
      var popped = cur.shots[cur.shots.length - 1]
      var shooter = popped.s || popped.p
      state.m3current = Object.assign({}, cur, { shots: shots })
      state.m3shooter = shooter
      state.m3breaking = m3BreakPending(shots, shooter, cur.breaker)
      afterChange(false)
      return true
    }
    if (!state.m3frames.length) return false
    var frames = state.m3frames.slice()
    var last = frames.pop()
    var shots2 = last.shots || []
    var breaker = last.breaker || 'A'
    var shooter2 = shots2.length ? (shots2[shots2.length - 1].s || shots2[shots2.length - 1].p) : breaker
    state.m3frames = frames
    state.m3current = { breaker: breaker, shots: shots2, clear: last.clear ? 1 : 0 }
    state.m3shooter = shooter2
    state.m3breaking = m3BreakPending(shots2, shooter2, breaker)
    afterChange(true)
    return true
  }

  function endM3Frame(winner) {
    var cur = state.m3current
    if (!cur) return
    state.m3frames = state.m3frames.concat([{
      winner: winner,
      clear: cur.clear ? 1 : 0,
      breaker: cur.breaker,
      shots: cur.shots,
      statText: m3StatText(cur.shots)
    }])
    var nextBreaker = cur.breaker === 'A' ? 'B' : 'A'
    state.m3current = { breaker: nextBreaker, shots: [], clear: 0 }
    state.m3shooter = nextBreaker
    state.m3breaking = true
    afterChange(true)
  }

  /* ---------- 黑 8 弹窗 ---------- */
  function black8ThreeModal(name) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div')
      mask.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:24px;'
      var card = document.createElement('div')
      card.style.cssText = 'width:340px;max-width:100%;background:var(--card,#fff);color:var(--foreground,#1d1d1f);border:1px solid var(--border,#e5e5ea);border-radius:16px;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.20);'
      card.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
        '<span style="font-size:15px;font-weight:700;">8 号球落袋</span>' +
        '<button class="b8-close" type="button" aria-label="关闭" style="width:28px;height:28px;border:none;border-radius:999px;cursor:pointer;background:var(--secondary,#f2f2f7);color:var(--muted-foreground,#6e6e73);">×</button></div>' +
        '<div style="font-size:14px;line-height:1.6;margin-bottom:16px;">' + esc(name) + ' 开球打进 8 号球：可判本局获胜，或按规则将黑球重置到开球点后继续对局。</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
        '<button class="b8-continue" style="height:36px;padding:0 16px;border-radius:999px;border:1px solid var(--border,#e5e5ea);background:var(--card,#fff);color:inherit;font-size:13px;font-weight:600;cursor:pointer;">对局继续</button>' +
        '<button class="b8-win" style="height:36px;padding:0 16px;border:none;border-radius:999px;background:var(--primary,#007aff);color:var(--primary-foreground,#fff);font-size:13px;font-weight:700;cursor:pointer;">确认获胜</button></div>'
      mask.appendChild(card)
      document.body.appendChild(mask)
      function done(v) { mask.remove(); resolve(v) }
      card.querySelector('.b8-win').addEventListener('click', function () { done('win') })
      card.querySelector('.b8-continue').addEventListener('click', function () { done('continue') })
      card.querySelector('.b8-close').addEventListener('click', function () { done('close') })
      mask.addEventListener('click', function (e) { if (e.target === mask) done('close') })
    })
  }

  function black8TwoModal(potterName, otherName) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div')
      mask.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:24px;'
      var card = document.createElement('div')
      card.style.cssText = 'width:340px;max-width:100%;background:var(--card,#fff);color:var(--foreground,#1d1d1f);border:1px solid var(--border,#e5e5ea);border-radius:16px;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.20);'
      card.innerHTML =
        '<div style="font-size:15px;font-weight:700;margin-bottom:12px;">8 号球落袋</div>' +
        '<div style="font-size:14px;line-height:1.6;margin-bottom:16px;">' + esc(potterName) + ' 打进 8 号球，判定本局胜方。</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
        '<button class="b8-other" style="height:36px;padding:0 16px;border-radius:999px;border:1px solid var(--border,#e5e5ea);background:var(--card,#fff);color:inherit;font-size:13px;font-weight:600;cursor:pointer;">对方获胜</button>' +
        '<button class="b8-win" style="height:36px;padding:0 16px;border:none;border-radius:999px;background:var(--primary,#007aff);color:var(--primary-foreground,#fff);font-size:13px;font-weight:700;cursor:pointer;">确认获胜</button></div>'
      mask.appendChild(card)
      document.body.appendChild(mask)
      function done(v) { mask.remove(); resolve(v) }
      card.querySelector('.b8-win').addEventListener('click', function () { done(true) })
      card.querySelector('.b8-other').addEventListener('click', function () { done(false) })
    })
  }

  /* ---------- 结束对局 ---------- */
  async function finish() {
    if (state.readOnly || state.submitting) return
    if (state.mode === 3 && state.m3current && state.m3current.shots.length > 0) {
      U.toast('本局未结束，请先定胜方', 'error')
      return
    }
    var empty = state.mode === 2 ? !state.m2frames.length : (state.mode === 3 ? !state.m3frames.length : !state.history.length)
    if (empty) { U.toast('请先记录对局', 'error'); return }
    var ds = displayScore()
    if (ds.a === ds.b) { U.toast('局分持平，无法判定胜负', 'error'); return }
    var winnerName = ds.a > ds.b ? nameOf('A') : nameOf('B')
    var ok = await U.confirmBox(
      nameOf('A') + ' ' + ds.a + ' : ' + ds.b + ' ' + nameOf('B') + '，' + winnerName + ' 获胜。提交后积分立即生效。',
      '确认提交'
    )
    if (!ok) return
    state.submitting = true
    el('finish-btn').disabled = true
    try {
      var frames
      if (state.mode === 3) {
        frames = state.m3frames.map(function (f, i) {
          return {
            seq: i + 1,
            winner: f.winner === 'A' ? state.playerA._id : state.playerB._id,
            is_clear: f.clear ? 1 : 0,
            shots: (f.shots || []).map(function (s, j) {
              return {
                seq: j + 1,
                player: s.p === 'A' ? state.playerA._id : state.playerB._id,
                ball_no: s.b,
                made: !!s.m,
                foul: !!s.f
              }
            })
          }
        })
      } else if (state.mode === 2) {
        frames = state.m2frames.map(function (f, i) {
          return {
            seq: i + 1,
            winner: f.winner === 'A' ? state.playerA._id : state.playerB._id,
            remaining_balls: f.remaining,
            is_clear: f.clear ? 1 : 0
          }
        })
      } else {
        frames = state.history.map(function (h, i) {
          return {
            seq: i + 1,
            winner: h.w === 'A' ? state.playerA._id : state.playerB._id,
            is_clear: h.c ? 1 : 0
          }
        })
      }
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'finishMatch', Object.assign({
        game_type: 'c8',
        match_id: state.matchId || null,
        mode: state.mode,
        best_of: state.bestOf,
        players: [state.playerA._id, state.playerB._id],
        frames: frames
      }, compPayload()))
      var idName = {}
      idName[state.playerA._id] = nameOf('A')
      idName[state.playerB._id] = nameOf('B')
      var deltaText = (res.deltas || []).map(function (d) {
        return (idName[d.player] || '') + ' ' + (d.delta > 0 ? '+' : '') + d.delta
      }).join('，')
      await resultModal('已记录', '积分变动：' + deltaText)
      window.location.href = './match-records.html'
    } catch (e) {
      state.submitting = false
      el('finish-btn').disabled = false
      await resultModal('提交失败', e.message || '请稍后重试')
    }
  }

  function resultModal(title, text) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div')
      mask.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:24px;'
      var card = document.createElement('div')
      card.style.cssText = 'width:320px;max-width:100%;background:var(--card,#fff);color:var(--foreground,#1d1d1f);border:1px solid var(--border,#e5e5ea);border-radius:16px;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.20);'
      card.innerHTML =
        '<div style="font-size:15px;font-weight:700;margin-bottom:12px;">' + esc(title) + '</div>' +
        '<div style="font-size:14px;line-height:1.6;margin-bottom:16px;">' + esc(text) + '</div>' +
        '<div style="display:flex;justify-content:flex-end;"><button class="rm-ok" style="height:36px;padding:0 20px;border:none;border-radius:999px;background:var(--primary,#007aff);color:var(--primary-foreground,#fff);font-size:13px;font-weight:700;cursor:pointer;">确定</button></div>'
      mask.appendChild(card)
      document.body.appendChild(mask)
      card.querySelector('.rm-ok').addEventListener('click', function () { mask.remove(); resolve() })
    })
  }

  /* ---------- 恢复进行中对局 ---------- */
  async function restoreMatch(matchId) {
    try {
      var auth = window.AppAuth.read(AUTH_PURPOSE)
      var d = await window.AppCloud.call('getOngoingMatch', { match_id: matchId, web_token: auth ? auth.token : undefined })
      var m = d.match
      var mm = d.members || {}
      var ids = m.players || []
      state.playerA = mm[ids[0]] ? { _id: ids[0], name: mm[ids[0]].name } : null
      state.playerB = mm[ids[1]] ? { _id: ids[1], name: mm[ids[1]].name } : null
      if (!state.playerA || !state.playerB) throw new Error('对局选手信息缺失')
      state.matchId = m._id
      state.mode = m.mode || 1
      state.bestOf = m.best_of || 5
      state.competition = m.competition_id ? { _id: m.competition_id, name: m.competition_name || '' } : null
      state.readOnly = !d.can_edit
      var p = m.progress || {}
      state.scoreA = p.scoreA || 0
      state.scoreB = p.scoreB || 0
      state.history = Array.isArray(p.history) ? p.history : []
      state.nextClear = !!p.nextClear
      state.m2frames = Array.isArray(p.m2frames) ? p.m2frames : []
      state.frameIndex = Math.max(0, state.m2frames.length - 1)
      if (p.m3) {
        state.m3frames = Array.isArray(p.m3.frames) ? p.m3.frames : []
        state.m3current = p.m3.current && Array.isArray(p.m3.current.shots)
          ? p.m3.current
          : { breaker: 'A', shots: [], clear: 0 }
        state.m3shooter = p.m3.shooter === 'B' ? 'B' : 'A'
        state.m3breaking = p.m3.breaking === true
      }
      if (state.mode === 2 && !state.m2frames.length) {
        state.m2frames = [{ remaining: DEFAULT_REMAINING, winner: 'A', clear: 0 }]
      }
      if (state.mode === 3 && !state.m3current) {
        state.m3current = { breaker: 'A', shots: [], clear: 0 }
        state.m3shooter = 'A'
        state.m3breaking = true
      }
      el('setup').classList.add('ms-hidden')
      el('scoring').classList.remove('ms-hidden')
      if (state.readOnly) el('readonly-banner').classList.remove('ms-hidden')
      renderAll()
    } catch (e) {
      U.toast('恢复对局失败：' + (e.message || e), 'error')
      enterApp()
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    el('gate-btn').addEventListener('click', function () {
      window.AppAuth.ensure(AUTH_PURPOSE).then(afterAuth).catch(function () { /* 用户取消 */ })
    })
    el('slot-a').addEventListener('click', function () {
      openPicker('A', function (p) { state.playerA = p; paintSlot('A') })
    })
    el('slot-b').addEventListener('click', function () {
      openPicker('B', function (p) { state.playerB = p; paintSlot('B') })
    })
    document.querySelectorAll('#mode-cards .mode-card').forEach(function (card) {
      card.addEventListener('click', function () {
        if (card.classList.contains('disabled')) {
          U.toast('比赛对局暂仅支持简易翻局')
          return
        }
        selectMode(Number(card.getAttribute('data-mode')))
      })
    })
    document.querySelectorAll('#bo-chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.bestOf = Number(chip.getAttribute('data-bo'))
        document.querySelectorAll('#bo-chips .chip').forEach(function (c) { c.classList.remove('active') })
        chip.classList.add('active')
      })
    })
    el('comp-select').addEventListener('change', function () {
      var sel = el('comp-select')
      var id = sel.value
      state.competition = id ? { _id: id, name: sel.options[sel.selectedIndex].textContent } : null
      lockModesByCompetition()
    })
    el('start-btn').addEventListener('click', function () {
      if (!(state.playerA && state.playerB)) return
      el('setup').classList.add('ms-hidden')
      el('scoring').classList.remove('ms-hidden')
      renderAll()
      queueSync(true) // 创建 ongoing 对局
    })

    // 模式一
    el('flip-a').addEventListener('click', function () { addWin('A') })
    el('flip-b').addEventListener('click', function () { addWin('B') })
    el('m1-clear').addEventListener('click', function () {
      if (state.readOnly) return
      state.nextClear = !state.nextClear
      renderM1()
    })

    // 模式二
    el('m2-prev').addEventListener('click', function () {
      if (state.frameIndex > 0) { state.frameIndex--; renderM2() }
    })
    el('m2-next').addEventListener('click', function () {
      if (state.frameIndex < state.m2frames.length - 1) { state.frameIndex++; renderM2() }
    })
    el('m2-win-a').addEventListener('click', function () { if (!state.readOnly) renderM2Frame({ winner: 'A' }) })
    el('m2-win-b').addEventListener('click', function () { if (!state.readOnly) renderM2Frame({ winner: 'B' }) })
    el('m2-rem-minus').addEventListener('click', function () {
      if (state.readOnly) return
      var cur = state.m2frames[state.frameIndex]
      if (cur) renderM2Frame({ remaining: Math.min(7, Math.max(0, cur.remaining - 1)) })
    })
    el('m2-rem-plus').addEventListener('click', function () {
      if (state.readOnly) return
      var cur = state.m2frames[state.frameIndex]
      if (cur) renderM2Frame({ remaining: Math.min(7, Math.max(0, cur.remaining + 1)) })
    })
    el('m2-clear').addEventListener('click', function () {
      if (state.readOnly) return
      var cur = state.m2frames[state.frameIndex]
      if (cur) renderM2Frame({ clear: cur.clear ? 0 : 1 })
    })
    el('m2-add').addEventListener('click', function () {
      if (state.readOnly) return
      state.m2frames = state.m2frames.concat([{ remaining: DEFAULT_REMAINING, winner: 'A', clear: 0 }])
      state.frameIndex = state.m2frames.length - 1
      afterChange(false)
    })
    el('m2-del').addEventListener('click', function () {
      if (state.readOnly) return
      if (state.m2frames.length <= 1) { U.toast('至少保留一局'); return }
      state.m2frames = state.m2frames.filter(function (_, i) { return i !== state.frameIndex })
      state.frameIndex = Math.min(state.frameIndex, state.m2frames.length - 1)
      afterChange(false)
    })

    // 模式三
    el('m3-sw-a').addEventListener('click', function () {
      if (state.readOnly) return
      state.m3shooter = 'A'
      state.m3breaking = false
      afterChange(false)
    })
    el('m3-sw-b').addEventListener('click', function () {
      if (state.readOnly) return
      state.m3shooter = 'B'
      state.m3breaking = false
    })
    el('m3-break').addEventListener('click', function () {
      if (state.readOnly) return
      state.m3breaking = !state.m3breaking
      renderM3()
    })
    el('m3-clear').addEventListener('click', function () {
      if (state.readOnly || !state.m3current) return
      state.m3current = Object.assign({}, state.m3current, { clear: state.m3current.clear ? 0 : 1 })
      afterChange(false)
    })
    el('m3-foul').addEventListener('click', onM3Foul)
    el('m3-undo').addEventListener('click', onM3Undo)
    el('m3-endframe-a').addEventListener('click', function () { if (!state.readOnly) endM3Frame('A') })
    el('m3-endframe-b').addEventListener('click', function () { if (!state.readOnly) endM3Frame('B') })

    // 通用
    el('undo-btn').addEventListener('click', function () {
      if (state.readOnly) return
      if (state.mode === 1) { if (undoM1()) afterChange(true) }
      else if (state.mode === 3) { onM3Undo() }
      else U.toast('请到对应局删除或调整')
    })
    el('finish-btn').addEventListener('click', finish)
  }

  /* ---------- 启动 ---------- */
  function afterAuth() {
    enterApp()
    var matchId = new URLSearchParams(window.location.search).get('match_id')
    Promise.all([loadMembers(), loadCompetitions()]).then(function () {
      if (matchId) restoreMatch(matchId)
    })
  }

  bindEvents()
  U.fixNav('')
  if (window.AppAuth.read(AUTH_PURPOSE)) {
    afterAuth()
  } else {
    gate()
    // 云端就绪后再允许扫码（避免 SDK 未初始化）
    window.AppCloud.ready().catch(function () {})
  }
  window.AppUI.mountCloudBar && window.AppUI.mountCloudBar()
})()
