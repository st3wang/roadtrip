const util = require('util')
const fs = require('fs')
const http 	= require('http')
const gunzip = require('gunzip-file')

const ymdHelper = require('./ymdHelper')
const shoes = require('./shoes')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const csvParse = require('csv-parse')
const csvStringify = require('csv-stringify')

const tradeFilePath = 'data/bitmex/trade/YYYYMMDD.csv'
const minTradeFilePath = 'data/bitmex/trade/YYYYMMDD.min.json'
const candleFilePath = 'data/bitmex/candle/YYYYMMDD.json'

const symbols = ['XBTUSD','ETHUSD','LTCUSD']
// const historyStartYmd = 20170101

function getCleanedTradeFile(ymd,symbol) {
  return tradeFilePath.replace('YYYYMMDD',ymd+'_'+symbol)
}

function getMinTradeFile(ymd,symbol) {
  return minTradeFilePath.replace('YYYYMMDD',ymd+'_'+symbol)
}

function getCandleFile(interval,ymd,symbol) {
  return candleFilePath.replace('YYYYMMDD',interval + '/' + ymd + '_' + symbol)
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
    groups.forEach((group,i) => {
      let candle = {
        time: new Date(startTime + intervalMS*i).toISOString(),
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

async function getCandleDay(ymd,interval,symbol) { try {
  console.log('getCandleDay',ymd,interval,symbol)
  var trades = await readAndParseForCandle(ymd,symbol)
  var startTimeGMT = new Date(ymdHelper.YYYY_MM_DD(ymd))
  var startTimeGMTMS = startTimeGMT.getTime()
  var groups = await getGroups(trades,startTimeGMTMS,interval)
  var candles = await getCandles(groups,startTimeGMTMS,interval)
  return candles
} catch(e) {console.error(e.stack||e);debugger} }

async function generateCandleDayFiles(startYmd,endYmd,interval) { try {
  var ymd = startYmd
  var len = symbols.length
  while (ymd <= endYmd) {
    for (var i = 0; i < len; i++) {
      let symbol = symbols[i]
      let writePath = getCandleFile(interval,ymd,symbol)
      if (fs.existsSync(writePath)) {
        console.log('skip',writePath)
      }
      else {
        var candles = await getCandleDay(ymd,interval,symbol)
        // if (candles.opens.length != 96 || candles.highs.length != 96 || candles.lows.length != 96 || candles.closes.length != 96 || candles.candles.length != 96) {
        //   debugger
        // }
        var candlesString = JSON.stringify(candles)
        await writeFile(writePath,candlesString,writeFileOptions)
        console.log('done writing', writePath)
      }
    }
    ymd = ymdHelper.nextDay(ymd)
  }
} catch(e) {console.error(e.stack||e);debugger} }

const msPerDay = 24*60*60000

async function getTradeBucketed(interval,time,symbol) {
  var readPath = getCandleFile(interval,ymdHelper.YYYYMMDD(time),symbol)
  var str = fs.readFileSync(readPath,readFileOptions)
  var dayMarket = JSON.parse(str)
  return dayMarket
}

async function readTradeDay(time,symbol) {
  var ymd = ymdHelper.YYYYMMDD(time)
  return new Promise((resolve, reject) => {
    console.time('readTradeDay')
    const minPath = getMinTradeFile(ymd,symbol)
    if (fs.existsSync(minPath)) {
      let trades = JSON.parse(fs.readFileSync(minPath,readFileOptions))
      resolve(trades)
      console.timeEnd('readTradeDay')
    }
    else {
      const readPath = getCleanedTradeFile(ymd,symbol)
      var trades = []
      fs.createReadStream(readPath).pipe(csvParse())
        .on('data', ([timestamp,side,size,price]) => {
          timestamp = +timestamp
          side = +side
          size = +size
          price = +price
          let [lastTime,lastSide,lastSize,lastPrice] = trades[trades.length-1] || []
          // let diff = timestamp - lastTime
          let currentMs = timestamp % 60000
          let lastMs = lastTime ? lastTime % 60000 : 0
          if (lastMs < 6000 && currentMs > 6000) {
            let insertTime = timestamp - currentMs + 6000
            do {
              trades.push([insertTime, null, 0, lastPrice
                // , new Date(insertTime).toISOString()
              ])
              insertTime += 60000
            } while(insertTime < timestamp)
          }
          if (
            // diff > 5000 || 
            price != lastPrice) {
            trades.push([timestamp, side, size, price
              // , new Date(timestamp).toISOString()
            ])
          }
        })
        .on('error', e => reject(e))
        .on('end', () => {
          fs.writeFileSync(minPath,JSON.stringify(trades),writeFileOptions)
          resolve(trades)
          console.timeEnd('readTradeDay')
        })
    }
  })
}

module.exports = {
  downloadTradeData: downloadTradeData,
  generateCandleDayFiles: generateCandleDayFiles,
  getTradeBucketed: getTradeBucketed,
  readTradeDay: readTradeDay
}