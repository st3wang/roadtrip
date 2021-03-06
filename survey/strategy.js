const util = require('util')
const talib = require('talib');
const talibExecute = util.promisify(talib.execute)

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

async function getRsiCase(startTime,interval,market,setup) { try {
  var rsiLength = setup.rsiLength,
      rsiOverbought = setup.rsiOverbought,
      rsiOversold = setup.rsiOversold,
      rsiOverboughtExecute = setup.rsiOverboughtExecute,
      rsiOversoldExecute = setup.rsiOversoldExecute,
      stopLossLookBack = setup.stopLossLookBack,
      profitFactor = setup.profitFactor/100,
      minStopLoss = setup.minStopLoss/10000, maxStopLoss = setup.maxStopLoss/10000,
      riskPerTradePercent = 0.01, compound = setup.compound
  var startCapital = 100000
  var capital = startCapital
  var startBar = 96
  var timeIncrement = interval*60000
  var time = startTime + (startBar-1)*timeIncrement
  var rsis = market.rsis[rsiLength]
  // var opens = market.opens
  var highs = market.highs
  var lows = market.lows
  var closes = market.closes
  var high, low, close, positionSize=0, absPositionSize=0, entryTime, entryPrice, stopLoss, takeProfit, lossDistance, profitDistance, lossDistancePercent
  var rsi, prsi, longCondition, shortCondition, fee
  var trades = [], drawdowns = [], winCount = 0, highestCapital = capital, maxDrawdown = 0, barsInTrade = 0, barsNotInTrade = 0, enterBar = 0, exitBar = startBar

  // var query = db.startTradeSetup(setup)

  var overbought, oversold

  var capitals = []
  for (var i = 0; i < startBar; i++) {
    capitals[i] = capital //* closes[i]
    drawdowns[i] = 0
  }

  var feeRate = -0.000225, stopFeeRate = 0.000675,
      skipCount = 0, skip = 0, looseCount = 0,looseSkip = 3,skipMax=0

  for (var i = startBar; i < rsis.length; i++) {
    time += timeIncrement
    drawdowns[i] = drawdowns[i-1]
    close = closes[i]
    if (absPositionSize > 0) {
      high = highs[i]
      low = lows[i]
      let stopLossReached, takeProfitReached 
      if (positionSize > 0) {
        stopLossReached = low <= stopLoss
        takeProfitReached = high >= takeProfit
      }
      else {
        stopLossReached = high >= stopLoss
        takeProfitReached = low <= takeProfit
      }
      if (!stopLossReached && !takeProfitReached && 
        (time - entryTime) > (50*60000) && lossDistancePercent > 0.002) {
        if (positionSize > 0) {
          if (close > entryPrice) {
            let profit = absPositionSize * ((close - entryPrice)/close)
            let profitPercent = profit/capital
            if (profitPercent > 0.02) {
              console.log(profitPercent)
              debugger
            }
            takeProfit = close
            profitDistance = close - entryPrice
          }
          else {
            stopLoss = close
            lossDistance = entryPrice - close
          }
        }
        else {
          if (close < entryPrice) {
            let profit = -absPositionSize * ((close - entryPrice)/close)
            let profitPercent = profit/capital
            if (profitPercent > 0.02) {
              console.log(profitPercent)
              debugger
            }
            takeProfit = close
            profitDistance = entryPrice - close
          }
          else {
            stopLoss = close
            lossDistance = close - entryPrice
          }
        }
        // if (close > low)
        // console.log(positionSize)
      }
      if (stopLossReached) {
        looseCount++
        if (looseCount >= looseSkip) {
          skip = skipMax
          looseCount = 0
        }
        fee = absPositionSize * stopFeeRate
        capital -= fee

        let profit = -absPositionSize * (lossDistance/close)
        let profitPercent = profit/capital
        capital += profit
        positionSize = absPositionSize = 0
        let drawdown = (capital-highestCapital) / highestCapital 
        drawdowns[i] = drawdown
        maxDrawdown = Math.min(maxDrawdown,drawdown)
        barsInTrade += i - enterBar
        exitBar = i
        // db.exitTrade(query,time,stopLoss,capital)
        pushExit(trades,time,stopLoss,profitPercent,capital)
      }
      else if (takeProfitReached) {
        looseCount = 0
        fee = absPositionSize * feeRate
        capital -= fee

        winCount++
        let profit = absPositionSize * (profitDistance/close)
        let profitPercent = profit/capital
        capital += profit
        positionSize = absPositionSize = 0
        highestCapital = Math.max(capital,highestCapital)
        barsInTrade += i - enterBar
        exitBar = i
        // db.exitTrade(query,time,takeProfit,capital)
        pushExit(trades,time,takeProfit,profitPercent,capital)
      }
    }
    else {
      rsi = rsis[i]
      prsi = rsis[i-1]
      overbought = overbought || (prsi >= rsiOverbought && rsi < rsiOverbought)
      oversold = oversold || (prsi <= rsiOversold && rsi > rsiOversold)
      // riskPerTrade = capital * riskPerTradePercent
      // var lowestLow = lowest(lows,i,stopLossLookBack)
      // var highestHigh = highest(highs,i,stopLossLookBack)
      // shortLossDistance = Math.abs(highest(highs,i,stopLossLookBack) - close)
      shortCondition = prsi > rsiOverboughtExecute && rsi <= rsiOverboughtExecute //&& overbought
      if (shortCondition) {
        skipCount++
        if (skipCount > skip) {
          skip = 0
          skipCount = 0
          overbought = oversold = false
          entryPrice = close //* (1 - (getRandomInt(5)*0.0001))
          stopLoss = highestBody(market,i,stopLossLookBack)
          lossDistance = Math.abs(stopLoss - close)
          lossDistancePercent = lossDistance/close
          if (lossDistancePercent >= minStopLoss && lossDistancePercent <= maxStopLoss) {
            profitDistance = lossDistance * profitFactor
            // stopLoss = entryPrice + lossDistance // optimize
            takeProfit = entryPrice - profitDistance
  
            // positionSize = (compound ? capital : startCapital) * riskPerTradePercent / lossDistance
            // positionSize = (compound ? capital : startCapital) * entryPrice * riskPerTradePercent / lossDistance
            positionSize = -(compound ? capital : startCapital) * riskPerTradePercent / lossDistancePercent 
            absPositionSize = -positionSize

            fee = absPositionSize * feeRate
            capital -= fee
  
            barsNotInTrade += i - exitBar
            enterBar = i
            // db.enterTrade(query,
              // rsiOverbought,rsiOversold,stopLossLookBack,setup.profitFactor,
              // 'S',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
            
            entryTime = time
            pushEnter(trades,'SHORT',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
          }
        }
      }
      else {
        // longLossDistance = Math.abs(close - lowest(lows,i,stopLossLookBack))
        longCondition = prsi < rsiOversoldExecute && rsi >= rsiOversoldExecute //&& oversold
        if (longCondition) {
          skipCount++
          if (skipCount > skip) {
            skip = 0
            skipCount = 0
            overbought = oversold = false
            entryPrice = close //* (1 + (getRandomInt(5)*0.0001))
            stopLoss = lowestBody(market,i,stopLossLookBack)
            lossDistance = Math.abs(close - stopLoss)
            lossDistancePercent = lossDistance/close
            if (lossDistancePercent >= minStopLoss && lossDistancePercent <= maxStopLoss) {
              profitDistance = lossDistance * profitFactor
              stopLoss = entryPrice - lossDistance
              takeProfit = entryPrice + profitDistance

              positionSize = (compound ? capital : startCapital) * riskPerTradePercent / lossDistancePercent 
              absPositionSize = positionSize

              fee = absPositionSize * feeRate
              capital -= fee

              barsNotInTrade += i - exitBar
              enterBar = i
              // db.enterTrade(query,
                // rsiOverbought,rsiOversold,stopLossLookBack,setup.profitFactor,
                // 'L',capital,time,positionSize,entryPrice,stopLoss,takeProfit)

              entryTime = time
              pushEnter(trades,'LONG',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
            }
          }
        }
      }
    }
    capitals[i] = capital //* close
  }
  // console.log(setup)
  // await db.endTradeSetup(query)
  return {capitals:capitals,drawdowns:drawdowns,maxDrawdown:maxDrawdown,winRate:winCount/trades.length,totalTrades:trades.length,averageBarsInTrade:barsInTrade/trades.length,averageBarsNotInTrade:barsNotInTrade/trades.length}
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  getRsi: getRsi,
  getRsiCase: getRsiCase
}