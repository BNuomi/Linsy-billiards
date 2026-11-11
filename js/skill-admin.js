/*
 * 杆法统计与管理页
 * - getCatalog + getStats 公开只读：展示每项杆法参与人数/掌握人数（聚合数字，无用户信息）
 * - saveSkill / toggleSkill 需 skill_admin 扫码授权（管理员/裁判），经 AppAuth.callAuthed 注入 web_token
 */
(function () {
  var TIERS = [
    { key: 'all', label: '全部' },
    { key: 'basic', label: '基础' },
    { key: 'intermediate', label: '进阶' },
    { key: 'advanced', label: '高阶' }
  ]
  var TIER_LABEL = { basic: '基础', intermediate: '进阶', advanced: '高阶' }

  var state = {
    catalog: [],          // 启用中的目录（getCatalog）
    statsMap: {},         // skill_id → { participant_count, mastered_count }
    activeTier: 'all',
    editing: null         // 正在编辑的目录项；null 表示新增
  }

  function $(id) { return document.getElementById(id) }
  function esc(s) { return window.AppUI ? window.AppUI.escapeHtml(String(s == null ? '' : s)) : String(s) }

  function toast(msg, ok) {
    var el = $('toast')
    el.textContent = msg
    el.style.background = ok === false ? 'rgba(255,59,48,.92)' : 'rgba(0,0,0,.82)'
    el.classList.add('show')
    clearTimeout(toast._t)
    toast._t = setTimeout(function () { el.classList.remove('show') }, 2200)
  }

  // 主题切换（与各管理页一致）
  function initThemeToggle() {
    var btn = $('theme-toggle')
    if (!btn) return
    btn.addEventListener('click', function () {
      var root = document.documentElement
      var dark = root.classList.toggle('dark')
      root.classList.toggle('light', !dark)
      try { localStorage.setItem('billiards-theme', dark ? 'dark' : 'light') } catch (e) {}
    })
  }

  function renderTierTabs() {
    $('tier-tabs').innerHTML = TIERS.map(function (t) {
      return '<button class="tier-tab ' + (state.activeTier === t.key ? 'is-active' : '') +
        '" data-tier="' + t.key + '" type="button">' + t.label + '</button>'
    }).join('')
    Array.prototype.forEach.call(document.querySelectorAll('.tier-tab'), function (b) {
      b.addEventListener('click', function () {
        state.activeTier = b.getAttribute('data-tier')
        renderTierTabs()
        renderTable()
      })
    })
  }

  function renderTable() {
    var rows = state.catalog.filter(function (s) {
      return state.activeTier === 'all' || s.tier === state.activeTier
    })
    var html = rows.map(function (s) {
      var st = state.statsMap[s.skill_id] || { participant_count: 0, mastered_count: 0 }
      return '<tr>' +
        '<td><span class="sk-id">' + esc(s.skill_id) + '</span></td>' +
        '<td><div class="sk-name">' + esc(s.name) + '</div>' +
        '<div class="sk-rule">' + esc(s.success_rule || '—') + '</div></td>' +
        '<td><span class="tier-tag tier-tag-' + s.tier + '">' + (TIER_LABEL[s.tier] || s.tier) + '</span></td>' +
        '<td><span class="num">' + st.participant_count + '</span></td>' +
        '<td><span class="num num--ok">' + st.mastered_count + '</span></td>' +
        '<td>' + (s.enabled === false ? '<span style="color:var(--muted-foreground);">已下架</span>' : '<span style="color:var(--success);">启用中</span>') + '</td>' +
        '<td><div class="row-actions">' +
          '<button class="link-btn" data-act="edit" data-id="' + esc(s.skill_id) + '" type="button">编辑</button>' +
          '<button class="link-btn danger" data-act="toggle" data-id="' + esc(s.skill_id) + '" data-enabled="' + (s.enabled === false ? 'true' : 'false') + '" type="button">' +
            (s.enabled === false ? '重新启用' : '下架') + '</button>' +
        '</div></td>' +
      '</tr>'
    }).join('')
    $('tbody').innerHTML = html || '<tr><td colspan="7" style="text-align:center;color:var(--muted-foreground);padding:40px;">暂无杆法项</td></tr>'

    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (btn) {
      btn.addEventListener('click', onRowAction)
    })
  }

  async function load() {
    $('loading-box').style.display = 'block'
    $('table-wrap').style.display = 'none'
    try {
      var [catalogData, statsData] = await Promise.all([
        window.AppCloud.call('skillPractice', { action: 'getCatalog' }),
        window.AppCloud.call('skillPractice', { action: 'getStats' })
      ])
      state.catalog = catalogData.skills || []
      state.statsMap = {}
      ;(statsData.stats || []).forEach(function (s) {
        state.statsMap[s.skill_id] = s
      })
      $('loading-box').style.display = 'none'
      $('table-wrap').style.display = 'block'
      renderTierTabs()
      renderTable()
    } catch (e) {
      $('loading-box').textContent = '加载失败：' + (e.message || e)
    }
  }

  function openModal(skill) {
    state.editing = skill || null
    $('modal-title').textContent = skill ? '编辑杆法项' : '新增杆法项'
    $('f-skill-id').value = skill ? skill.skill_id : ''
    $('f-skill-id').disabled = !!skill
    $('f-tier').value = skill ? skill.tier : 'basic'
    $('f-name').value = skill ? skill.name : ''
    $('f-desc').value = skill ? (skill.desc || '') : ''
    $('f-rule').value = skill ? (skill.success_rule || '') : ''
    $('f-order').value = skill ? (skill.order || 0) : 0
    $('modal-mask').style.display = 'flex'
  }

  function closeModal() {
    $('modal-mask').style.display = 'none'
    state.editing = null
  }

  async function saveModal() {
    var name = $('f-name').value.trim()
    if (!name) { toast('请填写杆法名称', false); return }
    var payload = {
      action: 'saveSkill',
      skill_id: $('f-skill-id').value.trim(),
      tier: $('f-tier').value,
      name: name,
      desc: $('f-desc').value.trim(),
      success_rule: $('f-rule').value.trim(),
      order: parseInt($('f-order').value, 10) || 0
    }
    var btn = $('modal-save')
    btn.disabled = true
    try {
      await window.AppAuth.ensure('skill_admin')
      await window.AppAuth.callAuthed('skill_admin', 'skillPractice', payload)
      toast('已保存')
      closeModal()
      load()
    } catch (e) {
      toast(e.message || '保存失败', false)
    } finally {
      btn.disabled = false
    }
  }

  async function onRowAction(e) {
    var act = e.currentTarget.getAttribute('data-act')
    var id = e.currentTarget.getAttribute('data-id')
    if (act === 'edit') {
      var skill = state.catalog.find(function (s) { return s.skill_id === id })
      openModal(skill)
    } else if (act === 'toggle') {
      var enabled = e.currentTarget.getAttribute('data-enabled') !== 'false'
      if (!window.confirm(enabled ? '确认重新启用该杆法项？' : '下架后小程序端将不再展示且不可打卡，确认下架？')) return
      try {
        await window.AppAuth.ensure('skill_admin')
        await window.AppAuth.callAuthed('skill_admin', 'skillPractice', {
          action: 'toggleSkill', skill_id: id, enabled: enabled
        })
        toast('已更新')
        load()
      } catch (err) {
        toast(err.message || '操作失败', false)
      }
    }
  }

  function bind() {
    initThemeToggle()
    $('btn-add').addEventListener('click', function () { openModal(null) })
    $('btn-refresh').addEventListener('click', load)
    $('modal-cancel').addEventListener('click', closeModal)
    $('modal-save').addEventListener('click', saveModal)
    $('modal-mask').addEventListener('click', function (e) {
      if (e.target === $('modal-mask')) closeModal()
    })
    // 公共导航链接修复与高亮
    if (window.AppUI && window.AppUI.fixNav) window.AppUI.fixNav('skill')
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind()
    load()
  })
})()
