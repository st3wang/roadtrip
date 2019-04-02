var fsR = require('fs-reverse')
const Stream = require('stream')
const writableStream = new Stream.Writable()

writableStream._write = (chunk, encoding, next) => {
  var lineString = chunk.toString()
  var line = JSON.parse(lineString)
  if (line.timestamp.indexOf('2019-03-25T21:29') >= 0) {
    console.log(line)
    debugger
  }
  next()
}

fsR('./log/aws_combined.log', {}).pipe(writableStream)