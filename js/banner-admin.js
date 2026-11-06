/*
 * 轮播图管理页：列表（上移/下移/删除/改时长）+ 全局切换效果设置 + 本地上传 + 微信扫码上传
 * 随机展示页面（#196）：勾选白名单页面加入轮播随机插入，每页独立停留时长/方向/浏览方式，
 *   全局总开关/插入时机/整页跳转兜底；不占 10 张图片名额
 * 本地上传/删除/排序/改时长/改效果/页面配置走 AppAuth.callAuthed('banner_admin', ...)：首次自动弹扫码授权，
 * 云端二次校验管理员/裁判角色；401/403 时 AppAuth 自动清缓存，下次操作重新扫码。
 * 微信扫码上传出码免授权：码无敏感性，上传权限由小程序端 + 云端 OPENID 角色校验把控
 */
(function () {
  var PURPOSE = 'banner_admin'
  var MAX_EDGE = 1920          // 压缩最长边
  var MAX_B64 = 700 * 1024     // 云函数请求体 1MB 上限内留余量
  var QR_POLL_MS = 5000        // 扫码上传弹层打开期间列表轮询间隔

  var listEl = document.getElementById('ba-list')
  var emptyEl = document.getElementById('ba-empty')
  var errEl = document.getElementById('ba-error')
  var errText = document.getElementById('ba-error-text')
  var nEl = document.getElementById('ba-n')
  var hintEl = document.getElementById('ba-hint')
  var uploadBtn = document.getElementById('ba-upload')
  var fileInput = document.getElementById('ba-file')
  var qrBtn = document.getElementById('ba-qr')
  var settingsEl = document.getElementById('ba-settings')
  var settingsMeta = document.getElementById('ba-settings-meta')
  var saveSettingsBtn = document.getElementById('ba-save-settings')

  var banners = []
  var max = 10
  var settings = { effect: 'fade' }
  var defaults = { duration: 5000 }
  var pages = []
  var pageDefaults = null

  function toast(msg, type) { window.AppUI.toast(msg, type) }
  function esc(s) { return window.AppUI.escapeHtml(s) }

  async function callWrite(params) {
    await window.AppAuth.ensure(PURPOSE)
    return window.AppAuth.callAuthed(PURPOSE, 'manageBanners', params)
  }

  async function load() {
    errEl.style.display = 'none'
    try {
      var data = await window.AppCloud.call('manageBanners', { action: 'list' })
      banners = data.banners || []
      max = data.max || 10
      settings = data.settings || { effect: 'fade' }
      if (data.defaults && data.defaults.duration) defaults.duration = data.defaults.duration
      pages = data.pages || []
      pageDefaults = data.page_defaults || null
      render()
      renderSettings()
      renderPages()
    } catch (e) {
      errText.textContent = '轮播图加载失败：' + (e.message || e)
      errEl.style.display = 'block'
    }
  }

  function render() {
    nEl.textContent = banners.length
    document.getElementById('ba-max').textContent = max
    document.getElementById('ba-max2').textContent = max
    var full = banners.length >= max
    uploadBtn.disabled = full
    qrBtn.disabled = full
    hintEl.textContent = full ? '已达上限，请先删除' : ''
    emptyEl.style.display = banners.length ? 'none' : 'block'
    listEl.innerHTML = banners.map(function (b, i) {
      var dur = (b.duration || defaults.duration) / 1000
      return '<div class="ba-item" data-id="' + esc(b.id) + '">' +
        '<div class="ba-thumb">' + (b.url ? '<img src="' + esc(b.url) + '" alt="">' : '') + '</div>' +
        '<div class="ba-info">' +
        '<div class="ba-name">' + esc(b.title || ('轮播图 ' + (i + 1))) + '</div>' +
        '<div class="ba-meta">第 ' + (i + 1) + ' 位 · ' + esc(b.created_by_name || '-') + ' · ' + window.AppUI.fmtDate(b.created_at) + '</div>' +
        '<div class="ba-duration">显示时长 ' +
        '<input type="number" min="1" max="120" step="0.5" value="' + dur + '" data-role="duration" aria-label="显示时长（秒）">' +
        ' 秒 <button class="btn ba-save-duration" type="button" data-act="save-duration">保存</button>' +
        '</div>' +
        '</div>' +
        '<div class="ba-ops">' +
        '<button class="btn" data-act="up" type="button"' + (i === 0 ? ' disabled' : '') + '>上移</button>' +
        '<button class="btn" data-act="down" type="button"' + (i === banners.length - 1 ? ' disabled' : '') + '>下移</button>' +
        '<button class="btn danger" data-act="del" type="button">删除</button>' +
        '</div></div>'
    }).join('')
  }

  function renderSettings() {
    settingsEl.style.display = 'flex'
    var radios = settingsEl.querySelectorAll('input[name=ba-effect]')
    radios.forEach(function (r) { r.checked = r.value === settings.effect })
    var meta = ''
    if (settings.updated_by_name) {
      meta = '最近修改：' + esc(settings.updated_by_name) + ' · ' + window.AppUI.fmtDate(settings.updated_at)
    } else {
      meta = '当前为默认效果（未保存过设置）'
    }
    settingsMeta.innerHTML = meta
  }

  saveSettingsBtn.addEventListener('click', async function () {
    var picked = settingsEl.querySelector('input[name=ba-effect]:checked')
    if (!picked) { toast('请选择切换效果', 'error'); return }
    var effect = picked.value
    saveSettingsBtn.disabled = true
    try {
      await callWrite({ action: 'update_settings', effect: effect })
      toast('切换效果已保存，展示页 1 分钟内自动生效', 'success')
      settings.effect = effect
      load()
    } catch (err) {
      toast('保存失败：' + (err.message || err), 'error')
    } finally {
      saveSettingsBtn.disabled = false
    }
  })

  listEl.addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]')
    if (!btn || btn.disabled) return
    var item = btn.closest('.ba-item')
    var id = item && item.getAttribute('data-id')
    var idx = banners.findIndex(function (b) { return b.id === id })
    if (idx < 0) return
    var act = btn.getAttribute('data-act')

    if (act === 'del') {
      var ok = await window.AppUI.confirmBox('确定删除这张轮播图？删除后展示页将不再播放。', '删除')
      if (!ok) return
      try {
        await callWrite({ action: 'delete', banner_id: id })
        toast('已删除', 'success')
        load()
      } catch (err) { toast('删除失败：' + (err.message || err), 'error') }
      return
    }

    if (act === 'save-duration') {
      var input = item.querySelector('input[data-role=duration]')
      var sec = Number(input && input.value)
      if (!Number.isFinite(sec) || sec < 1 || sec > 120) {
        toast('显示时长需在 1 ~ 120 秒之间', 'error')
        return
      }
      btn.disabled = true
      try {
        await callWrite({ action: 'update', banner_id: id, duration: Math.round(sec * 1000) })
        banners[idx].duration = Math.round(sec * 1000)
        toast('时长已保存', 'success')
      } catch (err) {
        toast('保存失败：' + (err.message || err), 'error')
      } finally {
        btn.disabled = false
      }
      return
    }

    var swap = act === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= banners.length) return
    var ids = banners.map(function (b) { return b.id })
    var t = ids[idx]; ids[idx] = ids[swap]; ids[swap] = t
    // 乐观更新
    var tb = banners[idx]; banners[idx] = banners[swap]; banners[swap] = tb
    render()
    try {
      await callWrite({ action: 'sort', ids: ids })
    } catch (err) {
      toast('排序失败：' + (err.message || err), 'error')
      load() // 回滚以云端为准
    }
  })

  // ---------- 本地上传：压缩 → upload_file ----------
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file)
      var img = new Image()
      img.onload = function () { URL.revokeObjectURL(url); resolve(img) }
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')) }
      img.src = url
    })
  }

  async function compress(file) {
    var img = await loadImage(file)
    var w = img.naturalWidth
    var h = img.naturalHeight
    if (!w || !h) throw new Error('图片尺寸无效')
    var scale = Math.min(1, MAX_EDGE / Math.max(w, h))
    var canvas = document.createElement('canvas')
    var ctx = canvas.getContext('2d')
    var q = 0.85
    for (var attempt = 0; attempt < 8; attempt++) {
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      var dataUrl = canvas.toDataURL('image/jpeg', q)
      var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      if (b64.length <= MAX_B64) return { base64: b64, mime: 'image/jpeg' }
      q -= 0.12
      if (q < 0.4) { q = 0.7; scale *= 0.8 } // 降质不够再缩尺寸
    }
    throw new Error('图片过大，压缩后仍超限，请更换图片')
  }

  uploadBtn.addEventListener('click', function () {
    if (uploadBtn.disabled) return
    fileInput.value = ''
    fileInput.click()
  })

  fileInput.addEventListener('change', async function () {
    var files = Array.prototype.slice.call(fileInput.files || [])
    if (!files.length) return
    files = files.filter(function (f) { return /^image\/(jpeg|png|webp)$/.test(f.type) })
    if (!files.length) {
      toast('仅支持 JPG/PNG/WebP 图片', 'error')
      return
    }
    // 超过剩余名额直接截断并提示
    var remain = max - banners.length
    if (files.length > remain) {
      toast('最多还能上传 ' + remain + ' 张，已自动截取前 ' + remain + ' 张')
      files = files.slice(0, remain)
    }
    uploadBtn.disabled = true
    qrBtn.disabled = true
    var done = 0
    var failMsg = ''
    try {
      await window.AppAuth.ensure(PURPOSE) // 多选只弹一次授权
      for (var i = 0; i < files.length; i++) {
        hintEl.textContent = '正在上传 ' + (i + 1) + ' / ' + files.length + '…'
        try {
          var c = await compress(files[i])
          await window.AppAuth.callAuthed(PURPOSE, 'manageBanners', {
            action: 'upload_file', image_base64: c.base64, mime: c.mime,
            title: files[i].name.replace(/\.[^.]+$/, '')
          })
          done++
        } catch (e) {
          failMsg = e.message || String(e)
          break // 达上限或失败即中止，保留已传部分
        }
      }
      if (done) toast('已上传 ' + done + ' 张' + (failMsg ? '，其余失败：' + failMsg : ''), failMsg ? 'error' : 'success')
      else toast('上传失败：' + failMsg, 'error')
    } catch (e) {
      toast('上传失败：' + (e.message || e), 'error')
    } finally {
      hintEl.textContent = ''
      load() // 刷新列表并恢复按钮态
    }
  })

  // ---------- 微信扫码上传：小程序码弹层 + 轮询刷新 ----------
  function openQrModal() {
    var esc2 = esc
    var mask = document.createElement('div')
    mask.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.36);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;'
    var card = document.createElement('div')
    card.style.cssText = 'width:340px;max-width:100%;background:var(--card,#fff);color:var(--foreground,#1d1d1f);' +
      'border:1px solid var(--border,#e5e5ea);border-radius:18px;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.24);'
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
      '<span style="font-size:16px;font-weight:700;">微信扫码上传</span>' +
      '<button class="qm-close" type="button" aria-label="关闭" style="width:30px;height:30px;border:none;border-radius:999px;' +
      'cursor:pointer;background:var(--secondary,#f2f2f7);color:var(--muted-foreground,#6e6e73);font-size:15px;">×</button></div>' +
      '<div class="qm-body" style="display:flex;flex-direction:column;align-items:center;gap:12px;min-height:220px;justify-content:center;">' +
      '<div style="font-size:13px;color:var(--muted-foreground,#6e6e73);">正在生成小程序码…</div></div>' +
      '<div class="ba-qr-tip" style="margin-top:14px;">微信扫码进入小程序上传页<br>扫码即校验身份，仅管理员/裁判可上传，上传后本页自动刷新</div>'
    mask.appendChild(card)
    document.body.appendChild(mask)

    var pollTimer = null
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
    function close() { stopPoll(); mask.remove() }
    card.querySelector('.qm-close').addEventListener('click', close)
    mask.addEventListener('click', function (e) { if (e.target === mask) close() })

    // 出码免授权：小程序码无敏感性，上传动作由云端 OPENID 角色校验兜底（manageBanners register/upload_file）
    window.AppCloud.call('manageBanners', { action: 'upload_qrcode' }).then(function (d) {
      var body = card.querySelector('.qm-body')
      if (!body || !document.body.contains(mask)) return
      body.innerHTML = '<img alt="小程序上传码" style="width:220px;height:220px;border-radius:12px;' +
        'border:1px solid var(--border,#e5e5ea);background:#fff;" src="' + esc2(d.url) + '">'
      pollTimer = setInterval(function () {
        if (!document.body.contains(mask)) { stopPoll(); return }
        load()
      }, QR_POLL_MS)
    }).catch(function (e) {
      var body = card.querySelector('.qm-body')
      if (body) body.innerHTML = '<div style="font-size:13px;color:var(--state-error,#ff3b30);text-align:center;">' +
        esc2('小程序码生成失败：' + (e.message || e)) + '</div>'
    })
  }

  qrBtn.addEventListener('click', function () {
    if (qrBtn.disabled) return
    openQrModal()
  })

  document.getElementById('ba-retry').addEventListener('click', load)

  // ---------- 随机展示页面配置（#196） ----------
  var bpSection = document.getElementById('bp-section')
  var bpList = document.getElementById('bp-list')
  var bpEnabled = document.getElementById('bp-enabled')
  var bpJump = document.getElementById('bp-jump')
  var bpMode = document.getElementById('bp-insert-mode')
  var bpN = document.getElementById('bp-insert-n')
  var bpNWrap = document.getElementById('bp-n-wrap')
  var bpNSuffix = document.getElementById('bp-n-suffix')
  var bpSaveGlobal = document.getElementById('bp-save-global')
  var bpMeta = document.getElementById('bp-meta')

  var ORIENT_LABEL = { both: '横竖屏', landscape: '仅横屏', portrait: '仅竖屏' }
  var BROWSE_LABEL = { segments: '随机段落跳视', scroll: '平滑滚动', static: '不滚动' }

  function syncNWrap() {
    var mode = bpMode.value
    bpNWrap.style.display = mode === 'after_cycle' ? 'none' : 'inline-flex'
    bpNSuffix.textContent = mode === 'probability' ? '% 概率' : '张图后'
  }

  function renderPages() {
    if (!pageDefaults || !bpSection) return
    bpSection.style.display = 'block'
    bpEnabled.checked = settings.pages_enabled === true
    bpJump.checked = settings.jump_fallback !== false
    bpMode.value = settings.insert_mode || pageDefaults.insert_mode
    bpN.value = settings.insert_n || pageDefaults.insert_n
    syncNWrap()
    bpMeta.textContent = settings.pages_updated_by_name
      ? '策略最近保存：' + esc(settings.pages_updated_by_name) + ' · ' + window.AppUI.fmtDate(settings.pages_updated_at)
      : '当前为默认策略（每轮图片后插 1 页）'

    var minS = Math.round(pageDefaults.min_duration / 1000)
    var maxS = Math.round(pageDefaults.max_duration / 1000)
    bpList.innerHTML = pages.map(function (p) {
      var sec = p.duration / 1000
      var orientOpts = pageDefaults.orientations.map(function (o) {
        return '<option value="' + o + '"' + (o === p.orientation ? ' selected' : '') + '>' + ORIENT_LABEL[o] + '</option>'
      }).join('')
      var browseOpts = pageDefaults.browse_modes.map(function (m) {
        return '<option value="' + m + '"' + (m === p.browse_mode ? ' selected' : '') + '>' + BROWSE_LABEL[m] + '</option>'
      }).join('')
      return '<div class="bp-card ' + (p.enabled ? 'is-on' : 'is-off') + '" data-url="' + esc(p.url) + '">' +
        '<div class="bp-row1">' +
        '<input type="checkbox" class="bp-check" ' + (p.enabled ? 'checked' : '') + ' aria-label="加入随机展示">' +
        '<span class="bp-name">' + esc(p.title) + '</span>' +
        '<span class="bp-tag">' + ORIENT_LABEL[p.catalog_orientation] + '</span>' +
        '</div>' +
        '<div class="bp-controls">' +
        '<label>停留 <input type="number" class="bp-dur" min="' + minS + '" max="' + maxS + '" step="1" value="' + sec + '"> 秒</label>' +
        '<label>方向 <select class="bp-orient">' + orientOpts + '</select></label>' +
        '<label>浏览 <select class="bp-browse">' + browseOpts + '</select></label>' +
        '<button class="btn bp-save" type="button">保存</button>' +
        '</div></div>'
    }).join('')
  }

  // 用云端 save_page 返回的覆盖项合并回内存 pages（保留标题/目录方向等只读字段）
  function mergePageLocal(url, d) {
    var idx = pages.findIndex(function (x) { return x.url === url })
    if (idx < 0 || !d) return
    pages[idx] = {
      url: url,
      title: pages[idx].title,
      catalog_orientation: pages[idx].catalog_orientation,
      enabled: d.enabled,
      duration: d.duration,
      orientation: d.orientation,
      browse_mode: d.browse_mode,
      updated_by_name: d.updated_by_name || '',
      updated_at: d.updated_at || 0
    }
  }

  bpMode.addEventListener('change', syncNWrap)

  bpSaveGlobal.addEventListener('click', async function () {
    var payload = {
      action: 'update_pages_settings',
      pages_enabled: bpEnabled.checked,
      insert_mode: bpMode.value,
      jump_fallback: bpJump.checked
    }
    if (bpMode.value !== 'after_cycle') {
      var n = Number(bpN.value)
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        toast(bpMode.value === 'probability' ? '概率需为 1~100 的整数' : 'N 需为 1~100 的整数', 'error')
        return
      }
      payload.insert_n = Math.round(n)
    }
    bpSaveGlobal.disabled = true
    try {
      await callWrite(payload)
      settings.pages_enabled = payload.pages_enabled
      settings.insert_mode = payload.insert_mode
      settings.insert_n = payload.insert_n || 1
      settings.jump_fallback = payload.jump_fallback
      // 只更新全局控件与提示，不整段 renderPages()：避免冲掉用户刚勾选/刚改但尚未单卡保存的页面状态
      bpEnabled.checked = payload.pages_enabled
      bpJump.checked = payload.jump_fallback !== false
      bpMode.value = payload.insert_mode
      if (payload.insert_n) bpN.value = payload.insert_n
      syncNWrap()
      bpMeta.textContent = '策略已保存 · 展示页 1 分钟内自动生效'
      toast('随机页面策略已保存，展示页 1 分钟内自动生效', 'success')
    } catch (err) {
      toast('保存失败：' + (err.message || err), 'error')
    } finally {
      bpSaveGlobal.disabled = false
    }
  })

  // 勾选/取消即时保存该页（连同卡片当前的时长/方向/浏览方式一并提交），
  // 避免用户只点顶部「保存策略」导致勾选未入库、列表重建后被重置的困惑
  bpList.addEventListener('change', async function (e) {
    if (!e.target.classList.contains('bp-check')) return
    var card = e.target.closest('.bp-card')
    if (!card) return
    var url = card.getAttribute('data-url')
    var p = pages.find(function (x) { return x.url === url })
    if (!p) return
    var check = e.target
    var want = check.checked
    card.classList.toggle('is-on', want)
    card.classList.toggle('is-off', !want)
    check.disabled = true
    try {
      var res = await callWrite({
        action: 'save_page',
        url: url,
        enabled: want,
        duration: p.duration,
        orientation: p.orientation,
        browse_mode: p.browse_mode
      })
      mergePageLocal(url, res.data)
      toast('「' + p.title + '」已' + (want ? '加入' : '移出') + '随机展示', 'success')
    } catch (err) {
      // 失败回滚勾选与卡片高亮
      check.checked = !want
      card.classList.toggle('is-on', !want)
      card.classList.toggle('is-off', want)
      toast('保存失败：' + (err.message || err), 'error')
    } finally {
      check.disabled = false
    }
  })

  bpList.addEventListener('click', async function (e) {
    var btn = e.target.closest('.bp-save')
    if (!btn || btn.disabled) return
    var card = btn.closest('.bp-card')
    var url = card && card.getAttribute('data-url')
    var p = pages.find(function (x) { return x.url === url })
    if (!p) return
    var enabled = card.querySelector('.bp-check').checked
    var sec = Number(card.querySelector('.bp-dur').value)
    var minS = pageDefaults.min_duration / 1000
    var maxS = pageDefaults.max_duration / 1000
    if (!Number.isFinite(sec) || sec < minS || sec > maxS) {
      toast('停留时长需在 ' + minS + ' ~ ' + maxS + ' 秒之间', 'error')
      return
    }
    var orientation = card.querySelector('.bp-orient').value
    var browse_mode = card.querySelector('.bp-browse').value
    btn.disabled = true
    btn.textContent = '保存中'
    try {
      var res = await callWrite({
        action: 'save_page',
        url: url,
        enabled: enabled,
        duration: Math.round(sec * 1000),
        orientation: orientation,
        browse_mode: browse_mode
      })
      mergePageLocal(url, res.data)
      toast('「' + p.title + '」配置已保存', 'success')
      btn.textContent = '已保存'
      setTimeout(function () { btn.textContent = '保存'; btn.disabled = false }, 1200)
    } catch (err) {
      btn.disabled = false
      btn.textContent = '保存'
      toast('保存失败：' + (err.message || err), 'error')
    }
  })

  // ---------- 网页截图（#198）：随机截 5 张站内页面首屏 + 打包下载 ----------
  // 候选池：仅无参数即可独立打开的内容页；排除 banner/banner-admin（自身与展示页）、
  // 带参详情页（match-detail/member-detail/competition-detail/fixtures/competition-live 空态）与 multi-watch（手表端）；
  // practice-board 画板页经实测 html-to-image 序列化失败且首屏为空画布素材价值低，不纳入
  var SHOT_PAGES = [
    { file: 'index.html', name: '首页' },
    { file: 'rankings.html', name: '积分榜' },
    { file: 'match-records.html', name: '对战记录' },
    { file: 'competitions.html', name: '比赛列表' },
    { file: 'points.html', name: '积分说明' },
    { file: 'rules.html', name: '赛事规则' },
    { file: 'practice.html', name: '练球记录' },
    { file: 'pursuit-score.html', name: '九球记分' },
    { file: 'snooker-score.html', name: '斯诺克记分' }
  ]
  var SHOT_W = 1080
  var SHOT_H = 1920
  var SHOT_WAIT_MS = 3200     // iframe load 后再等云函数数据渲染
  var SHOT_TIMEOUT_MS = 20000 // 单页整体超时（加载+等待+渲染）

  var bsList = document.getElementById('bs-list')
  var bsMeta = document.getElementById('bs-meta')
  var bsRefresh = document.getElementById('bs-refresh')
  var downloadBtn = document.getElementById('ba-download')

  var shots = []                    // [{ file, name, blob, thumbUrl, state: pending|ok|err }]
  var shotsGen = 0                  // 代际令牌：换一批时作废旧队列迟到的回调
  var shotsDone = Promise.resolve() // 当前批次全部 settle 的 Promise，打包下载时 await

  function renderShots() {
    bsList.innerHTML = shots.map(function (s) {
      var inner = s.state === 'ok'
        ? '<img src="' + s.thumbUrl + '" alt="">'
        : '<span class="bs-pending">' + (s.state === 'err' ? '生成失败' : '截图中…') + '</span>'
      var cls = s.state === 'ok' ? 'ok' : (s.state === 'err' ? 'err' : '')
      var label = s.state === 'ok' ? '已完成' : (s.state === 'err' ? '打包时自动跳过' : '正在生成')
      return '<div class="bs-card"><div class="bs-thumb">' + inner + '</div>' +
        '<div class="bs-info"><div class="bs-name">' + esc(s.name) + '</div>' +
        '<div class="bs-state ' + cls + '">' + esc(s.file) + ' · ' + label + '</div></div></div>'
    }).join('')
  }

  // 同域隐藏 iframe 加载目标页 → html-to-image（SVG foreignObject，CSS 变量/flex/grid 保真）截首屏
  function shotOne(s, gen) {
    return new Promise(function (resolve) {
      var iframe = document.createElement('iframe')
      iframe.style.cssText = 'position:fixed;left:-12000px;top:0;width:' + SHOT_W + 'px;height:' + SHOT_H + 'px;border:0;'
      iframe.src = './' + s.file
      var settled = false
      function fin(state, blob) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
        if (gen !== shotsGen) return resolve() // 已换批，丢弃结果
        s.state = state
        if (state === 'ok' && blob) {
          s.blob = blob
          s.thumbUrl = URL.createObjectURL(blob)
        }
        renderShots()
        resolve()
      }
      var timer = setTimeout(function () { fin('err') }, SHOT_TIMEOUT_MS)
      iframe.onload = function () {
        setTimeout(function () {
          try {
            var doc = iframe.contentDocument
            if (!doc || !doc.body) { fin('err'); return }
            window.htmlToImage.toBlob(doc.body, {
              width: SHOT_W, height: SHOT_H, pixelRatio: 1,
              canvasWidth: SHOT_W, canvasHeight: SHOT_H
            }).then(function (blob) {
              fin(blob ? 'ok' : 'err', blob)
            }).catch(function () { fin('err') })
          } catch (e) { fin('err') }
        }, SHOT_WAIT_MS)
      }
      iframe.onerror = function () { fin('err') }
      document.body.appendChild(iframe)
    })
  }

  // 串行生成（并行多个重页面 + 截图渲染内存压力大）；进度实时落在 bs-meta
  function startShots() {
    shotsGen++
    var gen = shotsGen
    var pool = SHOT_PAGES.slice()
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1))
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t
    }
    shots = pool.slice(0, 5).map(function (p) {
      return { file: p.file, name: p.name, blob: null, thumbUrl: '', state: 'pending' }
    })
    renderShots()
    shotsDone = (async function () {
      for (var k = 0; k < shots.length; k++) {
        if (gen !== shotsGen) return
        bsMeta.textContent = '截图生成中 ' + (k + 1) + ' / ' + shots.length + '…'
        await shotOne(shots[k], gen)
      }
      var okN = shots.filter(function (s) { return s.state === 'ok' }).length
      bsMeta.textContent = '已生成 ' + okN + ' / ' + shots.length + ' 张'
    })()
  }

  bsRefresh.addEventListener('click', function () { startShots() })

  // ---------- 打包下载（#198）：轮播图原图（image_data base64）+ 网页截图 → 单个 zip ----------
  function pad2(n) { return n < 10 ? '0' + n : '' + n }
  function safeFileName(s) {
    return (String(s || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40)) || 'banner'
  }
  function stamp() {
    var d = new Date()
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes())
  }

  downloadBtn.addEventListener('click', async function () {
    if (downloadBtn.disabled) return
    downloadBtn.disabled = true
    var bannerN = 0
    var shotN = 0
    try {
      var zip = new window.JSZip()
      hintEl.textContent = '正在打包：获取轮播图列表…'
      var data = await window.AppCloud.call('manageBanners', { action: 'list' })
      var items = data.banners || []
      for (var i = 0; i < items.length; i++) {
        hintEl.textContent = '正在打包：轮播图 ' + (i + 1) + ' / ' + items.length + '…'
        try {
          var r = await window.AppCloud.call('manageBanners', { action: 'image_data', file_id: items[i].file_id })
          var m = /\.(jpe?g|png|webp|gif)$/i.exec(items[i].file_id || '')
          var ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
          zip.file('banner-' + pad2(i + 1) + '-' + safeFileName(items[i].title) + '.' + ext, r.base64, { base64: true })
          bannerN++
        } catch (e) { /* 单图失败跳过，不阻塞整包 */ }
      }
      hintEl.textContent = '正在打包：等待网页截图生成…'
      await shotsDone
      for (var k = 0; k < shots.length; k++) {
        if (shots[k].state !== 'ok' || !shots[k].blob) continue
        shotN++
        zip.file('shot-' + pad2(shotN) + '-' + shots[k].file.replace(/\.html$/, '') + '.png', shots[k].blob)
      }
      if (!bannerN && !shotN) { toast('没有可下载的内容', 'error'); return }
      hintEl.textContent = '正在生成 zip…'
      var blob = await zip.generateAsync({ type: 'blob' })
      var a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'banner-pack-' + stamp() + '.zip'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(function () { URL.revokeObjectURL(a.href) }, 30000)
      toast('已导出 ' + bannerN + ' 张轮播图 + ' + shotN + ' 张网页截图', 'success')
    } catch (e) {
      toast('打包失败：' + (e.message || e), 'error')
    } finally {
      hintEl.textContent = ''
      downloadBtn.disabled = false
    }
  })

  window.AppUI.fixNav('')
  load()
  startShots()
})()
