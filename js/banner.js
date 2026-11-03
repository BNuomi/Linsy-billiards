/*
 * 轮播展示页（默认 1080×1920 竖屏 9:16 全幅播放，可切横屏 16:9 完整显示；?mode=9:16 / ?mode=16:9 强制锁定）
 * - manageBanners list 拉取图片（含 2 小时临时链接 + 每图 duration + 全局 settings.effect），60s 轮询热更新
 * - 竖屏图片高度优先充满，宽度按原比例自适应居中；横屏 contain 完整显示
 * - 每图按各自 duration 轮播（默认 5s），?interval=秒 可强制统一时长覆盖各图配置
 * - 切换效果 fade / slide / none 由管理页全局设置，?effect=xxx 可对本机覆盖（不写存储）
 * - 坏图兜底：单图加载失败自动跳过不卡屏，全部失败显示占位；链接续期后自动恢复重载
 * - 页面隐藏时暂停切换与轮询，恢复可见立即刷新（临时链接过期兜底）
 * - 显示比例记忆在 localStorage（bn-display-mode），展示设备固定模式免每次重设
 * - 老内核兼容：全文无 ES6+ 语法（qs 替代 URLSearchParams、Promise 链替代 async/await、
 *   removeChild 替代 Element.remove）；舞台高度由 getBoundingClientRect 实测兜底，
 *   body height:100% + overflow:hidden 硬性防底部溢出
 */
(function () {
  var REFRESH_MS = 60 * 1000

  var stage = document.getElementById('bn-stage')
  var dotsBox = document.getElementById('bn-dots')
  var emptyBox = document.getElementById('bn-empty')
  var emptySub = document.getElementById('bn-empty-sub')
  var modeBtn = document.getElementById('bn-mode')

  // 查询参数解析：不用 URLSearchParams（Chrome 49 以下不支持，老内核整页脚本会直接报错）
  function qs(name) {
    var m = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }

  // 显示比例：portrait 竖屏 9:16（1080×1920）cover 全幅占满（默认）/ landscape 横屏 16:9 contain 完整显示
  // 按钮文案显示「目标」比例；URL 参数 ?mode=9:16 / ?mode=16:9 可强制锁定（覆盖本机记忆），适合广告机固定书签
  function applyMode(mode) {
    var landscape = mode === 'landscape'
    document.body.classList.toggle('bn-landscape', landscape)
    if (modeBtn) {
      modeBtn.textContent = landscape ? '9:16' : '16:9'
      modeBtn.title = landscape ? '当前横屏 16:9，点击切回竖屏 9:16' : '当前竖屏 9:16，点击切换到横屏 16:9'
    }
  }
  var urlMode = qs('mode')
  var savedMode = null
  try { savedMode = localStorage.getItem('bn-display-mode') } catch (e) {}
  var initialMode
  if (urlMode === '16:9' || urlMode === 'landscape') initialMode = 'landscape'
  else if (urlMode === '9:16' || urlMode === 'portrait') initialMode = 'portrait'
  else initialMode = savedMode === 'landscape' ? 'landscape' : 'portrait'
  applyMode(initialMode)
  if (modeBtn) {
    modeBtn.addEventListener('click', function (e) {
      e.stopPropagation() // 不触发舞台点按换图
      var next = document.body.classList.contains('bn-landscape') ? 'portrait' : 'landscape'
      applyMode(next)
      try { localStorage.setItem('bn-display-mode', next) } catch (err) {}
    })
  }

  var intervalSec = parseInt(qs('interval'), 10)
  var FORCE_MS = (intervalSec >= 1 && intervalSec <= 120) ? intervalSec * 1000 : 0 // ?interval=秒 强制统一时长，覆盖各图配置
  var DEFAULT_MS = 5000

  // 切换效果：URL ?effect=fade|slide|none 优先（本机覆盖，不写存储），否则跟随管理页全局设置
  var EFFECTS = { fade: 1, slide: 1, none: 1 }
  var urlFx = qs('effect')
  var fxLock = EFFECTS[urlFx] ? urlFx : ''
  // slide 依赖 transform：完全不支持 transform 的老内核强制降级 fade，避免所有图片堆叠
  var probe = document.createElement('div').style
  var canTransform = typeof probe.transform === 'string' || typeof probe.webkitTransform === 'string'
  function applyFx(name) {
    if (name === 'slide' && !canTransform) name = 'fade'
    document.body.classList.toggle('bn-fx-slide', name === 'slide')
    document.body.classList.toggle('bn-fx-none', name === 'none')
  }
  applyFx(fxLock || 'fade')

  // 舞台高度显式兜底：CSS flex 链（body→main→stage flex:1）在广告机等老内核上可能失效，
  // 导致舞台高度塌陷、img height:100% 退化为原图自然高度而底部溢出。
  // 用 getBoundingClientRect 实测舞台顶到视口顶的距离（含导航及一切上方元素），
  // 不假设导航固定 52px；舞台高 = 视口高 - 舞台顶距 - 页脚高。body overflow:hidden 硬性防溢出。
  var footerEl = document.querySelector('.page-footer')
  function fitStage() {
    if (window.scrollTo) window.scrollTo(0, 0) // 先归位，避免残留滚动导致量距偏小
    var top = stage.getBoundingClientRect ? stage.getBoundingClientRect().top : 0
    var footH = footerEl ? footerEl.offsetHeight : 0
    var h = window.innerHeight - top - footH
    stage.style.height = Math.max(h, 100) + 'px'
  }
  fitStage()
  window.addEventListener('resize', fitStage)
  window.addEventListener('orientationchange', fitStage)
  window.addEventListener('load', fitStage)
  // 字体/图标异步渲染、老内核视口晚稳定：前 2 秒多次重算收敛
  setTimeout(fitStage, 300)
  setTimeout(fitStage, 1000)
  setTimeout(fitStage, 2000)

  var items = []        // [{ id, url, duration }]
  var current = -1
  var rotateTimer = null
  var refreshTimer = null
  var sig = ''          // 列表签名，避免无变化时重建 DOM

  // 幻灯片与常驻元素（占位/指示点/管理入口）同居 #bn-stage：只清幻灯片，且新片插到常驻元素之前保持层叠序
  function clearSlides() {
    // 不用 Element.remove()（DOM4，老内核不支持）：removeChild 全兼容
    var ss = stage.querySelectorAll('.bn-slide')
    for (var i = 0; i < ss.length; i++) {
      if (ss[i].parentNode) ss[i].parentNode.removeChild(ss[i])
    }
  }

  function showEmpty(text) {
    clearSlides()
    dotsBox.style.display = 'none'
    emptyBox.style.display = 'flex'
    emptySub.textContent = text || '暂无轮播内容'
  }

  function showStage() {
    emptyBox.style.display = 'none'
  }

  function render() {
    clearSlides()
    dotsBox.innerHTML = ''
    items.forEach(function (it, i) {
      var slide = document.createElement('div')
      slide.className = 'bn-slide'
      var img = document.createElement('img')
      img.src = it.url
      img.alt = it.title || ('轮播图 ' + (i + 1))
      img.onerror = function () {
        it.bad = 1
        if (slide.parentNode) slide.style.display = 'none'
        if (items[current] === it) showEmpty('图片加载失败，请检查图片')
      }
      slide.appendChild(img)
      stage.insertBefore(slide, emptyBox)
      var dot = document.createElement('i')
      dotsBox.appendChild(dot)
    })
    dotsBox.style.display = items.length > 1 ? 'flex' : 'none'
    current = -1
    showStage()
    next()
  }

  function next() {
    if (!items.length) return
    var slides = stage.querySelectorAll('.bn-slide')
    var dots = dotsBox.children
    if (current >= 0 && slides[current]) {
      slides[current].classList.remove('is-active')
      slides[current].classList.add('is-prev') // slide 模式下旧片向左滑出
      if (dots[current]) dots[current].classList.remove('on')
    }
    // 跳过加载失败的坏图
    var n = items.length, tries = 0
    do { current = (current + 1) % n; tries++ } while (items[current] && items[current].bad && tries < n)
    if (items[current] && items[current].bad) {
      showEmpty('图片加载失败，请检查图片')
      return
    }
    if (slides[current]) {
      slides[current].classList.remove('is-prev')
      slides[current].classList.add('is-active')
      if (dots[current]) dots[current].classList.add('on')
    }
    // 滑出动画结束后旧片无过渡归位到右侧待播（fade/none 模式下 is-prev 无样式，归位无副作用）
    setTimeout(function () {
      var olds = stage.querySelectorAll('.bn-slide.is-prev')
      Array.prototype.forEach.call(olds, function (s) {
        s.classList.add('bn-no-tx')
        s.classList.remove('is-prev')
        void s.offsetWidth // 强制回流，确保归位不触发过渡
        s.classList.remove('bn-no-tx')
      })
    }, 850)
    restartRotate()
  }

  function currentDuration() {
    if (FORCE_MS) return FORCE_MS
    var d = items[current] && Number(items[current].duration)
    return (d >= 1000 && d <= 120000) ? d : DEFAULT_MS
  }

  function restartRotate() {
    if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null }
    if (items.length > 1 && !document.hidden) {
      rotateTimer = setTimeout(next, currentDuration())
    }
  }

  // 不用 async/await（ES2017，Chrome 55 以下整页脚本语法报错）：Promise 链全兼容
  function refresh() {
    var p
    try {
      p = window.AppCloud.call('manageBanners', { action: 'list' })
    } catch (e) {
      if (!items.length) showEmpty('云端未连接，稍后再试')
      return
    }
    if (!p || typeof p.then !== 'function') return
    p.then(function (data) {
      // 全局切换效果热更新（URL ?effect= 锁定时不跟随云端）
      if (!fxLock && data.settings && EFFECTS[data.settings.effect]) applyFx(data.settings.effect)
      var list = (data.banners || []).filter(function (b) { return !!b.url })
      if (!list.length) {
        items = []
        sig = ''
        showEmpty('暂无轮播内容')
        return
      }
      var nextSig = list.map(function (b) { return b.id }).join(',')
      if (nextSig === sig && items.length) {
        // 图序未变：就地合并各图时长；临时链接续期或坏图恢复时原地重载 src（不打断当前播放）
        var domImgs = stage.querySelectorAll('.bn-slide img')
        items.forEach(function (it, i) {
          if (!list[i]) return
          it.duration = list[i].duration
          var im = domImgs[i]
          if (im && im.getAttribute('src') !== list[i].url) {
            it.bad = 0
            im.src = list[i].url
            if (im.parentNode) im.parentNode.style.display = ''
          }
        })
        return
      }
      sig = nextSig
      items = list
      render()
    }, function (e) {
      // 云端未连接/失败：有图继续播旧图，无图显示占位
      if (!items.length) showEmpty('云端未连接，稍后再试')
    })
  }

  function restartRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
    refreshTimer = setInterval(function () {
      if (!document.hidden) refresh()
    }, REFRESH_MS)
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null }
    } else {
      refresh() // 恢复可见立即刷新（临时链接可能已过期）
      restartRotate()
    }
  })

  // 触摸/点击手动切换下一张（展示设备点按即可换图；管理入口与比例切换钮不触发）
  stage.addEventListener('click', function (e) {
    if (e.target.closest && (e.target.closest('#bn-admin') || e.target.closest('#bn-mode'))) return
    if (items.length > 1) next()
  })

  refresh()
  restartRefresh()
})()
