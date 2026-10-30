/*
 * 网页端斯诺克记分页：对齐小程序 snooker-match 流程
 * - mode 1 简易翻局（history:[{w}]）；mode 2 单局比分（球值 1-7 加分 / 犯规罚 4-7 分给对手）
 * - 同一云函数 saveC8Progress / finishMatch，game_type='snooker'，red_count 15|6
 * - match_ops 扫码授权，web_token 随调用；?match_id= 恢复进行中对局（无编辑权只读）
 */
;(function () {
  var U = window.AppUI
  var AUTH_PURPOSE = 'match_ops'
  var SYNC_DEBOUNCE = 800

  var state = {
    mode: 1,
    redCount: 15,
    bestOf: 5,
    playerA: null,
    playerB: null,
    competition: null,
    matchId: null,
    readOnly: false,
    // mode1
    scoreA: 0,
    scoreB: 0,
    history: [],
    // mode2
    snFrames: [],
    snCur: { sa: 0, sb: 0, active: 'A', events: [] },
    submitting: false
  }
  var members = []
  var syncTimer = null
  var syncFailToastAt = 0

  function el(id) { return document.getElementById(id) }
  function esc(s) { return U.escapeHtml(s) }
  function nameOf(side) {
    var p = side === 'A' ? state.playerA : state.playerB
    return p ? (p.name || side) : side
  }

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
    } catch (e) { /* 不阻断 */ }
  }

  /* ---------- 选手选择弹层（与中八页同款） ---------- */
  function openPicker(onDone) {
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

  function paintSlot(side) {
    var slot = el(side === 'A' ? 'slot-a' : 'slot-b')
    var p = side === 'A' ? state.playerA : state.playerB
    slot.classList.toggle('empty', !p)
    slot.querySelector('.ps-name').textContent = p ? p.name : '点击选择'
    el('start-btn').disabled = !(state.playerA && state.playerB)
  }

  function compPayload() {
    return {
      competition_id: state.competition ? state.competition._id : null,
      competition_name: state.competition ? state.competition.name : null,
      fixture_id: null,
      stage: null
    }
  }

  /* ---------- 比分/同步 ---------- */
  function displayScore() {
    if (state.mode === 2) {
      var a = state.snFrames.filter(function (f) { return f.w === 'A' }).length
      return { a: a, b: state.snFrames.length - a }
    }
    return { a: state.scoreA, b: state.scoreB }
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
    var frameScore = {}
    frameScore[state.playerA._id] = ds.a
    frameScore[state.playerB._id] = ds.b
    try {
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'saveC8Progress', {
        game_type: 'snooker',
        match_id: state.matchId || null,
        players: [state.playerA._id, state.playerB._id],
        mode: state.mode,
        red_count: state.redCount,
        best_of: state.bestOf,
        frame_score: frameScore,
        progress: {
          scoreA: state.scoreA,
          scoreB: state.scoreB,
          history: state.history,
          snFrames: state.snFrames,
          snCur: state.snCur
        },
        ...compPayload()
      })
      if (!state.matchId && res && res.match_id) state.matchId = res.match_id
    } catch (e) {
      console.warn('[snooker-score] 进度同步失败', e)
      var now = Date.now()
      if (now - syncFailToastAt > 5000) {
        syncFailToastAt = now
        U.toast('比分同步失败：' + ((e && e.message) || '网络异常'), 'error')
      }
    }
  }

  /* ---------- 渲染 ---------- */
  function renderHead() {
    var ds = displayScore()
    el('sh-name-a').textContent = nameOf('A')
    el('sh-name-b').textContent = nameOf('B')
    el('sh-score-a').textContent = ds.a
    el('sh-score-b').textContent = ds.b
    el('sh-meta').textContent = '抢 ' + state.bestOf + ' · ' + state.redCount + ' 红' +
      (state.competition ? ' · ' + state.competition.name : '')
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
  }

  function renderM1() {
    el('flip-name-a').textContent = nameOf('A')
    el('flip-name-b').textContent = nameOf('B')
    el('flip-score-a').textContent = state.scoreA
    el('flip-score-b').textContent = state.scoreB
  }

  var BALL_DOT = { 1: '#e53935', 2: '#f5c518', 3: '#43a047', 4: '#8d3028', 5: '#2962ff', 6: '#f48fb1', 7: '#212121' }

  function renderM2() {
    var cur = state.snCur
    el('sn-frame-label').textContent = '第 ' + (state.snFrames.length + 1) + ' 局 · 点击选手卡切换加分方'
    el('sn-name-a').textContent = nameOf('A')
    el('sn-name-b').textContent = nameOf('B')
    el('sn-pts-a').textContent = cur.sa
    el('sn-pts-b').textContent = cur.sb
    el('sn-side-a').classList.toggle('active', cur.active === 'A')
    el('sn-side-b').classList.toggle('active', cur.active === 'B')
    var box = el('sn-events')
    if (!cur.events.length) {
      box.innerHTML = '<div class="eventlog-empty">本局暂无记录</div>'
    } else {
      box.innerHTML = cur.events.map(function (ev) {
        if (ev.type === 'foul') {
          return '<span class="ev-row"><span class="ev-chip"><b>' + esc(nameOf(ev.side)) + '</b>' +
            '<span class="ev-foul">犯 +' + ev.pts + '</span></span></span>'
        }
        return '<span class="ev-row"><span class="ev-chip"><span class="ev-dot" style="background:' +
          (BALL_DOT[ev.pts] || '#999') + ';"></span><b>' + esc(nameOf(ev.side)) + '</b>+' + ev.pts + '</span></span>'
      }).join('')
    }
    var fr = el('sn-frames')
    fr.innerHTML = state.snFrames.map(function (f, i) {
      return '<div class="fr">第 ' + (i + 1) + ' 局：' + esc(nameOf(f.w)) + ' 胜（' + f.sa + ' : ' + f.sb + '）</div>'
    }).join('')
  }

  function renderAll() {
    renderHead()
    renderPanels()
    if (state.mode === 1) renderM1()
    if (state.mode === 2) renderM2()
  }

  function afterChange(immediate) {
    renderAll()
    queueSync(immediate)
  }

  /* ---------- 模式一 ---------- */
  function addWin(side) {
    if (state.readOnly) return
    if (side === 'A') state.scoreA++
    else state.scoreB++
    state.history.push({ w: side })
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
  function snPot(pts) {
    if (state.readOnly) return
    var cur = state.snCur
    var ev = { side: cur.active, pts: pts, type: 'pot', prev: cur.active }
    if (cur.active === 'A') cur.sa += pts
    else cur.sb += pts
    cur.events.push(ev)
    afterChange(false)
  }

  function snFoul(pts) {
    if (state.readOnly) return
    var cur = state.snCur
    var shooter = cur.active
    var opponent = shooter === 'A' ? 'B' : 'A'
    var ev = { side: shooter, pts: pts, type: 'foul', prev: shooter }
    if (opponent === 'A') cur.sa += pts
    else cur.sb += pts
    cur.events.push(ev)
    cur.active = opponent // 犯规后击球权交对手
    afterChange(false)
    U.toast(nameOf(shooter) + ' 犯规，' + nameOf(opponent) + ' +' + pts)
  }

  function snUndo() {
    if (state.readOnly) return false
    var cur = state.snCur
    if (cur.events.length) {
      var ev = cur.events.pop()
      if (ev.type === 'pot') {
        if (ev.side === 'A') cur.sa -= ev.pts
        else cur.sb -= ev.pts
      } else {
        var opponent = ev.side === 'A' ? 'B' : 'A'
        if (opponent === 'A') cur.sa -= ev.pts
        else cur.sb -= ev.pts
      }
      cur.active = ev.prev || ev.side
      afterChange(false)
      return true
    }
    if (!state.snFrames.length) return false
    var last = state.snFrames.pop()
    state.snCur = {
      sa: last.sa,
      sb: last.sb,
      active: state.snFrames.length % 2 === 0 ? 'A' : 'B',
      events: last.events || []
    }
    afterChange(true)
    return true
  }

  function snEndFrame() {
    if (state.readOnly) return
    var cur = state.snCur
    if (!cur.events.length) { U.toast('本局暂无记录', 'error'); return }
    if (cur.sa === cur.sb) { U.toast('比分持平，请继续加分或重摆', 'error'); return }
    var w = cur.sa > cur.sb ? 'A' : 'B'
    state.snFrames.push({ sa: cur.sa, sb: cur.sb, w: w, events: cur.events })
    state.snCur = { sa: 0, sb: 0, active: state.snFrames.length % 2 === 0 ? 'A' : 'B', events: [] }
    afterChange(true)
  }

  /* ---------- 结束对局 ---------- */
  async function finish() {
    if (state.readOnly || state.submitting) return
    if (state.mode === 2 && state.snCur.events.length) {
      U.toast('本局未结束，请先结束本局', 'error')
      return
    }
    var empty = state.mode === 2 ? !state.snFrames.length : !state.history.length
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
      if (state.mode === 2) {
        frames = state.snFrames.map(function (f, i) {
          var winnerId = f.w === 'A' ? state.playerA._id : state.playerB._id
          var hi = Math.max(f.sa, f.sb)
          var lo = Math.min(f.sa, f.sb)
          return {
            seq: i + 1,
            winner: winnerId,
            score_winner: hi,
            score_loser: lo,
            events: (f.events || []).map(function (ev) {
              return {
                player: ev.side === 'A' ? state.playerA._id : state.playerB._id,
                pts: ev.pts,
                type: ev.type
              }
            })
          }
        })
      } else {
        frames = state.history.map(function (h, i) {
          return { seq: i + 1, winner: h.w === 'A' ? state.playerA._id : state.playerB._id }
        })
      }
      var res = await window.AppAuth.callAuthed(AUTH_PURPOSE, 'finishMatch', Object.assign({
        game_type: 'snooker',
        match_id: state.matchId || null,
        mode: state.mode,
        red_count: state.redCount,
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
      state.redCount = m.red_count === 6 ? 6 : 15
      state.competition = m.competition_id ? { _id: m.competition_id, name: m.competition_name || '' } : null
      state.readOnly = !d.can_edit
      var p = m.progress || {}
      state.scoreA = p.scoreA || 0
      state.scoreB = p.scoreB || 0
      state.history = Array.isArray(p.history) ? p.history : []
      state.snFrames = Array.isArray(p.snFrames) ? p.snFrames : []
      state.snCur = p.snCur && Array.isArray(p.snCur.events)
        ? p.snCur
        : { sa: 0, sb: 0, active: state.snFrames.length % 2 === 0 ? 'A' : 'B', events: [] }
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
      window.AppAuth.ensure(AUTH_PURPOSE).then(afterAuth).catch(function () {})
    })
    el('slot-a').addEventListener('click', function () { openPicker(function (p) { state.playerA = p; paintSlot('A') }) })
    el('slot-b').addEventListener('click', function () { openPicker(function (p) { state.playerB = p; paintSlot('B') }) })
    document.querySelectorAll('#mode-cards .mode-card').forEach(function (card) {
      card.addEventListener('click', function () {
        state.mode = Number(card.getAttribute('data-mode'))
        document.querySelectorAll('#mode-cards .mode-card').forEach(function (c) { c.classList.remove('active') })
        card.classList.add('active')
      })
    })
    document.querySelectorAll('#red-chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.redCount = Number(chip.getAttribute('data-red'))
        document.querySelectorAll('#red-chips .chip').forEach(function (c) { c.classList.remove('active') })
        chip.classList.add('active')
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
    })
    el('start-btn').addEventListener('click', function () {
      if (!(state.playerA && state.playerB)) return
      el('setup').classList.add('ms-hidden')
      el('scoring').classList.remove('ms-hidden')
      renderAll()
      queueSync(true)
    })

    el('flip-a').addEventListener('click', function () { addWin('A') })
    el('flip-b').addEventListener('click', function () { addWin('B') })

    el('sn-side-a').addEventListener('click', function () {
      if (state.readOnly) return
      state.snCur.active = 'A'
      renderM2()
    })
    el('sn-side-b').addEventListener('click', function () {
      if (state.readOnly) return
      state.snCur.active = 'B'
      renderM2()
    })
    document.querySelectorAll('#ball-btns .ball-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { snPot(Number(btn.getAttribute('data-pts'))) })
    })
    document.querySelectorAll('.foul-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { snFoul(Number(btn.getAttribute('data-pts'))) })
    })
    el('sn-undo').addEventListener('click', snUndo)
    el('sn-endframe').addEventListener('click', snEndFrame)

    el('undo-btn').addEventListener('click', function () {
      if (state.readOnly) return
      if (state.mode === 1) { if (undoM1()) afterChange(true) }
      else snUndo()
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
    window.AppCloud.ready().catch(function () {})
  }
  window.AppUI.mountCloudBar && window.AppUI.mountCloudBar()
})()
