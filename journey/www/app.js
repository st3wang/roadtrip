var setup = JSON.parse(localStorage.getItem('setup'))
if (!setup) {
  setup = {
    symbol: 'ETHUSD',
    interval: 1,
    startTime: '2018-08-03T00:00:00.000Z',
    endTime: '2019-05-09T00:00:00.000Z',
    rsi: {
      length: 2,
      shortPrsi: 65,
      shortRsi: 55,
      longRsi: 55,
      longPrsi: 50
    }
  }
  localStorage.setItem('setup',JSON.stringify(setup))
}
var lastStartTime, lastEndTime, lastMarket

if (location.hostname != 'localhost') {
  var now = new Date()
  setup.startTime = new Date(now.getTime() - 480*60000).toISOString()
  setup.endTime = now.toISOString()
}

symbolInput.value = setup.symbol
intervalInput.value = setup.interval
startTimeInput.value = setup.startTime
endTimeInput.value = setup.endTime

rsiLengthInput.value = setup.rsi.length
shortPrsiInput.value = setup.rsi.shortPrsi
shortRsiInput.value = setup.rsi.shortRsi
longPrsiInput.value = setup.rsi.longPrsi
longRsiInput.value = setup.rsi.longRsi

function changeDate(i) {
  var st = new Date(startTimeInput.value).getTime() + (i * 24*60*60000)
  var et = new Date(endTimeInput.value).getTime() + (i * 24*60*60000)
  setup.startTime = new Date(st).toISOString()
  setup.endTime = new Date(et).toISOString()
  startTimeInput.value = setup.startTime
  endTimeInput.value = setup.endTime
  setupAndPlot()
}

function changeValue(e,i) {
  var v = +e.value
  e.value = (v+i) + ''
  setupAndPlot()
}

function setupAndPlot() {
  setup.symbol = symbolInput.value
  setup.interval = intervalInput.value
  setup.startTime = startTimeInput.value
  setup.endTime = endTimeInput.value
  setup.rsi.length = +rsiLengthInput.value
  setup.rsi.shortPrsi = +shortPrsiInput.value
  setup.rsi.shortRsi = +shortRsiInput.value
  setup.rsi.longPrsi = +longPrsiInput.value
  setup.rsi.longRsi = +longRsiInput.value
  localStorage.setItem('setup',JSON.stringify(setup))
  plot()
}

function handleInputEnter() {
  if (event.keyCode === 13) {
    event.preventDefault()
    setupAndPlot()
  }
}

plotButton.onclick = setupAndPlot

dateButtonLeft.onclick = e => changeDate(-1)
dateButtonRight.onclick = e => changeDate(1)

startTimeInput.onkeyup = 
endTimeInput.onkeyup = 
rsiLengthInput.onkeyup = 
shortPrsiInput.onkeyup = 
shortRsiInput.onkeyup = 
longPrsiInput.onkeyup = 
longRsiInput.onkeyup = handleInputEnter

const step = 5
rsiLengthDown.onclick = e => changeValue(rsiLengthInput,-1)
rsiLengthUp.onclick = e => changeValue(rsiLengthInput,1)
shortPrsiDown.onclick = e => changeValue(shortPrsiInput,-step)
shortPrsiUp.onclick = e => changeValue(shortPrsiInput,step)
shortRsiDown.onclick = e => changeValue(shortRsiInput,-step)
shortRsiUp.onclick = e => changeValue(shortRsiInput,step)
longPrsiDown.onclick = e => changeValue(longPrsiInput,-step)
longPrsiUp.onclick = e => changeValue(longPrsiInput,step)
longRsiDown.onclick = e => changeValue(longRsiInput,-step)
longRsiUp.onclick = e => changeValue(longRsiInput,step)

function getTradeShape(startTime,endTime,startPrice,endPrice) {
  return {
    type: 'rect',
    xref: 'x',
    yref: 'y',
    opacity: 0.2,
    line: {
      width: 0
    },
    x0: startTime,
    x1: endTime,
    y0: startPrice,
    y1: endPrice,
    fillcolor: startPrice < endPrice ? '#0f0' : '#f00',
  }
}

function getTradeAnnotation({timestamp,transactTime,price,stopPx,ordStatus,orderQty},arrowColor) {
  return {
    x: transactTime,
    y: (price||stopPx),
    ax: -12,
    ay: -0,
    xref: 'x',
    yref: 'y',
    xanchor: 'right',
    text: (orderQty||'')+'x'+(price||stopPx),
    font: {color: arrowColor},
    showarrow: true,
    arrowwidth: 4,
    arrowsize: 0.5,
    arrowcolor: arrowColor,
    opacity: ordStatus == 'Filled' ? 1 : 0.5
  }
}

function getCandlestickAnnotation({time,low},text) {
  return {
    x: time,
    y: low,
    ax: 0,
    ay: 0,
    xref: 'x',
    yref: 'y',
    yanchor: 'top',
    text: text,
//     font: {color: 'white'},
    showarrow: false
  }
}

async function getMarket() {
  var marketResponse = await fetch('GetMarket', {
    method: "POST",
    body: JSON.stringify(setup)
  })
  return await marketResponse.json()
}

async function getTrade() {
  var tradeResponse = await fetch('GetTrade', {
    method: "POST",
    body: JSON.stringify(setup)
  })
  return await tradeResponse.json()
}

function addTradeShapesAndAnnotations(trade,lastCandleTime,shapes,annotations) {
  if (trade && trade.trades.length < 100) {
    trade.orders.forEach(o => {
      annotations.push(getTradeAnnotation(o,'#888'))
    })

    trade.trades.forEach(({timestamp,capitalBTC,type,orderQtyUSD,entryPrice,stopLoss,stopMarket,takeProfit,takeHalfProfit,entryOrders,closeOrders,takeProfitOrders,otherOrders},i) => {
  //     var endTime = new Date(new Date(timestamp).getTime() + 3600000).toISOString()
      var allOrders = entryOrders.concat(closeOrders).concat(takeProfitOrders).concat(otherOrders)
      var closeOrders = allOrders.filter(({ordStatus,execInst}) => {
        return execInst != 'ParticipateDoNotInitiate' && ordStatus == 'Filled'
      })
      var endTime
      if (closeOrders.length == 0 && i == trade.trades.length-1) {
        endTime =  lastCandleTime 
      }
      else {
        endTime = allOrders.reduce((a,c) => {
          return (new Date(c.timestamp).getTime() > new Date(a).getTime()) ? c.timestamp : a
        },timestamp)
        if (endTime == timestamp) {
          endTime = new Date(new Date(timestamp).getTime() + 600000).toISOString()
        }
      }


      var arrowColor
      if (type == 'LONG') {
        shapes.push(getTradeShape(timestamp,endTime,entryPrice,takeProfit))
        shapes.push(getTradeShape(timestamp,endTime,entryPrice,stopLoss))
        arrowColor = '#008fff'
      }
      else {
        shapes.push(getTradeShape(timestamp,endTime,takeProfit,entryPrice))
        shapes.push(getTradeShape(timestamp,endTime,stopLoss,entryPrice))
        arrowColor = '#cc47ed'
      }
      entryOrders.forEach((o) => {
        annotations.push(getTradeAnnotation(o,arrowColor))
      })
      closeOrders.forEach((o) => {
        annotations.push(getTradeAnnotation(o,arrowColor))
      })
      takeProfitOrders.forEach((o) => {
        annotations.push(getTradeAnnotation(o,arrowColor))
      })
      otherOrders.forEach((o) => {
        annotations.push(getTradeAnnotation(o,arrowColor))
      })
    })
  }
}

function addCandlestickAnnotations({candles},annotations) {
  var len = candles.length
  for (var i = 0; i < len; i++) {
    let candle = candles[i]
    if (candle.isHammer) {
      annotations.push(getCandlestickAnnotation(candle,'H'))
    }
  }
}

function plotTrade([market,trade]) {
  var lastCandleDate = new Date(market.candles[market.candles.length-1].time)
  var lastCandleTime = lastCandleDate.getTime() + (lastCandleDate.getTimezoneOffset()*60000)
  var marketTrace = {
    type: 'candlestick',
    xaxis: 'x',
    yaxis: 'y',
    hoverinfo: 'x',
    increasing: {line: {color:'#53B987', width:1}, fillcolor:'#53B987'},
    decreasing: {line: {color:'#EB4D5C', width:1}, fillcolor:'#EB4D5C'},
    x: market.candles.map(c => {return c.time}),
    open: market.opens,
    high: market.highs,
    low: market.lows,
    close: market.closes,
  }

  var shapes = [], annotations = []

  addCandlestickAnnotations(market,annotations)
  addTradeShapesAndAnnotations(trade,lastCandleTime,shapes,annotations)

  
  var layout = {
    dragmode: 'zoom',
    paper_bgcolor: '#131722',
    plot_bgcolor: '#131722',
//     autosize: true,
//     height: window.innerHeight,
    margin: {
      r: 10,
      t: 25,
      b: 40,
      l: 40
    },
    font: {
      size: 8,
      color: '#888'
    },
    showlegend: false,
    xaxis: {
      autorange: true,
      rangeslider: {visible: false},
      title: 'Date',
      type: 'date',
      gridcolor: '#333',
      spikemode: 'across+marker',
      spikecolor: '#888',
      spikethickness: 1,
      spikesnap: 'cursor',
      spikedash: 'dot'
    },
    yaxis: {
      autorange: true,
      type: 'linear',
      gridcolor: '#333',
      spikemode: 'across+marker',
      spikecolor: '#888',
      spikethickness: 1,
      spikesnap: 'cursor',
      spikedash: 'dot'
    },
    annotations: annotations,
    shapes: shapes
  }

  Plotly.newPlot(plotTradeDiv, [marketTrace], layout)
}

function plotWallet([market,trade]) {
  if (!trade.walletHistory.length) return
  var {candles} = market
  var {walletHistory} = trade
  var times = [], balances = [], drawdowns = [], highest = -99999999
  
  times.push(candles[0].time)
  balances.push(walletHistory[0][1]/100000000)
  var highestBalance = walletHistory.reduce((a,[transactTime,walletBalance]) => {
    walletBalance /= 100000000
    times.push(transactTime)
    balances.push(walletBalance)
    return Math.max(a,walletBalance)
  },-99999999)
  times.push(candles[candles.length-1].time)
  balances.push(walletHistory[walletHistory.length-1][1]/100000000)

  balances.forEach((b) => {
    highest = Math.max(highest,b)
    let dd = b - highest + highestBalance
    drawdowns.push(dd)
  })

  var data = [
    {
      x: times,
      y: balances,
      type: 'scatter',
      mode: "lines",
      line: {
        width: 1
      }
    },
    {
      x: times,
      y: drawdowns,
      type: 'scatter',
      mode: "lines",
      line: {
        width: 1
      }
    }
  ]

  var layout = {
    dragmode: 'zoom',
    paper_bgcolor: '#131722',
    plot_bgcolor: '#131722',
    margin: {
      r: 10,
      t: 25,
      b: 40,
      l: 40
    },
    font: {
      size: 8,
      color: '#888'
    },
    showlegend: false,
    xaxis: {
      autorange: true,
      rangeslider: {visible: false},
      title: 'Date',
      type: 'date',
      gridcolor: '#333',
      spikemode: 'across+marker',
      spikecolor: '#888',
      spikethickness: 1,
      spikesnap: 'cursor',
      spikedash: 'dot'
    },
    yaxis: {
      autorange: true,
      type: 'linear',
      gridcolor: '#333',
      spikemode: 'across+marker',
      spikecolor: '#888',
      spikethickness: 1,
      spikesnap: 'cursor',
      spikedash: 'dot'
    }
  }
  
  Plotly.newPlot(plotWalletDiv, data, layout)
}

async function plot() {
  setup.candlestick = true
  var data = await Promise.all([getMarket()])
  lastMarket = data[0]
  plotTrade(data)
  return
  
  if (lastStartTime != setup.startTime || lastEndTime != setup.endTime) {
    Plotly.purge(plotTradeDiv)
    Plotly.purge(plotWalletDiv)
    var data = await Promise.all([getMarket(), getTrade()])
    lastMarket = data[0]
    plotTrade(data)
    plotWallet(data)
  }
  else {
    Plotly.purge(plotWalletDiv);
    var data = await Promise.all([null,getTrade()])
    data[0] = lastMarket
    plotWallet(data)
  }
  lastStartTime = setup.startTime
  lastEndTime = setup.endTime
}

window.onload = plot

