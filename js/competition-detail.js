/* 比赛（赛事）详情页：只读展示比赛信息 / 统计 / 赛事积分榜 */
;(function () {
  var U = window.AppUI

  function el(id) { return document.getElementById(id) }

  function compId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search || '')
    return m ? decodeURIComponent(m[1]) : ''
  }

  function fmtDate(ts) {
    if (!ts) return '-'
    var d = new Date(ts)
    function p(n) { return String(n).padStart(2, '0') }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  async function load() {
    var id = compId()
    if (!id) {
      showError('缺少比赛参数')
      return
    }
    try {
      var results = await Promise.all([
        window.AppCloud.call('getCompetitionDetail', { competition_id: id }),
        window.AppCloud.call('getRankings', { scope: 'competition', competition_id: id })
      ])
      render(results[0] || {}, results[1] || [])
    } catch (e) {
      showError(e.message || '加载失败，请稍后重试')
    }
  }

  function render(detail, board) {
    var comp = detail.competition || {}
    el('cd-name').textContent = comp.name || '比赛详情'
    el('cd-subtitle').textContent = comp.created_at ? (fmtDate(comp.created_at) + ' 创建') : ''
    document.title = (comp.name || '比赛详情') + ' - 台球协会'

    el('cd-match-count').textContent = detail.match_count != null ? detail.match_count : 0
    el('cd-participant-count').textContent = detail.participant_count != null ? detail.participant_count : 0
    el('cd-created').textContent = fmtDate(comp.created_at)
    el('cd-desc').textContent = comp.description || ''
    el('cd-info-section').style.display = ''

    renderBoard(board)
    el('cd-board-section').style.display = ''
    refreshIcons()
  }

  function renderBoard(list) {
    var tbody = el('cd-tbody')
    if (!list.length) {
      tbody.innerHTML = '<tr class="cd-empty-row"><td colspan="6">该比赛暂无积分数据</td></tr>'
      return
    }
    tbody.innerHTML = list.map(function (m) {
      var total = (m.wins || 0) + (m.losses || 0)
      var badge = m.rank <= 3
        ? '<span class="cd-rank-badge ' + ['gold', 'silver', 'bronze'][m.rank - 1] + '">' + m.rank + '</span>'
        : String(m.rank)
      return '<tr data-id="' + m._id + '">' +
        '<td>' + badge + '</td>' +
        '<td>' + U.escapeHtml(m.name || '未命名') + '</td>' +
        '<td class="cd-points">' + (m.points != null ? m.points : 0) + '</td>' +
        '<td class="cd-num">' + (m.wins || 0) + ' / ' + total + '</td>' +
        '<td class="cd-num">' + (m.clears || 0) + '</td>' +
        '<td class="cd-num">' + (m.winRate || 0) + '%</td></tr>'
    }).join('')
    tbody.querySelectorAll('tr[data-id]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var id = tr.getAttribute('data-id')
        if (id) window.location.href = './member-detail.html?id=' + encodeURIComponent(id)
      })
    })
  }

  function showError(msg) {
    el('cd-subtitle').textContent = ''
    el('cd-error').style.display = ''
    el('cd-error-text').textContent = msg
    var retry = el('cd-retry')
    if (retry) retry.addEventListener('click', function () { window.location.reload() })
  }

  function refreshIcons() {
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons()
  }

  document.addEventListener('DOMContentLoaded', function () {
    U.fixNav('rankings')
    U.mountCloudBar(load)
    load()
  })
})()
