/*
 * 比赛管理模块（网页端）：扫码鉴权 + 编辑比赛信息 + 导入报名名单 + 编辑比赛日
 * - 鉴权流程：创建 webAuthSession 会话 → getWebAuthQrcode 出小程序码 → 微信扫码小程序内确认 → 轮询拿 token（2h）
 * - 小程序码 env_version：web-auth 页未随正式版发布前用 trial 体验版联调，发布后改 release
 * - 弹窗样式由本模块注入（wa-*），使用页无需内联重复样式
 */
window.CompAdmin = (function () {
  var U = window.AppUI
  var QR_ENV_VERSION = 'trial'
  var STORE_KEY = 'wa_comp_auth'

  var ctx = { getComp: null, onChanged: null }
  var authing = false // 授权弹窗是否打开（防止并发创建会话）
  var pendingAction = null // 授权完成后要执行的动作：'edit' | 'import' | 'days' | 'reorder'
  var pendingFixture = null // reorder 动作的目标对阵

  // ---------- 弹窗样式（单源注入，页面无需内联） ----------
  function ensureStyle() {
    if (document.getElementById('wa-admin-style')) return
    var style = document.createElement('style')
    style.id = 'wa-admin-style'
    style.textContent =
      '.wa-mask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.36);display:flex;align-items:center;justify-content:center;padding:20px;}' +
      '.wa-card{width:480px;max-width:100%;max-height:86vh;overflow-y:auto;background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.24);}' +
      '.wa-card.wa-card-wide{width:680px;}' +
      '.wa-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 0;}' +
      '.wa-title{font-size:16px;font-weight:700;}' +
      '.wa-close{width:32px;height:32px;border:none;border-radius:999px;cursor:pointer;background:var(--secondary);color:var(--muted-foreground);display:inline-flex;align-items:center;justify-content:center;}' +
      '.wa-close:hover{color:var(--foreground);}' +
      '.wa-close i{width:16px;height:16px;}' +
      '.wa-body{padding:16px 20px 20px;}' +
      '.wa-qr-wrap{display:flex;flex-direction:column;align-items:center;gap:12px;min-height:220px;justify-content:center;}' +
      '.wa-qr-img{width:220px;height:220px;border-radius:12px;border:1px solid var(--border);background:#fff;}' +
      '.wa-qr-loading,.wa-qr-error{font-size:13px;color:var(--muted-foreground);text-align:center;}' +
      '.wa-qr-error{color:var(--state-error);}' +
      '.wa-qr-tip{margin-top:14px;text-align:center;font-size:12px;line-height:1.7;color:var(--muted-foreground);}' +
      '.wa-retry{margin-top:4px;}' +
      '.wa-form{display:flex;flex-direction:column;gap:12px;}' +
      '.wa-field{display:flex;flex-direction:column;gap:6px;}' +
      '.wa-label{font-size:12px;font-weight:600;color:var(--muted-foreground);}' +
      '.wa-input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:var(--background);color:var(--foreground);font-size:14px;font-family:inherit;outline:none;}' +
      '.wa-input:focus{border-color:var(--primary);}' +
      'textarea.wa-input{resize:vertical;line-height:1.6;}' +
      '.wa-foot{display:flex;justify-content:flex-end;gap:10px;margin-top:8px;}' +
      '.wa-import-tip{font-size:12px;line-height:1.8;color:var(--muted-foreground);margin-bottom:14px;}' +
      '.wa-import-tip code{display:block;margin:8px 0;padding:10px 12px;border-radius:8px;background:var(--secondary);color:var(--foreground);font-size:11px;word-break:break-all;}' +
      '.wa-file-row{display:flex;align-items:center;gap:12px;margin-bottom:12px;}' +
      '.wa-file-input{display:none;}' +
      '.wa-file-btn{flex:none;display:inline-flex;align-items:center;gap:6px;padding:8px 18px;font-size:13px;font-weight:500;cursor:pointer;color:var(--primary);background:rgba(0,113,227,0.08);border:1px solid rgba(0,113,227,0.35);border-radius:999px;transition:background .15s ease,border-color .15s ease;}' +
      '.wa-file-btn:hover{background:rgba(0,113,227,0.14);border-color:var(--primary);}' +
      '.wa-file-name{flex:1;min-width:0;font-size:12px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.wa-file-name.is-picked{color:var(--foreground);}' +
      '.wa-parse-ok{font-size:13px;color:var(--foreground);line-height:1.7;padding:10px 12px;border-radius:8px;background:rgba(22,163,74,.1);}' +
      '.wa-parse-names{color:var(--muted-foreground);font-size:12px;}' +
      '.wa-parse-err{font-size:13px;color:var(--state-error);line-height:1.7;padding:10px 12px;border-radius:8px;background:rgba(255,59,48,.08);}' +
      '.wa-result-ok{font-size:13px;color:var(--foreground);line-height:1.7;padding:10px 12px;border-radius:8px;background:rgba(22,163,74,.1);margin-top:12px;}' +
      '.wa-failed-list{margin-top:10px;max-height:160px;overflow-y:auto;font-size:12px;color:var(--state-error);line-height:1.8;}' +
      /* 比赛日编辑 */
      '.wa-days-tip{font-size:12px;line-height:1.8;color:var(--muted-foreground);margin-bottom:12px;}' +
      '.wa-day-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}' +
      '.wa-day-row .wa-input{padding:8px 12px;font-size:13px;}' +
      '.wa-day-date{width:180px;flex:none;}' +
      '.wa-day-time{width:130px;flex:none;}' +
      '.wa-day-num{width:100px;flex:none;}' +
      '.wa-day-del{flex:none;width:34px;height:34px;border:none;border-radius:8px;cursor:pointer;background:var(--secondary);color:var(--muted-foreground);display:inline-flex;align-items:center;justify-content:center;}' +
      '.wa-day-del:hover{color:var(--state-error);}' +
      '.wa-day-del i{width:14px;height:14px;}' +
      '.wa-days-empty{font-size:12px;color:var(--muted-foreground);padding:8px 0;}' +
      '.wa-days-add{margin-top:4px;}' +
      '.wa-day-heads{display:flex;gap:10px;font-size:11px;color:var(--muted-foreground);margin-bottom:4px;}' +
      '.wa-day-heads span{display:block;}' +
      /* 调整排序 */
      '.wa-rs-list{max-height:46vh;overflow-y:auto;margin-bottom:12px;}' +
      '.wa-rs-opt{padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;cursor:pointer;background:var(--background);}' +
      '.wa-rs-opt.is-on{border-color:var(--primary);background:rgba(0,113,227,0.06);}' +
      '.wa-rs-label{font-size:13px;font-weight:600;color:var(--foreground);}' +
      '.wa-rs-sub{font-size:12px;color:var(--muted-foreground);margin-top:2px;}' +
      '.wa-rs-loading{font-size:13px;color:var(--muted-foreground);padding:12px 0;}'
    document.head.appendChild(style)
  }

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
  function openModal(titleText, bodyBuilder, opts) {
    ensureStyle()
    closeModal()
    var mask = document.createElement('div')
    mask.className = 'wa-mask'
    mask.id = 'wa-mask'
    var card = document.createElement('div')
    card.className = 'wa-card' + (opts && opts.wide ? ' wa-card-wide' : '')
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
    else if (action === 'days') openDays()
    else if (action === 'reorder') {
      var f = pendingFixture
      pendingFixture = null
      if (f) openReorderModal(f)
    }
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
    { key: 'format', label: '赛制（小组赛制仅中八；已抽对阵不可改）', type: 'select', options: [['rounds', '逐轮抽签'], ['groups_knockout', '小组赛+淘汰赛']] },
    { key: 'table_count', label: '同时开赛台数', type: 'number', placeholder: '默认 4' },
    { key: 'group_size', label: '小组人数（小组赛制）', type: 'number', placeholder: '默认 4' },
    { key: 'advance_count', label: '出线名额/组（小组赛制）', type: 'number', placeholder: '默认 2' },
    { key: 'race_group', label: '小组赛抢局（中八）', type: 'select', options: [['', '未设置'], ['3', '抢 3'], ['4', '抢 4'], ['5', '抢 5'], ['6', '抢 6'], ['7', '抢 7']] },
    { key: 'race_semi', label: '半决赛抢局（中八）', type: 'select', options: [['', '未设置'], ['3', '抢 3'], ['4', '抢 4'], ['5', '抢 5'], ['6', '抢 6'], ['7', '抢 7']] },
    { key: 'race_final', label: '决赛抢局（中八）', type: 'select', options: [['', '未设置'], ['3', '抢 3'], ['4', '抢 4'], ['5', '抢 5'], ['6', '抢 6'], ['7', '抢 7']] },
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
    // 局数设定全量传：数字字符串云端转数值落库，空串清除
    payload.race_group = get('race_group')
    payload.race_semi = get('race_semi')
    payload.race_final = get('race_final')
    // 赛制与排期设定全量传（空串清除回落默认）
    payload.format = get('format')
    payload.table_count = get('table_count')
    payload.group_size = get('group_size')
    payload.advance_count = get('advance_count')

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

  // ---------- 编辑比赛日 ----------
  // 与小程序端同口径：比赛日 [{date, start_time, slot_minutes, slot_count}] + 同时开赛台数；
  // 保存后未开打对阵需在小程序端「重新排期」生效
  function openDays() {
    var comp = ctx.getComp ? (ctx.getComp() || {}) : {}
    var days = (comp.match_days || []).map(function (d0) {
      return {
        date: d0.date || '',
        start_time: d0.start_time || '19:00',
        slot_minutes: Number(d0.slot_minutes) || 50,
        slot_count: Number(d0.slot_count) || 3
      }
    })
    var tables = Number(comp.table_count) > 0 ? Number(comp.table_count) : 4
    var card = openModal('编辑比赛日', function (body) {
      body.innerHTML =
        '<div class="wa-days-tip">对局时间按 比赛日 × 台数 × 场次 编排；保存后需在小程序端「重新排期」生效到未开打对阵。每场分钟 10-240，场次数 1-50。</div>' +
        '<div class="wa-day-heads"><span style="width:180px;">日期</span><span style="width:130px;">开始时间</span>' +
        '<span style="width:100px;">每场分钟</span><span style="width:100px;">场次数</span><span style="width:34px;"></span></div>' +
        '<div id="wa-days-list"></div>' +
        '<button class="btn btn-secondary wa-days-add" id="wa-days-add" type="button">+ 添加比赛日</button>' +
        '<label class="wa-field" style="margin-top:14px;"><span class="wa-label">同时开赛台数（1-16）</span>' +
        '<input class="wa-input" id="wa-days-tables" type="number" min="1" max="16" value="' + tables + '"></label>' +
        '<div class="wa-foot"><button class="btn btn-primary" id="wa-days-save" type="button">保存</button></div>'
      var listEl = body.querySelector('#wa-days-list')
      function renderRows() {
        listEl.innerHTML = days.length ? days.map(function (d0, i) {
          return '<div class="wa-day-row">' +
            '<input class="wa-input wa-day-date" type="date" data-i="' + i + '" data-k="date" value="' + U.escapeHtml(d0.date) + '">' +
            '<input class="wa-input wa-day-time" type="time" data-i="' + i + '" data-k="start_time" value="' + U.escapeHtml(d0.start_time) + '">' +
            '<input class="wa-input wa-day-num" type="number" min="10" max="240" data-i="' + i + '" data-k="slot_minutes" value="' + d0.slot_minutes + '">' +
            '<input class="wa-input wa-day-num" type="number" min="1" max="50" data-i="' + i + '" data-k="slot_count" value="' + d0.slot_count + '">' +
            '<button class="wa-day-del" type="button" data-i="' + i + '" aria-label="删除"><i data-lucide="trash-2"></i></button>' +
            '</div>'
        }).join('') : '<div class="wa-days-empty">暂无比赛日，点击下方「添加比赛日」</div>'
        if (window.lucide) window.lucide.createIcons()
      }
      renderRows()
      listEl.addEventListener('input', function (ev) {
        var i = Number(ev.target.getAttribute('data-i'))
        var k = ev.target.getAttribute('data-k')
        if (!days[i] || !k) return
        days[i][k] = (k === 'slot_minutes' || k === 'slot_count') ? Number(ev.target.value) || 0 : ev.target.value
      })
      listEl.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.wa-day-del')
        if (!btn) return
        days.splice(Number(btn.getAttribute('data-i')), 1)
        renderRows()
      })
      body.querySelector('#wa-days-add').addEventListener('click', function () {
        days.push({ date: '', start_time: '19:00', slot_minutes: 50, slot_count: 3 })
        renderRows()
      })
      body.querySelector('#wa-days-save').addEventListener('click', function () { saveDays(card, days) })
    }, { wide: true })
  }

  async function saveDays(card, days) {
    var btn = card.querySelector('#wa-days-save')
    var tables = Number(card.querySelector('#wa-days-tables').value) || 0
    var valid = days.filter(function (d0) { return d0.date })
    for (var i = 0; i < valid.length; i++) {
      if (!valid[i].start_time || !valid[i].slot_minutes || !valid[i].slot_count) {
        U.toast('请补全比赛日设置', 'error')
        return
      }
    }
    if (!Number.isInteger(tables) || tables < 1 || tables > 16) {
      U.toast('台数需为 1-16', 'error')
      return
    }
    var comp = ctx.getComp ? (ctx.getComp() || {}) : {}
    var auth = readAuth()
    if (!auth) { U.toast('授权已失效，请重新扫码', 'error'); startAuth('days'); return }
    btn.disabled = true
    btn.textContent = '保存中…'
    try {
      // updateCompetition 为全量字段写入，需带上现有字段避免被清空（与小程序端同口径）
      await window.AppCloud.call('updateCompetition', {
        competition_id: comp._id,
        web_token: auth.token,
        name: comp.name || '',
        description: comp.description || '',
        start_date: comp.start_date || '',
        end_date: comp.end_date || '',
        venue: comp.venue || '',
        signup_deadline: comp.signup_deadline || '',
        signup_url: comp.signup_url || '',
        rules_url: comp.rules_url || '',
        rules_text: comp.rules_text || '',
        contact: comp.contact || '',
        prize: comp.prize || '',
        match_days: valid,
        table_count: tables
      })
      closeModal()
      U.toast('已保存，可重新排期生效', 'success')
      if (typeof ctx.onChanged === 'function') ctx.onChanged()
    } catch (e) {
      btn.disabled = false
      btn.textContent = '保存'
      if (!handleAuthError(e)) U.toast('保存失败：' + (e.message || e), 'error')
    }
  }

  // ---------- 调整排序 ----------
  // 未开打对阵的排期顺序（与云端 updateFixture 同口径）：已排期按 时间→台号→场次，待定按场次编号排最后
  function cmpSched(a, b) {
    function key(f) {
      return [
        f.slot_at == null ? 9e15 : f.slot_at,
        f.table_no == null ? 99 : f.table_no,
        f.session_no == null ? 99 : f.session_no,
        f.match_no == null ? (f.seq || 0) : f.match_no
      ]
    }
    var x = key(a)
    var y = key(b)
    for (var i = 0; i < 4; i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    }
    return 0
  }

  function p2(n) { return String(n).padStart(2, '0') }
  function fmtSlot(ts) {
    var d = new Date(ts)
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
  }
  function namesOf(f) {
    if ((f.players || []).length) return f.players.map(function (p) { return p.name }).join(' vs ')
    return (f.placeholders || []).join(' vs ')
  }

  // 入口：fixtures 卡片「调整排序」按钮调用；未授权先走扫码
  function openReorder(fixture) {
    if (!fixture || !fixture._id) return
    if (readAuth()) { openReorderModal(fixture); return }
    pendingFixture = fixture
    startAuth('reorder')
  }

  function openReorderModal(fixture) {
    var comp = ctx.getComp ? (ctx.getComp() || {}) : {}
    var card = openModal('调整对阵排序', function (body) {
      body.innerHTML =
        '<div class="wa-days-tip">本场：<b>' + U.escapeHtml((fixture.match_no ? 'No.' + fixture.match_no + ' ' : '') + namesOf(fixture)) + '</b><br>' +
        '选择目标位置，本场将插到所选场之前；日期按排期自动分配。</div>' +
        '<div class="wa-rs-loading" id="wa-rs-loading">正在加载对阵…</div>' +
        '<div class="wa-rs-list" id="wa-rs-list" style="display:none;"></div>' +
        '<div class="wa-foot" id="wa-rs-foot" style="display:none;"><button class="btn btn-primary" id="wa-rs-save" type="button">保存</button></div>'
    }, { wide: true })
    window.AppCloud.call('getFixtures', { competition_id: comp._id }).then(function (d) {
      var open = (d.fixtures || []).filter(function (x) {
        return x.status !== 'bye' && !x.match_id && x._id !== fixture._id
      }).sort(cmpSched)
      var body = card.querySelector('.wa-body')
      body.querySelector('#wa-rs-loading').style.display = 'none'
      var listEl = body.querySelector('#wa-rs-list')
      listEl.style.display = ''
      body.querySelector('#wa-rs-foot').style.display = ''
      var rows = open.map(function (x) {
        return {
          id: x._id,
          label: (x.match_no ? 'No.' + x.match_no + ' ' : '') + namesOf(x),
          sub: x.slot_at ? fmtSlot(x.slot_at) + (x.table_no ? ' · ' + x.table_no + '号台' : '') : '时间待定'
        }
      })
      rows.push({ id: '', label: '移到最后', sub: '排在全部未开打对阵之后' })
      listEl.innerHTML = rows.map(function (r) {
        return '<div class="wa-rs-opt' + (r.id === '' ? ' is-on' : '') + '" data-id="' + r.id + '">' +
          '<div class="wa-rs-label">' + U.escapeHtml(r.label) + '</div>' +
          '<div class="wa-rs-sub">' + U.escapeHtml(r.sub) + '</div></div>'
      }).join('')
      listEl.addEventListener('click', function (ev) {
        var opt = ev.target.closest('.wa-rs-opt')
        if (!opt) return
        var all = listEl.querySelectorAll('.wa-rs-opt')
        for (var i = 0; i < all.length; i++) all[i].classList.remove('is-on')
        opt.classList.add('is-on')
      })
      body.querySelector('#wa-rs-save').addEventListener('click', function () { saveReorder(card, fixture) })
    }).catch(function (e) {
      var loading = card.querySelector('#wa-rs-loading')
      if (loading) loading.textContent = e.message || '对阵加载失败'
    })
  }

  async function saveReorder(card, fixture) {
    var sel = card.querySelector('.wa-rs-opt.is-on')
    var targetId = sel ? sel.getAttribute('data-id') : ''
    var auth = readAuth()
    if (!auth) {
      U.toast('授权已失效，请重新扫码', 'error')
      pendingFixture = fixture
      startAuth('reorder')
      return
    }
    var btn = card.querySelector('#wa-rs-save')
    btn.disabled = true
    btn.textContent = '保存中…'
    try {
      var params = { fixture_id: fixture._id, web_token: auth.token }
      if (targetId) params.before_fixture_id = targetId
      else params.at_end = true
      await window.AppCloud.call('updateFixture', params)
      closeModal()
      U.toast('已调整排序', 'success')
      if (typeof ctx.onChanged === 'function') ctx.onChanged()
    } catch (e) {
      btn.disabled = false
      btn.textContent = '保存'
      if (!handleAuthError(e)) U.toast('保存失败：' + (e.message || e), 'error')
    }
  }

  // ---------- 入口 ----------
  function init(opts) {
    ctx.getComp = opts && opts.getComp
    ctx.onChanged = opts && opts.onChanged
    var editBtn = document.getElementById('cd-edit-btn')
    var importBtn = document.getElementById('cd-import-btn')
    var daysBtn = document.getElementById('fx-days-edit-btn')
    if (editBtn) editBtn.addEventListener('click', function () { startAuth('edit') })
    if (importBtn) importBtn.addEventListener('click', function () { startAuth('import') })
    if (daysBtn) daysBtn.addEventListener('click', function () { startAuth('days') })
  }

  return { init: init, openReorder: openReorder }
})()
