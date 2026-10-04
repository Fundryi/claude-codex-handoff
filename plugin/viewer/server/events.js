'use strict';

const { sseClients } = require("./runtime");

function broadcast(obj, clients = sseClients) {
  if (!clients.size) return; // nobody listens: skip the stringify
  const line = "data: " + JSON.stringify(obj) + "\n\n";
  for (const res of clients) { try { res.write(line); } catch {} }
}

module.exports = { broadcast };
