'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const mediaEntries = new Map();
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MEDIA_MAX = 10 * 1024 * 1024;

// Only adapters supply locations, from the viewer's discovered transcript files.
// part is a JSON property/index path, never a filesystem path.
function registerMedia({ file, offset, part, mime }) {
  if (typeof file !== 'string' || !Number.isSafeInteger(offset) || offset < 0 ||
      !Array.isArray(part) || !part.length || !mediaTypes.has(mime)) return null;
  const key = JSON.stringify([file, offset, part, mime]);
  for (const [ref, entry] of mediaEntries) if (entry.key === key) return ref;
  const ref = crypto.randomBytes(12).toString('hex');
  mediaEntries.set(ref, { file, offset, part: part.slice(), mime, key });
  if (mediaEntries.size > 500) mediaEntries.delete(mediaEntries.keys().next().value);
  return ref;
}

function readMedia(ref) {
  if (typeof ref !== 'string' || !/^[0-9a-f]{24}$/.test(ref)) return null;
  const entry = mediaEntries.get(ref);
  if (!entry) return null;
  let fd;
  try {
    fd = fs.openSync(entry.file, 'r');
    if (entry.offset) {
      const previous = Buffer.alloc(1);
      if (fs.readSync(fd, previous, 0, 1, entry.offset - 1) !== 1 || previous[0] !== 10) return null;
    }
    // Bound both disk I/O and JSON/base64 allocation, even for a hostile line.
    const cap = Math.ceil(MEDIA_MAX / 3) * 4 + 64 * 1024;
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    let length = 0, complete = false;
    while (length < cap) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, cap - length), entry.offset + length);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? n : nl)));
      length += n;
      if (nl >= 0) { complete = true; break; }
    }
    if (!complete) return null;
    let part = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    for (const key of entry.part) {
      if (!part || typeof part !== 'object' || !Object.prototype.hasOwnProperty.call(part, key)) return null;
      part = part[key];
    }
    let source = part && part.type === 'image' && part.source;
    if (part && part.type === 'input_image' && typeof part.image_url === 'string') {
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/.exec(part.image_url);
      if (m) source = { type: 'base64', media_type: m[1], data: m[2] };
    }
    if (!source || source.type !== 'base64' || source.media_type !== entry.mime || !mediaTypes.has(source.media_type)) return null;
    const data = source.data;
    if (typeof data !== 'string' || !data.length || data.length > Math.ceil(MEDIA_MAX / 3) * 4 ||
        data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MEDIA_MAX || bytes.toString('base64') !== data) return null;
    return { mime: entry.mime, bytes };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { registerMedia, readMedia };
