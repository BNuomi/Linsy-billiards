/*
 * 网页端九球追分记分页：对齐小程序 nine-ball-pursuit 流程
 * 步骤：1 设置规则 → 2 安排座位 → 3 逐局记录 → 4 流水结算
 * 引擎：pages/js/pursuit-engine.js（与小程序 engine.js 等价，tests/test-webPursuitEngine.js 3324 断言）
 * 云函数：createPursuitMatch / recordPursuitRound / undoPursuitRound / finishMatch(game_type='nine_ball')
 * 授权：match_ops 扫码授权，web_token 随调用；?match_id= 恢复进行中对局（无编辑权只读）
 * 多人房间：pursuitRoom（开房/输码加入/退房/心跳），房间内 2 秒轮询全员实时记分；?room=123456 直达加入
 */
;(function () {
  var U = window.AppUI
  var ENGINE = window.PursuitEngine
  var AUTH_PURPOSE = 'match_ops'

  var state = {
    step: 1,
    // 步骤 1
    playerCount: 3,
    ballCount: 9,
    ballCoeffMap: { 4: 1.0, 5: 1.1, 6: 1.2, 7: 1.3, 8: 1.4, 9: 1.5 },
    initScore: 100,
    targetRounds: 0,
    scoreConfig: ENGINE.defaultScoreConfig(3),
    // 步骤 2
    seats: { A: null, B: null, C: null },
    competition: null,
    // 步骤 3
    matchId: null,
    readOnly: false,
    breakerSeat: 'A',
    order: ['A', 'B', 'C'],
    orderOverride: null, // 手动顺位覆盖锚点（云端 matches.order_override），轮询比对用
    balances: {},
    rounds: [],          // 云端原始流水（时间正序）
    selType: 'pusheng',
    scorerSeat: null,
    // 得分状态（互斥）：让球 / 黑白双下（原胜局类型 = 当前选中的得分类型 selType）
    letBall: false,
    heibai: false,
    foulSeats: [],
    foulExpanded: false,
    // 预览分数手动调整：编辑态下每人变动可输入，提交本局以调整值（delta_override）落库；
    // _deltaTexts 为各座位输入原文（null = 未动过），_editSig 标记调整对应的参数快照（参数变更即失效）
    deltaEditing: false,
    _deltaTexts: null,
    _editSig: null,
    submitting: false,
    // 对局中调分：草稿快照避免面板打开期间被轮询重同步覆盖
    cfgEditing: false,
    cfgDraft: null,
    cfgSaving: false,
    // 多人房间：房间码免审批加入，房间成员全员可记分
    room: null,
    inRoom: false,
    isCreator: false,
    // 步骤 4
    finished: false
  }
  var members = []
  var competitions = []

  var SCORE_TYPES = [
    { key: 'kaiqiu_dajin', name: '开球大金' },
    { key: 'dajin', name: '大金' },
    { key: 'xiaojin', name: '小金' },
    { key: 'kaiqiu_hj9', name: '黄金九' },
    { key: 'pusheng', name: '普胜' },
    { key: 'fangui', name: '犯规' },
    { key: 'heibai', name: '黑白双下' }
  ]
  // 分值表列：其余人列仅四人局显示（全体扣类型「开球大金/黄金九」其余每人赔付）
  var SCORE_FIELDS = [
    { field: 'scorer', label: '得分者' },
    { field: 'shangjia', label: '上家' },
    { field: 'xiajia', label: '下家' },
    { field: 'other', label: '其余人' }
  ]

  function el(id) { return document.getElementById(id) }
  function esc(s) { return U.escapeHtml(s) }
  // 当前生效座位字母（步骤 1/2 由人数决定；恢复对局后由云端 match.seats 派生）
  function seatKeys() { return Object.keys(state.seats) }
  function visibleScoreFields() {
    return SCORE_FIELDS.filter(function (f) { return f.field !== 'other' || state.playerCount === 4 })
  }
  function allSeated() {
    var ks = seatKeys()
    return ks.length >= 2 && ks.every(function (s) { return state.seats[s] })
  }
  function nameOf(id) {
    var m = members.filter(function (x) { return x._id === id })[0]
    return m ? (m.name || '未命名') : '?'
  }
  function typeName(key) {
    var t = SCORE_TYPES.filter(function (x) { return x.key === key })[0]
    return t ? t.name : key
  }
  function seatName(seat) {
    var s = state.seats[seat]
    return s ? (s.name || seat) : seat
  }

  /* ---------- 门禁 ---------- */
  function gate() {
    el('gate').classList.remove('ms-hidden')
    el('setup').classList.add('ms-hidden')
    el('scoring').classList.add('ms-hidden')
    el('settle').classList.add('ms-hidden')
  }
  function enterApp() {
    el('gate').classList.add('ms-hidden')
    goStep(1)
  }
  function goStep(n) {
    state.step = n
    el('setup').classList.toggle('ms-hidden', n !== 1 && n !== 2)
    el('scoring').classList.toggle('ms-hidden', n !== 3)
    el('settle').classList.toggle('ms-hidden', n !== 4)
    if (n === 1 || n === 2) {
      el('setup-rules').classList.toggle('ms-hidden', n !== 1)
      el('setup-players').classList.toggle('ms-hidden', n !== 2)
    }
    // 结算页停止轮询（他人记分不再打断结算视图）；返回记分页恢复（房间 2 秒 / 常规 5 秒）
    if (n === 4) stopPoll()
    if (n === 3 && state.matchId && !state.finished) startPoll()
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
      // 九球比赛：未设类型或 nine_ball
      competitions = comps.filter(function (c) { return !c.game_type || c.game_type === 'nine_ball' })
      var sel = el('comp-select')
      competitions.forEach(function (c) {
        var opt = document.createElement('option')
        opt.value = c._id
        opt.textContent = c.name
        sel.appendChild(opt)
      })
    } catch (e) { /* 不阻断 */ }
  }

  /* ---------- 步骤 1：规则渲染 ---------- */
  function renderScoreTable() {
    var wrap = el('score-table')
    var fields = visibleScoreFields()
    var cols = String(fields.length)
    var html = '<div class="st-row st-head" data-cols="' + cols + '"><span class="st-name">类型</span>' +
      fields.map(function (f) { return '<span class="st-col">' + f.label + '</span>' }).join('') +
      '</div>'
    SCORE_TYPES.forEach(function (t) {
      if (t.key === 'heibai') return
      var row = state.scoreConfig[t.key]
      html += '<div class="st-row" data-cols="' + cols + '"><span class="st-name">' + t.name + '</span>' +
        fields.map(function (f) {
          return '<input class="st-input" type="number" data-key="' + t.key + '" data-field="' + f.field + '" value="' + (row[f.field] || 0) + '">'
        }).join('') +
        '</div>'
    })
    wrap.innerHTML = html
    wrap.querySelectorAll('.st-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var k = inp.getAttribute('data-key')
        var f = inp.getAttribute('data-field')
        var n = Number(inp.value)
        state.scoreConfig[k][f] = Number.isFinite(n) ? n : 0
      })
    })
    el('st-tip-2p').classList.toggle('ms-hidden', state.playerCount !== 2)
    el('st-tip-4p').classList.toggle('ms-hidden', state.playerCount !== 4)
  }
  function renderRuleMeta() {
    el('ball-coeff-tip').textContent = '已选 ' + state.ballCount + ' 球 · 积分难度系数 ×' + (state.ballCoeffMap[state.ballCount] || 1.0)
  }

  // 人数切换（2-4）：座位与分值表按新人数重置（默认值的全体扣类型 xiajia/other 列与人数相关）；
  // 已入座选手保留在前 N 个座位；有座位或开始比赛后不可切换
  function onPlayerCount(n) {
    if (n === state.playerCount || state.matchId) return
    var dirty = seatKeys().some(function (s) { return state.seats[s] })
    var apply = function () {
      var letters = ENGINE.seatLetters(n)
      var seats = {}
      letters.forEach(function (s) { seats[s] = state.seats[s] || null })
      state.playerCount = n
      state.seats = seats
      state.order = letters.slice()
      state.scoreConfig = ENGINE.defaultScoreConfig(n)
      renderScoreTable()
      renderSeatSlots()
    }
    if (!dirty) { apply(); return }
    U.confirmBox(
      '切换为 ' + n + ' 人后，座位与分值表将按新人数重置（已入座选手会保留在前 ' + n + ' 个座位）。',
      '切换'
    ).then(function (ok) { if (ok) apply() })
  }

  // 座位卡片显隐 + 网格列数 + 上下家关系提示（2-4 人动态）
  function renderSeatSlots() {
    var letters = seatKeys()
    ;['a', 'b', 'c', 'd'].forEach(function (s) {
      var slot = el('slot-' + s)
      slot.classList.toggle('ms-hidden', letters.indexOf(s.toUpperCase()) < 0)
    })
    el('slots-wrap').setAttribute('data-n', String(letters.length))
    el('seat-slots-title').textContent = '安排座位（' + letters.join(' → ') + ' 顺时针，A 位先开球）'
    el('seat-rel-tip').textContent = '上下家关系（循环）：' + letters.join(' → ') + ' → ' + letters[0] + '；顺位前者为上家'
    paintAllSeats()
  }

  /* ---------- 步骤 2：选手选择弹层（与 snooker-score 同款） ---------- */
  function openSeatPicker(seat) {
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

    function taken(id) {
      return seatKeys().some(function (s) { return state.seats[s] && state.seats[s]._id === id })
    }
    function renderList() {
      var kw = input.value.trim().toLowerCase()
      var rows = members.filter(function (m) {
        if (taken(m._id)) return false
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
              pick({ _id: m._id, name: m.name })
            } catch (e) {
              U.toast('创建临时选手失败：' + (e.message || e), 'error')
            }
            return
          }
          var id = item.getAttribute('data-id')
          var m = members.filter(function (x) { return x._id === id })[0]
          if (m) pick({ _id: m._id, name: m.name })
        })
      })
    }
    function pick(p) {
      state.seats[seat] = p
      paintSeat(seat)
      close()
    }
    input.addEventListener('input', renderList)
    renderList()
    input.focus()
  }

  function paintSeat(seat) {
    var slot = el('slot-' + seat.toLowerCase())
    if (!slot) return
    var p = state.seats[seat]
    slot.classList.toggle('empty', !p)
    slot.querySelector('.ps-name').textContent = p ? p.name : '点击选择'
    el('start-btn').disabled = !allSeated()
  }
  function paintAllSeats() {
    seatKeys().forEach(paintSeat)
    el('start-btn').disabled = !allSeated()
  }

  function onShuffleSeats() {
    var letters = seatKeys()
    if (!allSeated()) {
      U.toast('请先安排 ' + letters.length + ' 个座位', 'error')
      return
    }
    // Fisher-Yates 洗牌；必保证与当前座次不同
    var cur = letters.map(function (s) { return state.seats[s] })
    var next = cur.slice()
    do {
      for (var i = next.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1))
        var t = next[i]; next[i] = next[j]; next[j] = t
      }
    } while (next.every(function (p, i) { return p === cur[i] }))
    letters.forEach(function (s, i) { state.seats[s] = next[i] })
    paintAllSeats()
  }

  function compPayload() {
    return {
      competition_id: state.competition ? state.competition._id : null,
      competition_name: state.competition ? state.competition.name : null,
      fixture_id: null,
      stage: null
    }
  }

  /* ---------- 步骤 2 → 3：开始比赛 ---------- */
  async function startMatch() {
    if (!allSeated() || state.submitting) return
    var letters = seatKeys()
    var seatsPayload = {}
    letters.forEach(function (s) { seatsPayload[s] = state.seats[s]._id })
    state.submitting = true
    el('start-btn').disabled = true
    try {
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'createPursuitMatch', Object.assign({
        players: letters.map(function (s) { return state.seats[s]._id }),
        seats: seatsPayload,
        ball_count: state.ballCount,
        init_score: state.initScore,
        target_rounds: state.targetRounds,
        score_config: state.scoreConfig
      }, compPayload()))
      state.matchId = res.match_id
      state.balances = res.balances || {}
      state.breakerSeat = letters[0]
      state.order = letters.slice()
      state.scorerSeat = letters[0]
      state.rounds = []
      state.isCreator = true
      state.submitting = false
      el('start-btn').disabled = false
      goStep(3)
      renderScoring()
      renderRoom()
      startPoll()
    } catch (e) {
      state.submitting = false
      el('start-btn').disabled = false
      U.toast('创建失败：' + (e.message || e), 'error')
    }
  }

  /* ---------- 步骤 3：渲染 ---------- */
  function mainRoundCount() {
    return state.rounds.filter(function (r) { return r.score_type !== 'fangui' }).length
  }

  function renderScoreboard() {
    var wrap = el('sb-grid')
    wrap.setAttribute('data-n', String(state.order.length))
    wrap.innerHTML = state.order.map(function (seat) {
      var p = state.seats[seat]
      var bal = state.balances[p._id]
      var isBreak = state.breakerSeat === seat
      var isScorer = state.scorerSeat === seat
      var stateText = bal >= state.initScore ? '水上' : '水下'
      var stateCls = bal >= state.initScore ? 'up' : 'down'
      return '<div class="sb-col' + (isScorer ? ' is-scorer' : '') + '" data-seat="' + seat + '" role="button" tabindex="0">' +
        '<div class="sb-badges">' +
        (isBreak ? '<span class="sb-badge sb-badge-break">开球</span>' : '') +
        (isScorer ? '<span class="sb-badge sb-badge-scorer">得分</span>' : '') +
        '</div>' +
        '<div class="sb-letter sb-letter-' + seat + '">' + seat + '</div>' +
        '<div class="sb-name">' + esc(p.name || seat) + '</div>' +
        '<div class="sb-balance">' + (bal != null ? bal : 0) + '</div>' +
        '<div class="sb-state sb-state-' + stateCls + '">' + stateText + '</div>' +
        '</div>'
    }).join('')
    wrap.querySelectorAll('.sb-col').forEach(function (col) {
      col.addEventListener('click', function () {
        if (state.readOnly) return
        if (suppressClick) return // 长按拖动松手后的合成 click，不当作选择得分者
        state.scorerSeat = col.getAttribute('data-seat')
        renderScoring()
      })
      bindColDrag(col)
    })
    el('sb-meta').textContent = state.ballCount + ' 球追分 · 已记 ' + mainRoundCount() + ' 局' +
      (state.targetRounds > 0 ? '（目标 ' + state.targetRounds + ' 局）' : '') +
      (state.competition ? ' · ' + state.competition.name : '')
  }

  /* ---------- 长按拖动调整顺位（编辑模式） ----------
     长按卡片 350ms 进入拖动：横向拖过其他卡片中点即锁定目标位；
     松手后新顺位经 reorderPursuitMatch 落云端（matches.order_override 锚点），多端同步 */
  var dragCtx = null // { seat, col, targetIndex, active, timer }
  var suppressClick = false

  function bindColDrag(col) {
    col.addEventListener('pointerdown', function () {
      if (state.readOnly || !state.matchId || state.submitting) return
      var seat = col.getAttribute('data-seat')
      dragCtx = { seat: seat, col: col, targetIndex: state.order.indexOf(seat), active: false, timer: null }
      dragCtx.timer = setTimeout(function () {
        if (!dragCtx) return
        dragCtx.active = true
        col.classList.add('is-drag')
      }, 350)
    })
  }

  document.addEventListener('pointermove', function (e) {
    if (!dragCtx || !dragCtx.active) return
    var cols = el('sb-grid').querySelectorAll('.sb-col')
    var x = e.clientX
    var target = cols.length - 1
    for (var i = 0; i < cols.length; i++) {
      var r = cols[i].getBoundingClientRect()
      if (x < r.left + r.width / 2) { target = i; break }
    }
    dragCtx.targetIndex = target
    if (e.cancelable) e.preventDefault()
  }, { passive: false })

  function endColDrag() {
    var d = dragCtx
    dragCtx = null
    if (!d) return
    clearTimeout(d.timer)
    if (!d.active) return
    d.col.classList.remove('is-drag')
    // 拖动已发生：抑制紧随 pointerup 的 click（避免误触选择得分者）
    suppressClick = true
    setTimeout(function () { suppressClick = false }, 80)
    var from = state.order.indexOf(d.seat)
    var to = Math.max(0, Math.min(state.order.length - 1, d.targetIndex))
    if (from < 0 || from === to) return
    var order = state.order.slice()
    order.splice(from, 1)
    order.splice(to, 0, d.seat)
    submitOrder(order)
  }
  document.addEventListener('pointerup', endColDrag)
  document.addEventListener('pointercancel', endColDrag)

  // 新顺位落云端 → 成功后本地同步（开球者 = 顺位第一，得分者跟随开球者）
  async function submitOrder(order) {
    if (state.submitting) return
    state.submitting = true
    try {
      await window.AppAuth.callAuthed(AUTH_PURPOSE, 'reorderPursuitMatch', { match_id: state.matchId, order: order })
      state.order = order
      state.breakerSeat = order[0]
      state.scorerSeat = order[0]
      state.submitting = false
      renderScoring()
      U.toast('已调整顺位')
    } catch (e) {
      state.submitting = false
      renderScoring()
      U.toast(e.message || '调整顺位失败', 'error')
    }
  }

  function renderTypeChips() {
    var wrap = el('type-chips')
    // chips 仅含胜利类类型（犯规为附加项、黑白双下为得分状态开关）
    wrap.innerHTML = SCORE_TYPES.filter(function (t) { return t.key !== 'fangui' && t.key !== 'heibai' }).map(function (t) {
      return '<button class="chip' + (state.selType === t.key ? ' active' : '') + '" data-key="' + t.key + '" type="button">' + t.name + '</button>'
    }).join('')
    wrap.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        if (state.readOnly) return
        // 切换类型不复位得分状态，黑白双下的原胜局基准随 selType 变化
        state.selType = chip.getAttribute('data-key')
        renderScoring()
      })
    })
  }

  function renderToggles() {
    el('toggle-letball').classList.toggle('active', state.letBall)
    el('toggle-heibai').classList.toggle('active', state.heibai)
    var tip = el('heibai-tip')
    if (state.heibai) {
      var cur = state.scoreConfig[state.selType] || state.scoreConfig.pusheng
      if (ENGINE.ALL_PAY_TYPES.indexOf(state.selType) >= 0) {
        // 原类型为开球大金/黄金九：按人均赔付（击球者 −(人均×其余人数+1)，其余每人 +人均，上家再 +1）
        var per = Math.abs(cur.shangjia)
        tip.textContent = '黑白双下（原' + typeName(state.selType) + '）：击球者 −(' + per + '×' + (state.order.length - 1) + '+1) · 其余每人 +' + per + ' · 上家再 +1'
      } else {
        tip.textContent = '黑白双下：按「' + typeName(state.selType) + ' + 犯规」推导——击球者 −(' + cur.scorer + '+1) · 上家 +1 · 下家 +' + cur.scorer
      }
      tip.classList.remove('ms-hidden')
    } else {
      tip.classList.add('ms-hidden')
    }
  }

  // 预览参数签名：手动调整仅对签名一致的参数快照生效（任何参数变更重算预览后，调整随之失效）
  function previewSig() {
    return JSON.stringify([state.scorerSeat, state.heibai ? 'heibai' : state.selType, state.heibai ? false : !!state.letBall, state.foulSeats])
  }

  // 解析各座位调整原文（缺省回退引擎值）：map = id→有效数值，allValid/sum/sumOk/edited 供提示与提交校验
  function resolveDeltaEdits(engineDeltas) {
    var res = { map: {}, allValid: true, sum: 0, sumOk: true, edited: false }
    seatKeys().forEach(function (s) {
      var id = state.seats[s]._id
      var t = state._deltaTexts ? state._deltaTexts[s] : undefined
      var fallback = engineDeltas[id] || 0
      if (t === undefined) { res.map[id] = fallback; return }
      var v = Number(t)
      if (String(t).trim() === '' || !Number.isFinite(v)) {
        res.allValid = false
        res.map[id] = fallback
        return
      }
      res.map[id] = v
      res.sum += v
      if (Math.abs(v - fallback) > 1e-9) res.edited = true
    })
    res.sum = Math.round(res.sum * 100) / 100
    res.sumOk = res.allValid && Math.abs(res.sum) <= 0.005
    return res
  }

  function renderDeltaHint(edits) {
    var hint = el('pv-sumhint')
    hint.textContent = !edits.allValid ? '含无效数字' : (edits.sumOk ? (edits.edited ? '已调整 · 合计 0' : '合计 0') : '合计 ' + edits.sum + ' · 须为 0')
    hint.classList.toggle('is-bad', !edits.sumOk)
    hint.classList.remove('ms-hidden')
  }

  function renderPreview() {
    var wrap = el('preview-body')
    var hint = el('pv-sumhint')
    var editBtn = el('pv-edit-btn')
    if (!state.scorerSeat || !allSeated()) {
      wrap.innerHTML = '<div class="eventlog-empty">请先选择得分者</div>'
      hint.classList.add('ms-hidden')
      state._previewDeltas = null
      state._previewEngineDeltas = null
      return
    }
    // 黑白双下状态开启时按 heibai 公式推导，原胜局类型 = 当前选中的得分类型（selType）
    var res = ENGINE.calcRoundDeltas(
      state.scoreConfig, state.heibai ? 'heibai' : state.selType,
      {
        scorerSeat: state.scorerSeat,
        doubled: false,
        letBall: state.letBall,
        foulSeats: state.foulSeats,
        order: state.order,
        negatedType: state.selType
      },
      state.seats
    )
    var engineDeltas = res.deltas
    // 参数变更（得分者/类型/状态/犯规）使既有调整失效
    var sig = previewSig()
    if (state._editSig !== sig) {
      state._deltaTexts = null
      state._editSig = sig
    }
    var edits = resolveDeltaEdits(engineDeltas)
    var deltas = state._deltaTexts ? edits.map : engineDeltas
    var foulCounts = {}
    state.foulSeats.forEach(function (fs) {
      var seat = typeof fs === 'string' ? fs : fs.seat
      foulCounts[seat] = (foulCounts[seat] || 0) + 1
    })
    // 既非上下家也非得分者的座位显示「旁观」（四人局全体扣类型仍参与赔付，由 delta 数值体现）
    function roleOf(seat) {
      if (seat === state.scorerSeat) return state.heibai ? '击球' : '得分'
      if (seat === res.shangjiaSeat) return '上家'
      if (seat === res.xiajiaSeat) return state.letBall ? '让球方' : '下家'
      return '旁观'
    }
    var html = seatKeys().map(function (seat) {
      var p = state.seats[seat]
      var d = deltas[p._id] || 0
      var cls = d > 0 ? 'is-plus' : (d < 0 ? 'is-minus' : '')
      var foulBadge = foulCounts[seat] > 0 ? '<span class="pv-foul">犯规' + (foulCounts[seat] > 1 ? '×' + foulCounts[seat] : '') + '</span>' : ''
      var deltaCell = state.deltaEditing
        ? '<input class="pv-delta-input" type="text" inputmode="decimal" data-seat="' + seat + '" value="' + esc(state._deltaTexts && state._deltaTexts[seat] !== undefined ? state._deltaTexts[seat] : String(engineDeltas[p._id] || 0)) + '" />'
        : '<span class="pv-delta ' + cls + '">' + (d > 0 ? '+' : '') + d + '</span>'
      return '<div class="pv-row">' +
        '<div class="pv-role-wrap"><span class="pv-role">' + roleOf(seat) + '</span>' + foulBadge + '</div>' +
        '<span class="pv-name">' + esc(p.name || seat) + '</span>' +
        deltaCell +
        '</div>'
    }).join('')
    wrap.innerHTML = html
    // 编辑态输入：原文入 _deltaTexts，实时重算有效变动表与零和提示（不重渲染，避免丢失焦点）
    wrap.querySelectorAll('.pv-delta-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        state._deltaTexts = state._deltaTexts || {}
        state._deltaTexts[inp.getAttribute('data-seat')] = inp.value
        var e2 = resolveDeltaEdits(engineDeltas)
        state._previewDeltas = e2.map
        renderDeltaHint(e2)
      })
    })
    // 缓存本局 deltas 用于提交后校验（手动调整场景为调整值）
    state._previewDeltas = deltas
    state._previewEngineDeltas = engineDeltas
    state._previewShangjiaSeat = res.shangjiaSeat
    state._previewXiajiaSeat = res.xiajiaSeat
    // 零和提示与按钮态
    if (state.deltaEditing || state._deltaTexts) renderDeltaHint(edits)
    else hint.classList.add('ms-hidden')
    editBtn.textContent = state.deltaEditing ? '完成' : '调整'
    editBtn.classList.toggle('is-on', state.deltaEditing)
  }

  function renderFouls() {
    var wrap = el('foul-list')
    if (!state.foulSeats.length) {
      wrap.innerHTML = ''
    } else {
      var fb = state.scoreConfig.fangui
      var rel = ENGINE.relationsInOrder(state.order, state.scorerSeat || 'A')
      var html = state.foulSeats.map(function (fs, i) {
        var foul = typeof fs === 'string' ? { seat: fs, letBall: false } : fs
        var seat = foul.seat
        var name = seatName(seat)
        var beneSeat
        var beneLabel
        if (foul.letBall) {
          beneLabel = '让球方'
          beneSeat = foul.beneficiarySeat && state.seats[foul.beneficiarySeat] ? foul.beneficiarySeat : rel.xiajiaSeat
        } else {
          beneLabel = '上家'
          beneSeat = ENGINE.relationsInOrder(state.order, seat).shangjiaSeat
        }
        return '<div class="fl-item">' +
          '<div class="fl-info"><span class="fl-name">' + esc(name) + ' 犯规</span>' +
          '<span class="fl-text">' + fb.scorer + ' 分 · ' + beneLabel + ' ' + esc(seatName(beneSeat)) + ' +' + fb.shangjia + '</span></div>' +
          '<button class="fl-x" data-index="' + i + '" type="button" aria-label="删除">✕</button>' +
          '</div>'
      }).join('')
      wrap.innerHTML = html
      wrap.querySelectorAll('.fl-x').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (state.readOnly) return
          var i = Number(btn.getAttribute('data-index'))
          state.foulSeats.splice(i, 1)
          renderScoring()
        })
      })
    }
    // 犯规候选
    var candWrap = el('foul-candidates')
    if (state.foulExpanded) {
      candWrap.classList.remove('ms-hidden')
      candWrap.innerHTML = state.order.map(function (seat) {
        return '<button class="foul-cand" data-seat="' + seat + '" type="button">' +
          '<span class="foul-cand-letter sb-letter-' + seat + '">' + seat + '</span>' +
          '<span>' + esc(seatName(seat)) + '</span>' +
          '</button>'
      }).join('')
      candWrap.querySelectorAll('.foul-cand').forEach(function (b) {
        b.addEventListener('click', function () {
          if (state.readOnly) return
          addFoul(b.getAttribute('data-seat'))
        })
      })
    } else {
      candWrap.classList.add('ms-hidden')
      candWrap.innerHTML = ''
    }
    // 犯规按钮文案
    el('foul-btn').textContent = state.letBall
      ? '＋ 犯规（扣' + seatName(state.scorerSeat || 'A') + '）'
      : (state.foulSeats.length > 0 ? '＋ 犯规（继续添加）' : '＋ 犯规')
  }

  function addFoul(seat) {
    var foul = { seat: seat, letBall: !!state.letBall }
    if (state.letBall && state.scorerSeat) {
      foul.beneficiarySeat = ENGINE.relationsInOrder(state.order, state.scorerSeat).xiajiaSeat
    }
    state.foulSeats.push(foul)
    if (state.letBall) state.letBall = false
    state.foulExpanded = false
    renderScoring()
  }

  function renderLedger() {
    var wrap = el('ledger-body')
    if (!state.rounds.length) {
      wrap.innerHTML = '<div class="eventlog-empty">暂无对局记录</div>'
      return
    }
    // 倒序：最新一局在最前；同局多行保持主事件在前
    var groups = []
    state.rounds.forEach(function (r) {
      var last = groups[groups.length - 1]
      if (last && last[0].round_seq === r.round_seq) last.push(r)
      else groups.push([r])
    })
    var html = ''
    for (var i = groups.length - 1; i >= 0; i--) {
      groups[i].forEach(function (r) {
        var flags = [r.doubled && '翻倍', r.let_ball && '让球', r.let_ball_foul && '让球犯规', r.overridden && '改'].filter(Boolean).join('·')
        var tname = typeName(r.score_type) +
          (r.score_type === 'heibai' && r.negated_type ? '（原' + typeName(r.negated_type) + '）' : '')
        var changes = Object.keys(r.deltas || {}).filter(function (id) { return r.deltas[id] !== 0 }).map(function (id) {
          var v = r.deltas[id]
          return '<span class="ld-change"><span class="ld-name">' + esc(nameOf(id)) + '</span>' +
            '<span class="ld-delta ' + (v > 0 ? 'is-plus' : 'is-minus') + '">' + (v > 0 ? '+' : '') + v + '</span></span>'
        }).join('')
        html += '<div class="ld-row">' +
          '<div class="ld-head"><span class="ld-seq">#' + r.round_seq + '</span>' +
          '<span class="ld-type">' + esc(tname) + '</span>' +
          (flags ? '<span class="ld-flags">' + esc(flags) + '</span>' : '') +
          '</div>' +
          '<div class="ld-changes">' + changes + '</div>' +
          '</div>'
      })
    }
    wrap.innerHTML = html
  }

  function renderScoring() {
    renderScoreboard()
    renderTypeChips()
    renderToggles()
    renderPreview()
    renderFouls()
    renderLedger()
    el('undo-btn').disabled = !state.rounds.length || state.submitting || state.readOnly
    el('record-btn').disabled = !state.scorerSeat || state.submitting || state.readOnly
    el('finish-btn').disabled = !state.rounds.length || state.submitting || state.readOnly
    // 对局中调分入口：仅编辑者可调（创建人/获准编辑者/房间成员；云端二次校验）
    el('cfg-entry').classList.toggle('ms-hidden', state.readOnly || state.finished)
    // 预览分数调整入口：仅编辑者可调（观看模式只读）
    el('pv-edit-btn').classList.toggle('ms-hidden', state.readOnly || state.finished)
    el('scoring').classList.toggle('is-readonly', state.readOnly)
  }

  /* ---------- 步骤 3：动作 ---------- */
  async function recordRound() {
    if (!state.scorerSeat || state.submitting || state.readOnly) return
    // 黑白双下为得分状态：开启后主事件按 heibai 落库，原胜局类型 = 当前选中的得分类型；与让球互斥
    var isHeibai = !!state.heibai
    var effType = isHeibai ? 'heibai' : state.selType
    var effLetBall = isHeibai ? false : !!state.letBall
    var rel = ENGINE.relationsInOrder(state.order, state.scorerSeat)
    var scorerSeat = state.scorerSeat
    var shangjiaSeat = rel.shangjiaSeat
    var xiajiaSeat = rel.xiajiaSeat
    // 幂等键（client_round_id）：失败重试复用同一键，防云端已落库但响应未达导致重复局
    var sig = JSON.stringify([scorerSeat, effType, isHeibai, effLetBall, state.foulSeats])
    // 预览分数手动调整：调整快照与当前参数一致（sig 相同）时携带 delta_override；
    // 提交前校验数值有效 + 合计零和（云端二次校验），不通过则拦截且不消耗幂等键
    var deltaOverride = null
    if (state._deltaTexts && state._editSig === sig) {
      var ovSeats = seatKeys()
      var ovVals = []
      var ovBad = false
      for (var oi = 0; oi < ovSeats.length; oi++) {
        var ot = state._deltaTexts[ovSeats[oi]]
        var ov = Number(ot)
        if (ot === undefined || String(ot).trim() === '' || !Number.isFinite(ov)) { ovBad = true; break }
        ovVals.push(ov)
      }
      if (ovBad) {
        U.toast('调整值含无效数字', 'error')
        return
      }
      var ovSum = Math.round(ovVals.reduce(function (a, b) { return a + b }, 0) * 100) / 100
      if (Math.abs(ovSum) > 0.005) {
        U.toast('变动合计须为 0', 'error')
        return
      }
      deltaOverride = {}
      ovSeats.forEach(function (s, i) { deltaOverride[state.seats[s]._id] = ovVals[i] })
    }
    var rid = (state._retryRid && state._retryRid.sig === sig)
      ? state._retryRid.rid
      : (state.matchId + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10))
    state._retryRid = null
    state.submitting = true
    el('record-btn').disabled = true
    try {
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'recordPursuitRound', {
        match_id: state.matchId,
        score_type: effType,
        client_round_id: rid,
        negated_type: isHeibai ? state.selType : undefined,
        scorer: state.seats[scorerSeat]._id,
        shangjia: state.seats[shangjiaSeat]._id,
        xiajia: state.seats[xiajiaSeat]._id,
        doubled: false,
        let_ball: effLetBall,
        order: state.order,
        foul_players: state.foulSeats.map(function (fs) {
          var seat = typeof fs === 'string' ? fs : fs.seat
          return state.seats[seat]._id
        }),
        foul_let_flags: state.foulSeats.map(function (fs) {
          return !!(typeof fs === 'object' && fs && fs.letBall)
        }),
        foul_beneficiary_seats: state.foulSeats.map(function (fs) {
          return (typeof fs === 'object' && fs && fs.letBall && fs.beneficiarySeat) || null
        }),
        // 预览分数手动调整：最终变动（主事件 + 犯规合计）；云端校验零和后主事件行吸收差值
        delta_override: deltaOverride || undefined
      })
      var newRounds = Array.isArray(res.rounds) ? res.rounds : (res.round ? [res.round] : [])
      // 端云一致性校验
      if (res.balances && state._previewDeltas) {
        var mismatch = seatKeys().some(function (seat) {
          var id = state.seats[seat]._id
          var prev = state.balances[id] || 0
          var dv = state._previewDeltas[id] || 0
          return res.balances[id] !== prev + dv
        })
        if (mismatch) {
          await U.confirmBox('云端返回的余额与预览不一致（云端云函数版本可能过旧）。本场数据以云端为准。', '知道了')
        }
      }
      // 重放开球者与顺位
      state.balances = res.balances || state.balances
      state.rounds = state.rounds.concat(newRounds)
      state.breakerSeat = ENGINE.nextBreakerSeat(effType, scorerSeat, xiajiaSeat)
      state.order = ENGINE.nextOrder(state.order, effType, scorerSeat, shangjiaSeat, xiajiaSeat)
      state.scorerSeat = state.breakerSeat
      state.heibai = false
      state.letBall = false
      state.foulSeats = []
      state.foulExpanded = false
      state.deltaEditing = false
      state._deltaTexts = null
      state._editSig = null
      state.submitting = false
      renderScoring()
      // 目标局数提醒：默认走「取消」即继续比赛；点「结束比赛」进结算页
      var mc = mainRoundCount()
      if (state.targetRounds > 0 && mc === state.targetRounds) {
        var goFinish = await U.confirmBox(
          '已完成 ' + mc + ' 局（目标 ' + state.targetRounds + ' 局）。点击「结束比赛」进入结算；点击「取消」继续比赛（以最终局数为准）。',
          '结束比赛'
        )
        if (goFinish) goSettle()
      }
    } catch (e) {
      state._retryRid = { sig: sig, rid: rid }
      state.submitting = false
      renderScoring()
      U.toast('记录失败：' + (e.message || e), 'error')
    }
  }

  async function undoRound() {
    if (!state.rounds.length || state.submitting || state.readOnly) return
    var last = state.rounds[state.rounds.length - 1]
    var ok = await U.confirmBox(
      '将撤销第 ' + last.round_seq + ' 局（含本局犯规流水），余额同步回退。是否继续？',
      '撤回'
    )
    if (!ok) return
    state.submitting = true
    el('undo-btn').disabled = true
    try {
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'undoPursuitRound', { match_id: state.matchId })
      var remain = state.rounds.filter(function (r) { return r.round_seq <= res.round_count })
      // 重放：从首座位开球 / 物理座位顺位起，按主事件逐局推算；
      // 云端返回仍生效的手动顺位覆盖锚点：重放到锚点局后先套用覆盖顺位
      var letters = seatKeys()
      var ov = res.order_override
      var ovOrder = ov && Array.isArray(ov.order) && ov.order.length === letters.length ? ov.order : null
      var ovApplied = !ovOrder
      var breakerSeat = letters[0]
      var order = letters.slice()
      remain.forEach(function (r) {
        if (r.score_type === 'fangui') return
        if (!ovApplied && (r.round_seq || 0) > (ov.round_seq || 0)) {
          order = ovOrder.slice()
          breakerSeat = order[0]
          ovApplied = true
        }
        var snap = r.seats_snapshot || {}
        var seatOf = function (id) { return letters.filter(function (s) { return snap[s] === id })[0] }
        var scorerSeat = seatOf(r.scorer)
        var shangjiaSeat = seatOf(r.shangjia)
        var xiajiaSeat = seatOf(r.xiajia)
        breakerSeat = ENGINE.nextBreakerSeat(r.score_type, scorerSeat, xiajiaSeat)
        order = ENGINE.nextOrder(order, r.score_type, scorerSeat, shangjiaSeat, xiajiaSeat)
      })
      state.balances = res.balances || state.balances
      state.rounds = remain
      state.breakerSeat = breakerSeat
      state.order = order
      state.scorerSeat = breakerSeat
      state.heibai = false
      state.letBall = false
      state.foulSeats = []
      state.foulExpanded = false
      state.deltaEditing = false
      state._deltaTexts = null
      state._editSig = null
      state.submitting = false
      renderScoring()
    } catch (e) {
      state.submitting = false
      renderScoring()
      U.toast('撤回失败：' + (e.message || e), 'error')
    }
  }

  /* ---------- 步骤 4：结算 ---------- */
  function goSettle() {
    if (!state.rounds.length) {
      U.toast('请先记录至少 1 局', 'error')
      return
    }
    // 目标局数未达：取消 = 继续比赛；确定 = 仍要提交
    var mc = mainRoundCount()
    if (state.targetRounds > 0 && mc < state.targetRounds) {
      U.confirmBox(
        '已记录 ' + mc + ' 局（目标 ' + state.targetRounds + ' 局）。未满足目标局数，是否仍要结束并进入结算？点击「取消」继续比赛。',
        '确定提交'
      ).then(function (confirmed) {
        if (confirmed) renderSettle()
      })
      return
    }
    renderSettle()
  }

  function renderSettle() {
    // 最终排名
    var ranking = seatKeys().map(function (seat) {
      var p = state.seats[seat]
      var bal = state.balances[p._id] || 0
      return { seat: seat, name: p.name || seat, balance: bal, net: bal - state.initScore }
    }).sort(function (x, y) { return y.balance - x.balance })
    el('rank-body').innerHTML = ranking.map(function (r, i) {
      return '<div class="rk-row">' +
        '<span class="rk-no' + (i === 0 ? ' rk-no-top' : '') + '">' + (i + 1) + '</span>' +
        '<div class="rk-main"><span class="rk-name">' + esc(r.name) + '</span>' +
        '<span class="rk-net">净胜 ' + (r.net > 0 ? '+' : '') + r.net + '</span></div>' +
        '<span class="rk-balance">' + r.balance + '</span>' +
        '</div>'
    }).join('')
    // 完整流水（复用 renderLedger 渲染）
    renderSettleLedger()
    goStep(4)
  }

  function renderSettleLedger() {
    var wrap = el('settle-ledger')
    if (!state.rounds.length) {
      wrap.innerHTML = '<div class="eventlog-empty">暂无对局记录</div>'
      return
    }
    var groups = []
    state.rounds.forEach(function (r) {
      var last = groups[groups.length - 1]
      if (last && last[0].round_seq === r.round_seq) last.push(r)
      else groups.push([r])
    })
    var html = ''
    for (var i = groups.length - 1; i >= 0; i--) {
      groups[i].forEach(function (r) {
        var flags = [r.doubled && '翻倍', r.let_ball && '让球', r.let_ball_foul && '让球犯规', r.overridden && '改'].filter(Boolean).join('·')
        var tname = typeName(r.score_type) +
          (r.score_type === 'heibai' && r.negated_type ? '（原' + typeName(r.negated_type) + '）' : '')
        var changes = Object.keys(r.deltas || {}).filter(function (id) { return r.deltas[id] !== 0 }).map(function (id) {
          var v = r.deltas[id]
          return '<span class="ld-change"><span class="ld-name">' + esc(nameOf(id)) + '</span>' +
            '<span class="ld-delta ' + (v > 0 ? 'is-plus' : 'is-minus') + '">' + (v > 0 ? '+' : '') + v + '</span></span>'
        }).join('')
        html += '<div class="ld-row">' +
          '<div class="ld-head"><span class="ld-seq">#' + r.round_seq + '</span>' +
          '<span class="ld-type">' + esc(tname) + '</span>' +
          (flags ? '<span class="ld-flags">' + esc(flags) + '</span>' : '') +
          '</div>' +
          '<div class="ld-changes">' + changes + '</div>' +
          '</div>'
      })
    }
    wrap.innerHTML = html
  }

  async function submitPoints() {
    if (state.finished || state.submitting) return
    var mc = mainRoundCount()
    var coeff = state.ballCoeffMap[state.ballCount] || 1.0
    var ok = await U.confirmBox(
      '当前 ' + state.ballCount + ' 球（难度系数 ×' + coeff + '），已记 ' + mc + ' 局。按「(参与分 1 + 净胜分×0.1)×球数系数 + 局数×0.1」写入会员总积分（每场保底 +0.5），提交后不可修改。',
      '确认提交'
    )
    if (!ok) return
    state.submitting = true
    el('submit-btn').disabled = true
    try {
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'finishMatch', {
        game_type: 'nine_ball',
        match_id: state.matchId,
        final_scores: state.balances
      })
      var deltaText = (res.deltas || []).map(function (d) {
        return nameOf(d.player) + ' ' + (d.delta > 0 ? '+' : '') + d.delta
      }).join('，')
      state.finished = true
      state.submitting = false
      await U.confirmBox('积分变动：' + deltaText, '确定')
      window.location.href = './match-records.html'
    } catch (e) {
      state.submitting = false
      el('submit-btn').disabled = false
      U.toast('提交失败：' + (e.message || e), 'error')
    }
  }

  /* ---------- 恢复进行中对局 ---------- */
  async function restoreMatch(matchId) {
    try {
      var auth = window.AppAuth.read(AUTH_PURPOSE)
      var d = await window.AppCloud.call('getOngoingMatch', { match_id: matchId, web_token: auth ? auth.token : undefined })
      applyMatchData(d)
      el('readonly-banner').classList.toggle('ms-hidden', !state.readOnly)
      el('join-card').classList.add('ms-hidden')
      goStep(3)
      renderScoring()
      renderRoom()
      startPoll()
    } catch (e) {
      U.toast('恢复对局失败：' + (e.message || e), 'error')
      enterApp()
    }
  }

  // 用云端快照灌满本地状态（restore / 轮询重同步共用）：座位/余额/流水重放 + 房间视图
  function applyMatchData(d) {
    var m = d.match
    var mm = d.members || {}
    // 把云端 members 灌入本地名单（用于 nameOf）
    Object.keys(mm).forEach(function (id) {
      if (!members.some(function (x) { return x._id === id })) members.push(mm[id])
    })
    state.matchId = m._id
    state.ballCount = m.ball_count || 9
    state.initScore = m.init_score || 100
    state.targetRounds = m.target_rounds || 0
    state.scoreConfig = m.score_config || ENGINE.defaultScoreConfig(3)
    // 动态座位（2-4 人）：按 match.seats 字母序派生，兼容旧 3 人与新 2/4 人对局
    var letters = Object.keys(m.seats || {}).filter(function (s) { return m.seats[s] }).sort()
    state.seats = {}
    letters.forEach(function (s) {
      state.seats[s] = mm[m.seats[s]] ? { _id: m.seats[s], name: mm[m.seats[s]].name } : null
    })
    if (!letters.length || letters.some(function (s) { return !state.seats[s] })) throw new Error('对局座位信息缺失')
    state.playerCount = letters.length
    state.competition = m.competition_id ? { _id: m.competition_id, name: m.competition_name || '' } : null
    state.balances = m.balances || {}
    state.rounds = d.rounds || []
    state.readOnly = !d.can_edit
    state.isCreator = !!d.is_creator
    state.inRoom = !!d.in_room
    state.room = buildRoomView(d)
    // 重放开球者与顺位；手动顺位覆盖（order_override）：重放到锚点局后先套用覆盖顺位再继续推算
    var ov = m.order_override
    var ovOrder = ov && Array.isArray(ov.order) && ov.order.length === letters.length ? ov.order : null
    state.orderOverride = ovOrder ? ov : null
    var ovApplied = !ovOrder
    var breakerSeat = letters[0]
    var order = letters.slice()
    state.rounds.forEach(function (r) {
      if (r.score_type === 'fangui') return
      if (!ovApplied && (r.round_seq || 0) > (ov.round_seq || 0)) {
        order = ovOrder.slice()
        breakerSeat = order[0]
        ovApplied = true
      }
      var snap = r.seats_snapshot || m.seats
      var seatOf = function (id) { return letters.filter(function (s) { return snap[s] === id })[0] }
      var scorerSeat = seatOf(r.scorer)
      var shangjiaSeat = seatOf(r.shangjia)
      var xiajiaSeat = seatOf(r.xiajia)
      breakerSeat = ENGINE.nextBreakerSeat(r.score_type, scorerSeat, xiajiaSeat)
      order = ENGINE.nextOrder(order, r.score_type, scorerSeat, shangjiaSeat, xiajiaSeat)
    })
    state.breakerSeat = breakerSeat
    state.order = order
    state.scorerSeat = breakerSeat
    // 步骤 1 视图与座位区同步新人数（恢复/重同步后若返回步骤 1 保持一致）
    renderScoreTable()
    renderSeatSlots()
  }

  /* ---------- 多人房间 ---------- */
  // 房间视图：成员在线状态按 last_seen 推算（心跳 30s 一刷，45s 内视为在线）
  function buildRoomView(d) {
    if (!d || !d.room || !d.room.code) return null
    var now = Date.now()
    return {
      code: d.room.code,
      members: (d.room.members || []).map(function (x) {
        return { openid: x.openid, name: x.name || '球友', online: !!(x.last_seen && now - x.last_seen < 45000) }
      })
    }
  }

  function roomSig(view) {
    if (!view) return ''
    return view.code + '|' + view.members.map(function (m) { return m.openid + (m.online ? '1' : '0') }).join(',')
  }

  // 房间卡片 / 开房入口渲染（步骤 3）
  function renderRoom() {
    var wrap = el('room-area')
    if (!state.matchId || state.finished || state.step !== 3) {
      wrap.classList.add('ms-hidden')
      wrap.innerHTML = ''
      return
    }
    if (state.room) {
      wrap.classList.remove('ms-hidden')
      var ops = []
      if (state.isCreator) ops.push('<button class="btn btn-ghost btn-sm" id="room-close-btn" type="button">关闭房间</button>')
      if (state.inRoom && !state.isCreator) ops.push('<button class="btn btn-ghost btn-sm" id="room-leave-btn" type="button">退出房间</button>')
      wrap.innerHTML = '<div class="ms-card room-card">' +
        '<div class="room-head"><div class="room-left"><span class="room-title">多人房间</span>' +
        '<span class="room-code" id="room-code" title="点击复制房间码">' + esc(state.room.code) + '</span></div>' +
        '<div class="room-ops">' + ops.join('') + '</div></div>' +
        '<div class="room-members">' + state.room.members.map(function (m) {
          return '<span class="room-member"><i class="room-dot' + (m.online ? ' is-online' : '') + '"></i>' + esc(m.name) + '</span>'
        }).join('') + '</div>' +
        '<div class="form-tip">球友在小程序「对战记录」或网页记分页输码加入，全员记分实时同步（2 秒）</div>' +
        '</div>'
      el('room-code').addEventListener('click', function () {
        copyText(state.room.code, '房间码已复制')
      })
      var closeBtn = el('room-close-btn')
      if (closeBtn) closeBtn.addEventListener('click', closeRoom)
      var leaveBtn = el('room-leave-btn')
      if (leaveBtn) leaveBtn.addEventListener('click', leaveRoom)
    } else if (state.isCreator && !state.readOnly) {
      wrap.classList.remove('ms-hidden')
      wrap.innerHTML = '<div class="ms-card room-open" id="room-open-btn" role="button" tabindex="0">＋ 开启多人房间（生成 6 位房间码，球友输码免审批加入共同记分）</div>'
      el('room-open-btn').addEventListener('click', openRoom)
    } else {
      wrap.classList.add('ms-hidden')
      wrap.innerHTML = ''
    }
  }

  function copyText(text, tip) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { U.toast(tip, 'success') }, function () {
        fallbackCopy(text, tip)
      })
    } else {
      fallbackCopy(text, tip)
    }
  }
  function fallbackCopy(text, tip) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); U.toast(tip, 'success') } catch (e) { U.toast('复制失败，请手动复制', 'error') }
    document.body.removeChild(ta)
  }

  // 创建人开房
  async function openRoom() {
    if (state.room || state.submitting) return
    state.submitting = true
    try {
      var d = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'pursuitRoom', { action: 'open', match_id: state.matchId })
      state.room = { code: d.room.code, members: (d.room.members || []).map(function (x) { return { openid: x.openid, name: x.name || '球友', online: true } }) }
      state.inRoom = true
      state.isCreator = true
      state.submitting = false
      renderRoom()
      restartPoll()
      U.toast('房间已开启：' + d.room.code, 'success')
    } catch (e) {
      state.submitting = false
      U.toast('开房失败：' + (e.message || e), 'error')
    }
  }

  // 创建人关房：全员记分权限收回
  async function closeRoom() {
    if (!state.room || state.submitting) return
    var ok = await U.confirmBox('关闭后房间内成员将无法继续记分（已记数据保留），确定关闭？', '关闭房间')
    if (!ok) return
    state.submitting = true
    try {
      await window.AppAuth.callAuthed(AUTH_PURPOSE, 'pursuitRoom', { action: 'close', match_id: state.matchId })
      state.room = null
      state.inRoom = false
      state.submitting = false
      renderRoom()
      restartPoll()
      U.toast('房间已关闭', 'success')
    } catch (e) {
      state.submitting = false
      U.toast('关房失败：' + (e.message || e), 'error')
    }
  }

  // 成员退房：退房后若无编辑权限切只读
  async function leaveRoom() {
    if (!state.inRoom || state.submitting) return
    var ok = await U.confirmBox('退出后将不再参与本场记分，确定退出？', '退出房间')
    if (!ok) return
    state.submitting = true
    try {
      await window.AppAuth.callAuthed(AUTH_PURPOSE, 'pursuitRoom', { action: 'leave', match_id: state.matchId })
      state.inRoom = false
      state.submitting = false
      // 权限复查：仍是创建人/获准编辑者则保持编辑，否则切只读
      var auth = window.AppAuth.read(AUTH_PURPOSE)
      var d = await window.AppCloud.call('getOngoingMatch', { match_id: state.matchId, web_token: auth ? auth.token : undefined })
      state.readOnly = !d.can_edit
      state.room = buildRoomView(d)
      el('readonly-banner').classList.toggle('ms-hidden', !state.readOnly)
      renderRoom()
      restartPoll()
      renderScoring()
      U.toast(state.readOnly ? '已退出房间，页面切换为只读' : '已退出房间（你仍有编辑权限）', 'success')
    } catch (e) {
      state.submitting = false
      U.toast('退房失败：' + (e.message || e), 'error')
    }
  }

  // 输码加入（步骤 1 入口 / ?room= 直达）
  async function joinRoom(code) {
    code = String(code || '').trim()
    if (!/^\d{6}$/.test(code)) {
      U.toast('房间码为 6 位数字', 'error')
      return
    }
    if (state._joining) return
    state._joining = true
    try {
      var d = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'pursuitRoom', { action: 'join', code: code })
      U.toast('已加入房间', 'success')
      window.history.replaceState(null, '', './pursuit-score.html?match_id=' + d.match_id)
      restoreMatch(d.match_id)
    } catch (e) {
      U.toast('加入失败：' + (e.message || e), 'error')
    } finally {
      state._joining = false
    }
  }

  /* ---------- 轮询（多人房间 2 秒 / 常规 5 秒） ---------- */
  function startPoll() {
    stopPoll()
    if (!state.matchId || state.finished) return
    state._pollTimer = setInterval(pollRemote, state.room ? 2000 : 5000)
    if (state.inRoom) state._beatTimer = setInterval(beatRoom, 30000)
  }
  function stopPoll() {
    if (state._pollTimer) { clearInterval(state._pollTimer); state._pollTimer = null }
    if (state._beatTimer) { clearInterval(state._beatTimer); state._beatTimer = null }
  }
  function restartPoll() { startPoll() }

  async function beatRoom() {
    if (!state.matchId || !state.inRoom) return
    try {
      await window.AppAuth.callAuthed(AUTH_PURPOSE, 'pursuitRoom', { action: 'heartbeat', match_id: state.matchId })
    } catch (e) { /* 心跳失败静默 */ }
  }

  async function pollRemote() {
    if (state._polling || !state.matchId || state.finished) return
    state._polling = true
    try {
      var auth = window.AppAuth.read(AUTH_PURPOSE)
      var d = await window.AppCloud.call('getOngoingMatch', { match_id: state.matchId, web_token: auth ? auth.token : undefined })
      if (state._polling && state.submitting) return
      syncRoomState(d)
      maybeResyncRemote(d)
    } catch (e) {
      if (/已结束/.test((e && e.message) || '')) {
        stopPoll()
        U.toast('本场对局已结束', 'success')
        window.location.href = './match-detail.html?match_id=' + state.matchId
      }
    } finally {
      state._polling = false
    }
  }

  // 房间开/关/成员变化 + 只读↔编辑权限切换同步
  function syncRoomState(d) {
    var roomView = buildRoomView(d)
    var sig = roomSig(roomView)
    var hadRoom = !!state.room
    var wasReadOnly = state.readOnly
    // 权限切换（关房后成员被收回 / 小程序端创建人批准编辑申请）
    var nextReadOnly = !d.can_edit
    if (nextReadOnly !== state.readOnly) {
      state.readOnly = nextReadOnly
      el('readonly-banner').classList.toggle('ms-hidden', !state.readOnly)
      renderScoring()
      U.toast(state.readOnly ? '编辑权限已被收回，页面切换为只读' : '已获得编辑权限', state.readOnly ? 'error' : 'success')
    }
    if (!roomView && hadRoom) {
      state.room = null
      state.inRoom = false
      renderRoom()
      restartPoll()
      U.toast('房间已关闭', 'error')
      return
    }
    if (roomView && !hadRoom) {
      state.room = roomView
      state.inRoom = !!d.in_room
      renderRoom()
      restartPoll()
      U.toast('多人房间已开启', 'success')
      return
    }
    if (sig !== roomSig(state.room)) {
      state.room = roomView
      state.inRoom = !!d.in_room
      renderRoom()
    }
    if (wasReadOnly === state.readOnly) state.readOnly = !d.can_edit
  }

  /* ---------- 对局中调分（updatePursuitConfig） ----------
     面板打开时以当前 scoreConfig 快照为草稿（避免输入中途受轮询重同步干扰）；
     保存成功后本地 scoreConfig 立即更新，历史流水不回溯（云端只更新 matches.score_config） */
  var CFG_TYPES = ['kaiqiu_dajin', 'dajin', 'xiaojin', 'kaiqiu_hj9', 'pusheng', 'fangui']

  function openCfgEditor() {
    if (!state.matchId || state.finished || state.readOnly || state.cfgSaving) return
    var draft = {}
    CFG_TYPES.forEach(function (t) {
      var c = state.scoreConfig[t] || {}
      draft[t] = { scorer: c.scorer || 0, shangjia: c.shangjia || 0, xiajia: c.xiajia || 0, other: c.other || 0 }
    })
    state.cfgDraft = draft
    state.cfgEditing = true
    renderCfgPanel()
    el('cfg-mask').classList.remove('ms-hidden')
  }

  function closeCfgEditor() {
    if (state.cfgSaving) return
    state.cfgEditing = false
    state.cfgDraft = null
    el('cfg-mask').classList.add('ms-hidden')
  }

  function renderCfgPanel() {
    var wrap = el('cfg-table')
    var fields = visibleScoreFields()
    var cols = String(fields.length)
    var html = '<div class="st-row st-head" data-cols="' + cols + '"><span class="st-name">类型</span>' +
      fields.map(function (f) { return '<span class="st-col">' + f.label + '</span>' }).join('') +
      '</div>'
    CFG_TYPES.forEach(function (t) {
      var name = typeName(t)
      html += '<div class="st-row" data-cols="' + cols + '"><span class="st-name">' + name + '</span>' +
        fields.map(function (f) {
          return '<input class="st-input" type="number" data-key="' + t + '" data-field="' + f.field + '" value="' + (state.cfgDraft[t][f.field] || 0) + '">'
        }).join('') +
        '</div>'
    })
    wrap.innerHTML = html
    wrap.querySelectorAll('.st-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        if (!state.cfgDraft) return
        var k = inp.getAttribute('data-key')
        var f = inp.getAttribute('data-field')
        var n = Number(inp.value)
        state.cfgDraft[k][f] = Number.isFinite(n) ? n : 0
      })
    })
    el('cfg-tip').textContent = state.playerCount === 4
      ? '其余人列仅「开球大金 / 黄金九」生效（其余每人赔付）；多人房间成员与获准编辑者也可调整'
      : '多人房间成员与获准编辑者也可调整；保存后其他端经轮询同步'
  }

  async function onSaveCfg() {
    if (state.cfgSaving || !state.cfgDraft) return
    state.cfgSaving = true
    el('cfg-save').disabled = true
    try {
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'updatePursuitConfig', {
        match_id: state.matchId,
        score_config: state.cfgDraft
      })
      state.scoreConfig = (res && res.score_config) || state.cfgDraft
      state.cfgEditing = false
      state.cfgDraft = null
      state.cfgSaving = false
      el('cfg-save').disabled = false
      el('cfg-mask').classList.add('ms-hidden')
      renderScoring()
      U.toast('分值表已更新', 'success')
    } catch (e) {
      state.cfgSaving = false
      el('cfg-save').disabled = false
      U.toast('保存失败：' + (e.message || e), 'error')
    }
  }

  // 云端局数/顺位覆盖变化（他人记局/撤回/拖动顺位）→ 以云端为准重放，保留本局未提交的编辑态
  function maybeResyncRemote(d) {
    var m = d.match || {}
    var mains = (d.rounds || []).filter(function (r) { return r.score_type !== 'fangui' })
    var ovRemote = m.order_override ? (m.order_override.order || []).join('') : ''
    var ovLocal = state.orderOverride ? (state.orderOverride.order || []).join('') : ''
    // 云端分值表变化（他人调分）同样触发重同步
    var cfgChanged = JSON.stringify(m.score_config || {}) !== JSON.stringify(state.scoreConfig || {})
    if (!cfgChanged && mains.length === mainRoundCount() && (m.round_count || 0) === mainRoundCount() && ovRemote === ovLocal) return
    if (state.submitting) return
    // 调分面板打开期间不覆盖用户草稿（待保存/取消后下轮再同步）
    if (state.cfgEditing) return
    // 预览分数编辑期间不覆盖输入中的调整值
    if (state.deltaEditing) return
    // 保留本局编辑态
    var keep = {
      selType: state.selType, scorerSeat: state.scorerSeat, letBall: state.letBall,
      heibai: state.heibai, foulSeats: state.foulSeats, foulExpanded: state.foulExpanded
    }
    var fresh = mains.filter(function (r) { return (r.round_seq || 0) > mainRoundCount() })
    var undone = mains.length < mainRoundCount()
    applyMatchData(d)
    state.selType = keep.selType
    state.scorerSeat = keep.scorerSeat
    state.letBall = keep.letBall
    state.heibai = keep.heibai
    state.foulSeats = keep.foulSeats
    state.foulExpanded = keep.foulExpanded
    renderScoring()
    renderRoom()
    U.toast(fresh.length
      ? ((fresh[fresh.length - 1].recorded_by_name ? fresh[fresh.length - 1].recorded_by_name + ' ' : '') + '记录了第 ' + fresh[fresh.length - 1].round_seq + ' 局')
      : (undone ? '最新一局已被撤回' : (cfgChanged ? '本场分值表已调整' : (ovRemote !== ovLocal ? '顺位已调整' : '已同步最新对局'))), 'success')
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    el('gate-btn').addEventListener('click', function () {
      window.AppAuth.ensure(AUTH_PURPOSE).then(afterAuth).catch(function () {})
    })

    // 步骤 1：人数 / 球数 / 初始分 / 目标局数
    document.querySelectorAll('#player-chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var n = Number(chip.getAttribute('data-n'))
        if (n === state.playerCount) return
        document.querySelectorAll('#player-chips .chip').forEach(function (c) { c.classList.remove('active') })
        chip.classList.add('active')
        onPlayerCount(n)
      })
    })
    document.querySelectorAll('#ball-chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.ballCount = Number(chip.getAttribute('data-n'))
        document.querySelectorAll('#ball-chips .chip').forEach(function (c) { c.classList.remove('active') })
        chip.classList.add('active')
        renderRuleMeta()
      })
    })
    el('init-score').addEventListener('input', function () {
      var n = Number(el('init-score').value)
      state.initScore = Number.isFinite(n) && n > 0 ? Math.round(n) : 100
    })
    el('target-rounds').addEventListener('input', function () {
      var n = Number(el('target-rounds').value)
      state.targetRounds = Number.isInteger(n) && n > 0 ? Math.min(n, 99) : 0
    })
    el('to-step2').addEventListener('click', function () { goStep(2) })
    el('back-step1').addEventListener('click', function () { goStep(1) })

    // 步骤 1：输码加入多人房间（Enter 或按钮触发）
    el('join-room-btn').addEventListener('click', function () { joinRoom(el('join-code').value) })
    el('join-code').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') joinRoom(el('join-code').value)
    })

    // 步骤 2：座位 + 关联比赛 + 随机排座
    ;['a', 'b', 'c', 'd'].forEach(function (s) {
      el('slot-' + s).addEventListener('click', function () {
        // 隐藏座位（人数不足时）不可点
        if (seatKeys().indexOf(s.toUpperCase()) < 0) return
        openSeatPicker(s.toUpperCase())
      })
    })
    el('shuffle-btn').addEventListener('click', onShuffleSeats)
    el('comp-select').addEventListener('change', function () {
      var sel = el('comp-select')
      var id = sel.value
      var comp = id ? competitions.filter(function (c) { return c._id === id })[0] : null
      state.competition = comp ? { _id: comp._id, name: comp.name } : null
    })
    el('start-btn').addEventListener('click', startMatch)

    // 步骤 3：得分状态开关（互斥）
    el('toggle-letball').addEventListener('click', function () {
      if (state.readOnly) return
      state.letBall = !state.letBall
      if (state.letBall) state.heibai = false
      renderScoring()
    })
    el('toggle-heibai').addEventListener('click', function () {
      if (state.readOnly) return
      state.heibai = !state.heibai
      if (state.heibai) state.letBall = false
      renderScoring()
    })
    el('foul-btn').addEventListener('click', function () {
      if (state.readOnly) return
      if (state.letBall && state.scorerSeat) {
        addFoul(state.scorerSeat)
        return
      }
      state.foulExpanded = !state.foulExpanded
      renderFouls()
    })
    el('record-btn').addEventListener('click', recordRound)
    el('undo-btn').addEventListener('click', undoRound)
    // 预览分数手动调整：切换编辑态（值在输入时实时生效，「完成」仅收起输入框）
    el('pv-edit-btn').addEventListener('click', function () {
      if (state.readOnly || state.submitting || state.finished || !state._previewDeltas) return
      state.deltaEditing = !state.deltaEditing
      renderPreview()
    })
    el('finish-btn').addEventListener('click', goSettle)

    // 对局中调分面板
    el('cfg-entry').addEventListener('click', openCfgEditor)
    el('cfg-cancel').addEventListener('click', closeCfgEditor)
    el('cfg-save').addEventListener('click', onSaveCfg)
    el('cfg-mask').addEventListener('click', function (e) { if (e.target === el('cfg-mask')) closeCfgEditor() })

    // 步骤 4
    el('back-to-record').addEventListener('click', function () { goStep(3) })
    el('submit-btn').addEventListener('click', submitPoints)
  }

  /* ---------- 启动 ---------- */
  function afterAuth() {
    enterApp()
    var qs = new URLSearchParams(window.location.search)
    var matchId = qs.get('match_id')
    var roomCode = qs.get('room')
    Promise.all([loadMembers(), loadCompetitions()]).then(function () {
      if (matchId) restoreMatch(matchId)
      else if (roomCode) joinRoom(roomCode)
    })
  }

  bindEvents()
  renderScoreTable()
  renderRuleMeta()
  U.fixNav('')
  if (window.AppAuth.read(AUTH_PURPOSE)) {
    afterAuth()
  } else {
    gate()
    window.AppCloud.ready().catch(function () {})
  }
  window.AppUI.mountCloudBar && window.AppUI.mountCloudBar()
})()
