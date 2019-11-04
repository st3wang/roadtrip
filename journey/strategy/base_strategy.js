const fs = require('fs')
const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)
const bitmex = require('../bitmex')
const shoes = require('../shoes')
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const entrySignalFilePath = global.logDir + '/entry_signal.json'

const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000
const fundingWindowTime = setup.candle.fundingWindow * oneCandleMS
var cutOffTimeForAll = setup.candle.inTradeMax*60000
var cutOffTimeForLargeTrade = 59*60000

var mock
if (shoes.mock) mock = require('../mock.js')

var logger, entrySignal
var roundPriceFactor = 1/setup.candle.tick

function getTimeNow() {
  return new Date().getTime()
}

function lowestBody(market,length) {
  var opens = market.opens, closes = market.closes, lows = market.lows
  var lowest = 9999999
  var start = market.closes.length - length
  var end = market.closes.length
  for (var i = start; i < end; i++) {
    var weightedLow = (Math.min(opens[i],closes[i])+lows[i])/2
    if (weightedLow < lowest) {
      lowest = weightedLow
    }
  }
  return lowest
}

function highestBody(market,length) {
  var opens = market.opens, closes = market.closes, highs = market.highs
  var highest = 0
  var start = market.closes.length - length
  var end = market.closes.length
  for (var i = start; i < end; i++) {
    var weightedHigh = (Math.max(opens[i],closes[i])+highs[i])/2
    if (weightedHigh > highest) {
      highest = weightedHigh
    }
  }
  return highest
}

function roundPrice(p) {
  return +((Math.round(p*roundPriceFactor)/roundPriceFactor).toFixed(2))
}

async function getRsi(data,length) { try {
  var result = await talibExecute({
    name: "RSI",
    inReal: data,
    startIdx: 0,
    endIdx: data.length - 1,
    optInTimePeriod: length
  })

  return Array(length).fill(0).concat(result.result.outReal)
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

function resetEntrySignal() {
  entrySignal = {}
  if (fs.existsSync(entrySignalFilePath)) {
    fs.unlinkSync(entrySignalFilePath)
  }
}

function getEntrySignal() {
  return entrySignal
}

function initEntrySignal() {
  entrySignal = {}

  if (!fs.existsSync(entrySignalFilePath)) {
    return
  }

  var entrySignalString = fs.readFileSync(entrySignalFilePath,readFileOptions)
  entrySignal = JSON.parse(entrySignalString)
  entrySignal.time = new Date(entrySignal.timestamp).getTime()

  var {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal)
  entrySignal.entryOrders = entryOrders
  entrySignal.closeOrders = closeOrders
  entrySignal.takeProfitOrders = takeProfitOrders
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
    execInst: 'Close,LastPrice'
  },
  // {
  //   price: stopLoss,
  //   stopPx: stopLoss + exitPriceOffset,
  //   side: exitSide,
  //   ordType: 'StopLimit',
  //   execInst: 'Close,LastPrice,ParticipateDoNotInitiate'
  // },
  {
    price: takeProfit - exitPriceOffset * 2,
    stopPx: takeProfit - exitPriceOffset,
    side: exitSide,
    ordType: 'LimitIfTouched',
    execInst: 'Close,LastPrice,ParticipateDoNotInitiate'
  }]

  var takeProfitOrders = [{
    price: takeProfit,
    orderQty: orderQtyUSD/2,
    side: exitSide,
    ordType: 'Limit',
    execInst: 'ParticipateDoNotInitiate,ReduceOnly'
  },{
    price: takeHalfProfit,
    orderQty: orderQtyUSD/2,
    side: exitSide,
    ordType: 'Limit',
    execInst: 'ParticipateDoNotInitiate,ReduceOnly'
  }]

  return {entryOrders:entryOrders,closeOrders:closeOrders,takeProfitOrders:takeProfitOrders}
}

function writeEntrySignal(entrySignal) {
  return fs.writeFileSync(entrySignalFilePath,JSON.stringify(entrySignal,null,2),writeFileOptions)
}

async function init(_logger) {
  logger = _logger

  initEntrySignal()
  if (mock) {
    getTimeNow = mock.getTimeNow
  }
}

module.exports = {
  init: init,
  roundPrice: roundPrice,
  highestBody: highestBody,
  lowestBody: lowestBody,
  getRsi: getRsi,
  writeEntrySignal: writeEntrySignal,
  resetEntrySignal: resetEntrySignal,
  getEntrySignal: getEntrySignal,
  getEntryExitOrders: getEntryExitOrders,
  exitTooLong: exitTooLong,
  exitFunding: exitFunding,
  exitStop: exitStop,
  exitTarget: exitTarget
}
