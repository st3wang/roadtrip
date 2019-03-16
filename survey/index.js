const util = require('util')
const fs = require('fs')

const ymdHelper = require('./ymdHelper')
const server = require('./server')
const bitmex = require('./bitmex')
const binance = require('./binance')
const marketHelper = require('./marketHelper')
const strategy = require('./strategy')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

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

function getRsiCaseFilePath(startYmd,endYmd,interval,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor) {
  return 'data/case/rsi/'+startYmd+'_'+interval+'/'+
    rsiLength+'_'+rsiOverbought+'_'+rsiOversold+'_'+stopLossLookBack+'_'+profitFactor+'.json'
}

function getRsiCaseFileDir(startYmd,length,interval,rsiOverbought,rsiOversold) {
  return 'data/case/rsi/'+startYmd+'_'+length+'_'+interval+'/'+rsiOverbought+'_'+rsiOversold+'/'
}

async function generateRsiCaseFiles(startYmd,endYmd,interval,config) {
  var startTime = new Date(ymdHelper.YYYY_MM_DD(startYmd)).getTime()
  var market = await bitmex.getMarket(startYmd,endYmd,interval)
  market.rsis = []

  var minRsiLength = config.minRsiLength, maxRsiLength = config.maxRsiLength
  var minRsiOverbought = config.minRsiOverbought, maxRsiOverbought = config.maxRsiOverbought
  var minRsiOversold = config.minRsiOversold, maxRsiOversold = config.maxRsiOversold
  var minStopLossLookBack = config.minStopLossLookBack, maxStopLossLookBack = config.maxStopLossLookBack
  var minProfitFactor = config.minProfitFactor, maxProfitFactor = config.maxProfitFactor
  
  for (var rsiLength = minRsiLength; rsiLength <= maxRsiLength; rsiLength++) {
    market.rsis[rsiLength] = await strategy.getRsi(market.closes,rsiLength)
  }

  await loopRsiCase(config, async (key,setup) => {
    var result = await strategy.getRsiCase(startTime,interval,market,setup)
    var writeFilePath = 'data/case/rsi/model/' + startTime + '_' + interval + '_' + key + '.js'
    await writeFile(writeFilePath, 'var model = ' + JSON.stringify(result), writeFileOptions)
  })

  console.log('done generateRsiCaseFiles')
}

async function getRsiCaseTrades(startYmd, endYmd, interval, rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor) {
  var readPath = getRsiCaseFilePath(bitmex.historyStartYmd, endYmd, interval, rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor)
  var jsonString = fs.readFileSync(readPath,readFileOptions)
  if (jsonString.length == 0) {
    return []
  }
  var trades = JSON.parse(jsonString)
  var startTime = new Date(ymdHelper.YYYY_MM_DD(startYmd)).getTime()
  var endTime = new Date(ymdHelper.YYYY_MM_DD(endYmd)).getTime() + (24*60*60000) - 1
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

  // var overviews = await getRsiOverviewFile(startYmd,endYmd)
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
  await loopRsiCase(config, async (key,setup,rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor) => {
    var trades = await db.getTrades(rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor)
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
    minRsiLength: 2, maxRsiLength: 2,
    minRsiOverbought: 55, maxRsiOverbought: 55,
    minRsiOversold: 45, maxRsiOversold: 45,
    minStopLossLookBack: 4, maxStopLossLookBack: 4,
    minProfitFactor: 150, maxProfitFactor: 150,
    minStopLoss: 0.001, maxStopLoss: 0.01,
    riskPerTradePercent: 0.01
  }
  await generateRsiCaseFiles(bitmex.historyStartYmd,20190307,15,config)
  debugger
  // await generateRsiOverviewFile(20190219,20190222,15,config)
  console.log('done updateRsiCaseFiles')
}

async function test() {
  var config = {
    minRsiLength: 11, maxRsiLength: 11,
    minRsiOverbought: 51, maxRsiOverbought: 51,
    minRsiOversold: 15, maxRsiOversold: 15,
    minStopLossLookBack: 10, maxStopLossLookBack: 10,
    minProfitFactor: 150, maxProfitFactor: 150,
    minStopLoss: 0.001, maxStopLoss: 0.01,
    riskPerTradePercent: 0.01
  }
  await studyRsiProfit(20190123,20190223,15,config)
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

async function initMarketServer() {
  let markets = {}

  // var setup = {
  //   rsiLength: 2, rsiOverboughtExecute: 55, rsiOversoldExecute: 50,
  //   stopLossLookBack: 4, profitFactor: 150, compound: true
  // }
  // var overview = await strategy.getRsiCase(startTime,15,market,setup)
  // debugger

  let getMarketData = async function(setup) {
    let startYMD = setup.startYMD
    if (!markets[startYMD]) {
      markets[startYMD] = await marketHelper.getMarket('bitmex',15,startYMD,20190307)
      markets[startYMD].rsis = []
    }
    return markets[startYMD]
  }
  let getMarketJson = async function(setup) {
    let market = await getMarketData(setup)
    return JSON.stringify({closes:market.closes})
  }
  let getOverviewJson = async function(setup) {
    let rsiLength = setup.rsiLength
    if (rsiLength < 2) {
      return '{"errorMessage":"Invalid rsiLength"}'
    }
    let startYMD = setup.startYMD
    let overviewJson
    let market = await getMarketData(setup)
    if (!market.rsis[rsiLength]) {
      market.rsis[rsiLength] = await strategy.getRsi(market.closes,rsiLength)
    }
    let key = rsiLength + '_' + setup.rsiOverbought + '_' + setup.rsiOversold + '_' + setup.stopLossLookBack + '_' + setup.profitFactor
    let fileName = 'data/case/rsi/overview/' + key + '.json'
    if (fs.existsSync(fileName)) {
      overviewJson = await readFile(fileName,readFileOptions)
    }
    else {
      let startTime = new Date(ymdHelper.YYYY_MM_DD(startYMD)).getTime()
      let overview = await strategy.getRsiCase(startTime,15,market,setup)
      overviewJson = JSON.stringify(overview)
      // await writeFile(fileName, overviewJson, writeFileOptions)
    }
    return overviewJson
  }
  await server.init(getMarketJson,getOverviewJson)
}

async function start() {
  // await bitmex.updateCandleFiles()
  // await binance.updateCandleFiles()

  await initMarketServer()
}

start()

