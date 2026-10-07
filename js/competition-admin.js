/*
 * 比赛详情页管理模块（网页端）：扫码鉴权 + 编辑比赛信息 + 导入报名名单
 * - 鉴权流程：创建 webAuthSession 会话 → getWebAuthQrcode 出小程序码 → 微信扫码小程序内确认 → 轮询拿 token（2h）
 * - 小程序码 env_version：web-auth 页未随正式版发布前用 trial 体验版联调，发布后改 release
 */
window.CompAdmin = (function () {
  var U = window.AppUI
  var QR_ENV_VERSION = 'trial'
  var STORE_KEY = 'wa_comp_auth'

  var ctx = { getComp: null, onChanged: null }
  var authing = false // 授权弹窗是否打开（防止并发创建会话）
  var pendingAction = null // 授权完成后要执行的动作：'edit' | 'import'

  // ---------- 授权态存取 ----------
  function readAuth() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY)
      if (!raw) return null
      var a = JSON.parse(raw)
      if (!a || !a.token || Date.now() > (a.expire || 0)) return null
      return a
    } catch (e) { return null }
  }
  function writeAuth(a) {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(a)) } catch (e) { /* noop */ }
  }
  function clearAuth() {
    try { sessionStorage.removeItem(STORE_KEY) } catch (e) { /* noop */ }
  }

  // ---------- 通用弹窗骨架 ----------
  function openModal(titleText, bodyBuilder) {
    closeModal()
    var mask = document.createElement('div')
    mask.className = 'wa-mask'
    mask.id = 'wa-mask'
    var card = document.createElement('div')
    card.className = 'wa-card'
    card.innerHTML =
      '<div class="wa-head"><span class="wa-title"></span>' +
      '<button class="wa-close" type="button" aria-label="关闭"><i data-lucide="x"></i></button></div>' +
      '<div class="wa-body"></div>'
    card.querySelector('.wa-title').textContent = titleText
    mask.appendChild(card)
    document.body.appendChild(mask)
    card.querySelector('.wa-close').addEventListener('click', closeModal)
    mask.addEventListener('click', function (e) { if (e.target === mask) closeModal() })
    document.addEventListener('keydown', onEsc)
    if (typeof bodyBuilder === 'function') bodyBuilder(card.querySelector('.wa-body'))
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons()
    return card
  }
  function onEsc(e) { if (e.key === 'Escape') closeModal() }
  function closeModal() {
    stopPoll()
    var old = document.getElementById('wa-mask')
    if (old) old.remove()
    document.removeEventListener('keydown', onEsc)
    authing = false
  }

  // ---------- 扫码授权 ----------
  var pollTimer = null
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  function startAuth(action) {
    var cached = readAuth()
    if (cached) { openAction(action); return }
    if (authing) return
    authing = true
    pendingAction = action

    openModal('微信扫码验证权限', function (body) {
      body.innerHTML =
        '<div class="wa-qr-wrap">' +
        '<div class="wa-qr-loading">正在生成小程序码…</div>' +
        '</div>' +
        '<div class="wa-qr-tip">使用微信扫码，在小程序中确认授权<br>仅管理员、裁判角色可授权，有效期 2 小时</div>'
      createSession(body)
    })
  }

  async function createSession(body) {
    stopPoll()
    try {
      var comp = ctx.getComp ? (ctx.getComp() || {}) : {}
      var s = await window.AppCloud.call('webAuthSession', {
        action: 'create',
        purpose: 'competition_admin',
        competition_id: comp._id || '',
        competition_name: comp.name || ''
      })
      var qr = await window.AppCloud.call('getWebAuthQrcode', {
        session_id: s.session_id,
        env_version: QR_ENV_VERSION
      })
      var wrap = body.querySelector('.wa-qr-wrap')
      if (!wrap) return // 弹窗已关闭
      wrap.innerHTML = '<img class="wa-qr-img" alt="授权小程序码" src="data:image/png;base64,' + qr.image_base64 + '">'
      pollStatus(body, s.session_id, s.expire_at)
    } catch (e) {
      renderQrError(body, e.message || '小程序码生成失败')
    }
  }

  function renderQrError(body, msg) {
    var wrap = body && body.querySelector('.wa-qr-wrap')
    if (!wrap) return
    wrap.innerHTML =
      '<div class="wa-qr-error">' + U.escapeHtml(msg) + '</div>' +
      '<button class="btn btn-secondary wa-retry" type="button">重新生成</button>'
    wrap.querySelector('.wa-retry').addEventListener('click', function () {
      wrap.innerHTML = '<div class="wa-qr-loading">正在生成小程序码…</div>'
      createSession(body)
    })
  }

  function pollStatus(body, sessionId, expireAt) {
    stopPoll()
    pollTimer = setInterval(async function () {
      if (!document.getElementById('wa-mask')) { stopPoll(); return }
      if (Date.now() > expireAt) {
        stopPoll()
        renderQrError(body, '二维码已过期')
        return
      }
      try {
        var st = await window.AppCloud.call('webAuthSession', { action: 'status', session_id: sessionId })
        if (st.status === 'approved') {
          stopPoll()
          writeAuth({ token: st.token, name: st.name, expire: st.token_expire_at })
          closeModal()
          U.toast('已授权：' + (st.name || ''), 'success')
          openAction(pendingAction)
          pendingAction = null
        } else if (st.status === 'expired') {
          stopPoll()
          renderQrError(body, '二维码已过期')
        }
      } catch (e) { /* 轮询失败下轮重试 */ }
    }, 2000)
  }

  // ---------- 授权后的动作 ----------
  function openAction(action) {
    if (action === 'edit') openEdit()
    else if (action === 'import') openImport()
  }

  // 权限失效统一处理：清缓存 → toast → 重新扫码
  function handleAuthError(e) {
    if (e && e.code === 403) {
      clearAuth()
      U.toast(e.message || '授权已失效，请重新扫码', 'error')
      return true
    }
    return false
  }

  // ---------- 编辑比赛信息 ----------
  var EDIT_FIELDS = [
    { key: 'name', label: '比赛名称', type: 'text', required: true, max: 20 },
    { key: 'game_type', label: '对局类型', type: 'select', options: [['', '未设置'], ['c8', '中八'], ['nine_ball', '九球追分']] },
    { key: 'start_date', label: '开始日期', type: 'date' },
    { key: 'end_date', label: '结束日期', type: 'date' },
    { key: 'venue', label: '比赛地点', type: 'text', max: 50 },
    { key: 'signup_deadline', label: '报名截止', type: 'date' },
    { key: 'contact', label: '联系方式', type: 'text', max: 50 },
    { key: 'prize', label: '奖品设置', type: 'text', max: 100 },
    { key: 'signup_url', label: '报名链接', type: 'url', max: 200, placeholder: 'https://…' },
    { key: 'rules_url', label: '规则链接', type: 'url', max: 200, placeholder: 'https://…' },
    { key: 'description', label: '比赛简介', type: 'textarea', max: 200 },
    { key: 'rules_text', label: '规则说明', type: 'textarea', max: 500 }
  ]

  function openEdit() {
    var comp = ctx.getComp ? (ctx.getComp() || {}) : {}
    var card = openModal('编辑比赛信息', function (body) {
      var html = '<form class="wa-form" id="wa-edit-form">'
      EDIT_FIELDS.forEach(function (f) {
        var val = comp[f.key] == null ? '' : String(comp[f.key])
        html += '<label class="wa-field"><span class="wa-label">' + f.label + (f.required ? ' *' : '') + '</span>'
        if (f.type === 'textarea') {
          html += '<textarea class="wa-input" name="' + f.key + '" rows="3" maxlength="' + f.max + '">' + U.escapeHtml(val) + '</textarea>'
        } else if (f.type === 'select') {
          html += '<select class="wa-input" name="' + f.key + '">' +
            f.options.map(function (o) {
              return '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>'
            }).join('') + '</select>'
        } else {
          html += '<input class="wa-input" name="' + f.key + '" type="' + f.type + '" maxlength="' + (f.max || 100) + '"' +
            ' value="' + U.escapeHtml(val) + '"' + (f.placeholder ? ' placeholder="' + f.placeholder + '"' : '') + '>'
        }
        html += '</label>'
      })
      html += '<div class="wa-foot"><button class="btn btn-primary" type="submit">保存</button></div></form>'
      body.innerHTML = html
      body.querySelector('#wa-edit-form').addEventListener('submit', function (ev) {
        ev.preventDefault()
        saveEdit(card)
      })
    })
  }

  async function saveEdit(card) {
    var form = card.querySelector('#wa-edit-form')
    var btn = card.querySelector('button[type="submit"]')
    var get = function (k) {
      var el = form.querySelector('[name="' + k + '"]')
      return el ? el.value.trim() : ''
    }
    if (!get('name')) { U.toast('请输入比赛名称', 'error'); return }
    if (get('start_date') && get('end_date') && get('start_date') > get('end_date')) {
      U.toast('开始日期不能晚于结束日期', 'error'); return
    }
    var comp = ctx.getComp ? (ctx.getComp() || {}) : {}
    var auth = readAuth()
    if (!auth) { U.toast('授权已失效，请重新扫码', 'error'); startAuth('edit'); return }

    var payload = {
      competition_id: comp._id,
      web_token: auth.token,
      name: get('name'),
      description: get('description'),
      start_date: get('start_date'),
      end_date: get('end_date'),
      venue: get('venue'),
      signup_deadline: get('signup_deadline'),
      signup_url: get('signup_url'),
      rules_url: get('rules_url'),
      rules_text: get('rules_text'),
      contact: get('contact'),
      prize: get('prize')
    }
    if (get('game_type')) payload.game_type = get('game_type')

    btn.disabled = true
    btn.textContent = '保存中…'
    try {
      await window.AppCloud.call('updateCompetition', payload)
      closeModal()
      U.toast('已保存', 'success')
      if (typeof ctx.onChanged === 'function') ctx.onChanged()
    } catch (e) {
      btn.disabled = false
      btn.textContent = '保存'
      if (!handleAuthError(e)) U.toast('保存失败：' + (e.message || e), 'error')
    }
  }

  // ---------- 导入报名名单 ----------
  var importState = { parsed: null }

  function openImport() {
    importState.parsed = null
    openModal('导入报名名单', function (body) {
      body.innerHTML =
        '<div class="wa-import-tip">选择 JSON 文件（与小程序端同一格式）：' +
        '<code>{"competition":"比赛名（可选）","participants":[{"emp_no":"工号","phone":"手机","name":"昵称"}]}</code>' +
        '单次最多 200 人，按 工号 → 手机 → 昵称 匹配已有会员，未匹配自动新建临时账号。</div>' +
        '<div class="wa-file-row">' +
        '<label class="wa-file-btn" for="wa-file">选择 JSON 文件</label>' +
        '<span class="wa-file-name" id="wa-file-name">未选择文件</span>' +
        '<input type="file" id="wa-file" accept=".json,application/json" class="wa-file-input">' +
        '</div>' +
        '<div id="wa-import-preview"></div>' +
        '<div class="wa-foot" id="wa-import-foot" style="display:none;">' +
        '<button class="btn btn-primary" id="wa-import-submit" type="button">确认导入</button></div>' +
        '<div id="wa-import-result"></div>'
      body.querySelector('#wa-file').addEventListener('change', onImportFile)
      body.querySelector('#wa-import-submit').addEventListener('click', doImport)
    })
  }

  function onImportFile(ev) {
    var file = ev.target.files && ev.target.files[0]
    var preview = document.getElementById('wa-import-preview')
    var foot = document.getElementById('wa-import-foot')
    var nameEl = document.getElementById('wa-file-name')
    importState.parsed = null
    foot.style.display = 'none'
    document.getElementById('wa-import-result').innerHTML = ''
    if (!file) {
      preview.innerHTML = ''
      nameEl.textContent = '未选择文件'
      nameEl.classList.remove('is-picked')
      return
    }
    nameEl.textContent = file.name
    nameEl.classList.add('is-picked')
    var reader = new FileReader()
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result || ''))
        if (!data || !Array.isArray(data.participants) || !data.participants.length) {
          throw new Error('文件缺少 participants 数组或名单为空')
        }
        if (data.participants.length > 200) {
          throw new Error('单次最多导入 200 人，当前 ' + data.participants.length + ' 人')
        }
        importState.parsed = {
          key: (data.competition == null ? '' : String(data.competition)).trim(),
          participants: data.participants
        }
        var names = data.participants.slice(0, 5).map(function (p) { return (p && p.name) || '（未命名）' })
        preview.innerHTML =
          '<div class="wa-parse-ok">解析成功：共 <b>' + data.participants.length + '</b> 人' +
          (importState.parsed.key ? '，文件标注比赛：' + U.escapeHtml(importState.parsed.key) : '') +
          '<br><span class="wa-parse-names">' + U.escapeHtml(names.join('、')) +
          (data.participants.length > 5 ? ' …' : '') + '</span></div>'
        foot.style.display = ''
      } catch (e2) {
        preview.innerHTML = '<div class="wa-parse-err">解析失败：' + U.escapeHtml(e2.message || '不是有效的 JSON 文件') + '</div>'
      }
    }
    reader.onerror = function () {
      preview.innerHTML = '<div class="wa-parse-err">文件读取失败，请重试</div>'
    }
    reader.readAsText(file, 'utf-8')
  }

  async function doImport() {
    if (!importState.parsed) return
    var comp = ctx.getComp ? (ctx.getComp() || {}) : {}
    var auth = readAuth()
    if (!auth) { U.toast('授权已失效，请重新扫码', 'error'); startAuth('import'); return }
    var btn = document.getElementById('wa-import-submit')
    btn.disabled = true
    btn.textContent = '导入中…'
    try {
      var res = await window.AppCloud.call('importSignups', {
        competition_id: comp._id,
        competition_key: importState.parsed.key,
        participants: importState.parsed.participants,
        web_token: auth.token
      })
      var html =
        '<div class="wa-result-ok">导入完成：匹配 ' + res.matched + ' / 新建 ' + res.created +
        ' / 已报名 ' + res.existed + ' / 失败 ' + (res.failed || []).length + '，名单共 ' + res.total + ' 人</div>'
      if (res.failed && res.failed.length) {
        html += '<div class="wa-failed-list">' + res.failed.map(function (f) {
          return '<div class="wa-failed-row">第 ' + f.index + ' 行 ' + U.escapeHtml(f.name || '') + '：' + U.escapeHtml(f.reason || '') + '</div>'
        }).join('') + '</div>'
      }
      document.getElementById('wa-import-result').innerHTML = html
      document.getElementById('wa-import-foot').style.display = 'none'
      document.getElementById('wa-file').value = ''
      var nameEl = document.getElementById('wa-file-name')
      nameEl.textContent = '未选择文件'
      nameEl.classList.remove('is-picked')
      importState.parsed = null
      if (typeof ctx.onChanged === 'function') ctx.onChanged()
    } catch (e) {
      btn.disabled = false
      btn.textContent = '确认导入'
      if (!handleAuthError(e)) {
        document.getElementById('wa-import-result').innerHTML =
          '<div class="wa-parse-err">导入失败：' + U.escapeHtml(e.message || String(e)) + '</div>'
      }
    }
  }

  // ---------- 入口 ----------
  function init(opts) {
    ctx.getComp = opts && opts.getComp
    ctx.onChanged = opts && opts.onChanged
    var editBtn = document.getElementById('cd-edit-btn')
    var importBtn = document.getElementById('cd-import-btn')
    if (editBtn) editBtn.addEventListener('click', function () { startAuth('edit') })
    if (importBtn) importBtn.addEventListener('click', function () { startAuth('import') })
  }

  return { init: init }
})()
