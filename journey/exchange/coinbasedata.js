const util = require('util')
const fs = require('fs')
const https 	= require('https')
const gunzip = require('gunzip-file')

const ymdHelper = require('../ymdHelper')
const shoes = require('../shoes')
const base = require('./basedata')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const candleFilePath = 'data/coinbase/candle/YYYYMMDD.json'
const feedFilePath = 'data/bitmex/feed/YYYYMMDD.json'

const exchange = 'coinbase'
const symbols = ['BTC-USD']

const oneDayMs = 24*60*60000

async function readFeedDay(symbol,interval,time) {
  return await base.readFeedDay(exchange,symbol,interval,time)
}

async function getCandleDay(symbol,interval,ymd) { try {
  console.log('getCandleDay',symbol,interval,ymd)
  return new Promise((resolve,reject) => {
    const yyyy_mm_dd = ymdHelper.YYYY_MM_DD(ymd)
    const options = {
      hostname: 'api.pro.coinbase.com',
      path: '/products/' + symbol + 
        '/candles?granularity=' + (interval*60) + 
        '&start=' + yyyy_mm_dd + 'T00:00:00.000Z' + 
        '&end=' + yyyy_mm_dd + 'T23:00:00Z',
      headers: {
        'User-Agent': 'Mozilla/5.0',
      }
    }

    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
    https.get(options, function(response) {
        let data = ''
        response.on('data', (chunk) => {data += chunk})
        response.on('end', () => {
          let candles = {
            opens: [], highs: [], lows: [], closes: [], candles: []
          }
          let value = JSON.parse(data).reverse()
          value.forEach(v => {
            candles.opens.push(v[3])
            candles.highs.push(v[2])
            candles.lows.push(v[1])
            candles.closes.push(v[4])
            candles.candles.push({
              time: new Date(v[0]*1000).toISOString(),
              volume: v[5],
              open: v[3], high: v[2], low: v[1], close: v[4]
            })
          })
          resolve(candles)
        })
      }
    )
  })
} catch(e) {console.error(e.stack||e);debugger} }
/*
0 time bucket start time
1 low lowest price during the bucket interval
2 high highest price during the bucket interval
3 open opening price (first trade) in the bucket interval
4 close closing price (last trade) in the bucket interval
5 volume volume of trading activity during the bucket interval
*/
async function generateCandleDayFiles(startYmd,endYmd,interval) { try {
  var len = symbols.length
  for (var i = 0; i < len; i++) {
    let symbol = symbols[i],
        ymd = startYmd,
        lastPrice
    while (ymd <= endYmd) {
      let writeCandlePath = base.getCandleFile(exchange,symbol,interval,ymd)
      let candles, feeds
      if (fs.existsSync(writeCandlePath)) {
        console.log('skip candle',writeCandlePath)
      }
      else {
        candles = await getCandleDay(symbol,interval,ymd)
        let candlesString = JSON.stringify(candles)
        await writeFile(writeCandlePath,candlesString,writeFileOptions)
        console.log('done writing candle', writeCandlePath)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      let writeFeedPath = base.getFeedFile(exchange,symbol,interval,ymd)
      if (fs.existsSync(writeFeedPath)) {
        console.log('skip feed',writeFeedPath)
      }
      else {
        candles = candles || JSON.parse(fs.readFileSync(writeCandlePath,readFileOptions))
        feeds = base.getFeedDay(candles,interval,lastPrice)
        let feedsString = JSON.stringify(feeds)
        await writeFile(writeFeedPath,feedsString,writeFileOptions)
        console.log('done writing feed', writeFeedPath)
        lastPrice = feeds[feeds.length-1][3]
      }
      ymd = ymdHelper.nextDay(ymd)
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  generateCandleDayFiles: generateCandleDayFiles,
  readFeedDay: readFeedDay
}