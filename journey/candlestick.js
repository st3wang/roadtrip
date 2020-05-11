function isHammer({tailCandlePercent} ) {
  return (tailCandlePercent > 0.5)
}

function fillPatterns({candles}) {
  var len = candles.length
  for (var i = 0; i < len; i++) {
    let candle = candles[i]
    candle.isHammer = isHammer(candle)
  }
}

function findBottom(v,start) {
  var stop = Math.max(start - 30,0)
  for (var i = start; i > stop; i--) {
      if (v[i-1] > v[i]) {
        return i
      }
  }
  return start
}

function findTop(v,start) {
  var stop = Math.max(start - 30,0)
  for (var i = start; i > stop; i--) {
      if (v[i] > v[i-1]) {
        return i
      }
  }
  return start
}

function findW(v,start,confirmValue,confirmOpen,confirmClose) {
  var bottom1 = findBottom(v,start)
  var top1 = findTop(v,bottom1)
  var bottom2 = findBottom(v,top1)
  var result = 0
  if (bottom1 < start && v[bottom1] >= v[bottom2]) {
    if (confirmOpen <= confirmValue[top1]) {
        if (confirmClose >= confirmValue[top1]) {
          result = 3
        }
        else {
          result = 1
        }
    }
    else {
      result = 2
    }
  }
  if (bottom1 < start && v[bottom1] >= v[bottom2]) {
    if (confirmOpen <= confirmValue[top1]) {
        if (confirmClose >= confirmValue[top1]) {
          result = 3
        }
        else {
          result = 1
        }
    }
    else {
      result = 2
    }
  }
  return [result,bottom1,top1,bottom2]
}

function findM(v,start,confirmValue,confirmOpen,confirmClose) {
  var top1 = findTop(v,start)
  var bottom1 = findBottom(v,top1)
  var top2 = findTop(v,bottom1)
  var result = 0
  if (top1 < start && v[top1] <= v[top2]) {
    if (confirmOpen >= confirmValue[bottom1]) {
        if (confirmClose <= confirmValue[bottom1]) {
          result = 3
        }
        else {
          result = 1
        }
    }
    else {
      result = 2
    }
  }
  return [result,top1,bottom1,top2]
}

// var W3 = [2,3,4,5,6,7,8,9,0,1,2,3,4,5,6,7,8,9,0,1,2,3,4,5,6,7,8,9,
//   9,8,7,6,5,6,7,8,7,6,7,8,9]
// var M3 = [2,3,4,5,6,7,8,9,0,1,2,3,4,5,6,7,8,9,0,1,2,3,4,5,6,7,8,9,
//   5,6,7,9,8,6,7,8,7,6,5,4,3]

// var resultW0 = findW(M3,M3.length-1,M3,7,8)
// var resultW1 = findW(W3,W3.length-1,W3,6,7)
// var resultW2 = findW(W3,W3.length-1,W3,9,10)
// var resultW3 = findW(W3,W3.length-1,W3,8,10)

// var resultM0 = findM(W3,W3.length-1,W3,7,8)
// var resultM1 = findM(M3,M3.length-1,M3,8,7)
// var resultM2 = findM(M3,M3.length-1,M3,4,3)
// var resultM3 = findM(M3,M3.length-1,M3,7,5)
// debugger

function getBody(market) {
  var opens = market.opens
  var closes = market.closes
  var avgBodies = []
  var bodyHighs = []
  var bodyLows = []
  var len = opens.length
  for (var i = 0; i < len; i++) {
    avgBodies.push((opens[i] + closes[i])/2)
    bodyHighs.push(Math.max(opens[i], closes[i]))
    bodyLows.push(Math.min(opens[i],closes[i]))
  }
  return [avgBodies,bodyHighs,bodyLows]
}

function lowestBody(market,length) {
  var opens = market.opens, closes = market.closes, lows = market.lows
  var lowest = 9999999
  var start = market.closes.length - length
  var end = market.closes.length
  for (var i = start; i < end; i++) {
    var weightedLow = (Math.min(opens[i],closes[i])+lows[i])/2
    if (weightedLow < lowest) {
      lowest = weightedLow
    }
  }
  return lowest
}

function highestBody(market,length) {
  var opens = market.opens, closes = market.closes, highs = market.highs
  var highest = 0
  var start = market.closes.length - length
  var end = market.closes.length
  for (var i = start; i < end; i++) {
    var weightedHigh = (Math.max(opens[i],closes[i])+highs[i])/2
    if (weightedHigh > highest) {
      highest = weightedHigh
    }
  }
  return highest
}

module.exports = {
  fillPatterns: fillPatterns,
  isHammer: isHammer,
  getBody: getBody,
  lowestBody: lowestBody,
  highestBody: highestBody,
  findW: findW,
  findM: findM
}