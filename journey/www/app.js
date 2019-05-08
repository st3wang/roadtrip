var setup = {}
setup.symbol = 'ETHUSD'
setup.interval = 1

var now = new Date()
setup.startTime = new Date(now.getTime() - 480*60000).toISOString()
setup.endTime = now.toISOString()
if (location.hostname == 'localhost') {
  setup.startTime = '2019-05-07T18:00:00Z'
  setup.endTime = '2019-05-07T20:00:00Z'
}

symbolInput.value = setup.symbol
intervalInput.value = setup.interval
startTimeInput.value = setup.startTime
endTimeInput.value = setup.endTime

function getShape(startTime,endTime,startPrice,endPrice) {
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

function getAnnotation({timestamp,transactTime,price,stopPx,ordStatus,orderQty},arrowColor) {
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

async function init() {
  var marketResponse = await fetch('GetMarket', {
    method: "POST",
    body: JSON.stringify(setup)
  })
  var market = await marketResponse.json()
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

  var tradeResponse = await fetch('GetTrade', {
    method: "POST",
    body: JSON.stringify(setup)
  })
  var trade = await tradeResponse.json()

  var annotations = []
  var shapes = []

  trade.orders.forEach(o => {
    annotations.push(getAnnotation(o,'#888'))
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
      shapes.push(getShape(timestamp,endTime,entryPrice,takeProfit))
      shapes.push(getShape(timestamp,endTime,entryPrice,stopLoss))
      arrowColor = '#008fff'
    }
    else {
      shapes.push(getShape(timestamp,endTime,takeProfit,entryPrice))
      shapes.push(getShape(timestamp,endTime,stopLoss,entryPrice))
      arrowColor = '#cc47ed'
    }
    entryOrders.forEach((o) => {
      annotations.push(getAnnotation(o,arrowColor))
    })
    closeOrders.forEach((o) => {
      annotations.push(getAnnotation(o,arrowColor))
    })
    takeProfitOrders.forEach((o) => {
      annotations.push(getAnnotation(o,arrowColor))
    })
    otherOrders.forEach((o) => {
      annotations.push(getAnnotation(o,arrowColor))
    })
  })

  var layout = {
    dragmode: 'zoom',
    paper_bgcolor: '#131722',
    plot_bgcolor: '#131722',
    height: window.innerHeight,
    margin: {
      r: 10,
      t: 25,
      b: 40,
      l: 60
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

  Plotly.plot('plotlyDiv', [marketTrace], layout);
}

window.onload = init

