const util = require('util')
const fs = require('fs')
const https 	= require('https')

const ymdHelper = require('../ymdHelper')
const shoes = require('../shoes')
const base = require('./basedata')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const exchange = 'bitfinex'
const symbols = ['tBTCUSD']

async function readFeedDay(symbol,interval,time) {
  return await base.readFeedDay(exchange,symbol,interval,time)
}

async function readMarket(symbol,interval,st,et) { try {
  return await base.readMarket(exchange,symbol,interval,st,et)
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarket(symbol,interval,start,end) {
  return new Promise((resolve,reject) => {
    const startTime = new Date(start).getTime()
    const endTime = new Date(end).getTime()
    const options = {
      hostname: 'api-pub.bitfinex.com',
      path: '/v2/candles/trade:' + (interval/60) + 'h:' + symbol + 
        '/hist?start=' + startTime + 
        '&end=' + endTime
    }

    https.get(options, function(response) {
        let data = ''
        response.on('data', (chunk) => {data += chunk})
        response.on('end', () => {
          let candles = {
            opens: [], highs: [], lows: [], closes: [], candles: []
          }
          let value = JSON.parse(data).reverse()
          value.forEach(v => {
            candles.opens.push(v[1])
            candles.highs.push(v[3])
            candles.lows.push(v[4])
            candles.closes.push(v[2])
            candles.candles.push({
              time: new Date(v[0]).toISOString(),
              volume: v[5],
              open: v[1], high: v[3], low: v[4], close: v[2]
            })
          })
          resolve(candles)
        })
      }
    )
  })
}

async function getCandleDay(symbol,interval,ymd) { try {
  console.log('getCandleDay',symbol,interval,ymd)
  const yyyy_mm_dd = ymdHelper.YYYY_MM_DD(ymd)
  return await getMarket(symbol,interval,yyyy_mm_dd+'T00:00:00.000Z',yyyy_mm_dd+'T23:00:00Z')
} catch(e) {console.error(e.stack||e);debugger} }

async function wait(ms) {
  return new Promise((resolve,reject) => {
    setTimeout(_ => resolve(true), ms)
  })
}

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
        await wait(2000)
      }
      ymd = ymdHelper.nextDay(ymd)
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  generateCandleDayFiles: generateCandleDayFiles,
  readFeedDay: readFeedDay,
  readMarket: readMarket,
  getMarket: getMarket
}