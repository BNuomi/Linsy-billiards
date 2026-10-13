/*
 * 网页版公共 UI 层：导航链接、云端状态栏（演示数据管理，管理员扫码鉴权）、Toast、格式化工具
 */
window.AppUI = (function () {
  var NAV_ITEMS = [
    { key: 'rankings', label: '积分排行', href: './rankings.html' },
    { key: 'matches', label: '对战记录', href: './match-records.html' },
    { key: 'competitions', label: '比赛', href: './competitions.html' },
    { key: 'member', label: '会员详情', href: './member-detail.html' },
    { key: 'home', label: '首页', href: './index.html' }
  ]

  // 将设计稿中的占位导航（href="#"）替换为真实链接，并高亮当前页
  function fixNav(activeKey) {
    var rails = document.querySelectorAll('nav .rail, .rk-nav .rail, .webbar .rail')
    rails.forEach(function (rail) {
      var links = rail.querySelectorAll('a.link')
      links.forEach(function (a) {
        var text = a.textContent.trim()
        var item = NAV_ITEMS.filter(function (n) { return n.label === text })[0]
        if (item) {
          a.setAttribute('href', item.href)
          if (item.key === activeKey) {
            a.classList.add('is-active')
            a.classList.add('active')
            a.setAttribute('aria-current', 'page')
          } else {
            a.classList.remove('is-active')
            a.classList.remove('active')
            a.removeAttribute('aria-current')
          }
        }
      })
    })
  }

  function fmtDate(ts) {
    if (!ts) return '-'
    var d = new Date(ts)
    var p = function (n) { return String(n).padStart(2, '0') }
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate())
  }

  function fmtMonthDay(ts) {
    var d = new Date(ts)
    return (d.getMonth() + 1) + '.' + d.getDate()
  }

  function fmtDelta(d) {
    if (d === null || d === undefined) return ''
    return (d > 0 ? '+' : '') + d
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // 赛季口径：每年 9 月至次年 8 月
  function seasonLabel() {
    var d = new Date()
    var y = d.getFullYear()
    var start = d.getMonth() >= 8 ? y : y - 1
    return start + '.09 - ' + (start + 1) + '.08'
  }

  function monthStartTs() {
    var d = new Date()
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  // ---------- Toast ----------
  function toast(msg, type) {
    var old = document.querySelector('.app-toast')
    if (old) old.remove()
    var el = document.createElement('div')
    el.className = 'app-toast'
    el.textContent = msg
    var bg = type === 'error' ? 'var(--state-error, #ff3b30)' : type === 'success' ? 'var(--success, #34c759)' : 'var(--foreground, #1d1d1f)'
    el.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:9999;' +
      'max-width:82vw;padding:10px 18px;border-radius:999px;background:' + bg + ';' +
      'color:var(--background,#fff);font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.18);' +
      'opacity:0;transition:opacity .2s ease, transform .2s ease;pointer-events:none;'
    document.body.appendChild(el)
    requestAnimationFrame(function () {
      el.style.opacity = '1'
      el.style.transform = 'translateX(-50%) translateY(-4px)'
    })
    setTimeout(function () {
      el.style.opacity = '0'
      setTimeout(function () { el.remove() }, 250)
    }, 2600)
  }

  // ---------- 自定义确认弹层（避免原生 confirm 在内嵌浏览器中触发宿主崩溃） ----------
  function confirmBox(text, okLabel) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div')
      mask.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.32);' +
        'display:flex;align-items:center;justify-content:center;padding:24px;'
      var card = document.createElement('div')
      card.style.cssText = 'width:320px;max-width:100%;background:var(--card,#fff);color:var(--foreground,#1d1d1f);' +
        'border:1px solid var(--border,#e5e5ea);border-radius:16px;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.20);'
      card.innerHTML =
        '<div style="font-size:14px;line-height:1.6;margin-bottom:16px;">' + escapeHtml(text) + '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
        '<button class="acb-cancel" style="height:36px;padding:0 16px;border-radius:999px;border:1px solid var(--border,#e5e5ea);' +
        'background:var(--card,#fff);color:inherit;font-size:13px;font-weight:600;cursor:pointer;">取消</button>' +
        '<button class="acb-ok" style="height:36px;padding:0 16px;border:none;border-radius:999px;' +
        'background:var(--primary,#007aff);color:var(--primary-foreground,#fff);font-size:13px;font-weight:700;cursor:pointer;">' +
        escapeHtml(okLabel || '确定') + '</button></div>'
      mask.appendChild(card)
      document.body.appendChild(mask)
      function done(val) {
        mask.remove()
        document.removeEventListener('keydown', onKey)
        resolve(val)
      }
      function onKey(e) {
        if (e.key === 'Escape') done(false)
        if (e.key === 'Enter') done(true)
      }
      card.querySelector('.acb-cancel').addEventListener('click', function () { done(false) })
      card.querySelector('.acb-ok').addEventListener('click', function () { done(true) })
      mask.addEventListener('click', function (e) { if (e.target === mask) done(false) })
      document.addEventListener('keydown', onKey)
    })
  }

  // ---------- 联系我们：协会钉钉群二维码浮层（类右键菜单，无遮罩，锚定触发链接） ----------
  // 用法：页脚「联系我们」链接加 data-contact-qr 属性即可，脚本自动初始化（common.js 于 body 末尾加载，DOM 已就绪）
  function mountContactQr() {
    var triggers = document.querySelectorAll('[data-contact-qr]')
    if (!triggers.length) return
    if (document.getElementById('contact-qr-pop')) return

    var style = document.createElement('style')
    style.id = 'contact-qr-style'
    style.textContent =
      '.contact-qr-pop{position:fixed;z-index:9999;width:288px;max-width:calc(100vw - 24px);' +
      'background:var(--card,#fff);color:var(--card-foreground,#1d1d1f);border:1px solid var(--border,#e5e5ea);' +
      'border-radius:16px;box-shadow:0 12px 32px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.06);padding:14px;' +
      'opacity:0;transform:translateY(4px) scale(.97);transform-origin:bottom right;' +
      'transition:opacity .16s ease,transform .16s ease;pointer-events:none;}' +
      '.contact-qr-pop.open{opacity:1;transform:none;pointer-events:auto;}' +
      '.contact-qr-pop img{display:block;width:100%;border-radius:10px;border:1px solid var(--border,#e5e5ea);background:#fff;}' +
      '.contact-qr-tip{margin-top:10px;text-align:center;font-size:12px;color:var(--muted-foreground,#6e6e73);}'
    document.head.appendChild(style)

    var pop = document.createElement('div')
    pop.className = 'contact-qr-pop'
    pop.id = 'contact-qr-pop'
    pop.setAttribute('role', 'dialog')
    pop.setAttribute('aria-label', '协会钉钉群二维码')
    pop.innerHTML = '<img src="./assets/dingtalk-group-qr.png" alt="林氏台球协会钉钉群二维码">' +
      '<div class="contact-qr-tip">钉钉扫码加入协会群，赛事通知与约战一手掌握</div>'
    document.body.appendChild(pop)

    function isOpen() { return pop.classList.contains('open') }
    function close() { pop.classList.remove('open') }
    function place(anchor) {
      var rect = anchor.getBoundingClientRect()
      pop.style.visibility = 'hidden'
      pop.classList.add('open')
      var w = pop.offsetWidth
      var h = pop.offsetHeight
      var left = Math.max(12, Math.min(rect.right - w, window.innerWidth - w - 12))
      var top = rect.top - h - 10
      if (top < 8) top = rect.bottom + 10
      pop.style.left = left + 'px'
      pop.style.top = top + 'px'
      pop.style.visibility = ''
    }
    triggers.forEach(function (t) {
      t.addEventListener('click', function (e) {
        e.preventDefault()
        e.stopPropagation()
        if (isOpen()) { close(); return }
        place(t)
      })
    })
    pop.addEventListener('click', function (e) { e.stopPropagation() })
    document.addEventListener('click', close)
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close() })
    window.addEventListener('scroll', close, { passive: true })
    window.addEventListener('resize', close)
  }
  mountContactQr()

  // ---------- 云端状态栏 + 演示数据管理（管理员扫码鉴权） ----------
  // 右下角仅保留状态与单个「数据管理」入口；扫码授权（仅管理员）通过后展开 生成/清除/清空 按钮
  var DA_STORE_KEY = 'wa_data_auth'

  function readDataAuth() {
    try {
      var raw = sessionStorage.getItem(DA_STORE_KEY)
      if (!raw) return null
      var a = JSON.parse(raw)
      if (!a || !a.token || Date.now() > (a.expire || 0)) return null
      return a
    } catch (e) { return null }
  }
  function writeDataAuth(a) {
    try { sessionStorage.setItem(DA_STORE_KEY, JSON.stringify(a)) } catch (e) { /* noop */ }
  }
  function clearDataAuth() {
    try { sessionStorage.removeItem(DA_STORE_KEY) } catch (e) { /* noop */ }
  }

  // 扫码授权弹层：创建 data_admin 会话 → 小程序码 → 轮询；仅角色含 admin 视为通过
  function openDataAuthModal(onApproved) {
    var mask = document.createElement('div')
    mask.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.36);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;'
    var card = document.createElement('div')
    card.style.cssText = 'width:340px;max-width:100%;background:var(--card,#fff);color:var(--foreground,#1d1d1f);' +
      'border:1px solid var(--border,#e5e5ea);border-radius:18px;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.24);'
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
      '<span style="font-size:16px;font-weight:700;">微信扫码验证权限</span>' +
      '<button class="da-close" type="button" aria-label="关闭" style="width:30px;height:30px;border:none;border-radius:999px;' +
      'cursor:pointer;background:var(--secondary,#f2f2f7);color:var(--muted-foreground,#6e6e73);font-size:15px;">×</button></div>' +
      '<div class="da-qr" style="display:flex;flex-direction:column;align-items:center;gap:12px;min-height:220px;justify-content:center;">' +
      '<div style="font-size:13px;color:var(--muted-foreground,#6e6e73);">正在生成小程序码…</div></div>' +
      '<div style="margin-top:14px;text-align:center;font-size:12px;line-height:1.7;color:var(--muted-foreground,#6e6e73);">' +
      '使用微信扫码，在小程序中确认授权<br>仅管理员角色可授权数据管理，有效期 2 小时</div>'
    mask.appendChild(card)
    document.body.appendChild(mask)

    var pollTimer = null
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
    function close() { stopPoll(); mask.remove() }
    card.querySelector('.da-close').addEventListener('click', close)
    mask.addEventListener('click', function (e) { if (e.target === mask) close() })

    function renderError(msg) {
      var wrap = card.querySelector('.da-qr')
      wrap.innerHTML =
        '<div style="font-size:13px;color:var(--state-error,#ff3b30);text-align:center;">' + escapeHtml(msg) + '</div>' +
        '<button class="da-retry" type="button" style="height:32px;padding:0 16px;border-radius:999px;' +
        'border:1px solid var(--border,#e5e5ea);background:var(--card,#fff);color:inherit;font-size:12px;font-weight:600;cursor:pointer;">重新生成</button>'
      wrap.querySelector('.da-retry').addEventListener('click', function () {
        wrap.innerHTML = '<div style="font-size:13px;color:var(--muted-foreground,#6e6e73);">正在生成小程序码…</div>'
        createSession()
      })
    }

    async function createSession() {
      stopPoll()
      try {
        var s = await window.AppCloud.call('webAuthSession', { action: 'create', purpose: 'data_admin' })
        var qr = await window.AppCloud.call('getWebAuthQrcode', { session_id: s.session_id, env_version: 'trial' })
        var wrap = card.querySelector('.da-qr')
        if (!wrap || !document.body.contains(mask)) return
        wrap.innerHTML = '<img alt="授权小程序码" style="width:220px;height:220px;border-radius:12px;' +
          'border:1px solid var(--border,#e5e5ea);background:#fff;" src="data:image/png;base64,' + qr.image_base64 + '">'
        poll(s.session_id, s.expire_at)
      } catch (e) {
        renderError(e.message || '小程序码生成失败')
      }
    }

    function poll(sessionId, expireAt) {
      stopPoll()
      pollTimer = setInterval(async function () {
        if (!document.body.contains(mask)) { stopPoll(); return }
        if (Date.now() > expireAt) { stopPoll(); renderError('二维码已过期'); return }
        try {
          var st = await window.AppCloud.call('webAuthSession', { action: 'status', session_id: sessionId })
          if (st.status === 'approved') {
            stopPoll()
            var roles = Array.isArray(st.roles) ? st.roles : []
            if (roles.indexOf('admin') < 0) {
              close()
              toast('仅管理员可操作演示数据', 'error')
              return
            }
            var auth = { token: st.token, name: st.name, roles: roles, expire: st.token_expire_at }
            writeDataAuth(auth)
            close()
            toast('已授权：' + (st.name || ''), 'success')
            onApproved(auth)
          } else if (st.status === 'expired') {
            stopPoll()
            renderError('二维码已过期')
          }
        } catch (e) { /* 轮询失败下轮重试 */ }
      }, 2000)
    }

    createSession()
  }

  function mountCloudBar(onDataChanged) {
    var bar = document.createElement('div')
    bar.id = 'app-cloud-bar'
    bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9998;display:flex;flex-direction:column;' +
      'align-items:flex-end;gap:8px;font-family:inherit;'
    bar.innerHTML =
      '<div class="acb-status" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;' +
      'border-radius:999px;background:var(--card,#fff);border:1px solid var(--border,#e5e5ea);' +
      'box-shadow:0 2px 8px rgba(0,0,0,.06);font-size:12px;color:var(--muted-foreground,#6e6e73);">' +
      '<span class="acb-dot" style="width:8px;height:8px;border-radius:999px;background:#aeaeb2;"></span>' +
      '<span class="acb-text">连接云端…</span></div>' +
      '<button class="acb-entry" type="button" style="display:none;height:30px;padding:0 12px;border-radius:999px;' +
      'border:1px solid var(--border,#e5e5ea);background:var(--card,#fff);color:var(--muted-foreground,#6e6e73);' +
      'font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.06);">数据管理</button>' +
      '<div class="acb-actions" style="display:none;gap:8px;">' +
      '<button class="acb-btn" data-act="seed" style="height:34px;padding:0 14px;border:none;border-radius:999px;' +
      'background:var(--primary,#007aff);color:var(--primary-foreground,#fff);font-size:12px;font-weight:700;cursor:pointer;' +
      'box-shadow:0 4px 12px rgba(0,122,255,.28);">生成演示数据</button>' +
      '<button class="acb-btn" data-act="clear" style="height:34px;padding:0 14px;border-radius:999px;' +
      'border:1px solid var(--border,#e5e5ea);background:var(--card,#fff);color:var(--foreground,#1d1d1f);' +
      'font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.06);">清除演示数据</button>' +
      '<button class="acb-btn" data-act="clearAll" style="height:34px;padding:0 14px;border-radius:999px;' +
      'border:1px solid var(--state-error,#ff3b30);background:var(--card,#fff);color:var(--state-error,#ff3b30);' +
      'font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.06);">清空全部数据</button>' +
      '</div>'
    document.body.appendChild(bar)

    var dot = bar.querySelector('.acb-dot')
    var text = bar.querySelector('.acb-text')
    var entry = bar.querySelector('.acb-entry')
    var actions = bar.querySelector('.acb-actions')
    var dataAuth = readDataAuth() // 当前授权态（null=未授权/已过期）

    function paint() {
      var st = window.AppCloud.status()
      if (st.online) {
        dot.style.background = 'var(--success,#34c759)'
        text.textContent = '云端已连接'
      } else {
        dot.style.background = 'var(--state-error,#ff3b30)'
        text.textContent = '本地演示数据（云端未连接）'
        bar.title = st.reason || ''
      }
      dataAuth = readDataAuth()
      // 演示数据操作默认隐藏：已授权（含 admin 角色）展示按钮组，否则仅保留「数据管理」入口
      if (dataAuth && (dataAuth.roles || []).indexOf('admin') >= 0) {
        actions.style.display = 'flex'
        entry.style.display = 'none'
      } else {
        actions.style.display = 'none'
        entry.style.display = st.sdkReady ? '' : 'none'
      }
    }

    entry.addEventListener('click', function () {
      var st = window.AppCloud.status()
      if (!st.sdkReady) {
        toast('云端未连接，无法管理演示数据', 'error')
        return
      }
      openDataAuthModal(function (auth) {
        dataAuth = auth
        paint()
      })
    })

    async function run(action) {
      var LABELS = { seed: '生成', clear: '清除', clearAll: '清空' }
      var label = LABELS[action] || '操作'
      var tip = action === 'clear'
        ? '确定清除全部演示数据？（仅删除 demo 标记数据，不影响正式数据）'
        : action === 'clearAll'
          ? '高危操作：将清空数据库中全部数据（含真实会员、全部对局与积分流水），仅保留表结构，且不可恢复。确定继续？'
          : '将重建全部演示数据（会员/对局/积分流水），约需半分钟，继续？'
      if (!(await confirmBox(tip, label))) return
      var st = window.AppCloud.status()
      if (!st.sdkReady) {
        toast('云端未连接，无法' + label + '：请先在云开发控制台开启「未登录用户访问云资源权限」', 'error')
        return
      }
      var TOKEN = 'lsmy-demo-seed'
      var call = function (params) {
        params.web_token = (dataAuth && dataAuth.token) || ''
        return window.AppCloud.call('seedDemoData', params)
      }
      try {
        if (action === 'clear') {
          text.textContent = '正在清除演示数据…'
          await call({ action: 'clear', token: TOKEN })
          paint()
          toast('演示数据已清除', 'success')
        } else if (action === 'clearAll') {
          text.textContent = '正在清空全部数据…'
          var ca = await call({ action: 'clearAll', token: TOKEN, confirm: 'ALL' })
          paint()
          toast('已清空：会员 ' + ca.members + ' / 对局 ' + ca.matches + ' / 流水 ' + ca.points_logs, 'success')
        } else {
          // 分步编排：clear → begin → match×N → finish（每步 1 次云调用，绕开函数 3s 超时限制）
          text.textContent = '正在清空旧演示数据 (1/4)…'
          await call({ action: 'seed', step: 'clear', token: TOKEN })
          text.textContent = '正在创建演示会员 (2/4)…'
          var begin = await call({ action: 'seed', step: 'begin', token: TOKEN })
          for (var i = 0; i < begin.total; i++) {
            text.textContent = '正在生成对局 ' + (i + 1) + '/' + begin.total + '：' + (begin.labels[i] || '') + ' (3/4)…'
            await call({ action: 'seed', step: 'match', index: i, token: TOKEN })
          }
          text.textContent = '正在汇总积分榜 (4/4)…'
          var fin = await call({ action: 'seed', step: 'finish', token: TOKEN })
          paint()
          toast('演示数据已生成：' + fin.members + ' 名会员 / ' + fin.matches + ' 场对局 / ' + fin.points_logs + ' 条流水', 'success')
        }
        if (typeof onDataChanged === 'function') onDataChanged()
        document.dispatchEvent(new CustomEvent('appcloud:datachanged'))
      } catch (e) {
        // 授权失效（云端 403）：清缓存并回收为「数据管理」入口，提示重新扫码
        if (e && e.code === 403) {
          clearDataAuth()
          dataAuth = null
          paint()
        }
        paint()
        toast(label + '失败：' + (e.message || e), 'error')
      }
    }

    bar.querySelectorAll('.acb-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { run(btn.getAttribute('data-act')) })
    })

    window.AppCloud.ready().then(paint)
    document.addEventListener('appcloud:statechanged', paint)
    paint()
  }

  return {
    fixNav: fixNav,
    fmtDate: fmtDate,
    fmtMonthDay: fmtMonthDay,
    fmtDelta: fmtDelta,
    escapeHtml: escapeHtml,
    seasonLabel: seasonLabel,
    monthStartTs: monthStartTs,
    toast: toast,
    mountContactQr: mountContactQr,
    mountCloudBar: mountCloudBar
  }
})()
