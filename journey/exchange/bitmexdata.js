const util = require('util')
const fs = require('fs')
const http 	= require('http')
const gunzip = require('gunzip-file')

const ymdHelper = require('../ymdHelper')
const shoes = require('../shoes')
// const strategy = require('./strategy')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const csvParse = require('csv-parse')
const csvStringify = require('csv-stringify')

const tradeFilePath = 'data/bitmex/trade/YYYYMMDD.csv'
const minTradeFilePath = 'data/bitmex/trade/min/YYYYMMDD.json'
const candleFilePath = 'data/bitmex/candle/YYYYMMDD.json'
const feedFilePath = 'data/bitmex/feed/YYYYMMDD.json'
const rsiFilePath = 'data/bitmex/rsi/YYYYMMDD.json'

const symbols = ['XBTUSD']

const oneDayMs = 24*60*60000

function getCleanedTradeFile(ymd,symbol) {
  return tradeFilePath.replace('YYYYMMDD',symbol+'/'+ymd)
}

function getMinTradeFile(ymd,symbol) {
  return minTradeFilePath.replace('YYYYMMDD',symbol+'/'+ymd)
}

function getCandleFile(symbol,interval,ymd) {
  return candleFilePath.replace('YYYYMMDD',symbol+'/'+interval+'/'+ymd)
}

function getFeedFile(symbol,interval,ymd) {
  return feedFilePath.replace('YYYYMMDD',symbol+'/'+interval+'/'+ymd)
}

function getRsiFile(symbol,ymd,interval,length) {
  return rsiFilePath.replace('YYYYMMDD',symbol+'/'+ymd+'_'+interval+'_'+length)
}

async function writeCleanedFile(ymd,symbol,output) {
  return new Promise((resolve,reject) => {
    var writePath = getCleanedTradeFile(ymd,symbol)
    csvStringify(output, async (err, outputString) => {
      await writeFile(writePath,outputString,writeFileOptions)
      console.log('done writing', writePath)
      resolve()
    })
  })
}

function downloadTradeDay(ymd) { try {
  return new Promise((resolve, reject) => {
    console.log('downloadTradeDay',ymd)
    const request = http.get(shoes.bitmexdata.url + ymd + '.csv.gz', function(response) {
      const csvFilename = tradeFilePath.replace('YYYYMMDD',ymd) //'data/trade/' + ymd + '.csv'
      const gzFilename = csvFilename + '.gz'
      const ws = fs.createWriteStream(gzFilename);
      response.pipe(ws)
      ws.on('finish', _ => {
        gunzip(gzFilename, csvFilename, _ => {
          console.log('gunzipped',ymd)
          fs.unlink(gzFilename,_=>{});
          resolve(csvFilename)
        })
      })
    })
  })
} catch(e) {console.error(e.stack||e);debugger} }

function readAndParseCleanUp(ymd) {
  return new Promise((resolve, reject) => {
    const readPath = tradeFilePath.replace('YYYYMMDD',ymd)
    var trades ={}
    var symbolsString = ''
    symbols.forEach(symbol => {
      trades[symbol] = []
      symbolsString = symbolsString + symbol
    })
    fs.createReadStream(readPath).pipe(csvParse())
      .on('data', ([timestamp,symbol,side,size,price]) => {
        if (symbolsString.indexOf(symbol) >= 0) {
          var timeString = timestamp.slice(0,23).replace('D',' ').replace('.',':')
          var timeLocal = new Date(timeString)
          var timeGMT = new Date(timeLocal.valueOf() - timeLocal.getTimezoneOffset() * 60000)
          trades[symbol].push([timeGMT.getTime(),side=='Buy'?1:-1,size,price])
        }
      })
      .on('error', e => reject(e))
      .on('end', () => resolve(trades));
  });
}

async function downloadTradeData(startYmd,endYmd) { try {
  var ymd = startYmd
  while (ymd <= endYmd) {
    let toDoSymbols = symbols.filter(symbol => {
      let cleanedTradeFile = getCleanedTradeFile(ymd,symbol)
      if (fs.existsSync(cleanedTradeFile)) {
        console.log('skip',cleanedTradeFile)
        return false
      }
      else {
        return true
      }
    })
    if (toDoSymbols.length > 0) {
      const csvFilename = await downloadTradeDay(ymd)
      const trades = await readAndParseCleanUp(ymd)
      fs.unlink(csvFilename,_=>{})
      var writeAll = toDoSymbols.map(symbol => {
        return writeCleanedFile(ymd,symbol,trades[symbol])
      })
      await Promise.all(writeAll)
    }
    ymd = ymdHelper.nextDay(ymd)
  }
} catch(e) {console.error(e.stack||e);debugger} }

function readAndParseForCandle(ymd,symbol) {
  return new Promise((resolve, reject) => {
    const readPath = getCleanedTradeFile(ymd,symbol)
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
    var groupsLen = groups.length
    for (var i = 0; i < groupsLen; i++) {
      let group = groups[i]
      let groupLen = group.length
      let volume = 0
      let open,high,low,close
      if (group.length > 0) {
        try {
          open = high = low = group[0].price
          close = group[group.length-1].price
          for (let j = 0; j < groupLen; j++) {
            let {price,size} = group[j]
            if (price > high) high = price
            if (price < low) low = price
            volume += size
          }
          if (!open || !close || !high || !low) {
            debugger
          }
        }
        catch(e) {
          debugger
        }
      }
      let gain = close - open, 
          gainPercent = gain / open,
          candleHeight = high - low,
          body = Math.abs(gain),
          bodyTop = Math.max(open,close),
          bodyBottom = Math.min(open,close),
          wick = high - bodyTop,
          tail = bodyBottom - low

      let candle = {
        time: new Date(startTime + intervalMS*i).toISOString(),
        volume: volume,
        open: open,
        high: high,
        low: low,
        close: close,
        gain: close - open,
        gainPercent: gainPercent,
        avgBody: (open+close)/2,
        candleHeight: candleHeight,
        candlePricePercent: candleHeight / open,
        bodyTop: Math.max(open,close),
        bodyBottom: Math.min(open,close),
        body: body,
        bodyPricePercent: body / open,
        bodyCandlePercent: body / candleHeight,
        wick: wick,
        wickPricePercent: wick / open,
        wickCandlePercent: wick / candleHeight,
        tail: tail,
        tailPricePercent: tail / open,
        tailCandlePercent: tail / candleHeight
      }

      candles.push(candle)
      opens.push(open)
      highs.push(high)
      lows.push(low)
      closes.push(close)
    }
    resolve({opens:opens, highs:highs, lows:lows, closes:closes, candles:candles})
  })
}

async function getCandleDay(symbol,interval,ymd) { try {
  console.log('getCandleDay',symbol,interval,ymd)
  var trades = await readAndParseForCandle(ymd,symbol)
  var startTimeGMT = new Date(ymdHelper.YYYY_MM_DD(ymd))
  var startTimeGMTMS = startTimeGMT.getTime()
  var groups = await getGroups(trades,startTimeGMTMS,interval)
  var candles = await getCandles(groups,startTimeGMTMS,interval)
  return candles
} catch(e) {console.error(e.stack||e);debugger} }

function getFeedDay({candles},interval,lastPrice) { try {
  var feeds = [], len = candles.length, 
      feedInterval = interval / 4 * 60000
  for (var i = 0; i < len; i++) {
    let {time:t,open,high,low,close} = candles[i]
    let time = new Date(t).getTime()
        openTime = time + 6000,
        highTime = time + feedInterval,
        lowTime = highTime + feedInterval,
        closeTime = lowTime + feedInterval
    feeds.push([openTime,1,1,open||lastPrice,new Date(openTime).toISOString()])
    feeds.push([highTime,1,1,high||lastPrice,new Date(highTime).toISOString()])
    feeds.push([lowTime,1,1,low||lastPrice,new Date(lowTime).toISOString()])
    feeds.push([closeTime,1,1,close||lastPrice,new Date(closeTime).toISOString()])
    lastPrice = (close||lastPrice)
  }
  return feeds
} catch(e) {console.error(e.stack||e);debugger} }

async function generateCandleDayFiles(startYmd,endYmd,interval) { try {
  var len = symbols.length
  for (var i = 0; i < len; i++) {
    let symbol = symbols[i],
        ymd = startYmd,
        lastPrice
    while (ymd <= endYmd) {
      let writeCandlePath = getCandleFile(symbol,interval,ymd)
      let candles, feeds
      if (fs.existsSync(writeCandlePath)) {
        console.log('skip',writeCandlePath)
      }
      else {
        candles = await getCandleDay(symbol,interval,ymd)
        let candlesString = JSON.stringify(candles)
        await writeFile(writeCandlePath,candlesString,writeFileOptions)
        console.log('done writing', writeCandlePath)
      }
      let writeFeedPath = getFeedFile(symbol,interval,ymd)
      // if (fs.existsSync(writeFeedPath)) {
      //   console.log('skip',writeFeedPath)
      // }
      // else {
        candles = candles || JSON.parse(fs.readFileSync(writeCandlePath,readFileOptions))
        feeds = getFeedDay(candles,interval,lastPrice)
        let feedsString = JSON.stringify(feeds)
        await writeFile(writeFeedPath,feedsString,writeFileOptions)
        console.log('done writing', writeFeedPath)
        lastPrice = feeds[feeds.length-1][3]
      // }
      ymd = ymdHelper.nextDay(ymd)
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function testCandleDayFiles(startYmd,endYmd,interval) { try {
  let symbol = 'XBTUSD',
  ymd = startYmd,
  allLows = [],
  allHighs = [],
  allCloses = [],
  gapUp = 0,
  eqUp = 0,
  gapDown = 0,
  eqDown = 0,
  total = 0
  while (ymd <= endYmd) {
    let {lows,highs,closes} = await getTradeBucketed(interval,ymdHelper.getTime(ymd),symbol)
    allLows = allLows.concat(lows)
    allHighs = allHighs.concat(highs)
    allCloses = allCloses.concat(closes)
    ymd = ymdHelper.nextDay(ymd)
  }

  let len = allLows.length
  for (let i = 1; i < len; i++) {
    if (allLows[i] > allCloses[i-1]) {
      gapUp++
    }
    if (allLows[i] == allCloses[i-1]) {
      eqUp++
    }
    if (allHighs[i] < allCloses[i-1]) {
      gapDown++
    }
    if (allHighs[i] == allCloses[i-1]) {
      eqDown++
    }
    total++
  }
  console.log('total',total)
  console.log('gapUp',gapUp,(gapUp/total)*100)
  console.log('eqUp',eqUp,(eqUp/total)*100)
  console.log('gapDown',gapDown,(gapUp/total)*100)
  console.log('eqDown',eqDown,(eqDown/total)*100)
  debugger
} catch(e) {console.error(e.stack||e);debugger} }

async function getTradeBucketed(interval,time,symbol) {
  var readPath = getCandleFile(symbol,interval,ymdHelper.YYYYMMDD(time))
  if (fs.existsSync(readPath)) {
    var str = fs.readFileSync(readPath,readFileOptions)
    var dayMarket = JSON.parse(str)
    return dayMarket
  }
}

async function readTradeDay(time,symbol) {
  var ymd = ymdHelper.YYYYMMDD(time)
  return new Promise((resolve, reject) => {
    // console.log('readTradeDay',ymd)
    // console.time('readTradeDay')
    const minPath = getMinTradeFile(ymd,symbol)
    if (fs.existsSync(minPath)) {
      let trades = JSON.parse(fs.readFileSync(minPath,readFileOptions))
      resolve(trades)
      // console.timeEnd('readTradeDay')
    }
    else {
      const readPath = getCleanedTradeFile(ymd,symbol)
      var trades = []
      if (fs.existsSync(readPath)) {
        fs.createReadStream(readPath).pipe(csvParse())
        .on('data', ([timestamp,side,size,price]) => {
          timestamp = +timestamp
          side = +side
          size = +size
          price = +price
          let [lastTime,lastSide,lastSize,lastPrice] = trades[trades.length-1] || [time]
          // let diff = timestamp - lastTime
          let insertTime = lastTime - (lastTime % 60000) + 6000
          if (insertTime <= lastTime) insertTime += 60000
          // if (timestamp >= 1556874366000+60000-2000) {
          //   console.log('lastTime',new Date(lastTime).toISOString())
          //   console.log('insertTime',new Date(insertTime).toISOString())
          //   console.log('timestamp',new Date(timestamp).toISOString())
          //   debugger
          // }
          if (lastTime < insertTime && timestamp > insertTime) {
            do {
              trades.push([insertTime, null, 0, lastPrice
                , new Date(insertTime).toISOString()
              ])
              insertTime += 60000
            } while(insertTime < timestamp)
          }
          if (
            // diff > 5000 || 
            price != lastPrice) {
            trades.push([timestamp, side, size, price
              , new Date(timestamp).toISOString()
            ])
          }
        })
        .on('error', e => reject(e))
        .on('end', () => {
          trades = trades.sort((a, b) => a[0] - b[0])
          fs.writeFileSync(minPath,JSON.stringify(trades),writeFileOptions)
          resolve(trades)
          // console.timeEnd('readTradeDay')
        })
      }
      else {
        resolve(trades)
      }
    }
  })
}

async function readFeedDay(symbol,interval,time) { try {
  var readPath = getFeedFile(symbol,interval,ymdHelper.YYYYMMDD(time))
  if (fs.existsSync(readPath)) {
    var str = fs.readFileSync(readPath,readFileOptions)
    var feeds = JSON.parse(str)
    return feeds
  }
  else {
    return []
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function generateRsiFiles(symbol,startYmd,endYmd,interval,length) { try {
  var st = ymdHelper.getTime(startYmd)
  var et = ymdHelper.getTime(endYmd)
  var closes = []
  for (var time = st; time <= et; time += oneDayMs) {
    var dayMarket = await getTradeBucketed(interval,time,symbol)
    closes.push(...dayMarket.closes)
  }
  var rsis = await strategy.getRsi(closes,length)
  rsis.forEach((r,i) => {
    rsis[i] = Math.round(r*100)/100
  })
  var rsiFile = getRsiFile(symbol,startYmd,interval,length)
  fs.writeFileSync(rsiFile,JSON.stringify(rsis),writeFileOptions)
} catch(e) {console.error(e.stack||e);debugger} }

async function readRsis(symbol,startTime,interval,length) {
  console.time('readRsis')
  var fileYmd = 20190501
  var rsiFile = getRsiFile(symbol,fileYmd,interval,length)
  var rsisString = fs.readFileSync(rsiFile,readFileOptions)
  var rsis = JSON.parse(rsisString)
  var begin = Math.floor((startTime - ymdHelper.getTime(fileYmd)) / (interval * 60000))
  var result = rsis.slice(begin)
  console.timeEnd('readRsis')
  return result
}

module.exports = {
  downloadTradeData: downloadTradeData,
  generateCandleDayFiles: generateCandleDayFiles,
  testCandleDayFiles: testCandleDayFiles,
  generateRsiFiles: generateRsiFiles,
  getTradeBucketed: getTradeBucketed,
  readTradeDay: readTradeDay,
  readFeedDay: readFeedDay
}