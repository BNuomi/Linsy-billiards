/*
 * 练球进球数记录页（手表优先，手机/桌面同可用）
 * - token 即凭证：URL ?token= 读取后存 localStorage，后续免参数直接打开
 * - 乐观更新：点击立即更新本地数字，云端返回快照后校正；失败回滚
 * - 撤销防误触：第一次点击进入 3s 确认态（按钮变红「确认撤销？」）
 * - 时钟式连进盘：长按主按钮（≥350ms）在按钮周围按表盘 12 点位弹出 1~12 数字键，
 *   拖动到数字松手即一次记 N 球；不移动直接松手仍为单击 +1
 */
;(function () {
  var TOKEN_KEY = 'practice_token'
  var UNDO_CONFIRM_MS = 3000
  var LONG_PRESS_MS = 350       // 长按开盘阈值
  var DIAL_KEYS = 12            // 表盘 12 个键位（1~12）
  var HIT_PAD = 10              // 命中半径补偿（px，手指遮挡下更易选中）

  function el(id) { return document.getElementById(id) }

  // ---------- 设备判定（决定 source 标记）----------
  // 1. URL 显式 watch=1（短信/收藏的链接可控，最可靠）
  // 2. 屏幕极小 + 触屏（手表视口 ≤ 230 CSS px）
  // 3. UA 含 Watch 字样（部分第三方手表浏览器）
  function detectSource() {
    var q = new URLSearchParams(window.location.search)
    if (q.get('watch') === '1') return 'watch'
    var small = Math.min(window.screen.width, window.screen.height) <= 230
    var touch = 'ontouchstart' in window
    if ((small && touch) || /Watch/i.test(navigator.userAgent || '')) return 'watch'
    return touch ? 'phone' : 'web'
  }

  function readToken() {
    var q = new URLSearchParams(window.location.search)
    var t = (q.get('token') || '').trim()
    if (/^[0-9a-f]{48}$/.test(t)) {
      try { localStorage.setItem(TOKEN_KEY, t) } catch (_) { /* noop */ }
      return t
    }
    try { return localStorage.getItem(TOKEN_KEY) || '' } catch (_) { return '' }
  }

  var state = {
    token: '',
    source: detectSource(),
    today: 0,
    pending: 0, // 飞行中的记分请求数（禁用按钮防连点风暴）
    undoArmed: false,
    undoTimer: null
  }

  // ---------- Toast ----------
  var toastTimer = null
  function toast(msg, isError) {
    var t = el('toast')
    t.textContent = msg
    t.className = 'toast is-show' + (isError ? ' is-error' : '')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { t.className = 'toast' }, 2400)
  }

  // ---------- 渲染 ----------
  function render(snap) {
    if (!snap) return
    state.today = snap.today
    el('today-num').textContent = snap.today
    el('season-num').textContent = snap.season
    el('total-num').textContent = snap.total
    if (snap.name) el('member-name').textContent = snap.name
  }

  function setBusy(busy) {
    state.pending = Math.max(0, state.pending + (busy ? 1 : -1))
    var disabled = state.pending > 0
    el('btn-add-1').disabled = disabled
    document.querySelectorAll('.btn-add-sub').forEach(function (b) { b.disabled = disabled })
    el('btn-undo').disabled = disabled
  }

  // ---------- 记分（乐观更新 + 云端校正）----------
  async function add(goals) {
    if (state.pending > 0) return
    setBusy(true)
    // 本地先更新（手表网络经蓝牙中继偏慢，即时反馈避免重复点击）
    el('today-num').textContent = state.today + goals
    try {
      var snap = await window.AppCloud.call('recordPractice', {
        action: 'add', token: state.token, goals: goals, source: state.source
      })
      render(snap)
      toast((goals >= 2 ? '连进 ' : '+') + goals + ' 已记录')
    } catch (e) {
      el('today-num').textContent = state.today // 回滚
      toast(e.message || '记录失败，请重试', true)
    } finally {
      setBusy(false)
    }
  }

  // ---------- 撤销（二次确认：图标态 ↺ → 确认态「确认?」变红，3s 超时恢复）----------
  function disarmUndo() {
    state.undoArmed = false
    var btn = el('btn-undo')
    btn.textContent = '↺'
    btn.classList.remove('is-confirm')
    if (state.undoTimer) { clearTimeout(state.undoTimer); state.undoTimer = null }
  }

  async function onUndoTap() {
    if (state.pending > 0) return
    if (!state.undoArmed) {
      state.undoArmed = true
      var btn = el('btn-undo')
      btn.textContent = '确认?'
      btn.classList.add('is-confirm')
      state.undoTimer = setTimeout(disarmUndo, UNDO_CONFIRM_MS)
      return
    }
    disarmUndo()
    setBusy(true)
    try {
      var snap = await window.AppCloud.call('recordPractice', { action: 'undo', token: state.token })
      render(snap)
      toast(snap.undone ? '已撤销 ' + (snap.undone_goals || 0) + ' 球' : '没有可撤销的记录')
    } catch (e) {
      toast(e.message || '撤销失败，请重试', true)
    } finally {
      setBusy(false)
    }
  }

  /* =====================================================================
   * 时钟式连进数字盘（长按主按钮）
   * 手势状态机：idle → waiting(按下计时) → open(盘已开，拖动选数) → 提交/取消
   * 键位按真实表盘：12 在正上方，顺时针 1..12，角度 = n*30° - 90°
   * ===================================================================== */
  var dial = {
    root: null,
    mask: null,
    hubNum: null,
    keys: [],          // [{n, x, y, r, node}]（x/y 为相对盘心坐标）
    open: false,
    timer: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
    active: 0,         // 当前高亮数字（0=无）
    centerX: 0,
    centerY: 0,
    half: 124,         // 盘半径（尺寸/2），layoutDial 时按视口写入
    keyR: 26           // 键半径
  }

  function haptic(style) {
    // 手表/手机 WebKit 支持振动时给轻反馈；不支持时静默
    try {
      if (navigator.vibrate) navigator.vibrate(style === 'success' ? 18 : 8)
    } catch (_) { /* noop */ }
  }

  // 按视口动态决定盘与键的尺寸：保证整盘（含键位）在任意手表宽度内完整可见
  // 规则：盘体 = min(视口宽, 视口高) - 两侧安全边距(8)，钳制在 168~248；键位随盘等比（约盘体 1/5）
  function dialMetrics() {
    var edge = Math.min(window.innerWidth, window.innerHeight)
    var size = Math.round(Math.max(168, Math.min(248, edge - 8)))
    var key = Math.round(Math.max(32, Math.min(52, size / 5)))
    return { size: size, key: key, radius: size / 2 - key / 2 - 4 }
  }

  function buildDial() {
    dial.root = el('dial')
    dial.mask = el('dial-mask')
    dial.hubNum = el('dial-hub-num')

    // 一次性创建 12 个键位节点；位置/尺寸在每次开盘时由 layoutDial 重算（适配旋转/分屏）
    for (var n = 1; n <= DIAL_KEYS; n++) {
      var node = document.createElement('div')
      node.className = 'dial__key' + (n >= 2 ? ' is-streak' : '')
      node.textContent = String(n)
      dial.root.appendChild(node)
      dial.keys.push({ n: n, x: 0, y: 0, r: 26, node: node })
    }
    // 遮罩仅作视觉层：指针已被主按钮 setPointerCapture 捕获，松手统一由 onMainUp 收口
  }

  // 每次开盘按当前视口重算盘尺寸与 12 键坐标（12 点位正上方起，顺时针 1..12）
  function layoutDial() {
    var m = dialMetrics()
    dial.half = m.size / 2
    dial.keyR = m.key / 2
    dial.root.style.setProperty('--dial-size', m.size + 'px')
    dial.root.style.setProperty('--key-size', m.key + 'px')
    for (var i = 0; i < dial.keys.length; i++) {
      var k = dial.keys[i]
      var angle = (k.n * 30 - 90) * Math.PI / 180
      k.x = m.radius * Math.cos(angle)
      k.y = m.radius * Math.sin(angle)
      k.r = dial.keyR
      k.node.style.left = (dial.half + k.x) + 'px'
      k.node.style.top = (dial.half + k.y) + 'px'
    }
  }

  // 盘心固定在视口几何中心（不再跟随中下部的 +1 按钮），整盘四周留白对称、绝不溢出；
  // 垂直方向略下移，为手表 mini Safari 顶部「关闭」浮层让出顶部键位空间
  function positionDial() {
    var m = dialMetrics()
    var cx = window.innerWidth / 2
    var cy = window.innerHeight / 2 + Math.min(14, window.innerHeight * 0.04)
    // 双保险：即便极端视口也钳制在可视区内
    var half = m.size / 2
    cx = Math.max(half + 4, Math.min(window.innerWidth - half - 4, cx))
    cy = Math.max(half + 4, Math.min(window.innerHeight - half - 4, cy))
    dial.centerX = cx
    dial.centerY = cy
    dial.root.style.left = cx + 'px'
    dial.root.style.top = cy + 'px'
  }

  function openDial() {
    layoutDial()
    positionDial()
    dial.open = true
    dial.active = 0
    dial.hubNum.textContent = '1'
    dial.root.classList.add('is-show')
    dial.mask.classList.add('is-show')
    dial.root.setAttribute('aria-hidden', 'false')
    haptic('open')
  }

  function closeDialogSilent() {
    dial.root.classList.remove('is-show')
    dial.mask.classList.remove('is-show')
    dial.root.setAttribute('aria-hidden', 'true')
    dial.keys.forEach(function (k) { k.node.classList.remove('is-active') })
    dial.open = false
    dial.active = 0
    if (dial.timer) { clearTimeout(dial.timer); dial.timer = null }
  }

  // 松手收口：命中数字 → 连进 N；未命中（中心/盘外）→ 回退单击 +1
  function closeDial(pick) {
    var wasOpen = dial.open
    closeDialogSilent()
    if (!wasOpen) return
    if (pick >= 1) {
      haptic('success')
      add(pick)
    } else {
      add(1)
    }
  }

  // 指针坐标 → 命中键（键位坐标以盘心为原点；取距离最近且在命中半径内的键）
  function hitKey(x, y) {
    var dx = x - dial.centerX
    var dy = y - dial.centerY
    var best = null
    var bestDist = Infinity
    for (var i = 0; i < dial.keys.length; i++) {
      var k = dial.keys[i]
      var ddx = dx - k.x
      var ddy = dy - k.y
      var dist = Math.sqrt(ddx * ddx + ddy * ddy)
      if (dist <= k.r + HIT_PAD && dist < bestDist) {
        best = k
        bestDist = dist
      }
    }
    return best
  }

  function setActive(k) {
    var n = k ? k.n : 0
    if (n === dial.active) return
    dial.keys.forEach(function (item) { item.node.classList.toggle('is-active', !!k && item.n === n) })
    dial.active = n
    if (n) {
      dial.hubNum.textContent = String(n)
      haptic('tick')
    }
  }

  function onMainDown(e) {
    if (state.pending > 0) return
    // 仅主键（鼠标左键/触摸/笔）响应，避免右键干扰
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    dial.pointerId = e.pointerId
    dial.startX = e.clientX
    dial.startY = e.clientY
    dial.moved = false
    el('btn-add-1').setPointerCapture && el('btn-add-1').setPointerCapture(e.pointerId)
    // 长按计时：到点开盘；期间松手则走单击
    dial.timer = setTimeout(function () {
      dial.timer = null
      openDial()
    }, LONG_PRESS_MS)
  }

  function onMainMove(e) {
    if (dial.pointerId !== e.pointerId) return
    if (Math.abs(e.clientX - dial.startX) + Math.abs(e.clientY - dial.startY) > 8) dial.moved = true
    if (!dial.open) return
    e.preventDefault()
    setActive(hitKey(e.clientX, e.clientY))
  }

  function onMainUp(e) {
    if (dial.pointerId !== e.pointerId) return
    dial.pointerId = null
    if (dial.open) {
      // 盘已开：命中数字提交连进 N；未命中（停在中心/划到盘外）回退 +1
      closeDial(dial.active)
    } else {
      // 未到长按时长松手：清计时器，单击 +1
      if (dial.timer) { clearTimeout(dial.timer); dial.timer = null }
      add(1)
    }
  }

  function onMainCancel(e) {
    if (dial.pointerId !== (e && e.pointerId)) return
    dial.pointerId = null
    closeDialogSilent() // 系统打断（来电/手势）：一律不记分
  }

  // 窗口尺寸变化（旋转/分屏）时，若盘正开则重算尺寸、键位与中心
  window.addEventListener('resize', function () {
    if (dial.open) {
      layoutDial()
      positionDial()
    }
  })

  // ---------- 初始化 ----------
  async function boot() {
    state.token = readToken()
    if (!state.token) {
      el('loading').classList.add('is-hide')
      el('guide').classList.add('is-show')
      return
    }
    try {
      var snap = await window.AppCloud.call('recordPractice', { action: 'state', token: state.token })
      render(snap)
    } catch (e) {
      // token 失效（被吊销/重新生成）：清除本地缓存并展示引导
      if (e && e.code === 403) {
        try { localStorage.removeItem(TOKEN_KEY) } catch (_) { /* noop */ }
        el('guide').classList.add('is-show')
        el('main').style.display = 'none'
      } else {
        toast(e.message || '加载失败，下拉刷新重试', true)
      }
    } finally {
      el('loading').classList.add('is-hide')
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildDial()
    var mainBtn = el('btn-add-1')
    // 主按钮：Pointer Events 统一触摸/鼠标/笔；单击 +1、长按开盘拖拽连进
    mainBtn.addEventListener('pointerdown', onMainDown)
    mainBtn.addEventListener('pointermove', onMainMove)
    mainBtn.addEventListener('pointerup', onMainUp)
    mainBtn.addEventListener('pointercancel', onMainCancel)
    // 屏蔽长按系统菜单/双击缩放，保证手势不被浏览器打断
    mainBtn.addEventListener('contextmenu', function (e) { e.preventDefault() })
    document.querySelectorAll('.btn-add-sub').forEach(function (b) {
      b.addEventListener('click', function () { add(Number(b.getAttribute('data-goals')) || 1) })
    })
    el('btn-undo').addEventListener('click', onUndoTap)
    boot()
  })
})()
