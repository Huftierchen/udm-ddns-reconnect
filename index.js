import fs from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import { Client as SshClient } from "ssh2";

// ---------- Config ----------
const TZ = process.env.TZ || "Europe/Berlin";

// DDNS
const DDNS_USER = process.env.DDNS_USER || "";
const DDNS_PASSWORD = process.env.DDNS_PASSWORD || "";
const DDNS_HOST = process.env.DDNS_HOST || "";
const DDNS_UPDATE_URL =
  process.env.DDNS_UPDATE_URL || "http://ddnss.de/upd.php";

const CHECK_INTERVAL_MINUTES = parseInt(
  process.env.CHECK_INTERVAL_MINUTES || "5",
  10
);

const IP_SERVICE_URL =
  process.env.IP_SERVICE_URL || "https://api.ipify.org";

// Reconnect (SSH)
const RECONNECT_ENABLED =
  (process.env.RECONNECT_ENABLED || "true").toLowerCase() === "true";

const RECONNECT_CRON = process.env.RECONNECT_CRON || "0 5 * * *"; // 05:00
const SSH_HOST = process.env.SSH_HOST || "";
const SSH_PORT = parseInt(process.env.SSH_PORT || "22", 10);
const SSH_USER = process.env.SSH_USER || "";
const SSH_PASSWORD = process.env.SSH_PASSWORD || "";
const SSH_COMMAND =
  process.env.SSH_COMMAND || "/usr/bin/killall -HUP pppd";
const SSH_READY_TIMEOUT_MS = parseInt(
  process.env.SSH_READY_TIMEOUT_MS || "20000",
  10
);

// Persistence
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ---------- Helpers ----------
function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastIp: null, lastUpdateAt: null };
  }
}

async function writeState(state) {
  await ensureDataDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

async function getExternalIp() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(IP_SERVICE_URL, {
      method: "GET",
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`IP service HTTP ${res.status}`);
    const ip = (await res.text()).trim();
    // sehr simple Plausibilitätsprüfung (IPv4/IPv6 grob)
    if (!ip || ip.length < 7) throw new Error(`Bad IP response: "${ip}"`);
    return ip;
  } finally {
    clearTimeout(t);
  }
}

async function updateDdns(currentIp) {
  if (!DDNS_USER || !DDNS_PASSWORD || !DDNS_HOST) {
    throw new Error("DDNS_USER/DDNS_PASSWORD/DDNS_HOST nicht gesetzt.");
  }

  const url = new URL(DDNS_UPDATE_URL);
  url.searchParams.set("user", DDNS_USER);
  url.searchParams.set("pwd", DDNS_PASSWORD);
  url.searchParams.set("host", DDNS_HOST);
  url.searchParams.set("ip", currentIp);
  const safeUrl = new URL(url.toString());
  safeUrl.searchParams.set("pwd", "***");
  log("DDNS Request:", safeUrl.toString());
  log("DDNS Params present:", {
  user: !!DDNS_USER,
  pwd: !!DDNS_PASSWORD,
  host: !!DDNS_HOST,
  ip: currentIp
  });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    const body = (await res.text()).trim();
    if (!res.ok) {
      throw new Error(`DDNS HTTP ${res.status}: ${body}`);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function readPrivateKey() {
  if (!SSH_PRIVATE_KEY_PATH) {
    throw new Error("SSH_PRIVATE_KEY_PATH nicht gesetzt.");
  }
  return fs.readFile(SSH_PRIVATE_KEY_PATH, "utf-8");
}

async function runSshCommand() {
  if (!SSH_HOST || !SSH_USER || !SSH_PASSWORD) {
    throw new Error("SSH_HOST/SSH_USER/SSH_PASSWORD nicht gesetzt.");
  }

  return await new Promise((resolve, reject) => {
    const conn = new SshClient();

    conn
      .on("ready", () => {
        conn.exec(SSH_COMMAND, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          let stdout = "";
          let stderr = "";

          stream
            .on("close", (code) => {
              conn.end();
              resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
            })
            .on("data", (d) => (stdout += d.toString()))
            .stderr.on("data", (d) => (stderr += d.toString()));
        });
      })
      .on("keyboard-interactive", (name, instructions, lang, prompts, finish) => {
        // meistens genau 1 Prompt: "Password:"
        finish(prompts.map(() => SSH_PASSWORD));
      })
      .on("error", (e) => reject(e))
      .connect({
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        password: SSH_PASSWORD,
        tryKeyboard: true,        // <— wichtig
        readyTimeout: SSH_READY_TIMEOUT_MS
      });
  });
}

// ---------- Main loops ----------
async function ddnsLoopTick() {
  const state = await readState();

  let currentIp;
  try {
    currentIp = await getExternalIp();
  } catch (e) {
    log("IP check fehlgeschlagen:", e.message);
    return;
  }

  if (state.lastIp === currentIp) {
    log("IP unverändert:", currentIp);
    return;
  }

  log("IP Änderung erkannt:", state.lastIp, "->", currentIp);

  try {
    const resp = await updateDdns(currentIp);
    log("DDNS Update OK:", resp);

    state.lastIp = currentIp;
    state.lastUpdateAt = new Date().toISOString();
    await writeState(state);
  } catch (e) {
    log("DDNS Update FEHLER:", e.message);
  }
}

function startDdnsInterval() {
  const ms = CHECK_INTERVAL_MINUTES * 60_000;
  log(`Starte DDNS Check alle ${CHECK_INTERVAL_MINUTES} Minuten (TZ=${TZ})`);

  // sofort einmal beim Start
  ddnsLoopTick().catch((e) => log("DDNS Tick Error:", e.message));

  setInterval(() => {
    ddnsLoopTick().catch((e) => log("DDNS Tick Error:", e.message));
  }, ms);
}

function startReconnectCron() {
  if (!RECONNECT_ENABLED) {
    log("Reconnect Cron deaktiviert (RECONNECT_ENABLED=false).");
    return;
  }
  if (!SSH_HOST || !SSH_USER || !SSH_PASSWORD) {
    log("Reconnect Cron übersprungen: SSH_HOST/SSH_USER/SSH_PASSWORD fehlen.");
    return;
  }

  log(`Plane Reconnect via Cron "${RECONNECT_CRON}" (TZ=${TZ})`);

  cron.schedule(
    RECONNECT_CRON,
    async () => {
      log("Starte nächtlichen Reconnect via SSH...");
      try {
        const r = await runSshCommand();
        log("Reconnect SSH fertig. exitCode=", r.code);
        if (r.stdout) log("stdout:", r.stdout);
        if (r.stderr) log("stderr:", r.stderr);
      } catch (e) {
        log("Reconnect SSH FEHLER:", e.message);
      }
    },
    { timezone: TZ }
  );
}

async function main() {
  process.env.TZ = TZ; // wichtig für Cron/Date handling
  await ensureDataDir();

  log("Container gestartet.");
  startDdnsInterval();
  startReconnectCron();
}

main().catch((e) => {
  log("Fatal:", e);
  process.exit(1);
});
