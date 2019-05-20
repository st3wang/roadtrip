var padStart = require('string.prototype.padstart');

function getTime(ymd) {
  return new Date(YYYY_MM_DD(ymd)+'T00:00:00.000Z').getTime()
}

function YYYYMMDD(time) {
  return (new Date(time).toISOString()).substring(0,10).replace(/-/g,'')
}

function getYmd(ymd) {
  var y = Math.floor(ymd / 10000)
  var m = Math.floor((ymd - y * 10000) / 100)
  var d = ymd - y * 10000 - m * 100
  return {y:y,m:m,d:d}
}

function YYYY_MM_DD(ymd) {
  var date = getYmd(ymd)
  return date.y + '-' + padStart(date.m,2,'0') + '-' + padStart(date.d,2,'0')
}

function nextDay(ymd) {
  var date = getYmd(ymd)
  var y = date.y, m = date.m, d = date.d
  var maxDay = 30
  switch (m) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      maxDay = 31
      break;
    case 2:
      maxDay = (y % 4 == 0 ? 29 : 28)
      break;
  }

  if (++d > maxDay) {
    d = 1
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return y*10000 + m*100 + d
}

module.exports = {
  nextDay: nextDay,
  getYmd: getYmd,
  getTime: getTime,
  YYYY_MM_DD: YYYY_MM_DD,
  YYYYMMDD: YYYYMMDD
}