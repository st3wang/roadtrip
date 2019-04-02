const util = require('util')
const talib = require('talib');
const talibExecute = util.promisify(talib.execute)
const marketHelper = require('./marketHelper')
const ymdHelper = require('./ymdHelper')

async function getRsi(data,length) {
  var result = await talibExecute({
    name: "RSI",
    inReal: data,
    startIdx: 0,
    endIdx: data.length - 1,
    optInTimePeriod: length
  })

  return Array(length).fill(0).concat(result.result.outReal)
}

// async function getMarket(startYmd,length,interval) {
//   console.log('getMarket',startYmd,length,interval)
//   var ymd = startYmd
//   var opens = [], highs = [], lows = [], closes = []
//   for (var i = 0; i < length; i++) {
//     var path = 'data/candle/' + interval + '/' + ymd + '.json'
//     var marketString = await readFile(path,readFileOptions)
//     var market = JSON.parse(marketString)
//     opens = opens.concat(market.opens)
//     highs = highs.concat(market.highs)
//     lows = lows.concat(market.lows)
//     closes = closes.concat(market.closes)
//     ymd = ymdNextDay(ymd)
//   }
//   return {
//     opens:opens, highs:highs, lows:lows, closes:closes
//   }
// }

function lowest(values,start,length) {
  start++
  var array = values.slice(start-length,start)
  return Math.min.apply( Math, array )
}

function highest(values,start,length) {
  start++
  var array = values.slice(start-length,start)
  return Math.max.apply( Math, array )
}

function pushEnter(trades,type,capital,time,size,price,stopLoss,takeProfit) {
  trades.push([type,Math.round(capital*100)/100,time,Math.round(size*100)/100,Math.round(price*100)/100,Math.round(stopLoss*100)/100,Math.round(takeProfit*100)/100])
}

function popEnter(trades) {
  trades.pop()
}

function pushExit(trades,time,price,profit,capital) {
  var trade = trades[trades.length-1]
  trade.push(time)
  trade.push(Math.round(price*100)/100)
  trade.push(Math.round(profit*100)/100)
  trade.push(Math.round(capital*100)/100)
}

function lowest(values,start,length) {
  start++
  var array = values.slice(start-length,start)
  return Math.min.apply( Math, array )
}

function highest(values,start,length) {
  start++
  var array = values.slice(start-length,start)
  return Math.max.apply( Math, array )
}

function lowestBody(market,start,length) {
  var lowestOpen = lowest(market.opens,start,length)
  var lowestClose = lowest(market.closes,start,length)
  return Math.min(lowestOpen,lowestClose)
}

function highestBody(market,start,length) {
  var highestOpen = highest(market.opens,start,length)
  var highestClose = highest(market.closes,start,length)
  return Math.max(highestOpen,highestClose)
}

function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
}

async function testGetRsiCase() {
  var interval = 15
  var startYMD = '20170101'
  var endYMD = '20190330'
  var setup = {
    rsiLength: 2,
    rsiOverboughtExecute: 80,
    rsiOversold: 55,
    rsiOverbought: 51,
    rsiOversoldExecute: 39,
    stopLossLookBack: 6,
    profitFactor: 200,
    minStopLoss: 6,
    maxStopLoss: 100,
    compound: true,
    skipWin: false,
    enterSameBar: false
  }
  let market = await marketHelper.getMarket('bitmex',interval,startYMD,endYMD)
  market.rsis[setup.rsiLength] = await getRsi(market.closes,setup.rsiLength)
  let startTime = new Date(ymdHelper.YYYY_MM_DD(startYMD)).getTime()
  var overview = await getRsiCase(startTime,interval,market,setup)
  debugger
}

async function getRsiCase(startTime,interval,market,setup) { try {
  var rsiLength = setup.rsiLength,
      rsiOverbought = setup.rsiOverbought,
      rsiOversold = setup.rsiOversold,
      rsiOverboughtExecute = setup.rsiOverboughtExecute,
      rsiOversoldExecute = setup.rsiOversoldExecute,
      stopLossLookBack = setup.stopLossLookBack,
      profitFactor = setup.profitFactor/100,
      minStopLoss = setup.minStopLoss/10000, maxStopLoss = setup.maxStopLoss/10000,
      riskPerTradePercent = 0.01, compound = setup.compound, skipWin = setup.skipWin, enterSameBar = setup.enterSameBar
  var startCapital = 100000
  var capital = startCapital
  var startBar = 96
  var timeIncrement = interval*60000
  var time = startTime + (startBar-1)*timeIncrement
  var rsis = market.rsis[rsiLength]
  var opens = market.opens
  var highs = market.highs
  var lows = market.lows
  var closes = market.closes
  var high, low, close, positionSize=0, absPositionSize=0, entryTime, entryPrice, stopLoss, takeProfit, lossDistance, profitDistance, lossDistancePercent
  var rsi, prsi, longCondition, shortCondition, fee
  var trades = [], drawdowns = [], highestCapital = capital, maxDrawdown = 0, barsInTrade = 0, barsNotInTrade = 0, enterBar = 0, exitBar = startBar
  var missedEntry, missedEntryWin = 0, missedEntryLoose = 0
  // var shortWin = 0, shortLoose = 0, longWin = 0, longLoose = 0
  var winCount = {LONG:0,SHORT:0}, looseCount = {LONG:0,SHORT:0}
  var lossDistancePercentWin = {LONG:0,SHORT:0}, lossDistancePercentLoose = {LONG:0,SHORT:0}
  var entryType, longestMissedEntry = 0, signalBar
  var missedEntryTime = 0
  var capitals = []
  for (var i = 0; i < startBar; i++) {
    capitals[i] = capital //* closes[i]
    drawdowns[i] = 0
  }

  var profitFeeRate = -0.000225, 
      stopFeeRate = 0.000675, 
      entryFeeRate = -0.000225
  // var profitFeeRate = 0, stopFeeRate = 0, entryFeeRate = 0
  var skip = ''
  var bothWinAndLossCount = 0
  var moveStopLossReachedBothSide = 0

  for (var i = startBar; i < rsis.length; i++) {
    time += timeIncrement
    drawdowns[i] = drawdowns[i-1]
    open = opens[i]
    close = closes[i]
    high = highs[i]
    low = lows[i]

    if (absPositionSize == 0) {
      // if (entryType && ((time - entryTime) > (50*60000) && lossDistancePercent > 0.002) || ((time - entryTime) > (4*60*60000))) {
      //   entryType = null
      //   missedEntryTime++
      // }

      switch(entryType) {
        case 'SHORT': {
          // if (high > entryPrice) {
            if (signalBar < i-1) {
              // console.log('enter after signal', i-signalBar)
              // debugger
            }
            positionSize = -(compound ? capital : startCapital) * riskPerTradePercent / lossDistancePercent 
            absPositionSize = -positionSize
            barsNotInTrade += i - exitBar
            enterBar = i
            pushEnter(trades,'SHORT',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
          // }
        } break
        case 'LONG': {
          // if (low < entryPrice) {
            if (signalBar < i-1) {
              // console.log('enter after signal', i-signalBar)
              // debugger
            }
            positionSize = (compound ? capital : startCapital) * riskPerTradePercent / lossDistancePercent 
            absPositionSize = positionSize
            barsNotInTrade += i - exitBar
            enterBar = i
            pushEnter(trades,'LONG',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
          // }
        } break
      }

      if (absPositionSize == 0) {
        let stopLossReached, takeProfitReached 
        switch(entryType) {
          case 'SHORT': {
            stopLossReached = high >= stopLoss
            takeProfitReached = low <= takeProfit
          } break
          case 'LONG': {
            stopLossReached = low <= stopLoss
            takeProfitReached = high >= takeProfit
          } break
        }
        if (stopLossReached || takeProfitReached) {
          entryType = null
          if (takeProfitReached) missedEntryWin++
          if (stopLossReached) missedEntryLoose++
        }
      }
    }

    if (absPositionSize > 0) {
      let stopLossReached, takeProfitReached, moveStopLossReached
      let stopLossFeeRate = stopFeeRate
      if (positionSize > 0) {
        moveStopLossReached = high >= moveStopLoss
      }
      else {
        moveStopLossReached = low <= moveStopLoss
      }

      if (moveStopLossReached) {
        stopLoss = entryPrice
      }

      if (positionSize > 0) {
        stopLossReached = low <= stopLoss
        takeProfitReached = high >= takeProfit
        if (stopLossReached && takeProfitReached) {
          if (moveStopLossReached || close > open) {
            takeProfitReached = false
          }
          else {
            moveStopLossReachedBothSide++
            stopLossReached = false;
          }
        }
      }
      else {
        stopLossReached = high >= stopLoss
        takeProfitReached = low <= takeProfit
        if (stopLossReached && takeProfitReached) {
          if (moveStopLossReached || close < open) {
            takeProfitReached = false
          }
          else {
            stopLossReached = false;
          }
        }
      }

      let cancelTooLong = false
      if (cancelTooLong && !stopLossReached && !takeProfitReached && (
        true
        //((time - entryTime) > (50*60000) && lossDistancePercent > 0.002) 
        //|| 
        //((time - entryTime) > (4*60*60000))
        )) {
        if (positionSize > 0) {
          if (close > entryPrice) {
            takeProfit = Math.min(close,takeProfit)
            profitDistance = takeProfit - entryPrice
            takeProfitReached = true
          }
          else {
            stopLoss = Math.max(close,stopLoss)
            lossDistance = entryPrice - stopLoss
            stopLossReached = true
          }
        }
        else {
          if (close < entryPrice) {
            takeProfit = Math.max(close,takeProfit)
            profitDistance = takeProfit - close
            takeProfitReached = true
          }
          else {
            stopLoss = Math.min(close, stopLoss)
            lossDistance = stopLoss - entryPrice
            stopLossReached = true
          }
        }
      }

      if (stopLossReached && takeProfitReached) {
        // console.log(open,high,low,close,stopLoss,takeProfit)
        // bothWinAndLossCount++
        // debugger
      }

      if (stopLossReached) {
        looseCount[entryType]++
        lossDistancePercentLoose[entryType] += lossDistancePercent
        let profit = -absPositionSize * (lossDistance/entryPrice)
        let profitPercent = profit/capital
        capital += profit
        fee = absPositionSize * entryFeeRate
        capital -= fee
        fee = absPositionSize * stopFeeRate
        capital -= fee
        let drawdown = (capital-highestCapital) / highestCapital 
        drawdowns[i] = drawdown
        maxDrawdown = Math.min(maxDrawdown,drawdown)
        barsInTrade += i - enterBar
        pushExit(trades,time,stopLoss,profitPercent,capital)

        positionSize = absPositionSize = 0
        exitBar = i
        entryType = null
      }
      else if (takeProfitReached) {
        if (skipWin) skip = trades[trades.length-1][0] == 'LONG' ? 'SHORT' : 'LONG'

        winCount[entryType]++
        lossDistancePercentWin[entryType] += lossDistancePercent
        let profit = absPositionSize * (profitDistance/entryPrice)
        let profitPercent = profit/capital
        capital += profit
        fee = absPositionSize * entryFeeRate
        capital -= fee
        fee = absPositionSize * profitFeeRate
        capital -= fee
        highestCapital = Math.max(capital,highestCapital)
        barsInTrade += i - enterBar
        pushExit(trades,time,takeProfit,profitPercent,capital)
 
        positionSize = absPositionSize = 0
        exitBar = i
        entryType = null
      }
    }

    if (!entryType && absPositionSize == 0) {
      rsi = rsis[i]
      prsi = rsis[i-1]
      // riskPerTrade = capital * riskPerTradePercent
      // var lowestLow = lowest(lows,i,stopLossLookBack)
      // var highestHigh = highest(highs,i,stopLossLookBack)
      // shortLossDistance = Math.abs(highest(highs,i,stopLossLookBack) - close)
      shortCondition = prsi > rsiOverboughtExecute && rsi <= rsiOversold 
        // && (highs[i+1] > close || highs[i+2] > close || highs[i+3] > close || highs[i+4] > close ||
          // highs[i+5] > close || highs[i+6] > close || highs[i+7] > close || highs[i+8] > close)
      if (shortCondition) {
        // if (highs[i+1] <= close && highs[i+2] <= close && highs[i+3] <= close && highs[i+4] <= close &&
        //   highs[i+5] <= close && highs[i+6] <= close && highs[i+7] <= close && highs[i+8] <= close) {
        //   marketOrder = true
        // }
        if (skip.indexOf('SHORT') == -1) {
          stopLoss = highestBody(market,i,stopLossLookBack)
          lossDistance = Math.abs(stopLoss - close)
          lossDistancePercent = lossDistance/close
          if (lossDistancePercent >= minStopLoss && lossDistancePercent <= maxStopLoss) {
            signalBar = i
            entryType = 'SHORT'
            entryPrice = close
            entryTime = time
            profitDistance = lossDistance * profitFactor
            takeProfit = entryPrice - profitDistance
            moveStopLoss = entryPrice - profitDistance*1
          }
        }
        skip = ''
      }
      else {
        longCondition = prsi < rsiOversoldExecute && rsi >= rsiOverbought
          // && (lows[i+1] < close || lows[i+2] < close || lows[i+3] < close || lows[i+4] < close ||
            // lows[i+5] < close || lows[i+6] < close || lows[i+7] < close || lows[i+8] < close)
        if (longCondition) {
          // if (lows[i+1] >= close && lows[i+2] >= close && lows[i+3] >= close && lows[i+4] >= close &&
          //   lows[i+5] >= close && lows[i+6] >= close && lows[i+7] >= close && lows[i+8] >= close) {
          //   marketOrder = true
          // }
          if (skip.indexOf('LONG') == -1) {
            stopLoss = lowestBody(market,i,stopLossLookBack)
            lossDistance = Math.abs(close - stopLoss)
            lossDistancePercent = lossDistance/close
            if (lossDistancePercent >= minStopLoss && lossDistancePercent <= maxStopLoss) {
              signalBar = i
              entryType = 'LONG'
              entryPrice = close
              entryTime = time
              profitDistance = lossDistance * profitFactor
              takeProfit = entryPrice + profitDistance
              moveStopLoss = entryPrice + profitDistance*1
            }
          }
          skip = ''
        }
      }
    }
    capitals[i] = capital //* close
  }

  var totalWinCount = winCount.LONG + winCount.SHORT
  var totalLooseCount = looseCount.LONG + looseCount.SHORT
  var totalTrade = totalWinCount + totalLooseCount
  var totalLong = winCount.LONG + looseCount.LONG
  var totalShort = winCount.SHORT + looseCount.SHORT

  console.log('missedEntryTime',missedEntryTime)
  console.log('missedEntryWin',missedEntryWin)
  console.log('missedEntryLoose',missedEntryLoose)
  console.log('totalTrade',totalTrade)
  console.log('totalWinCount',totalWinCount)
  console.log('totalLooseCount',totalLooseCount)
  console.log('totalLong',totalLong)
  console.log('long win',winCount.LONG)
  console.log('long loose',looseCount.LONG)
  console.log('totalShort',totalShort)
  console.log('short win',winCount.SHORT)
  console.log('short loose',looseCount.SHORT)
  console.log('longestMissedEntry',longestMissedEntry)
  console.log('bothWinAndLossCount',bothWinAndLossCount)
  console.log('moveStopLossReachedBothSide',moveStopLossReachedBothSide)
  var lossDistancePercentWinTotal = lossDistancePercentWin.LONG + lossDistancePercentWin.SHORT
  var lossDistancePercentLooseTotal = lossDistancePercentLoose.LONG + lossDistancePercentLoose.SHORT
  var lossDistancePercentTotal = lossDistancePercentWinTotal + lossDistancePercentLooseTotal
  var lossDistancePercentLong = lossDistancePercentWin.LONG + lossDistancePercentLoose.LONG
  var lossDistancePercentShort = lossDistancePercentWin.SHORT + lossDistancePercentLoose.SHORT

  console.log('lossDistancePercentTotal',lossDistancePercentTotal/totalTrade)
  console.log('lossDistancePercentWinTotal',lossDistancePercentWinTotal/totalWinCount)
  console.log('lossDistancePercentLooseTotal',lossDistancePercentLooseTotal/totalLooseCount)
  console.log('lossDistancePercentLong',lossDistancePercentLong/totalLong)
  console.log('loss distance long win',lossDistancePercentWin.LONG/winCount.LONG)
  console.log('loss distance long loose',lossDistancePercentLoose.LONG/looseCount.LONG)
  console.log('lossDistancePercentShort',lossDistancePercentShort/totalShort)
  console.log('loss distance short win',lossDistancePercentWin.SHORT/winCount.SHORT)
  console.log('loss distance short loose',lossDistancePercentLoose.SHORT/looseCount.SHORT)

  return {capitals:capitals,drawdowns:drawdowns,maxDrawdown:maxDrawdown,winRate:totalWinCount/trades.length,totalTrades:trades.length,averageBarsInTrade:barsInTrade/trades.length,averageBarsNotInTrade:barsNotInTrade/trades.length}
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  getRsi: getRsi,
  getRsiCase: getRsiCase,
  testGetRsiCase: testGetRsiCase
}