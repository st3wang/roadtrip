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

const oneDayMs = 24*60*60000

const candleFilePath = 'data/exchange/candle/YYYYMMDD.json'
const feedFilePath = 'data/exchange/feed/YYYYMMDD.json'

function getCandleFile(exchange,symbol,interval,ymd) {
  return candleFilePath.replace('exchange',exchange).replace('YYYYMMDD',symbol+'/'+interval+'/'+ymd)
}

function getFeedFile(exchange,symbol,interval,ymd) {
  return feedFilePath.replace('exchange',exchange).replace('YYYYMMDD',symbol+'/'+interval+'/'+ymd)
}

async function readCandleDay(exchange,interval,time,symbol) {
  var readPath = getCandleFile(exchange,symbol,interval,ymdHelper.YYYYMMDD(time))
  if (fs.existsSync(readPath)) {
    var str = fs.readFileSync(readPath,readFileOptions)
    var dayMarket = JSON.parse(str)
    return dayMarket
  }
}

async function readFeedDay(exchange,symbol,interval,time) { try {
  var readPath = getFeedFile(exchange,symbol,interval,ymdHelper.YYYYMMDD(time))
  if (fs.existsSync(readPath)) {
    var str = fs.readFileSync(readPath,readFileOptions)
    var feeds = JSON.parse(str)
    return feeds
  }
  else {
    return []
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function readMarket(exchange,symbol,interval,st,et) { try {
  oneCandleMs = interval * 60000
  var startTime = new Date(st).getTime()
  var endTime = new Date(et).getTime() + oneCandleMs
  var startDayTime = startTime - (startTime % oneDayMs) 
  var marketBuffer = {
    opens: [],
    highs: [],
    lows: [],
    closes: [],
    candles: []
  }
  for (; startDayTime < endTime; startDayTime += oneDayMs) {
    endDayTime = startDayTime + oneDayMs - 1
    let {opens,highs,lows,closes,candles} = await readCandleDay(exchange,interval,startDayTime,symbol)
    marketBuffer.opens.push(...opens)
    marketBuffer.highs.push(...highs)
    marketBuffer.lows.push(...lows)
    marketBuffer.closes.push(...closes)
    marketBuffer.candles.push(...candles)
  }
  var startIndex = startTime % (oneDayMs) / oneCandleMs
  var endIndex = startIndex + (endTime - startTime) / oneCandleMs
  var market = {
    opens: marketBuffer.opens.slice(startIndex,endIndex),
    highs: marketBuffer.highs.slice(startIndex,endIndex),
    lows: marketBuffer.lows.slice(startIndex,endIndex),
    closes: marketBuffer.closes.slice(startIndex,endIndex),
    candles: marketBuffer.candles.slice(startIndex,endIndex),
  }
  return market
} catch(e) {logger.error(e.stack||e);debugger} }

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

module.exports = {
  getCandleFile: getCandleFile,
  getFeedFile: getFeedFile,
  getFeedDay: getFeedDay,
  readCandleDay: readCandleDay,
  readFeedDay: readFeedDay,
  readMarket: readMarket
}