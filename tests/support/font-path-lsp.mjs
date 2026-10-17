#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const log = process.env.FONT_PATH_LSP_LOG;
if (!log) throw new Error("FONT_PATH_LSP_LOG is required");

let buffer = Buffer.alloc(0);
const page = Buffer.from(
  '<svg viewBox="0 0 16 16" width="16pt" height="16pt" xmlns="http://www.w3.org/2000/svg"><path fill="#010203" d="M 0 0h 1v 1h -1Z"/></svg>',
).toString("base64");

function record(direction, message) {
  appendFileSync(log, `${JSON.stringify({ direction, message })}\n`);
}

function send(message) {
  record("to-client", message);
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function respond(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "initialized") {
    send({ jsonrpc: "2.0", id: "configuration", method: "workspace/configuration", params: { items: [{ section: "tinymist" }] } });
    return;
  }
  if (message.method === "workspace/executeCommand") {
    const command = message.params?.command;
    const result = command === "tinymist.exportSvg" ? { items: [{ page: 0, data: page }] } : null;
    send({ jsonrpc: "2.0", id: message.id, result });
  }
}

function receive(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
    if (!match) throw new Error("missing Content-Length");
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    if (message.method !== "shutdown" && message.method !== "exit") record("from-client", message);
    respond(message);
  }
}

process.stdin.on("data", receive);
