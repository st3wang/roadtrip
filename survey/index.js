const util = require('util')
const http = require('http')
const fs = require('fs')
const gunzip = require('gunzip-file')
var padStart = require('string.prototype.padstart');
padStart.shim();

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const csvParse = require('csv-parse')
const csvStringify = require('csv-stringify')

const talib = require('talib');
const talibExecute = util.promisify(talib.execute)

const db = require('./db')
const roadmap = require('./roadmap');
const historyStartYmd = 20170101

const filePath = 'data/trade/YYYYMMDD.csv'
const symbol = 'XBTUSD'

const ENTER_TYPE = 0
const ENTER_CAPITAL = 1
const ENTER_TIME = 2
const ENTER_SIZE = 3
const ENTER_PRICE = 4
const STOP_LOSS = 5
const TAKE_PROFIT = 6
const EXIT_TIME = 7
const EXIT_PRICE = 8
const EXIT_PROFIT = 9
const EXIT_CAPITAL = 10

function getCleanedTradeFile(ymd) {
  return filePath.replace('YYYYMMDD',ymd+'_'+symbol)
}

function writeCleanedFile(ymd,output) {
  var writePath = getCleanedTradeFile(ymd)
  csvStringify(output, async (err, outputString) => {
    await writeFile(writePath,outputString,writeFileOptions)
    console.log('done writing', ymd, symbol)
  })
}

function readAndParseCleanUp(ymd) {
  return new Promise((resolve, reject) => {
    const readPath = filePath.replace('YYYYMMDD',ymd)
    const data = [];
    fs.createReadStream(readPath).pipe(csvParse())
      .on('data', (record) => {
        if (record[1] === symbol) {
          var timeString = record[0].slice(0,23).replace('D',' ').replace('.',':')
          var timeLocal = new Date(timeString)
          var timeGMT = new Date(timeLocal.valueOf() - timeLocal.getTimezoneOffset() * 60000)
          data.push([timeGMT.getTime(),record[2][0],record[3],record[4]])
        }
      })
      .on('error', e => reject(e))
      .on('end', () => resolve(data));
  });
}

function readAndParseForCandle(ymd) {
  return new Promise((resolve, reject) => {
    const readPath = filePath.replace('YYYYMMDD',ymd+'_'+symbol)
    const data = [];
    fs.createReadStream(readPath).pipe(csvParse())
      .on('data', (record) => {
        data.push({
          time: parseInt(record[0]),
          size: parseInt(record[2]),
          price: parseFloat(record[3])
        })
      })
      .on('error', e => reject(e))
      .on('end', () => {
        resolve(data)});
  });
}

function readAndParseOBOSCases(readPath) {
  return new Promise((resolve, reject) => {
    const data = [];
    fs.createReadStream(readPath).pipe(csvParse())
      .on('data', (record) => {
        if (record[0] !== 'rsiLength') {
          record[6] = parseFloat(record[6])
          data.push(record)
        }
      })
      .on('error', e => reject(e))
      .on('end', () => {
        resolve(data)});
  });
}

function getGroups(trades,startTime,interval) {
  return new Promise((resolve, reject) => {
    var groups = []
    var len = 24*60/interval;
    for (var i = 0; i < len; i++) {
      groups[i] = []
    }

    var intervalMS = interval*60*1000

    trades.forEach(trade => {
      try {
        var i = Math.floor((trade.time-startTime) / intervalMS)
        groups[i].push(trade)
      }
      catch(e) {
        console.log(new Date(trade.time))
        console.log(e)
        debugger
      }
    })
    resolve(groups)
  })
}

function getCandles(groups,startTime,interval) {
  return new Promise((resolve, reject) => {
    var intervalMS = interval*60*1000
    var candles = []
    var opens = [], highs = [], lows = [], closes = []
    groups.forEach((group,i) => {
      let candle = {
        time: startTime + intervalMS*i,
        open: null,
        high: null,
        low: null,
        close: null
      }
      if (group.length > 0) {
        try {
          candle.open = candle.high = candle.low = group[0].price
          candle.close = group[group.length-1].price
          candle = group.reduce((a,c) => {
            if (c.price > a.high) a.high = c.price
            if (c.price < a.low) a.low = c.price
            return a
          },candle)
          if (!candle.open || !candle.close || !candle.high || !candle.low) {
            debugger
          }
        }
        catch(e) {
          debugger
        }
      }
      candles.push(candle)
      opens.push(candle.open)
      highs.push(candle.high)
      lows.push(candle.low)
      closes.push(candle.close)
    })
    resolve({opens:opens, highs:highs, lows:lows, closes:closes, candles:candles})
  })
}

async function getCandleDay(ymd,interval) {
  console.log('getCandleDay',ymd,interval)
  var trades = await readAndParseForCandle(ymd)
  var startTimeGMT = new Date(YYYY_MM_DD(ymd))
  var startTimeGMTMS = startTimeGMT.getTime()
  var groups = await getGroups(trades,startTimeGMTMS,interval)
  var candles = await getCandles(groups,startTimeGMTMS,interval)
  return candles
}

function downloadTradeDay(ymd) {
  return new Promise((resolve, reject) => {
    const request = http.get(roadmap.url + ymd + '.csv.gz', function(response) {
      const csvFilename = 'data/trade/' + ymd + '.csv'
      const gzFilename = csvFilename + '.gz'
      const ws = fs.createWriteStream(gzFilename);
      response.pipe(ws)
      ws.on('finish', _ => {
        gunzip(gzFilename, csvFilename, _ => {
          console.log(ymd + ' gunzipped')
          fs.unlink(gzFilename,_=>{});
          resolve(csvFilename)
        })
      })
    })
  })
}

function getYmd(ymd) {
  var y = Math.floor(ymd / 10000)
  var m = Math.floor((ymd - y * 10000) / 100)
  var d = ymd - y * 10000 - m * 100
  return {y:y,m:m,d:d}
}

function YYYY_MM_DD(ymd) {
  var date = getYmd(ymd)
  return date.y + '-' + padStart(date.m,2,'0') + '-' + padStart(date.d,2,'0')
}

function ymdNextDay(ymd) {
  var date = getYmd(ymd)
  var y = date.y, m = date.m, d = date.d
  var maxDay = 30
  switch (m) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      maxDay = 31
      break;
    case 2:
      maxDay = (y % 4 == 0 ? 29 : 28)
      break;
  }

  if (++d > maxDay) {
    d = 1
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return y*10000 + m*100 + d
}

async function downloadTradeData(startYmd,endYmd) {
  var ymd = startYmd
  while (ymd <= endYmd) {
    const cleanedTradeFile = getCleanedTradeFile(ymd)
    if (fs.existsSync(cleanedTradeFile)) {
      console.log('skip',cleanedTradeFile)
    }
    else {
      const csvFilename = await downloadTradeDay(ymd)
      const trades = await readAndParseCleanUp(ymd)
      fs.unlink(csvFilename,_=>{})
      writeCleanedFile(ymd,trades)
    }
    ymd = ymdNextDay(ymd)
  }
}

async function generateCandleDayFiles(startYmd,endYmd,interval) {
  var ymd = startYmd
  while (ymd <= endYmd) {
    var writePath = 'data/candle/' + interval + '/' + ymd + '.json'
    if (fs.existsSync(writePath)) {
      console.log('skip',writePath)
    }
    else {
      var candles = await getCandleDay(ymd,interval)
      if (candles.opens.length != 96 || candles.highs.length != 96 || candles.lows.length != 96 || candles.closes.length != 96 || candles.candles.length != 96) {
        debugger
      }
      var candlesString = JSON.stringify(candles)
      await writeFile(writePath,candlesString,writeFileOptions)
      console.log('done writing', writePath)
    }
    ymd = ymdNextDay(ymd)
  }
}

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

function testMarket(market) {
  var opens = [], highs = [], lows = [], closes = []
  var len = market.opens.length
  var i = 0
  var last
  while (i < len) {
    opens.push(market.opens[i])
    closes.push(market.closes[i+3])
    let high = market.highs[i]
    let low = market.lows[i]
    i++
    for (var last = i+3; i < last; i++) {
      if (market.highs[i] > high) high = market.highs[i]
      if (market.lows[i] < low) low = market.lows[i] 
    }
    highs.push(high)
    lows.push(low)
  }

  var testIndex = 100*24
  console.log('==============',testIndex)
  console.log(opens[testIndex])
  console.log(highs[testIndex])
  console.log(lows[testIndex])
  console.log(closes[testIndex])
  testIndex++
  console.log('==============',testIndex)
  console.log(opens[testIndex])
  console.log(highs[testIndex])
  console.log(lows[testIndex])
  console.log(closes[testIndex])
  testIndex++
  console.log('==============',testIndex)
  console.log(opens[testIndex])
  console.log(highs[testIndex])
  console.log(lows[testIndex])
  console.log(closes[testIndex])
  testIndex++
  console.log('==============',testIndex)
  console.log(opens[testIndex])
  console.log(highs[testIndex])
  console.log(lows[testIndex])
  console.log(closes[testIndex])
  testIndex++
  console.log('==============',testIndex)
  console.log(opens[testIndex])
  console.log(highs[testIndex])
  console.log(lows[testIndex])
  console.log(closes[testIndex])

  debugger
}

async function getMarket(startYmd,length,interval) {
  console.log('getMarket',startYmd,length,interval)
  var ymd = startYmd
  var opens = [], highs = [], lows = [], closes = []
  for (var i = 0; i < length; i++) {
    var path = 'data/candle/' + interval + '/' + ymd + '.json'
    var marketString = await readFile(path,readFileOptions)
    var market = JSON.parse(marketString)
    opens = opens.concat(market.opens)
    highs = highs.concat(market.highs)
    lows = lows.concat(market.lows)
    closes = closes.concat(market.closes)
    ymd = ymdNextDay(ymd)
  }
  return {
    opens:opens, highs:highs, lows:lows, closes:closes
  }
}

async function generateMarketData(startYmd,endYmd,interval) {
  console.log('generateMarketData',startYmd,endYmd,interval)
  var opens = [], highs = [], lows = [], closes = []
  for (var ymd = startYmd; ymd <= endYmd; ymd = ymdNextDay(ymd)) {
    var path = 'data/candle/' + interval + '/' + ymd + '.json'
    var marketString = await readFile(path,readFileOptions)
    var market = JSON.parse(marketString)
    opens = opens.concat(market.opens)
    highs = highs.concat(market.highs)
    lows = lows.concat(market.lows)
    closes = closes.concat(market.closes)
  }
  var rsis = []
  rsis[11] = await getRsi(closes,11)
  rsis[12] = await getRsi(closes,12)
  rsis[13] = await getRsi(closes,13)
  rsis[14] = await getRsi(closes,14)
  return {
    opens:opens, highs:highs, lows:lows, closes:closes, rsis:rsis
  }
}

async function updateMarketData() {
  var interval = 15
  var startYmd = historyStartYmd
  var endYmd = 20190223
  await downloadTradeData(startYmd,endYmd)
  await generateCandleDayFiles(startYmd,endYmd,interval)
  // var market = await generateMarketData(startYmd,endYmd,interval)
  // var marketString = JSON.stringify(market)
  // var path = 'data/market/'+interval+'/market.json'
  // await writeFile(path,marketString,writeFileOptions)
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

async function getRsiCase(startTime,interval,market,setup) {
  var query = db.startTradeSetup(setup)
  var rsiLength = setup.rsiLength,
      rsiOverbought = setup.rsiOverbought,
      rsiOversold = setup.rsiOversold,
      stopLossLookBack = setup.stopLossLookBack,
      profitFactor = setup.profitFactor/100,
      minimumStopLoss = 0.001, riskPerTradePercent = 0.01
  var capital = 100
  var startBar = 96
  var timeIncrement = interval*60000
  var time = startTime + (startBar-1)*timeIncrement
  var rsis = market.rsis[rsiLength]
  // var opens = market.opens
  var highs = market.highs
  var lows = market.lows
  var closes = market.closes
  var high, low, close, positionSize, entryPrice, stopLoss, takeProfit, lossDistance, profitDistance
  var rsi, prsi, longCondition, shortCondition
  //var trades = [], winCount = 0, highestCapital = capital, maxDrawdown = 0, barsInTrade = 0, barsNotInTrade = 0, enterBar = 0, exitBar = startBar

  for (var i = startBar; i < rsis.length; i++) {
    time += timeIncrement
    if (positionSize > 0) {
      high = highs[i]
      low = lows[i]
      if (stopLoss >= low && stopLoss <= high) {
        let profit = -positionSize * lossDistance
        let profitPercent = profit/capital*100
        capital += profit
        positionSize = 0
        // let drawdown = (capital-highestCapital) / highestCapital 
        // maxDrawdown = Math.min(maxDrawdown,drawdown)
        // barsInTrade += i - enterBar
        // exitBar = i
        db.exitTrade(query,time,takeProfit,profitPercent,capital)
        // pushExit(trades,time,stopLoss,profitPercent,capital)
      }
      else if (takeProfit >= low && takeProfit <= high) {
        // winCount++
        let profit = positionSize * profitDistance
        let profitPercent = profit/capital*100
        capital += profit
        positionSize = 0
        // highestCapital = Math.max(capital,highestCapital)
        // barsInTrade += i - enterBar
        // exitBar = i
        db.exitTrade(query,time,takeProfit,profitPercent,capital)
        // pushExit(trades,time,takeProfit,profitPercent,capital)
      }
    }
    else {
      rsi = rsis[i]
      prsi = rsis[i-1]
      close = closes[i]
      // riskPerTrade = capital * riskPerTradePercent
      // var lowestLow = lowest(lows,i,stopLossLookBack)
      // var highestHigh = highest(highs,i,stopLossLookBack)
      // shortLossDistance = Math.abs(highest(highs,i,stopLossLookBack) - close)
      shortCondition = prsi > rsiOverbought && rsi <= rsiOverbought 
        && Math.abs(highest(highs,i,stopLossLookBack) - close)/close >= minimumStopLoss
      if (shortCondition) {
        entryPrice = close
        lossDistance = Math.abs(highest(highs,i,stopLossLookBack) - close)
        profitDistance = lossDistance * profitFactor
        stopLoss = entryPrice + lossDistance // optimize
        takeProfit = entryPrice - profitDistance
        positionSize = capital * riskPerTradePercent / lossDistance
        // barsNotInTrade += i - exitBar
        // enterBar = i
        db.enterTrade(query,
          rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,
          'SHORT',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
        // pushEnter(trades,'SHORT',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
      }
      else {
        // longLossDistance = Math.abs(close - lowest(lows,i,stopLossLookBack))
        longCondition = prsi < rsiOversold && rsi >= rsiOversold 
          && Math.abs(close - lowest(lows,i,stopLossLookBack))/close >= minimumStopLoss
        if (longCondition) {
          entryPrice = close
          lossDistance = Math.abs(close - lowest(lows,i,stopLossLookBack))
          profitDistance = lossDistance * profitFactor
          stopLoss = entryPrice - lossDistance
          takeProfit = entryPrice + profitDistance
          positionSize = capital * riskPerTradePercent / lossDistance
          // barsNotInTrade += i - exitBar
          // enterBar = i
          db.enterTrade(query,
            rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,
            'LONG',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
          // pushEnter(trades,'LONG',capital,time,positionSize,entryPrice,stopLoss,takeProfit)
        }
      }
    }
  }
  console.log(setup)
  await db.endTradeSetup(query)
  return
  // return {
  //   setup: {
  //     startTime:startTime,interval:interval,rsiLength:rsiLength,rsiOverbought:rsiOverbought,rsiOversold:rsiOversold,
  //     stopLossLookBack:stopLossLookBack,profitFactor:profitFactor,minimumStopLoss:minimumStopLoss
  //   },
  //   overview: {
  //     netProfit:(capital-100),
  //     winRate:(winCount/trades.length*100),
  //     maxDrawdown:(maxDrawdown*100),
  //     averageBarsInTrade:barsInTrade/trades.length, 
  //     averageBarsNotInTrade:barsNotInTrade/trades.length
  //   },
  //   trades:trades
  // }
}

function getRsiCaseFilePath(startYmd,endYmd,interval,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor) {
  return 'data/case/rsi/'+startYmd+'_'+interval+'/'+
    rsiLength+'_'+rsiOverbought+'_'+rsiOversold+'_'+stopLossLookBack+'_'+profitFactor+'.json'
}

function getRsiCaseFileDir(startYmd,length,interval,rsiOverbought,rsiOversold) {
  return 'data/case/rsi/'+startYmd+'_'+length+'_'+interval+'/'+rsiOverbought+'_'+rsiOversold+'/'
}

function fillMarketNull(market) {
  var closes = market.closes
  var len = closes.length
  for (var i = 0; i < len; i++) {
    if (closes[i] == null) {
      closes[i] = closes[i-1]
    }
  }
}

async function generateRsiCaseFiles(startYmd,endYmd,interval,config) {
  var startTime = new Date(YYYY_MM_DD(startYmd)).getTime()
  var market = await generateMarketData(startYmd,endYmd,interval)
  fillMarketNull(market)
  market.rsis = []

  var minRsiLength = config.minRsiLength, maxRsiLength = config.maxRsiLength
  var minRsiOverbought = config.minRsiOverbought, maxRsiOverbought = config.maxRsiOverbought
  var minRsiOversold = config.minRsiOversold, maxRsiOversold = config.maxRsiOversold
  var minStopLossLookBack = config.minStopLossLookBack, maxStopLossLookBack = config.maxStopLossLookBack
  var minProfitFactor = config.minProfitFactor, maxProfitFactor = config.maxProfitFactor
  var minimumStopLoss = config.minimumStopLoss, riskPerTradePercent = config.riskPerTradePercent
  // var bestCase = {overview:{netProfit:0}}
  
  for (var rsiLength = minRsiLength; rsiLength <= maxRsiLength; rsiLength++) {
    market.rsis[rsiLength] = await getRsi(market.closes,rsiLength)
  }

  await loopRsiCase(config, async (key,setup) => {
    await getRsiCase(startTime,interval,market,setup)
  })
/*
  var fileWritten = 0
  var fileTotal = (maxRsiOverbought - minRsiOverbought + 1) * (maxRsiOversold - minRsiOversold + 1)
  var t0 = new Date()

  for (var rsiOverbought = minRsiOverbought; rsiOverbought <= maxRsiOverbought; rsiOverbought++) {
    for (var rsiOversold = minRsiOversold; rsiOversold <= maxRsiOversold; rsiOversold++) {
      // if (fs.existsSync(writeFilePath)) {
      //   console.log('skip',rsiOverbought,rsiOversold)
      // }
      // else {
        // var csv = '' //'rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,minimumStopLoss,netProfit,numTrades,winRate,maxDrawdown,averageBarsInTrade,averageBarsNotInTrade\n'
        for (var rsiLength = minRsiLength; rsiLength <= maxRsiLength; rsiLength++) {
          for (var stopLossLookBack = minStopLossLookBack; stopLossLookBack <= maxStopLossLookBack; stopLossLookBack++) {
            for (var profitFactor = minProfitFactor; profitFactor <= maxProfitFactor; profitFactor++) {
              var writeFilePath = getRsiCaseFilePath(startYmd,endYmd,interval,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor)
              if (fs.existsSync(writeFilePath)) {
                console.log('skip',writeFilePath)
              }
              else {
                var acase = await getRsiCase(startTime,interval,market,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor/100,minimumStopLoss,riskPerTradePercent)
                // var overview = acase.overview
                // var csv = rsiLength + ',' + rsiOverbought + ',' + rsiOversold + ',' + stopLossLookBack + ',' + profitFactor + ',' + minimumStopLoss + ',' +
                  // overview.netProfit.toFixed(2) + ',' + acase.trades.length + ',' + 
                  // overview.winRate.toFixed(1) + ',' + overview.maxDrawdown.toFixed(1) + ',' + 
                  // Math.round(overview.averageBarsInTrade) + ',' + Math.round(overview.averageBarsNotInTrade) + '\n'
                // await writeFile(writeFilePath,csv,writeFileOptions)
                // await writeFile(writeFilePath,JSON.stringify(acase.trades),writeFileOptions)
              }
            }
          }
        }
        // await writeFile(writeFilePath,csv,writeFileOptions)
        fileWritten++
        var t1 = new Date()
        var timeSpent = t1 - t0
        var avgTimeSpent = timeSpent/fileWritten
        var fileRemaining = fileTotal-fileWritten
        var timeRemaining = (fileRemaining * avgTimeSpent)
        var timeFinish = new Date(t1.getTime() + timeRemaining)
  
        console.log('done',startYmd,rsiOverbought,rsiOversold)
        console.log('time remaining', (timeRemaining/60000).toFixed(2), timeFinish.toString())
      }
    // }
    // fs.appendFileSync(writeFilePath, csv);
    // console.log('bestCase netProfit', bestCaseInRsi.overview.netProfit)
    // if (bestCaseInRsi.overview.netProfit > bestCase.overview.netProfit) {
    //   bestCase = bestCaseInRsi
    // }
  }
*/
  // var rsiOverbought = 55
  // var rsiOversold = 22
  // var stopLossLookBack = 1
  // var profitFactor = 2.7799
  // var minimumStopLoss = 0.001
  // var riskPerTradePercent = 0.01
  // var rsiLength = 11
  // console.log('rsiLength',rsiLength,new Date())
  // market.rsis = await getRsi(market.closes,rsiLength)
  // var acase = await getRsiCase(startTime,interval,market,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,minimumStopLoss,riskPerTradePercent)
  // debugger

  console.log('done generateRsiCaseFiles')
}

async function getRsiCaseTrades(startYmd, endYmd, interval, rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor) {
  var readPath = getRsiCaseFilePath(historyStartYmd, endYmd, interval, rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor)
  var jsonString = fs.readFileSync(readPath,readFileOptions)
  if (jsonString.length == 0) {
    return []
  }
  var trades = JSON.parse(jsonString)
  var startTime = new Date(YYYY_MM_DD(startYmd)).getTime()
  var endTime = new Date(YYYY_MM_DD(endYmd)).getTime() + (24*60*60000) - 1
  var startIndex = trades.findIndex(t => {
    return t[ENTER_TIME] > startTime
  })
  var endIndex = trades.findIndex(t => {
    return t[EXIT_TIME] > endTime
  }) - 1
  return trades.slice(startIndex,endIndex)
}

async function loopRsiCase(config, callback) {
  var minRsiLength = config.minRsiLength, maxRsiLength = config.maxRsiLength
  var minRsiOverbought = config.minRsiOverbought, maxRsiOverbought = config.maxRsiOverbought
  var minRsiOversold = config.minRsiOversold, maxRsiOversold = config.maxRsiOversold
  var minStopLossLookBack = config.minStopLossLookBack, maxStopLossLookBack = config.maxStopLossLookBack
  var minProfitFactor = config.minProfitFactor, maxProfitFactor = config.maxProfitFactor
  var minimumStopLoss = config.minimumStopLoss, riskPerTradePercent = config.riskPerTradePercent
  
  var fileWritten = 0
  var fileTotal = (maxRsiOverbought - minRsiOverbought + 1) * (maxRsiOversold - minRsiOversold + 1)
  var t0 = new Date()
  
  for (var rsiOverbought = minRsiOverbought; rsiOverbought <= maxRsiOverbought; rsiOverbought++) {
    for (var rsiOversold = minRsiOversold; rsiOversold <= maxRsiOversold; rsiOversold++) {
      for (var rsiLength = minRsiLength; rsiLength <= maxRsiLength; rsiLength++) {
        for (var stopLossLookBack = minStopLossLookBack; stopLossLookBack <= maxStopLossLookBack; stopLossLookBack++) {
          for (var profitFactor = minProfitFactor; profitFactor <= maxProfitFactor; profitFactor++) {
            await callback(rsiLength+'_'+rsiOverbought+'_'+rsiOversold+'_'+stopLossLookBack+'_'+profitFactor,
              {rsiLength:rsiLength, rsiOverbought:rsiOverbought, rsiOversold:rsiOversold, stopLossLookBack:stopLossLookBack, profitFactor:profitFactor},
              rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor)
          }
        }
      }
      // await writeFile(writeFilePath,csv,writeFileOptions)
      fileWritten++
      var t1 = new Date()
      var timeSpent = t1 - t0
      var avgTimeSpent = timeSpent/fileWritten
      var fileRemaining = fileTotal-fileWritten
      var timeRemaining = (fileRemaining * avgTimeSpent)
      var timeFinish = new Date(t1.getTime() + timeRemaining)

      console.log('done',rsiOverbought,rsiOversold,'time remaining',(timeRemaining/60000).toFixed(2), timeFinish.toString())
    }
  }
}

async function generateRsiOverviewFile(startYmd,endYmd,interval,config) {
  var overviews = {}
  await loopRsiCase(config, async (key,rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor) => {
    var trades = await getRsiCaseTrades(startYmd, endYmd, interval, rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor)
    if (trades.length > 0) {
      var profitPercent = Math.round((trades[trades.length-1][EXIT_CAPITAL] - trades[0][ENTER_CAPITAL])/trades[0][ENTER_CAPITAL]*10000)/100
      var winCount = trades.reduce((a,c) => {
        return c[EXIT_PROFIT] > 0 ? a+1 : a
      },0)
      var winRate = Math.round(winCount/trades.length*100)
      overviews[key] = [profitPercent,winRate]
    }
    else {
      overviews[key] = [0,0]
    }
  })
  var writePath = 'data/case/rsi/model/'+startYmd+'_'+endYmd+'_overviews.json'
  await writeFile(writePath,JSON.stringify(overviews),writeFileOptions)
}

async function getRsiOverviewFile(startYmd,endYmd) {
  var readPath = 'data/case/rsi/model/'+startYmd+'_'+endYmd+'_overviews.json'
  var profitsString = await readFile(readPath,readFileOptions)
  var profits = JSON.parse(profitsString)
  return profits
}

async function generateRsiProfitModel(startYmd,endYmd,interval,config) {
  var overviews = await getRsiOverviewFile(startYmd,endYmd)

  var profitSlots = []
  for (var si = 0; si < 500; si++) {
    profitSlots[si] = 0
  }

  await loopRsiCase(config, async (key,rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor) => {
    var profit = overviews[key][0]
    var winRate = overviews[key][1]
    var profitIndex = Math.round(profit) + 100
    profitSlots[profitIndex]++
  })
  
  var modelNumber = 
    config.minRsiOverbought+'_'+config.maxRsiOverbought+'_'+
    config.minRsiOversold+'_'+config.maxRsiOversold+'_'+
    config.minRsiLength+'_'+config.maxRsiLength+'_'+
    config.minStopLossLookBack+'_'+config.maxStopLossLookBack+'_'+
    config.minProfitFactor+'_'+config.maxProfitFactor
  var modelFilePath = 'data/case/rsi/model/'+startYmd+'_'+endYmd+'_models.js'
  var modelVarPrefix = 'var models = '
  var models = {}
  if (fs.existsSync(modelFilePath)) {
    modelsString = await readFile(modelFilePath,readFileOptions)
    models = JSON.parse(modelsString.replace(modelVarPrefix,''))
  }
  models[modelNumber] = profitSlots
  await writeFile(modelFilePath,modelVarPrefix+JSON.stringify(models),writeFileOptions)
  console.log('done generateRsiProfitModel', startYmd, endYmd, interval)
}

async function studyRsiProfit(startYmd,endYmd,interval,config) {
  var minRsiLength = config.minRsiLength, maxRsiLength = config.maxRsiLength
  var minRsiOverbought = config.minRsiOverbought, maxRsiOverbought = config.maxRsiOverbought
  var minRsiOversold = config.minRsiOversold, maxRsiOversold = config.maxRsiOversold
  var minStopLossLookBack = config.minStopLossLookBack, maxStopLossLookBack = config.maxStopLossLookBack
  var minProfitFactor = config.minProfitFactor, maxProfitFactor = config.maxProfitFactor
  var minimumStopLoss = config.minimumStopLoss, riskPerTradePercent = config.riskPerTradePercent

  var overviews = await getRsiOverviewFile(startYmd,endYmd)
  var overbought = {}, oversold = {}, lookback = {}, factor = {}
  
  for (var rsiOverbought = minRsiOverbought; rsiOverbought <= maxRsiOverbought; rsiOverbought++) {
    overbought[rsiOverbought] = {profit:0,winRate:0}
  }
  for (var rsiOversold = minRsiOversold; rsiOversold <= maxRsiOversold; rsiOversold++) {
    oversold[rsiOversold] = {profit:0,winRate:0}
  }
  for (var stopLossLookBack = minStopLossLookBack; stopLossLookBack <= maxStopLossLookBack; stopLossLookBack++) {
    lookback[stopLossLookBack] = {profit:0,winRate:0}
  }
  for (var profitFactor = minProfitFactor; profitFactor <= maxProfitFactor; profitFactor++) {
    factor[profitFactor] = {profit:0,winRate:0}
  }
  await loopRsiCase(config, async (key,rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor) => {
    var profit = overviews[key][0]
    var winRate = overviews[key][1]
    console.log(key,profit,winRate)
    if (profit > 5) {
      overbought[rsiOverbought].profit++
      oversold[rsiOversold].profit++
      lookback[stopLossLookBack].profit++
      factor[profitFactor].profit++
    }
    // else {
    //   overbought[rsiOverbought].looser++
    //   oversold[rsiOversold].looser++
    //   lookback[stopLossLookBack].looser++
    //   factor[profitFactor].looser++
    // }
    if (winRate > 50) {
      overbought[rsiOverbought].winRate++
      oversold[rsiOversold].winRate++
      lookback[stopLossLookBack].winRate++
      factor[profitFactor].winRate++
    }
    // else {
    //   overbought[rsiOverbought].looseRate++
    //   oversold[rsiOversold].looseRate++
    //   lookback[stopLossLookBack].looseRate++
    //   factor[profitFactor].looseRate++
    // }
  })
  console.log(overviews)
  console.log('==== good rsiOverbought')
  for (var rsiOverbought = minRsiOverbought; rsiOverbought <= maxRsiOverbought; rsiOverbought++) {
    if (overbought[rsiOverbought].winner > overbought[rsiOverbought].looser*10) {
      console.log('good rsiOverbought',rsiOverbought)
    }
  }
  console.log('==== good rsiOversold')
  for (var rsiOversold = minRsiOversold; rsiOversold <= maxRsiOversold; rsiOversold++) {
    if (oversold[rsiOversold].winner > oversold[rsiOversold].looser*10) {
      console.log('good rsiOversold',rsiOversold)
    }
  }
  console.log('==== good stopLossLookBack')
  for (var stopLossLookBack = minStopLossLookBack; stopLossLookBack <= maxStopLossLookBack; stopLossLookBack++) {
    if (lookback[stopLossLookBack].winner > lookback[stopLossLookBack].looser*10) {
      console.log('good stopLossLookBack',stopLossLookBack)
    }
  }
  console.log('==== good profitFactor')
  for (var profitFactor = minProfitFactor; profitFactor <= maxProfitFactor; profitFactor++) {
    if (factor[profitFactor].winner > factor[profitFactor].looser*10) {
      console.log('good profitFactor',profitFactor)
    }
  }
}

async function updateRsiCaseFiles() {
  var config = {
    minRsiLength: 11, maxRsiLength: 11,
    minRsiOverbought: 51, maxRsiOverbought: 85,
    minRsiOversold: 16, maxRsiOversold: 49,
    minStopLossLookBack: 2, maxStopLossLookBack: 18,
    minProfitFactor: 100, maxProfitFactor: 200,
    minimumStopLoss: 0.001, riskPerTradePercent: 0.01
  }
  // var config = {
  //   minRsiLength: 11, maxRsiLength: 11,
  //   minRsiOverbought: 55, maxRsiOverbought: 85,
  //   minRsiOversold: 25, maxRsiOversold: 49,
  //   minStopLossLookBack: 4, maxStopLossLookBack: 18,
  //   minProfitFactor: 140, maxProfitFactor: 300,
  //   minimumStopLoss: 0.001, riskPerTradePercent: 0.01
  // }
  await generateRsiCaseFiles(historyStartYmd,20190222,15,config)
  // await generateRsiOverviewFile(20190219,20190222,15,config)
  console.log('done updateRsiCaseFiles')
}

async function test() {
  var config = {
    minRsiLength: 11, maxRsiLength: 11,
    minRsiOverbought: 75, maxRsiOverbought: 75,
    minRsiOversold: 44, maxRsiOversold: 44,
    minStopLossLookBack: 10, maxStopLossLookBack: 10,
    minProfitFactor: 100, maxProfitFactor: 200,
    minimumStopLoss: 0.001, riskPerTradePercent: 0.01
  }
  await studyRsiProfit(20190122,20190222,15,config)
  // await generateRsiProfitModel(20190122,20190222,15,config)
  // for (var os = 15; os <= 25; os++) {
  //   for (var ob = 50; ob <= 57; ob++) {
  //     config.minRsiOverbought = config.maxRsiOverbought = ob
  //     config.minRsiOversold = config.maxRsiOversold = os
  //     await generateRsiCaseOBOSAnalysisFile(20190101,20190131,15,config)
  //   }
  // }
  debugger
}

async function getBestOBOS(startYmd,length,interval) {
  var obosString = await readFile('data/case/rsi/'+startYmd+'_'+length+'_'+interval+'/obos.json',readFileOptions)
  var obos = JSON.parse(obosString)
  var obCaseAvg = obos.ob.caseAvg, osCaseAvg = obos.os.caseAvg
  obCaseAvg[0] = 0
  osCaseAvg[0] = 0
  var bestOB = Object.keys(obCaseAvg).reduce((a,c) => {
    return (obCaseAvg[c] > obCaseAvg[a]) ? c : a
  },0)
  var bestOS = Object.keys(osCaseAvg).reduce((a,c) => {
    return (osCaseAvg[c] > osCaseAvg[a]) ? c : a
  },0)
  return {ob:bestOB,os:bestOS}
}

async function start() {
  await db.connect()
  // db.enterTrade(1,2,3,4,5,6,7,8,9,10,11,12)
  // db.exitTrade(1,2,3.12666,4,5)

// updateMarketData()
updateRsiCaseFiles()
// test()
}

try {
  start()
}
catch (e){
  console.log(e)
  debugger
}

