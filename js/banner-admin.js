/*
 * 轮播图管理页：列表（上移/下移/删除/改时长）+ 全局切换效果设置 + 本地上传 + 微信扫码上传
 * 本地上传/删除/排序/改时长/改效果走 AppAuth.callAuthed('banner_admin', ...)：首次自动弹扫码授权，
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
      render()
      renderSettings()
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

  window.AppUI.fixNav('')
  load()
})()
