/*
 * 轮播展示页（1080×2160 竖屏设备全幅播放）
 * - manageBanners list 拉取图片（含 2 小时临时链接），60s 轮询热更新
 * - 淡入淡出自动轮播，默认 6s 一切（?interval=秒 可调）
 * - 页面隐藏时暂停切换与轮询，恢复可见立即刷新（临时链接过期兜底）
 */
(function () {
  var REFRESH_MS = 60 * 1000

  var stage = document.getElementById('bn-stage')
  var dotsBox = document.getElementById('bn-dots')
  var emptyBox = document.getElementById('bn-empty')
  var emptySub = document.getElementById('bn-empty-sub')

  var params = new URLSearchParams(location.search)
  var intervalSec = parseInt(params.get('interval'), 10)
  var ROTATE_MS = (intervalSec >= 3 && intervalSec <= 120 ? intervalSec : 6) * 1000

  var items = []        // [{ id, url }]
  var current = -1
  var rotateTimer = null
  var refreshTimer = null
  var sig = ''          // 列表签名，避免无变化时重建 DOM

  // 幻灯片与常驻元素（占位/指示点/管理入口）同居 #bn-stage：只清幻灯片，且新片插到常驻元素之前保持层叠序
  function clearSlides() {
    Array.prototype.slice.call(stage.querySelectorAll('.bn-slide')).forEach(function (s) { s.remove() })
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
      if (dots[current]) dots[current].classList.remove('on')
    }
    current = (current + 1) % items.length
    if (slides[current]) {
      slides[current].classList.add('is-active')
      if (dots[current]) dots[current].classList.add('on')
    }
    restartRotate()
  }

  function restartRotate() {
    if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null }
    if (items.length > 1 && !document.hidden) {
      rotateTimer = setTimeout(next, ROTATE_MS)
    }
  }

  async function refresh() {
    try {
      var data = await window.AppCloud.call('manageBanners', { action: 'list' })
      var list = (data.banners || []).filter(function (b) { return !!b.url })
      if (!list.length) {
        items = []
        sig = ''
        showEmpty('暂无轮播内容')
        return
      }
      var nextSig = list.map(function (b) { return b.id }).join(',')
      if (nextSig === sig && items.length) return // 内容未变，继续当前播放
      sig = nextSig
      items = list
      render()
    } catch (e) {
      // 云端未连接/失败：有图继续播旧图，无图显示占位
      if (!items.length) showEmpty('云端未连接，稍后再试')
    }
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

  // 触摸/点击手动切换下一张（展示设备点按即可换图；管理入口不触发）
  stage.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#bn-admin')) return
    if (items.length > 1) next()
  })

  refresh()
  restartRefresh()
})()
