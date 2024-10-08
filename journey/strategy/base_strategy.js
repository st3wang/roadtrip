const fs = require('fs')
const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)
const bitmex = require('../exchange/bitmex')
const shoes = require('../shoes')
const { v4 } = require('uuid')
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}
const path = require('path')

const entrySignalFilePath = path.resolve(__dirname, '../data/exchange/entrySignal/YYYYMMDD.json')

const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000
const fundingWindowTime = setup.candle.fundingWindow * oneCandleMS
var cutOffTimeForAll = setup.candle.inTradeMax*60000
var cutOffTimeForLargeTrade = 59*60000

var tradeExchanges
var entrySignals = {}

const {getTimeNow} = global

function getEntrySignalFile(exchange,ymd) {
  return entrySignalFilePath.replace('exchange',exchange).replace('YYYYMMDD',ymd || 'last')
}

function roundPrice(exchange,p,roundFn) {
  roundFn = roundFn || Math.round
  const roundPriceFactor = 1/setup.exchange[exchange.name].tick
  return +((roundFn(p*roundPriceFactor)/roundPriceFactor).toFixed(2))
}

async function getRsi(closes,length) { try {
  // closes = closes.map(c => {return Math.round(c*2)/2})
  var result = await talibExecute({
    name: "RSI",
    inReal: closes,
    startIdx: 0,
    endIdx: closes.length - 1,
    optInTimePeriod: length
  })

  return Array(length).fill(0).concat(result.result.outReal)
} catch(e) {console.error(e.stack||e);debugger} }

async function getSMA(closes,length) { try {
  var result = await talibExecute({
    name: "SMA",
    inReal: closes,
    startIdx: 0,
    endIdx: closes.length - 1,
    optInTimePeriod: length
  })

  return Array(length).fill(0).concat(result.result.outReal)
} catch(e) {console.error(e.stack||e);debugger} }

async function getWilly({highs,lows,closes},length) { try {
  var result = await talibExecute({
    name: "WILLR",
    high: highs,
    low: lows,
    close: closes,
    startIdx: 0,
    endIdx: closes.length - 1,
    optInTimePeriod: length
  })

  return Array(length-1).fill(0).concat(result.result.outReal)
} catch(e) {console.error(e.stack||e);debugger} }

function isFundingWindow(fundingTimestamp) {
  var fundingTime = new Date(fundingTimestamp).getTime()
  var checkFundingPositionTime = fundingTime - fundingWindowTime //1800000
  var now = getTimeNow()
  return (now > checkFundingPositionTime)
}

function isInPositionForTooLong(signal) {
  if (signal) {
    var time = getTimeNow()
    var entryTime = new Date(signal.timestamp).getTime()
    var delta = time-entryTime
    return (delta > cutOffTimeForAll)
     //|| (delta > cutOffTimeForLargeTrade && Math.abs(signal.lossDistancePercent) >= 0.002))
  }
}

function getFee(size,rate,risk) {
  var pay = size*rate
  return {
    isLarge: pay > risk/2,
    pay: pay
  }
}

function exitTooLong({positionSize,signal}) {
  if (positionSize != 0 && isInPositionForTooLong(signal)) {
    return {reason:'toolong'}
  }
}

function exitFunding({positionSize,fundingTimestamp,fundingRate,signal}) {
  var fee = getFee(positionSize,fundingRate,signal.riskAmountUSD)
  if (fee.isLarge && isFundingWindow(fundingTimestamp)) {
    return {reason:'funding',pay:fee.pay,risk:signal.riskAmountUSD}
  }
}

function exitTarget({positionSize,bid,ask,signal}) {
  var {takeProfit} = signal
  if (positionSize > 0) {
    if (ask >= takeProfit) return {price:Math.max(takeProfit,ask),reason:'target'}
  } 
  else if (positionSize < 0) {
    if (bid <= takeProfit) return {price:Math.min(takeProfit,bid),reason:'target'}
  }
}

function exitStop({positionSize,bid,ask,signal}) {
  var {stopLoss} = signal
  if (positionSize > 0) {
    if (ask <= stopLoss) return {price:stopLoss,reason:'stop'}
  } 
  else if (positionSize < 0) {
    if (bid >= stopLoss) return {price:stopLoss,reason:'stop'}
  }
}

function resetEntrySignal(exchange) {
  entrySignals[exchange] = {}
  const entrySignalFile = getEntrySignalFile(exchange)
  if (fs.existsSync(entrySignalFile)) {
    fs.unlinkSync(entrySignalFile)
  }
}

function getEntrySignal(exchange) {
  return entrySignals[exchange]
}

function setEntrySignal(exchange,signal) {
  entrySignals[exchange] = signal
  writeEntrySignal(exchange,signal)
}

function readEntrySignal(exchange) {
  var entrySignalFile = getEntrySignalFile(exchange)
  if (!fs.existsSync(entrySignalFile)) {
    return
  }

  var entrySignalString = fs.readFileSync(entrySignalFile,readFileOptions)
  var entrySignal = JSON.parse(entrySignalString)
  entrySignal.time = new Date(entrySignal.signal.timestamp).getTime()

  var {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal.signal)
  entrySignal.entryOrders = entryOrders
  entrySignal.closeOrders = closeOrders
  entrySignal.takeProfitOrders = takeProfitOrders

  entrySignals[exchange] = entrySignal
}

function writeEntrySignal(exchange,signal) {
  var signalJsonString = JSON.stringify(signal)
  var entrySignalFile = getEntrySignalFile(exchange)
  fs.writeFileSync(entrySignalFile,signalJsonString,writeFileOptions)
  var entrySignalFileLog = getEntrySignalFile(exchange,getTimeNow())
  fs.writeFileSync(entrySignalFileLog,signalJsonString,writeFileOptions)
}

function getEntryExitOrders({orderQtyUSD,entryPrice,stopLoss,stopMarket,takeProfit,takeHalfProfit,scaleInOrders}) {
  var entrySide, exitSide
  if (orderQtyUSD > 0) {
    entrySide = 'Buy'
    exitSide = 'Sell'
  }
  else {
    entrySide = 'Sell'
    exitSide = 'Buy'
  }

  var entryOrders
  if (scaleInOrders && scaleInOrders.length > 0) {
    entryOrders = scaleInOrders.map(o => {
      return {
        price: o.price,
        side: entrySide,
        orderQty: o.size,
        ordType: 'Limit',
        execInst: 'ParticipateDoNotInitiate'
      }
    })
  }
  else {
    entryOrders = [{
      price: entryPrice,
      side: entrySide,
      orderQty: orderQtyUSD,
      ordType: 'Limit',
      execInst: 'ParticipateDoNotInitiate'
    }]
  }

  var exitPriceOffset = (-orderQtyUSD/Math.abs(orderQtyUSD)*setup.candle.tick)
  var closeOrders = [{
    stopPx: stopMarket,
    side: exitSide,
    ordType: 'Stop',
    execInst: 'LastPrice,Close'
  },
  // {
  //   price: stopLoss,
  //   stopPx: stopLoss + exitPriceOffset,
  //   side: exitSide,
  //   ordType: 'StopLimit',
  //   execInst: 'Close,LastPrice,ParticipateDoNotInitiate'
  // },

  // {
  //   price: takeProfit - exitPriceOffset * 2,
  //   stopPx: takeProfit - exitPriceOffset,
  //   side: exitSide,
  //   ordType: 'LimitIfTouched',
  //   execInst: 'Close,LastPrice,ParticipateDoNotInitiate'
  // }
]

  var takeProfitOrders = [{
    price: takeProfit,
    orderQty: orderQtyUSD,
    side: exitSide,
    ordType: 'Limit',
    execInst: 'ParticipateDoNotInitiate,ReduceOnly'
  }]

  // var takeProfitOrders = [{
  //   price: takeProfit,
  //   orderQty: orderQtyUSD/2,
  //   side: exitSide,
  //   ordType: 'Limit',
  //   execInst: 'ParticipateDoNotInitiate,ReduceOnly'
  // },{
  //   price: takeHalfProfit,
  //   orderQty: orderQtyUSD/2,
  //   side: exitSide,
  //   ordType: 'Limit',
  //   execInst: 'ParticipateDoNotInitiate,ReduceOnly'
  // }]

  return {entryOrders:entryOrders,closeOrders:closeOrders,takeProfitOrders:takeProfitOrders}
}

async function init(tradeExchanges) {
  entrySignals.bitmex = {}
  entrySignals.coinbase = {}
  for (let i = 0; i < tradeExchanges.length; i++) {
    const exchange = tradeExchanges[i]
    readEntrySignal(exchange.name)
  }
}

module.exports = {
  init: init,
  roundPrice: roundPrice,
  getRsi: getRsi,
  getSMA: getSMA,
  getWilly: getWilly,
  isFundingWindow: isFundingWindow,
  resetEntrySignal: resetEntrySignal,
  getEntrySignal: getEntrySignal,
  setEntrySignal: setEntrySignal,
  getEntryExitOrders: getEntryExitOrders,
  exitTooLong: exitTooLong,
  exitFunding: exitFunding,
  exitStop: exitStop,
  exitTarget: exitTarget
}
