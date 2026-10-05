/*
 * 网页版云端接入层（微信云开发 Web SDK · 未登录模式）
 * - 微信云开发环境没有腾讯云版的「身份认证 → 匿名登录」入口，
 *   网页端应使用微信官方 Web SDK 的未登录模式（identityless）
 * - 连接失败时自动降级为内置演示数据（FallbackData），页面仍可浏览
 *
 * 控制台准备（微信开发者工具 → 云开发控制台）：
 * 1. 「设置 → 权限设置 → 未登录用户访问云资源权限设置」打开本环境开关
 * 2. 「云函数 → 权限设置 → 安全规则」放行网页端调用的函数，例如：
 *    {
 *      "getRankings":     { "invoke": true },
 *      "getMatches":      { "invoke": true },
 *      "getOverview":     { "invoke": true },
 *      "getMemberDetail": { "invoke": true },
 *      "seedDemoData":    { "invoke": true }
 *    }
 *    （未登录模式下简易权限配置不生效，必须使用安全规则）
 */
window.AppCloud = (function () {
  var ENV = 'cloud1-6grlhnlnc6c57e90'
  var RESOURCE_APPID = 'wx635ed0ddb3af64e4'
  var SDK_URL = 'https://res.wx.qq.com/open/js/cloudbase/1.1.0/cloud.js'
  var state = { online: false, sdkReady: false, degraded: false, reason: '', app: null }
  var readyPromise = null

  function notifyStateChanged() {
    try {
      document.dispatchEvent(new CustomEvent('appcloud:statechanged'))
    } catch (_) { /* noop */ }
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise(function (resolve, reject) {
        setTimeout(function () { reject(new Error((label || '操作') + '超时')) }, ms)
      })
    ])
  }

  function loadScript(src, ms) {
    return new Promise(function (resolve, reject) {
      if (window.cloud) return resolve()
      var s = document.createElement('script')
      s.src = src
      s.onload = function () { resolve() }
      s.onerror = function () { reject(new Error('SDK 加载失败')) }
      document.head.appendChild(s)
      setTimeout(function () {
        if (!window.cloud) reject(new Error('SDK 加载超时'))
      }, ms)
    })
  }

  async function init() {
    try {
      await loadScript(SDK_URL, 10000)
      var app = new window.cloud.Cloud({
        // 未登录模式：网页端无微信登录态，公开只读浏览
        identityless: true,
        resourceAppid: RESOURCE_APPID,
        resourceEnv: ENV
      })
      // init 过程中会调用资源方环境下的 cloudbase_auth 函数完成授权确认
      await withTimeout(app.init(), 10000, '云环境初始化')
      state.app = app
      state.sdkReady = true
      state.online = true
    } catch (e) {
      state.online = false
      state.sdkReady = false
      state.reason = (e && e.message) ? e.message : String(e)
      console.warn('[AppCloud] 云端连接失败，使用本地演示数据：', state.reason)
    }
    return state
  }

  function ready() {
    if (!readyPromise) readyPromise = init()
    return readyPromise
  }

  /*
   * 与小程序端 utils/cloud.js 相同的调用约定：
   * 云函数返回 { code: 0, data } 视为成功，其余抛错
   * 读接口（get*）云端调用失败时自动降级为本地演示数据；
   * 写接口（seedDemoData）失败时抛出真实错误
   */
  async function call(name, data) {
    await ready()
    if (state.sdkReady) {
      try {
        var res = await withTimeout(state.app.callFunction({ name: name, data: data || {} }), 15000, '云函数调用')
        var r = res.result || {}
        if (r.code === 0) {
          // 调用成功后若之前处于降级状态则恢复
          if (state.degraded) {
            state.degraded = false
            state.online = true
            state.reason = ''
            notifyStateChanged()
          }
          return r.data
        }
        var bErr = new Error(r.message || '云函数返回异常')
        bErr.code = r.code
        throw bErr
      } catch (e) {
        // 业务错误（云函数正常响应但返回非零 code，如「对局已结束」）不属于离线场景：
        // 不降级本地演示数据，原样抛出由调用方处理，避免真实业务语义被吞
        if (e && typeof e.code === 'number') throw e
        if (window.FallbackData && /^get/.test(name)) {
          console.warn('[AppCloud] 云端调用失败，降级为本地演示数据：', name, e)
          degrade(errText(e))
          return window.FallbackData.respond(name, data || {})
        }
        throw e instanceof Error ? e : new Error(errText(e))
      }
    }
    if (window.FallbackData) {
      return window.FallbackData.respond(name, data || {})
    }
    throw new Error('云端未连接且无本地演示数据')
  }

  // 读接口调用失败仅标记降级（不阻断后续写接口尝试），并通知状态栏重绘
  function degrade(reason) {
    state.degraded = true
    state.online = false
    state.reason = reason
    notifyStateChanged()
  }

  function errText(e) {
    if (!e) return '未知错误'
    if (typeof e === 'string') return e
    // SDK 网络/权限错误的详细信息在 errMsg（message 通常只是 'Error'），优先提取
    if (e.errMsg) return e.errMsg
    if (e.message && e.message !== 'Error') return e.message
    if (e.msg) return e.msg
    if (e.code !== undefined && e.message === undefined) return '请求失败（' + e.code + '）'
    if (e.message) return e.message
    try { return JSON.stringify(e) } catch (_) { return String(e) }
  }

  return {
    call: call,
    ready: ready,
    ENV: ENV,
    status: function () {
      return { online: state.online, sdkReady: state.sdkReady, reason: state.reason }
    }
  }
})()
