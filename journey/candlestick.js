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

module.exports = {
  fillPatterns: fillPatterns,
  isHammer: isHammer,
}