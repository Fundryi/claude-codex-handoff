'use strict';

const fs = require("fs");

function readAppended(file, cursor, maxBytes) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (st.size < cursor.size) { cursor.offset = 0; cursor.partial = Buffer.alloc(0); }
  const from = cursor.offset;
  if (st.size <= from) { cursor.size = st.size; return { lines: [], st }; }
  const buf = Buffer.alloc(Math.min(st.size - from, maxBytes));
  let fd, n = 0;
  try { fd = fs.openSync(file, "r"); n = fs.readSync(fd, buf, 0, buf.length, from); }
  catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  const data = Buffer.concat([cursor.partial, buf.subarray(0, n)]);
  const cut = data.lastIndexOf(10) + 1;
  cursor.partial = Buffer.from(data.subarray(cut));
  cursor.offset = from + n;
  cursor.size = st.size;
  return { lines: data.toString("utf8", 0, cut).split("\n").filter((l) => l.trim()), st };
}

function claudeCursor() { return { offset: 0, size: 0, partial: Buffer.alloc(0) }; }

function claudeReadHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, bytes, 0));
  } catch { return ""; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// The last `bytes` of a file; midFile when the read did not start at byte 0.
function claudeReadTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    return { text: buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, from)), midFile: from > 0 };
  } catch { return { text: "", midFile: false }; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}


module.exports = { readAppended, claudeCursor, claudeReadHead, claudeReadTail };
