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

function getAnnotation({timestamp,price,stopPx,ordStatus,orderQty},arrowColor) {
  return {
    x: timestamp,
    y: (price||stopPx),
    ax: -40,
    ay: -0,
    xref: 'x',
    yref: 'y',
    text: (orderQty||'')+'x'+(price||stopPx),
    font: {color: arrowColor},
    showarrow: true,
    arrowwidth: 5,
    arrowsize: 0.5,
    arrowcolor: arrowColor,
    opacity: ordStatus == 'Filled' ? 1 : 0.5
  }
}

async function init() {
  var marketResponse = await fetch('market.json')
  var market = await marketResponse.json()

  var marketTrace = {
    type: 'candlestick',
    xaxis: 'x',
    yaxis: 'y',
    increasing: {line: {color:'#53B987', width:1}, fillcolor:'#53B987'},
    decreasing: {line: {color:'#EB4D5C', width:1}, fillcolor:'#EB4D5C'},
    x: market.candles.map(c => {return c.time}),
    open: market.opens,
    high: market.highs,
    low: market.lows,
    close: market.closes,
  }

  var tradeResponse = await fetch('trade.json')
  var trade = await tradeResponse.json()

  var annotations = []
  var shapes = []

  trade.orders.forEach(o => {
    annotations.push(getAnnotation(o,'#888'))
  })

  trade.trades.forEach(({timestamp,capitalBTC,type,orderQtyUSD,entryPrice,stopLoss,stopMarket,takeProfit,takeHalfProfit,entryOrders,closeOrders,takeProfitOrders,otherOrders}) => {
//     var endTime = new Date(new Date(timestamp).getTime() + 3600000).toISOString()
    var allOrders = entryOrders.concat(closeOrders).concat(takeProfitOrders)
    var endTime = allOrders.reduce((a,c) => {
      return (new Date(c.timestamp).getTime() > new Date(a).getTime()) ? c.timestamp : a
    },timestamp)
    if (endTime == timestamp) {
      var endTime = new Date(new Date(timestamp).getTime() + 600000).toISOString()
    }
    var arrowColor
    console.log('endTime',endTime)
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

// var trace1 = {
//   x: ['2017-02-01T00:00:00.000Z', '2017-02-01T00:01:00.000Z', '2017-02-01T00:02:00.000Z', '2017-02-01T00:03:00.000Z'], 
//   open: [100,102,102,107],
//   high: [103,103,109,108],
//   low: [99,101,102,103],
//   close: [102,102,107,105],
//   increasing: {line: {color: '#53B987'}},
//   decreasing: {line: {color: '#EB4D5C'}},
//   type: 'candlestick',
//   xaxis: 'x',
//   yaxis: 'y'
// }

