/*
 * 练球进球数记录页（手表优先，手机/桌面同可用）
 * - token 即凭证：URL ?token= 读取后存 localStorage，后续免参数直接打开
 * - 乐观更新：点击立即更新本地数字，云端返回快照后校正；失败回滚
 * - 撤销防误触：第一次点击进入 3s 确认态（按钮变红「确认撤销？」）
 */
;(function () {
  var TOKEN_KEY = 'practice_token'
  var UNDO_CONFIRM_MS = 3000

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
      toast('+' + goals + ' 已记录')
    } catch (e) {
      el('today-num').textContent = state.today // 回滚
      toast(e.message || '记录失败，请重试', true)
    } finally {
      setBusy(false)
    }
  }

  // ---------- 撤销（二次确认）----------
  function disarmUndo() {
    state.undoArmed = false
    var btn = el('btn-undo')
    btn.textContent = '撤销上一次'
    btn.classList.remove('is-confirm')
    if (state.undoTimer) { clearTimeout(state.undoTimer); state.undoTimer = null }
  }

  async function onUndoTap() {
    if (state.pending > 0) return
    if (!state.undoArmed) {
      state.undoArmed = true
      var btn = el('btn-undo')
      btn.textContent = '确认撤销？'
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
    el('btn-add-1').addEventListener('click', function () { add(1) })
    document.querySelectorAll('.btn-add-sub').forEach(function (b) {
      b.addEventListener('click', function () { add(Number(b.getAttribute('data-goals')) || 1) })
    })
    el('btn-undo').addEventListener('click', onUndoTap)
    boot()
  })
})()
