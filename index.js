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

var talib = require('talib');
const talibExecute = util.promisify(talib.execute)

const filePath = 'data/trade/YYYYMMDD.csv'
const symbol = 'XBTUSD'

const roadmap = require('./roadmap');

function writeCleanedFile(ymd,output) {
  var writePath = filePath.replace('YYYYMMDD',ymd+'_'+symbol)
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
    const request = http.get(roadmap.url + '.csv.gz', function(response) {
      const csvFilename = 'data/trade/' + ymd + '.csv'
      const gzFilename = csvFilename + '.gz'
      const ws = fs.createWriteStream(gzFilename);
      response.pipe(ws)
      ws.on('finish', _ => {
        gunzip(gzFilename, csvFilename, _ => {
          console.log(ymd + ' gunzipped')
          fs.unlink(gzFilename,_=>{});
          resolve()
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
    await downloadTradeDay(ymd)
    var trades = await readAndParseCleanUp(ymd)
    const csvFilename = 'data/trade/' + ymd + '.csv'
    fs.unlink(csvFilename,_=>{})
    writeCleanedFile(ymd,trades)
    ymd = ymdNextDay(ymd)
  }
}

async function generateCandleDayFiles(startYmd,endYmd,interval) {
  var ymd = startYmd
  var open = []
  var high = []
  var low = []
  var close = []
  while (ymd <= endYmd) {
    var candles = await getCandleDay(ymd,interval)
    if (candles.opens.length != 96 || candles.highs.length != 96 || candles.lows.length != 96 || candles.closes.length != 96 || candles.candles.length != 96) {
      debugger
    }
    var candlesString = JSON.stringify(candles)
    var writePath = 'data/candle/' + interval + '/' + ymd + '.json'
    await writeFile(writePath,candlesString,writeFileOptions)
    console.log('done writing', writePath)
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

function pushEnter(trades,time,size,price,stopLoss,takeProfit) {
  trades.push({enterTime:time,size:size,enterPrice:price,stopLoss:stopLoss,takeProfit:takeProfit})
}

function pushExit(trades,time,price) {
  var trade = trades[trades.length-1]
  trade.exitTime = time
  trade.exitPrice = price
}

async function getRsiCase(startTime,interval,market,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,minimumStopLoss,riskPerTradePercent) {
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
  var trades = [], winCount = 0, highestCapital = capital, maxDrawdown = 0, barsInTrade = 0, barsNotInTrade = 0, enterBar = 0, exitBar = startBar
  // var shortLossDistance, longLossDistance
  for (var i = startBar; i < rsis.length; i++) {
    time += timeIncrement
    if (positionSize > 0) {
      high = highs[i]
      low = lows[i]
      if (stopLoss >= low && stopLoss <= high) {
        let profit = -positionSize * lossDistance
        capital += profit
        positionSize = 0
        let drawdown = (capital-highestCapital) / highestCapital 
        maxDrawdown = Math.min(maxDrawdown,drawdown)
        barsInTrade += i - enterBar
        exitBar = i
        pushExit(trades,time,stopLoss,profit)
      }
      else if (takeProfit >= low && takeProfit <= high) {
        winCount++
        let profit = positionSize * profitDistance
        capital += profit
        positionSize = 0
        highestCapital = Math.max(capital,highestCapital)
        barsInTrade += i - enterBar
        exitBar = i
        pushExit(trades,time,takeProfit,profit)
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
        barsNotInTrade += i - exitBar
        enterBar = i
        pushEnter(trades,time,positionSize,entryPrice,stopLoss,takeProfit)
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
          barsNotInTrade += i - exitBar
          enterBar = i
          pushEnter(trades,time,positionSize,entryPrice,stopLoss,takeProfit)
        }
      }
    }
  }
  return {
    setup: {
      startTime:startTime,interval:interval,rsiLength:rsiLength,rsiOverbought:rsiOverbought,rsiOversold:rsiOversold,
      stopLossLookBack:stopLossLookBack,profitFactor:profitFactor,minimumStopLoss:minimumStopLoss
    },
    overview: {
      netProfit:(capital-100),
      winRate:(winCount/trades.length*100),
      maxDrawdown:(maxDrawdown*100),
      averageBarsInTrade:barsInTrade/trades.length, 
      averageBarsNotInTrade:barsNotInTrade/trades.length
    },
    trades:trades
  }
}

async function generateRsiCaseFiles(startYmd,length,interval) {
  var startTime = new Date(YYYY_MM_DD(startYmd)).getTime()
  var market = await getMarket(startYmd,length,interval)
  market.rsis = []

  var minRsiLength = 6, maxRsiLength = 16
  var minRsiOverbought = 50, maxRsiOverbought = 60
  var minRsiOversold = 15, maxRsiOversold = 35
  var minStopLossLookBack = 1, maxStopLossLookBack = 8
  var minProfitFactor = 1.00, maxProfitFactor = 3.00
  var minimumStopLoss = 0.001
  var riskPerTradePercent = 0.01
  // var bestCase = {overview:{netProfit:0}}
  
  for (var rsiLength = minRsiLength; rsiLength <= maxRsiLength; rsiLength++) {
    market.rsis[rsiLength] = await getRsi(market.closes,rsiLength)
  }

  var fileWritten = 0
  var fileTotal = (maxRsiOverbought - minRsiOverbought + 1) * (maxRsiOversold - minRsiOversold + 1)
  var t0 = new Date()

  for (var rsiOverbought = minRsiOverbought; rsiOverbought <= maxRsiOverbought; rsiOverbought++) {
    for (var rsiOversold = minRsiOversold; rsiOversold <= maxRsiOversold; rsiOversold++) {
      var writeFilePath = 'data/case/rsi/'+startYmd+'_'+length+'_'+interval+'/'+rsiOverbought+'_'+rsiOversold+'.csv'
      if (fs.existsSync(writeFilePath)) {
        console.log('skip',rsiOverbought,rsiOversold)
      }
      else {
        var csv = 'rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,minimumStopLoss,netProfit,numTrades,winRate,maxDrawdown,averageBarsInTrade,averageBarsNotInTrade\n'
        for (var rsiLength = minRsiLength; rsiLength <= maxRsiLength; rsiLength++) {
          for (var stopLossLookBack = minStopLossLookBack; stopLossLookBack <= maxStopLossLookBack; stopLossLookBack++) {
            for (var profitFactor = minProfitFactor; profitFactor <= maxProfitFactor; profitFactor+=0.01) {
              var acase = await getRsiCase(startTime,interval,market,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,minimumStopLoss,riskPerTradePercent)
              var overview = acase.overview
              if (overview.netProfit >= 10 && overview.winRate >= 50) {
                // netProfit:(capital-100).toFixed(2),
                // winRate:(winCount/trades.length*100).toFixed(1),
                // maxDrawdown:(maxDrawdown*100).toFixed(1),
                // averageBarsInTrade:Math.round(barsInTrade/trades.length), 
                // averageBarsNotInTrade:Math.round(barsNotInTrade/trades.length)
                csv += rsiLength + ',' + rsiOverbought + ',' + rsiOversold + ',' + stopLossLookBack + ',' + profitFactor + ',' + minimumStopLoss + ',' +
                  overview.netProfit.toFixed(2) + ',' + acase.trades.length + ',' + 
                  overview.winRate.toFixed(1) + ',' + overview.maxDrawdown.toFixed(1) + ',' + 
                  Math.round(overview.averageBarsInTrade) + ',' + Math.round(overview.averageBarsNotInTrade) + '\n'
              }
            }
          }
        }
        await writeFile(writeFilePath,csv,writeFileOptions)
        fileWritten++
        var t1 = new Date()
        var timeSpent = t1 - t0
        var avgTimeSpent = timeSpent/fileWritten
        var fileRemaining = fileTotal-fileWritten
        var timeRemaining = (fileRemaining * avgTimeSpent)
        var timeFinish = new Date(t1.getTime() + timeRemaining)
  
        console.log('done',rsiOverbought,rsiOversold)
        console.log('time remaining', (timeRemaining/60000).toFixed(2), timeFinish.toString())
      }
    }
    // fs.appendFileSync(writeFilePath, csv);
    // console.log('bestCase netProfit', bestCaseInRsi.overview.netProfit)
    // if (bestCaseInRsi.overview.netProfit > bestCase.overview.netProfit) {
    //   bestCase = bestCaseInRsi
    // }
  }

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

//8	55	26	2	1.41	0.001
async function testRsiCase(startYmd,length,interval,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,minimumStopLoss,riskPerTradePercent) {
  var startTime = new Date(YYYY_MM_DD(startYmd)).getTime()
  var market = await getMarket(startYmd,length,interval)
  market.rsis = []
  market.rsis[rsiLength] = await getRsi(market.closes,rsiLength)
  var acase = await getRsiCase(startTime,interval,market,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,minimumStopLoss,riskPerTradePercent)
  debugger
}

async function generateRsiCaseOBOSAnalysisFile(startYmd,length,interval,minRsiOverbought,maxRsiOverbought,minRsiOversold,maxRsiOversold) {
  var nCasesCSV = ''
  for (var rsiOversold = minRsiOversold; rsiOversold <= maxRsiOversold; rsiOversold++) {
    nCasesCSV += rsiOversold + ','
  }
  nCasesCSV = nCasesCSV.replace(/.$/,"\n")
  var netProfitCSV = (' ' + nCasesCSV).slice(1);
  for (var rsiOverbought = minRsiOverbought; rsiOverbought <= maxRsiOverbought; rsiOverbought++) {
    for (var rsiOversold = minRsiOversold; rsiOversold <= maxRsiOversold; rsiOversold++) {
      var readPath = 'data/case/rsi/'+startYmd+'_'+length+'_'+interval+'/'+rsiOverbought+'_'+rsiOversold+'.csv'
      var stats = {size:163}
      var nCases = 0
      var highestNetProfitCase
      try {
        stats = fs.statSync(readPath)
        var cases = await readAndParseOBOSCases(readPath)
        nCases = cases.length
        highestNetProfitCase = cases.reduce((a,c) => {
          return (c[6] > a[6]) ? c : a
        }, cases[0])
      }
      catch(e) {

      }
      nCasesCSV += nCases + ','
      netProfitCSV += (highestNetProfitCase ? highestNetProfitCase[6] : 0) + ','
    }
    nCasesCSV = nCasesCSV.replace(/.$/,"\n")
    netProfitCSV = netProfitCSV.replace(/.$/,"\n")
  }
  await writeFile('data/case/rsi/'+startYmd+'_'+length+'_'+interval+'/obos/ncases.csv',nCasesCSV,writeFileOptions)
  await writeFile('data/case/rsi/'+startYmd+'_'+length+'_'+interval+'/obos/netprofit.csv',netProfitCSV,writeFileOptions)
}

// downloadTradeData(20190208,20190208)

// generateCandleDayFiles(20170101,20190208,15);

// getRsiCases(20170320,90,15)
// getRsiCases(20190108,30,15)
async function generateRsiTestCases() {
  await generateRsiCaseFiles(20181001,30,15)
  await generateRsiCaseFiles(20181101,30,15)
  await generateRsiCaseFiles(20181201,30,15)
  await generateRsiCaseFiles(20190101,30,15)
}

generateRsiTestCases()

async function generateRsiOBOSTestCases() {
  await generateRsiCaseOBOSAnalysisFile(20181001,30,15,50,60,10,35)
  await generateRsiCaseOBOSAnalysisFile(20181101,30,15,50,60,10,35)
  await generateRsiCaseOBOSAnalysisFile(20181201,30,15,50,60,10,35)
  await generateRsiCaseOBOSAnalysisFile(20190101,30,15,50,60,10,35)
}
// generateRsiOBOSTestCases()
// generateRsiCaseOBOSAnalysisFile(20181001,90,15,50,65,10,40)

// testRsiCase(20190107,31,15,11,55,25,4,1.39,0.001,0.01)
// testRsiCase(20190101,30,15,11,55,22,1,2.78,0.001,0.01)