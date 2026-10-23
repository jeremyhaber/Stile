#!/usr/bin/env node
'use strict';
// Reference implementation of the Mac app's connector mode: what Chrome starts as the native messaging
// host. A plain byte pipe between stdio and the app's `host.sock` (framing is passed through unchanged).
// It writes nothing to stdout except bytes from the socket.
//
//   SIDEBAR_APP_DIR              directory holding host.sock (default ~/Library/Application Support/Sidebar)
//   SIDEBAR_APP_LAUNCH           optional shell command that starts the app when the socket is missing
//   SIDEBAR_CONNECT_TIMEOUT_MS   how long to wait for the socket (default 10000)

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const APP_DIR_FOR_FLAG = () => process.env.SIDEBAR_APP_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Sidebar');
const { spawn } = require('child_process');

const appDir = process.env.SIDEBAR_APP_DIR || path.join(os.homedir(), 'Library/Application Support/Sidebar');
const sockPath = path.join(appDir, 'host.sock');
const timeoutMs = Number(process.env.SIDEBAR_CONNECT_TIMEOUT_MS) || 10000;
const logFile = path.join(appDir, 'connector.log');

function log(msg) {
  try { fs.mkdirSync(appDir, { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${msg}\n`); } catch { /* best effort */ }
}

function tryConnect() {
  return new Promise((resolve) => {
    const s = net.createConnection(sockPath);
    s.once('connect', () => resolve(s));
    s.once('error', () => { s.destroy(); resolve(null); });
  });
}

async function connect() {
  const t0 = Date.now();
  let launched = false;
  for (;;) {
    const s = await tryConnect();
    if (s) return s;
    // Mirrors the Swift connector: after "Quit Sidebar" (quit-by-user flag) don't relaunch the app.
    if (fs.existsSync(path.join(APP_DIR_FOR_FLAG(), 'quit-by-user'))) return null;
    if (!launched && process.env.SIDEBAR_APP_LAUNCH) {
      launched = true;
      log(`socket missing, launching: ${process.env.SIDEBAR_APP_LAUNCH}`);
      spawn('/bin/sh', ['-c', process.env.SIDEBAR_APP_LAUNCH], { detached: true, stdio: 'ignore' }).unref();
    }
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

(async () => {
  process.stdin.pause();
  const sock = await connect();
  if (!sock) { log(`could not connect to ${sockPath}`); process.exit(1); }
  log('connected');
  process.stdin.pipe(sock);
  sock.pipe(process.stdout, { end: false });
  sock.on('error', (e) => log(`socket error: ${e.message}`));
  sock.on('close', () => { log('socket closed'); process.stdout.write('', () => process.exit(0)); });
  process.stdin.on('end', () => sock.end());
  process.stdout.on('error', () => process.exit(0));
})();
