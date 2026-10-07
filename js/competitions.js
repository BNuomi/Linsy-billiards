/* 比赛列表页：全量比赛卡片（阶段标签 / 对局类型 / 日期 / 简介），点击进详情
 * 排序口径与小程序 pages/competitions 一致：报名中 > 备战中 > 进行中 > 已完成 > 无日期，同阶段按创建时间倒序
 */
;(function () {
  var U = window.AppUI

  var GAME_TYPE_LABEL = { c8: '中八', nine_ball: '九球追分' }
  var PHASE_LABEL = { signup: '报名中', standby: '备战中', live: '进行中', done: '已完成' }
  var PHASE_ORDER = { signup: 0, standby: 1, live: 2, done: 3 }

  function el(id) { return document.getElementById(id) }

  // 阶段推导口径与小程序 utils/competition.js phaseOf 一致
  function phaseOf(comp) {
    var d = new Date()
    function p(n) { return String(n).padStart(2, '0') }
    var t = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    if (comp.end_date && t > comp.end_date) return 'done'
    if (comp.start_date && t >= comp.start_date) return 'live'
    if (comp.start_date) {
      return (comp.signup_deadline && t > comp.signup_deadline) ? 'standby' : 'signup'
    }
    if (comp.end_date) return 'live'
    return null
  }

  async function load() {
    try {
      var data = await window.AppCloud.call('getCompetitions')
      render(data || [])
    } catch (e) {
      showError(e.message || '加载失败，请稍后重试')
    }
  }

  function render(list) {
    var items = list.map(function (comp) {
      return {
        id: comp._id,
        name: comp.name || '未命名比赛',
        description: comp.description || '',
        gameType: comp.game_type || '',
        dateRange: (comp.start_date || comp.end_date)
          ? (comp.start_date || '未定') + ' ~ ' + (comp.end_date || '未定')
          : '',
        venue: comp.venue || '',
        participants: Array.isArray(comp.participants) ? comp.participants.length : 0,
        phase: phaseOf(comp),
        created_at: comp.created_at || 0
      }
    })
    items.sort(function (a, b) {
      var pa = a.phase ? PHASE_ORDER[a.phase] : 4
      var pb = b.phase ? PHASE_ORDER[b.phase] : 4
      if (pa !== pb) return pa - pb
      return b.created_at - a.created_at
    })

    el('cl-subtitle').textContent = items.length ? ('共 ' + items.length + ' 场比赛') : ''
    if (!items.length) {
      el('cl-empty').style.display = ''
      el('cl-list-section').style.display = 'none'
      return
    }
    el('cl-empty').style.display = 'none'
    el('cl-list').innerHTML = items.map(function (it) {
      var chips = ''
      if (it.phase) chips += '<span class="cl-status ' + it.phase + '">' + PHASE_LABEL[it.phase] + '</span>'
      if (it.gameType) chips += '<span class="cl-game ' + it.gameType + '">' + (GAME_TYPE_LABEL[it.gameType] || it.gameType) + '</span>'
      var meta = ''
      if (it.dateRange) meta += '<span><i data-lucide="calendar"></i>' + U.escapeHtml(it.dateRange) + '</span>'
      if (it.venue) meta += '<span><i data-lucide="map-pin"></i>' + U.escapeHtml(it.venue) + '</span>'
      if (it.participants) meta += '<span><i data-lucide="users"></i>' + it.participants + ' 人已报名</span>'
      return '<a class="cl-card" href="./competition-detail.html?id=' + encodeURIComponent(it.id) + '">' +
        '<div class="cl-card-head"><span class="cl-card-name">' + U.escapeHtml(it.name) + '</span>' +
        chips + '<i data-lucide="chevron-right" class="cl-card-arrow"></i></div>' +
        (meta ? '<div class="cl-card-meta">' + meta + '</div>' : '') +
        (it.description ? '<div class="cl-card-desc">' + U.escapeHtml(it.description) + '</div>' : '') +
        '</a>'
    }).join('')
    el('cl-list-section').style.display = ''
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons()
  }

  function showError(msg) {
    el('cl-subtitle').textContent = ''
    el('cl-error').style.display = ''
    el('cl-error-text').textContent = msg
    el('cl-retry').addEventListener('click', function () { window.location.reload() })
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('competitions')
    U.mountCloudBar(load)
    load()
  })
})()
