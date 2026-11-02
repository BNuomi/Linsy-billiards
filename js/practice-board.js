/*
 * 练球球形图画板（纯前端，无云端依赖）
 * - 竖向球桌画布（背景图旋转 90° 绘制）
 * - 侧栏球子拖放摆放 / 画布内拖动 / 双击删除
 * - 线条工具：实线 / 虚线 / 箭头，颜色可选
 * - 撤销 / 清空 / 保存截图；截图列举在侧栏（localStorage 持久化）
 */
window.PracticeBoard = (function () {
  var LOGICAL_W = 720
  var LOGICAL_H = 1290 // 与裁剪后球桌区域（旋转）同比例
  /* 背景图球桌裁剪区域（原图 2848×1600 中量取），去掉四周大片绿边 */
  var SRC = { x: 360, y: 265, w: 2130, h: 1190 }
  var BALL_R = 13
  var LINE_W = 4
  var SHOT_KEY = 'practice-board-shots-v1'
  var STATE_KEY = 'practice-board-state-v1'
  var MAX_SHOTS = 30

  /* 中八球配色：0=母球，1-7 全色，8 黑，9-15 花色（同 1-7 色） */
  var BALL_DEFS = [
    { num: 0, color: '#f6f6f0' },
    { num: 1, color: '#f7c948' }, { num: 2, color: '#2563eb' },
    { num: 3, color: '#dc2626' }, { num: 4, color: '#7c3aed' },
    { num: 5, color: '#f97316' }, { num: 6, color: '#16a34a' },
    { num: 7, color: '#7c4a2d' }, { num: 8, color: '#171717' },
    { num: 9, color: '#f7c948' }, { num: 10, color: '#2563eb' },
    { num: 11, color: '#dc2626' }, { num: 12, color: '#7c3aed' },
    { num: 13, color: '#f97316' }, { num: 14, color: '#16a34a' },
    { num: 15, color: '#7c4a2d' }
  ]
  var LINE_COLORS = ['#ffffff', '#fde047', '#f87171', '#60a5fa']
  var TOOL_LINE_TYPES = { line: 1, dash: 1, arrow: 1 }

  var canvas, ctx, bgImg = null
  var state = { balls: [], lines: [], tool: 'move', lineColor: LINE_COLORS[0], selected: null }
  var undoStack = []
  var drag = null // {kind:'ball',id,dx,dy,moved} | {kind:'line',x1,y1,x2,y2}
  var placing = null // {num, ghost, moved}
  var idSeq = 1

  function toast(msg, type) {
    if (window.AppUI && window.AppUI.toast) window.AppUI.toast(msg, type)
  }

  /* ── 持久化 ── */
  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ balls: state.balls, lines: state.lines }))
    } catch (e) {}
  }
  function loadState() {
    try {
      var s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null')
      if (s && Array.isArray(s.balls) && Array.isArray(s.lines)) {
        state.balls = s.balls
        state.lines = s.lines
        s.balls.forEach(function (b) { if (b.id >= idSeq) idSeq = b.id + 1 })
        s.lines.forEach(function (l) { if (l.id >= idSeq) idSeq = l.id + 1 })
      }
    } catch (e) {}
  }

  /* ── 撤销 ── */
  function snapshot() {
    undoStack.push(JSON.stringify({ balls: state.balls, lines: state.lines }))
    if (undoStack.length > 50) undoStack.shift()
  }
  function undo() {
    var prev = undoStack.pop()
    if (!prev) { toast('没有可撤销的操作'); return }
    var s = JSON.parse(prev)
    state.balls = s.balls
    state.lines = s.lines
    state.selected = null
    saveState()
    render()
  }

  /* ── 绘制 ── */
  function drawBackground(c) {
    if (!bgImg) {
      c.fillStyle = '#0d3a1e'
      c.fillRect(0, 0, LOGICAL_W, LOGICAL_H)
      return
    }
    c.save()
    c.translate(LOGICAL_W / 2, LOGICAL_H / 2)
    c.rotate(Math.PI / 2)
    c.drawImage(bgImg, SRC.x, SRC.y, SRC.w, SRC.h, -LOGICAL_H / 2, -LOGICAL_W / 2, LOGICAL_H, LOGICAL_W)
    c.restore()
  }

  function drawLine(c, l, highlight) {
    c.save()
    c.strokeStyle = l.color
    c.lineWidth = LINE_W
    c.lineCap = 'round'
    if (l.type === 'dash') c.setLineDash([12, 9])
    if (highlight) {
      c.shadowColor = l.color
      c.shadowBlur = 8
      c.lineWidth = LINE_W + 1.5
    }
    c.beginPath()
    c.moveTo(l.x1, l.y1)
    c.lineTo(l.x2, l.y2)
    c.stroke()
    c.setLineDash([])
    if (l.type === 'arrow') {
      var ang = Math.atan2(l.y2 - l.y1, l.x2 - l.x1)
      var hl = 16
      c.beginPath()
      c.moveTo(l.x2, l.y2)
      c.lineTo(l.x2 - hl * Math.cos(ang - 0.42), l.y2 - hl * Math.sin(ang - 0.42))
      c.lineTo(l.x2 - hl * Math.cos(ang + 0.42), l.y2 - hl * Math.sin(ang + 0.42))
      c.closePath()
      c.fillStyle = l.color
      c.fill()
    }
    c.restore()
  }

  function drawBall(c, num, x, y, highlight) {
    var def = BALL_DEFS[num]
    var stripe = num >= 9
    c.save()
    c.beginPath()
    c.arc(x, y, BALL_R, 0, Math.PI * 2)
    c.clip()
    if (num === 0 || stripe) {
      c.fillStyle = '#f6f6f0'
      c.fillRect(x - BALL_R, y - BALL_R, BALL_R * 2, BALL_R * 2)
    }
    if (num === 0) {
      c.fillStyle = '#c23b3b'
      c.beginPath()
      c.arc(x, y - BALL_R * 0.35, 1.8, 0, Math.PI * 2)
      c.fill()
    } else if (stripe) {
      c.fillStyle = def.color
      c.fillRect(x - BALL_R, y - BALL_R * 0.55, BALL_R * 2, BALL_R * 1.1)
    } else {
      c.fillStyle = def.color
      c.fillRect(x - BALL_R, y - BALL_R, BALL_R * 2, BALL_R * 2)
    }
    /* 球面阴影 */
    var g = c.createRadialGradient(x - BALL_R * 0.35, y - BALL_R * 0.4, BALL_R * 0.15, x, y, BALL_R * 1.05)
    g.addColorStop(0, 'rgba(255,255,255,0.34)')
    g.addColorStop(0.45, 'rgba(255,255,255,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.4)')
    c.fillStyle = g
    c.fillRect(x - BALL_R, y - BALL_R, BALL_R * 2, BALL_R * 2)
    c.restore()

    if (num > 0) {
      c.beginPath()
      c.arc(x, y, BALL_R * 0.5, 0, Math.PI * 2)
      c.fillStyle = '#ffffff'
      c.fill()
      c.fillStyle = '#1d1d1f'
      c.font = '700 ' + (num >= 10 ? 8.5 : 10) + 'px JetBrains Mono, monospace'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText(String(num), x, y + 0.5)
    }

    c.beginPath()
    c.arc(x, y, BALL_R, 0, Math.PI * 2)
    c.strokeStyle = 'rgba(0,0,0,0.28)'
    c.lineWidth = 1
    c.stroke()
    if (highlight) {
      c.beginPath()
      c.arc(x, y, BALL_R + 3.5, 0, Math.PI * 2)
      c.strokeStyle = '#ffffff'
      c.lineWidth = 2.5
      c.stroke()
    }
  }

  function paint(c, forExport) {
    c.clearRect(0, 0, LOGICAL_W, LOGICAL_H)
    drawBackground(c)
    state.lines.forEach(function (l) {
      drawLine(c, l, !forExport && state.selected && state.selected.kind === 'line' && state.selected.id === l.id)
    })
    state.balls.forEach(function (b) {
      drawBall(c, b.num, b.x, b.y, !forExport && state.selected && state.selected.kind === 'ball' && state.selected.id === b.id)
    })
    if (drag && drag.kind === 'line') {
      drawLine(c, { type: state.tool, color: state.lineColor, x1: drag.x1, y1: drag.y1, x2: drag.x2, y2: drag.y2 }, false)
    }
  }

  function render() {
    if (!ctx) return
    ctx.save()
    ctx.setTransform(canvas._dpr, 0, 0, canvas._dpr, 0, 0)
    paint(ctx, false)
    ctx.restore()
  }

  /* ── 命中检测 ── */
  function hitBall(x, y) {
    for (var i = state.balls.length - 1; i >= 0; i--) {
      var b = state.balls[i]
      if ((x - b.x) * (x - b.x) + (y - b.y) * (y - b.y) <= (BALL_R + 5) * (BALL_R + 5)) return b
    }
    return null
  }
  function distToSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1
    var len2 = dx * dx + dy * dy
    var t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    var cx = x1 + t * dx, cy = y1 + t * dy
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
  }
  function hitLine(x, y) {
    for (var i = state.lines.length - 1; i >= 0; i--) {
      var l = state.lines[i]
      if (distToSeg(x, y, l.x1, l.y1, l.x2, l.y2) <= 7) return l
    }
    return null
  }

  function toLogical(e) {
    var r = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - r.left) / r.width * LOGICAL_W,
      y: (e.clientY - r.top) / r.height * LOGICAL_H
    }
  }
  function clampBall(b) {
    b.x = Math.max(BALL_R + 1, Math.min(LOGICAL_W - BALL_R - 1, b.x))
    b.y = Math.max(BALL_R + 1, Math.min(LOGICAL_H - BALL_R - 1, b.y))
  }

  /* ── 画布指针交互 ── */
  function onCanvasDown(e) {
    if (placing) return
    e.preventDefault()
    canvas.setPointerCapture(e.pointerId)
    var p = toLogical(e)
    if (TOOL_LINE_TYPES[state.tool]) {
      drag = { kind: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y }
    } else {
      var b = hitBall(p.x, p.y)
      if (b) {
        snapshot()
        state.selected = { kind: 'ball', id: b.id }
        drag = { kind: 'ball', id: b.id, dx: b.x - p.x, dy: b.y - p.y, moved: false }
      } else {
        var l = hitLine(p.x, p.y)
        state.selected = l ? { kind: 'line', id: l.id } : null
      }
    }
    render()
  }
  function onCanvasMove(e) {
    if (!drag) return
    e.preventDefault()
    var p = toLogical(e)
    if (drag.kind === 'ball') {
      var b = state.balls.filter(function (x) { return x.id === drag.id })[0]
      if (!b) { drag = null; return }
      b.x = p.x + drag.dx
      b.y = p.y + drag.dy
      clampBall(b)
      drag.moved = true
    } else {
      drag.x2 = p.x
      drag.y2 = p.y
    }
    render()
  }
  function onCanvasUp(e) {
    if (!drag) return
    e.preventDefault()
    if (drag.kind === 'line') {
      var len = Math.sqrt((drag.x2 - drag.x1) * (drag.x2 - drag.x1) + (drag.y2 - drag.y1) * (drag.y2 - drag.y1))
      if (len > 12) {
        snapshot()
        state.lines.push({ id: idSeq++, type: state.tool, color: state.lineColor, x1: drag.x1, y1: drag.y1, x2: drag.x2, y2: drag.y2 })
      }
    }
    if (drag.kind === 'ball' && !drag.moved) {
      undoStack.pop() // 未移动：撤销本次 snapshot，避免空操作堆栈
    }
    drag = null
    saveState()
    render()
  }
  function onCanvasDblClick(e) {
    e.preventDefault()
    var p = toLogical(e)
    var b = hitBall(p.x, p.y)
    if (b) {
      snapshot()
      state.balls = state.balls.filter(function (x) { return x.id !== b.id })
      state.selected = null
    } else {
      var l = hitLine(p.x, p.y)
      if (l) {
        snapshot()
        state.lines = state.lines.filter(function (x) { return x.id !== l.id })
        state.selected = null
      }
    }
    saveState()
    render()
  }
  function onKeyDown(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
      var tag = (document.activeElement || {}).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      snapshot()
      if (state.selected.kind === 'ball') {
        var id = state.selected.id
        state.balls = state.balls.filter(function (x) { return x.id !== id })
      } else {
        var lid = state.selected.id
        state.lines = state.lines.filter(function (x) { return x.id !== lid })
      }
      state.selected = null
      saveState()
      render()
    }
  }

  /* ── 侧栏球子拖放 ── */
  function ballCss(num) {
    var def = BALL_DEFS[num]
    if (num === 0) return { background: '#f6f6f0' }
    if (num >= 9) {
      return { background: 'linear-gradient(to bottom, #f6f6f0 0 27%, ' + def.color + ' 27% 73%, #f6f6f0 73% 100%)' }
    }
    return { background: def.color }
  }
  function buildPalette() {
    var wrap = document.getElementById('pb-palette')
    BALL_DEFS.forEach(function (def) {
      var el = document.createElement('button')
      el.type = 'button'
      el.className = 'pb-ball' + (def.num === 0 ? ' cue' : '')
      el.dataset.num = def.num
      el.title = def.num === 0 ? '母球' : def.num + ' 号球'
      var css = ballCss(def.num)
      Object.keys(css).forEach(function (k) { el.style[k] = css[k] })
      var no = document.createElement('span')
      no.className = 'no'
      no.textContent = def.num > 0 ? String(def.num) : ''
      el.appendChild(no)
      el.addEventListener('pointerdown', onPaletteDown)
      wrap.appendChild(el)
    })
  }
  function onPaletteDown(e) {
    e.preventDefault()
    var num = parseInt(e.currentTarget.dataset.num, 10)
    var ghost = document.createElement('div')
    ghost.className = 'pb-ghost'
    var css = ballCss(num)
    Object.keys(css).forEach(function (k) { ghost.style[k] = css[k] })
    document.body.appendChild(ghost)
    placing = { num: num, ghost: ghost, sx: e.clientX, sy: e.clientY, moved: false }
    moveGhost(e)
    document.addEventListener('pointermove', onPlacingMove)
    document.addEventListener('pointerup', onPlacingUp, { once: true })
  }
  function moveGhost(e) {
    if (placing && placing.ghost) {
      placing.ghost.style.left = e.clientX + 'px'
      placing.ghost.style.top = e.clientY + 'px'
    }
  }
  function onPlacingMove(e) {
    if (!placing) return
    e.preventDefault()
    if (Math.abs(e.clientX - placing.sx) + Math.abs(e.clientY - placing.sy) > 6) placing.moved = true
    moveGhost(e)
  }
  function onPlacingUp(e) {
    document.removeEventListener('pointermove', onPlacingMove)
    if (!placing) return
    var r = canvas.getBoundingClientRect()
    var inCanvas = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    var x, y
    if (inCanvas) {
      x = (e.clientX - r.left) / r.width * LOGICAL_W
      y = (e.clientY - r.top) / r.height * LOGICAL_H
    } else if (!placing.moved) {
      /* 纯点击：放到画布中心附近（带少量偏移避免重叠） */
      x = LOGICAL_W / 2 + (Math.random() * 60 - 30)
      y = LOGICAL_H / 2 + (Math.random() * 60 - 30)
    } else {
      placing.ghost.remove()
      placing = null
      return
    }
    snapshot()
    var b = { id: idSeq++, num: placing.num, x: x, y: y }
    clampBall(b)
    state.balls.push(b)
    state.selected = { kind: 'ball', id: b.id }
    placing.ghost.remove()
    placing = null
    saveState()
    render()
  }

  /* ── 工具与颜色 ── */
  function buildTools() {
    document.getElementById('pb-tools').addEventListener('click', function (e) {
      var btn = e.target.closest('.pb-tool')
      if (!btn) return
      state.tool = btn.dataset.tool
      state.selected = null
      document.querySelectorAll('.pb-tool').forEach(function (b) {
        b.classList.toggle('is-active', b === btn)
      })
      canvas.style.cursor = TOOL_LINE_TYPES[state.tool] ? 'crosshair' : 'default'
      render()
    })
    var colors = document.getElementById('pb-colors')
    LINE_COLORS.forEach(function (c, i) {
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'pb-color' + (i === 0 ? ' is-active' : '')
      b.style.background = c
      b.title = c
      b.addEventListener('click', function () {
        state.lineColor = c
        colors.querySelectorAll('.pb-color').forEach(function (x) { x.classList.toggle('is-active', x === b) })
      })
      colors.appendChild(b)
    })
  }

  /* ── 截图记录 ── */
  function loadShots() {
    try { return JSON.parse(localStorage.getItem(SHOT_KEY) || '[]') } catch (e) { return [] }
  }
  function saveShots(shots) {
    try {
      localStorage.setItem(SHOT_KEY, JSON.stringify(shots))
      return true
    } catch (e) {
      return false
    }
  }
  function fmtTime(ts) {
    var d = new Date(ts)
    function p(n) { return (n < 10 ? '0' : '') + n }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function renderShots() {
    var shots = loadShots()
    var wrap = document.getElementById('pb-shots')
    document.getElementById('pb-shot-count').textContent = shots.length ? shots.length + ' 张' : ''
    if (!shots.length) {
      wrap.innerHTML = '<div class="pb-empty">暂无截图<br>摆好球形后点击「保存截图」</div>'
      return
    }
    wrap.innerHTML = ''
    shots.forEach(function (s) {
      var item = document.createElement('div')
      item.className = 'pb-shot'

      var img = document.createElement('img')
      img.className = 'pb-shot-thumb'
      img.src = s.dataUrl
      img.alt = '截图 ' + fmtTime(s.ts)
      img.addEventListener('click', function () { openViewer(s.dataUrl) })

      var meta = document.createElement('div')
      meta.className = 'pb-shot-meta'
      meta.textContent = fmtTime(s.ts)

      var ops = document.createElement('div')
      ops.className = 'pb-shot-ops'

      var dl = document.createElement('button')
      dl.type = 'button'
      dl.title = '下载'
      dl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>'
      dl.addEventListener('click', function () {
        var a = document.createElement('a')
        var d = new Date(s.ts)
        function p(n) { return (n < 10 ? '0' : '') + n }
        a.href = s.dataUrl
        a.download = '练球球形图-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.jpg'
        a.click()
      })

      var del = document.createElement('button')
      del.type = 'button'
      del.title = '删除'
      del.className = 'danger'
      del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m1 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>'
      del.addEventListener('click', function () {
        if (!confirm('删除这张截图？')) return
        var list = loadShots().filter(function (x) { return x.id !== s.id })
        saveShots(list)
        renderShots()
      })

      ops.appendChild(dl)
      ops.appendChild(del)
      item.appendChild(img)
      item.appendChild(meta)
      item.appendChild(ops)
      wrap.appendChild(item)
    })
  }
  function exportImage() {
    var off = document.createElement('canvas')
    var scale = 2
    off.width = LOGICAL_W * scale
    off.height = LOGICAL_H * scale
    var c = off.getContext('2d')
    c.scale(scale, scale)
    paint(c, true)
    return off.toDataURL('image/jpeg', 0.85)
  }
  function saveShot() {
    var dataUrl = exportImage()
    var shots = loadShots()
    shots.unshift({ id: Date.now(), ts: Date.now(), dataUrl: dataUrl })
    if (shots.length > MAX_SHOTS) shots = shots.slice(0, MAX_SHOTS)
    while (!saveShots(shots) && shots.length > 1) {
      shots.pop() // 存储超限：逐步淘汰最旧截图重试
    }
    if (!saveShots(shots)) {
      toast('截图保存失败：本地存储空间不足', 'error')
      return
    }
    renderShots()
    toast('截图已保存', 'success')
  }
  function openViewer(dataUrl) {
    var viewer = document.getElementById('pb-viewer')
    document.getElementById('pb-viewer-img').src = dataUrl
    viewer.hidden = false
  }

  /* ── 初始化 ── */
  function init() {
    canvas = document.getElementById('pb-canvas')
    var dpr = Math.min(window.devicePixelRatio || 1, 3)
    canvas._dpr = dpr
    canvas.width = LOGICAL_W * dpr
    canvas.height = LOGICAL_H * dpr
    ctx = canvas.getContext('2d')

    bgImg = new Image()
    bgImg.onload = render
    bgImg.src = './assets/practice-table-bg.png'

    loadState()
    buildPalette()
    buildTools()

    canvas.addEventListener('pointerdown', onCanvasDown)
    canvas.addEventListener('pointermove', onCanvasMove)
    canvas.addEventListener('pointerup', onCanvasUp)
    canvas.addEventListener('pointercancel', onCanvasUp)
    canvas.addEventListener('dblclick', onCanvasDblClick)
    document.addEventListener('keydown', onKeyDown)

    document.getElementById('pb-undo').addEventListener('click', undo)
    document.getElementById('pb-clear').addEventListener('click', function () {
      if (!state.balls.length && !state.lines.length) { toast('画布已是空的'); return }
      if (!confirm('清空画布上的全部球子和线条？')) return
      snapshot()
      state.balls = []
      state.lines = []
      state.selected = null
      saveState()
      render()
    })
    document.getElementById('pb-save').addEventListener('click', saveShot)

    document.getElementById('pb-viewer').addEventListener('click', function () {
      this.hidden = true
    })

    renderShots()
    render()

    if (window.AppUI && window.AppUI.fixNav) window.AppUI.fixNav('practice')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  return { render: render, state: state }
})()
