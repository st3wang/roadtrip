const util = require('util')
const fs = require('fs')
const ymdHelper = require('./ymdHelper')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const csvParse = require('csv-parse')
const csvStringify = require('csv-stringify')
const roadmap = require('./roadmap');

const filePath = 'data/bitmex/trade/YYYYMMDD.csv'
const symbol = 'XBTUSD'
const historyStartYmd = 20170101

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
      const csvFilename = filePath.replace('YYYYMMDD',ymd) //'data/trade/' + ymd + '.csv'
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
    ymd = ymdHelper.nextDay(ymd)
  }
}

async function generateCandleDayFiles(startYmd,endYmd,interval) {
  var ymd = startYmd
  while (ymd <= endYmd) {
    var writePath = 'data/bitmex/candle/' + interval + '/' + ymd + '.json'
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
    ymd = ymdHelper.nextDay(ymd)
  }
}

async function updateMarketData() {
  var interval = 15
  var startYmd = historyStartYmd
  var endYmd = 20190307
  await downloadTradeData(startYmd,endYmd)
  await generateCandleDayFiles(startYmd,endYmd,interval)
  // var market = await getMarket(startYmd,endYmd,interval)
  // var marketString = JSON.stringify(market)
  // var path = 'data/market/'+interval+'/market.json'
  // await writeFile(path,marketString,writeFileOptions)
}

async function getMarket(startYmd,endYmd,interval) {
  console.log('getMarket',startYmd,endYmd,interval)
  var opens = [], highs = [], lows = [], closes = []
  for (var ymd = startYmd; ymd <= endYmd; ymd = ymdHelper.nextDay(ymd)) {
    var path = 'data/bitmex/candle/' + interval + '/' + ymd + '.json'
    var marketString = await readFile(path,readFileOptions)
    var market = JSON.parse(marketString)
    opens = opens.concat(market.opens)
    highs = highs.concat(market.highs)
    lows = lows.concat(market.lows)
    closes = closes.concat(market.closes)
  }
  var rsis = []
  var market = {
    opens:opens, highs:highs, lows:lows, closes:closes, rsis:rsis
  }
  fillMarketNull(market)
  return market
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

module.exports = {
  historyStartYmd, historyStartYmd,
  getMarket: getMarket,
  updateMarketData: updateMarketData
}
