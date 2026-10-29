/*
 * 网页端九球追分引擎：与 miniprogram/pages/nine-ball-pursuit/engine.js 严格等价
 * UMD 包装：浏览器挂 window.PursuitEngine；node 测试 require 直接用
 * 支持 2-4 人对局：座位字母 A-D 按人数取前 N 个；两人局时对方同为上家和下家（同座分值叠加）
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PursuitEngine = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  function seatLetters(n) {
    var count = Math.max(2, Math.min(4, Number(n) || 3))
    return ['A', 'B', 'C', 'D'].slice(0, count)
  }

  function validOrder(order) {
    return Array.isArray(order) && order.length >= 2 && order.length <= 4
  }

  function relationsInOrder(order, scorerSeat) {
    var ord = validOrder(order) ? order : ['A', 'B', 'C']
    var n = ord.length
    var i = ord.indexOf(scorerSeat)
    return { shangjiaSeat: ord[(i + n - 1) % n], xiajiaSeat: ord[(i + 1) % n] }
  }

  function nextOrder(order, scoreType, scorerSeat, shangjiaSeat, xiajiaSeat) {
    var ord = validOrder(order) ? order : ['A', 'B', 'C']
    var breaker = nextBreakerSeat(scoreType, scorerSeat, xiajiaSeat)
    var loser = null
    if (scoreType === 'pusheng' || scoreType === 'dajin' || scoreType === 'xiaojin') {
      loser = shangjiaSeat
    } else if (scoreType === 'fangui') {
      loser = scorerSeat
    }
    if (!loser || loser === breaker) {
      return [breaker].concat(ord.filter(function (s) { return s !== breaker }))
    }
    return [breaker, loser].concat(ord.filter(function (s) { return s !== breaker && s !== loser }))
  }

  function calcDeltas(base, opts) {
    var scorer = opts.scorer
    var shangjia = opts.shangjia
    var xiajia = opts.xiajia
    var others = opts.others || []
    var doubled = opts.doubled
    var letBall = opts.letBall
    if (letBall) {
      var r = {}
      r[scorer] = base.scorer * 2
      r[xiajia] = -base.scorer * 2
      return r
    }
    var m = doubled ? 2 : 1
    var deltas = {}
    function add(id, v) { if (id && v) deltas[id] = (deltas[id] || 0) + v * m }
    add(scorer, base.scorer)
    add(shangjia, base.shangjia)
    add(xiajia, base.xiajia)
    for (var i = 0; i < others.length; i++) add(others[i], base.other || 0)
    return deltas
  }

  function defaultScoreConfig(n) {
    var count = Math.max(2, Math.min(4, Number(n) || 3))
    var others = count - 1
    var duo = count === 2 // 两人局：xiajia 与 shangjia 同座，全体扣类型的 xiajia 列置 0 防重复扣
    return {
      kaiqiu_dajin: { scorer: 10 * others, shangjia: -10, xiajia: duo ? 0 : -10, other: -10 },
      dajin: { scorer: 10, shangjia: -10, xiajia: 0, other: 0 },
      xiaojin: { scorer: 7, shangjia: -7, xiajia: 0, other: 0 },
      kaiqiu_hj9: { scorer: 7 * others, shangjia: -7, xiajia: duo ? 0 : -7, other: -7 },
      pusheng: { scorer: 4, shangjia: -4, xiajia: 0, other: 0 },
      fangui: { scorer: -1, shangjia: 1, xiajia: 0, other: 0 }
    }
  }
  var DEFAULT_SCORE_CONFIG = defaultScoreConfig(3)

  var WIN_TYPES = ['kaiqiu_dajin', 'dajin', 'xiaojin', 'kaiqiu_hj9', 'pusheng']
  var ALL_PAY_TYPES = ['kaiqiu_dajin', 'kaiqiu_hj9']

  function nextBreakerSeat(scoreType, scorerSeat, xiajiaSeat) {
    return (WIN_TYPES.indexOf(scoreType) >= 0 || scoreType === 'heibai') ? scorerSeat : xiajiaSeat
  }

  function calcRoundDeltas(scoreConfig, selType, opts, seats) {
    var scorerSeat = opts.scorerSeat
    var doubled = opts.doubled
    var letBall = opts.letBall
    var foulSeats = opts.foulSeats || []
    var order = opts.order
    var negatedType = opts.negatedType

    var seatKeys = Object.keys(seats).filter(function (s) { return seats[s] })
    var ord = (validOrder(order) && order.length === seatKeys.length && order.every(function (s) { return seats[s] }))
      ? order
      : seatKeys
    var rel = relationsInOrder(ord, scorerSeat)
    var shangjiaSeat = rel.shangjiaSeat
    var xiajiaSeat = rel.xiajiaSeat
    var otherSeats = ord.filter(function (s) { return s !== scorerSeat && s !== shangjiaSeat && s !== xiajiaSeat })
    function addSeat(deltas, seat, v) {
      if (!v || !seats[seat]) return
      var id = seats[seat]._id
      deltas[id] = (deltas[id] || 0) + v
    }
    var deltas

    if (selType === 'heibai') {
      var w = scoreConfig[WIN_TYPES.indexOf(negatedType) >= 0 ? negatedType : 'pusheng']
      var f = scoreConfig.fangui
      deltas = {}
      if (ALL_PAY_TYPES.indexOf(negatedType) >= 0) {
        // 原类型为开球大金/黄金九：击球方给出人均分值×其余人数，其余每人各得人均分值，犯规分归上家
        var per = Math.abs(w.shangjia)
        addSeat(deltas, scorerSeat, -per * (ord.length - 1) + (f.scorer || 0))
        for (var i = 0; i < ord.length; i++) {
          if (ord[i] !== scorerSeat) addSeat(deltas, ord[i], per)
        }
        addSeat(deltas, shangjiaSeat, f.shangjia || 0)
      } else {
        addSeat(deltas, scorerSeat, -w.scorer + (f.scorer || 0))
        addSeat(deltas, shangjiaSeat, f.shangjia || 0)
        addSeat(deltas, xiajiaSeat, w.scorer)
      }
    } else {
      deltas = calcDeltas(scoreConfig[selType], {
        scorer: seats[scorerSeat]._id,
        shangjia: seats[shangjiaSeat]._id,
        xiajia: seats[xiajiaSeat]._id,
        others: otherSeats.map(function (s) { return seats[s]._id }),
        doubled: doubled,
        letBall: letBall
      })
    }

    var fb = scoreConfig.fangui
    for (var i = 0; i < foulSeats.length; i++) {
      var fs = foulSeats[i]
      var foul = typeof fs === 'string' ? { seat: fs, letBall: false } : fs
      var seat = foul.seat
      deltas[seats[seat]._id] = (deltas[seats[seat]._id] || 0) + fb.scorer
      if (foul.letBall) {
        var beneSeat = foul.beneficiarySeat && seats[foul.beneficiarySeat] ? foul.beneficiarySeat : xiajiaSeat
        var bid = seats[beneSeat]._id
        deltas[bid] = (deltas[bid] || 0) + fb.shangjia
      } else {
        var foulRel = relationsInOrder(ord, seat)
        deltas[seats[foulRel.shangjiaSeat]._id] = (deltas[seats[foulRel.shangjiaSeat]._id] || 0) + fb.shangjia
        if (fb.xiajia) {
          deltas[seats[foulRel.xiajiaSeat]._id] = (deltas[seats[foulRel.xiajiaSeat]._id] || 0) + fb.xiajia
        }
      }
    }
    return { deltas: deltas, shangjiaSeat: shangjiaSeat, xiajiaSeat: xiajiaSeat }
  }

  return {
    seatLetters: seatLetters,
    relationsInOrder: relationsInOrder,
    nextOrder: nextOrder,
    calcDeltas: calcDeltas,
    defaultScoreConfig: defaultScoreConfig,
    DEFAULT_SCORE_CONFIG: DEFAULT_SCORE_CONFIG,
    WIN_TYPES: WIN_TYPES,
    ALL_PAY_TYPES: ALL_PAY_TYPES,
    nextBreakerSeat: nextBreakerSeat,
    calcRoundDeltas: calcRoundDeltas
  }
})
