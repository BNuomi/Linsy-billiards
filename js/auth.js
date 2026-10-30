/*
 * 网页端扫码授权（通用）：webAuthSession 会话 + getWebAuthQrcode 小程序码 + 2s 轮询
 * 用途（purpose）：
 *   match_ops    对局操作（任意在册会员可授权，以其本人身份执行）
 *   member_admin 会员管理（仅管理员）
 *   competition_admin / data_admin 沿用各页既有实现（本模块不接管，避免回归）
 * token 存 sessionStorage（按用途分 key），2 小时有效；云端 403 时调用方应 clear() 后重新授权
 */
window.AppAuth = (function () {
  var KEYS = { match_ops: 'wa_match_ops', member_admin: 'wa_member_admin' }
  var PURPOSE_TIP = {
    match_ops: '在册会员扫码授权后，可在网页端创建对局 / 记分 / 结束对局（以本人身份执行）',
    member_admin: '仅管理员可授权；授权后可在网页端管理会员角色、删除会员、级联改名'
  }

  function keyOf(purpose) { return KEYS[purpose] || ('wa_' + purpose) }

  function read(purpose) {
    try {
      var raw = sessionStorage.getItem(keyOf(purpose))
      if (!raw) return null
      var a = JSON.parse(raw)
      if (!a || !a.token || Date.now() > (a.expire || 0)) return null
      return a
    } catch (e) { return null }
  }

  function write(purpose, a) {
    try { sessionStorage.setItem(keyOf(purpose), JSON.stringify(a)) } catch (e) { /* noop */ }
  }

  function clear(purpose) {
    try { sessionStorage.removeItem(keyOf(purpose)) } catch (e) { /* noop */ }
  }

  // 带授权的云调用：自动注入 web_token；403 时清缓存并抛错（调用方引导重新扫码）
  async function callAuthed(purpose, name, params) {
    var auth = read(purpose)
    if (!auth) {
      var e = new Error('扫码授权已失效，请重新扫码')
      e.code = 401
      throw e
    }
    try {
      return await window.AppCloud.call(name, Object.assign({}, params || {}, { web_token: auth.token }))
    } catch (err) {
      if (err && (err.code === 403 || err.code === 401)) clear(purpose)
      throw err
    }
  }

  // 确保已授权：有缓存直接返回；否则弹扫码弹层，授权成功后 resolve
  function ensure(purpose) {
    var cached = read(purpose)
    if (cached) return Promise.resolve(cached)
    return new Promise(function (resolve, reject) {
      openModal(purpose, function (auth) { resolve(auth) }, function () {
        reject(new Error('已取消授权'))
      })
    })
  }

  // 扫码授权弹层：创建会话 → 小程序码 → 轮询；approved 后写缓存并回调
  function openModal(purpose, onApproved, onCancel) {
    var esc = window.AppUI.escapeHtml
    var mask = document.createElement('div')
    mask.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.36);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;'
    var card = document.createElement('div')
    card.style.cssText = 'width:340px;max-width:100%;background:var(--card,#fff);color:var(--foreground,#1d1d1f);' +
      'border:1px solid var(--border,#e5e5ea);border-radius:18px;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.24);'
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
      '<span style="font-size:16px;font-weight:700;">微信扫码验证身份</span>' +
      '<button class="aa-close" type="button" aria-label="关闭" style="width:30px;height:30px;border:none;border-radius:999px;' +
      'cursor:pointer;background:var(--secondary,#f2f2f7);color:var(--muted-foreground,#6e6e73);font-size:15px;">×</button></div>' +
      '<div class="aa-qr" style="display:flex;flex-direction:column;align-items:center;gap:12px;min-height:220px;justify-content:center;">' +
      '<div style="font-size:13px;color:var(--muted-foreground,#6e6e73);">正在生成小程序码…</div></div>' +
      '<div style="margin-top:14px;text-align:center;font-size:12px;line-height:1.7;color:var(--muted-foreground,#6e6e73);">' +
      esc(PURPOSE_TIP[purpose] || '扫码后在小程序中确认授权') + '<br>授权有效期 2 小时</div>'
    mask.appendChild(card)
    document.body.appendChild(mask)

    var pollTimer = null
    var cancelled = false
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
    function close(byUser) {
      stopPoll()
      mask.remove()
      if (byUser && !cancelled) {
        cancelled = true
        if (typeof onCancel === 'function') onCancel()
      }
    }
    card.querySelector('.aa-close').addEventListener('click', function () { close(true) })
    mask.addEventListener('click', function (e) { if (e.target === mask) close(true) })

    function renderError(msg) {
      var wrap = card.querySelector('.aa-qr')
      wrap.innerHTML =
        '<div style="font-size:13px;color:var(--state-error,#ff3b30);text-align:center;">' + esc(msg) + '</div>' +
        '<button class="aa-retry" type="button" style="height:32px;padding:0 16px;border-radius:999px;' +
        'border:1px solid var(--border,#e5e5ea);background:var(--card,#fff);color:inherit;font-size:12px;font-weight:600;cursor:pointer;">重新生成</button>'
      wrap.querySelector('.aa-retry').addEventListener('click', function () {
        wrap.innerHTML = '<div style="font-size:13px;color:var(--muted-foreground,#6e6e73);">正在生成小程序码…</div>'
        createSession()
      })
    }

    async function createSession() {
      stopPoll()
      try {
        var s = await window.AppCloud.call('webAuthSession', { action: 'create', purpose: purpose })
        var qr = await window.AppCloud.call('getWebAuthQrcode', { session_id: s.session_id, env_version: 'release' })
        var wrap = card.querySelector('.aa-qr')
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
            var auth = { token: st.token, name: st.name, roles: st.roles || [], openid: st.openid || '', expire: st.token_expire_at }
            write(purpose, auth)
            cancelled = true
            close(false)
            window.AppUI.toast('已授权：' + (st.name || ''), 'success')
            if (typeof onApproved === 'function') onApproved(auth)
          } else if (st.status === 'expired') {
            stopPoll()
            renderError('二维码已过期')
          }
        } catch (e) { /* 轮询失败下轮重试 */ }
      }, 2000)
    }

    createSession()
  }

  return { read: read, write: write, clear: clear, ensure: ensure, callAuthed: callAuthed, openModal: openModal }
})()
