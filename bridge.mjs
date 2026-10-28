#!/usr/bin/env node
/**
 * Office-PC bridge between eSSL eTimeTrackLite Web (SOAP) and Omni HRMS.
 *
 *   cp config.example.json config.json   # then fill in the values
 *   node bridge.mjs --discover           # list SOAP methods and the live sample
 *   node bridge.mjs --dry-run            # fetch and print punches, push nothing, move no cursor
 *   node bridge.mjs                      # one pass: push new punches, run queued device commands
 *   node bridge.mjs --watch              # keep running: commands every ~15 s, punches every 5 min
 *
 * install-task.ps1 runs `--watch` as a Windows scheduled task (SYSTEM, starts
 * at boot, restarted if it stops).
 *
 * Punches: GetTransactionsLog per device serial number. cursor.json (one
 * device) or cursor-<serial>.json (devices list) stores the latest punch time
 * pushed. Each pass asks again from lookbackMinutes (default 120) before the
 * cursor so late-arriving punches are not missed; externalEventId is
 * serial|employee|time, so Omni stores each punch once. The sample request
 * uses FromDate/ToDate; if the server rejects those names, set soapFields to
 * FromDateTime and ToDateTime.
 *
 * Device commands: HR queues add / block / unblock / delete in Omni. The
 * bridge claims them over the same signed channel as punches, calls
 * AddEmployee / BlockUnblockUser / DeleteUser, reports the outcome, and polls
 * GetCommandStatus until the device confirms. Only types listed in
 * allowCommands are carried out; the rest are reported back as refused.
 */
import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const configPath = join(root, "config.json");
const cursorPath = join(root, "cursor.json");
const BATCH_SIZE = 500;
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_LOOKBACK_MINUTES = 120;

export function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function compareLogIds(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Device clock string → ISO-8601 with the configured offset. Null when unrecognized. */
export function toIsoTimestamp(raw, offset) {
  const value = String(raw ?? "").trim();
  const iso = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (iso) {
    const base = `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6] ?? "00"}`;
    return iso[7] ? `${base}${iso[7] === "Z" ? "Z" : iso[7]}` : `${base}${offset}`;
  }
  const dmy = value.match(
    /^(\d{2})[/.-](\d{2})[/.-](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}T${dmy[4]}:${dmy[5]}:${dmy[6] ?? "00"}${offset}`;
  const ymd = value.match(
    /^(\d{4})[/](\d{2})[/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}T${ymd[4]}:${ymd[5]}:${ymd[6] ?? "00"}${offset}`;
  return null;
}

/** `yyyy-MM-dd HH:mm` — format required by GetTransactionsLog on eTimeTrackLite Web. */
export function formatEsslDate(iso, offset) {
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
  const parsed = toIsoTimestamp(iso, offset);
  if (!parsed) throw new Error(`Unparseable date "${iso}"`);
  return formatEsslDate(parsed, offset);
}

/** Epoch ms → ISO-8601 wall clock in the configured offset, e.g. 2026-10-28T09:05:00+05:30. */
export function isoInOffset(ms, offset) {
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  const sign = match[1] === "-" ? -1 : 1;
  const shiftMs = sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  const shifted = new Date(ms + shiftMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${offset}`;
}

export function nowEsslDate(offset) {
  return formatEsslDate(isoInOffset(Date.now(), offset), offset);
}

/**
 * Where a run starts asking eSSL: lookbackMinutes before the cursor, never
 * before syncFrom. Punches that reach the eSSL server late (device offline,
 * out-of-order upload) still get sent; the webhook drops the repeats.
 */
export function lookbackStart(cursor, config) {
  const minutes = Number(config.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES);
  if (!(minutes > 0)) return cursor;
  const floor = toIsoTimestamp(config.syncFrom, config.timezoneOffset);
  const start = Math.max(Date.parse(cursor) - minutes * 60_000, floor ? Date.parse(floor) : -Infinity);
  return start < Date.parse(cursor) ? isoInOffset(start, config.timezoneOffset) : cursor;
}

export function laterTimestamp(a, b) {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export function punchDirection(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "IN" || normalized === "I" || normalized === "CHECKIN" || normalized === "CHECK-IN") {
    return "IN";
  }
  if (normalized === "OUT" || normalized === "O" || normalized === "CHECKOUT" || normalized === "CHECK-OUT") {
    return "OUT";
  }
  return "PUNCH";
}

export function buildSoapEnvelope(config, range) {
  const method = config.method;
  const fields = config.soapFields;
  const values = {
    UserName: config.esslUser,
    Password: config.esslPassword,
    UserPassword: config.esslPassword,
    SerialNumber: config.serialNumber ?? "",
    SerialNo: config.serialNumber ?? "",
    FromDate: range.from,
    ToDate: range.to,
    FromDateTime: range.from,
    ToDateTime: range.to,
    strDataList: "",
    LogId: range.from,
    Location: config.location ?? "",
    LocationCode: config.location ?? "",
  };
  return soapEnvelope(
    method,
    fields.map((name) => [name, Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ""]),
  );
}

/** One SOAP 1.1 request body; `fields` are [name, value] pairs in the service's order. */
export function soapEnvelope(method, fields) {
  const inner = fields.map(([name, value]) => `<${name}>${escapeXml(value ?? "")}</${name}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${method} xmlns="http://tempuri.org/">${inner}</${method}>
  </soap:Body>
</soap:Envelope>`;
}

export function extractSoapResult(xml, method) {
  const fault = xml.match(/<(?:[\w]+:)?faultstring[^>]*>([\s\S]*?)<\/(?:[\w]+:)?faultstring>/i);
  if (fault) {
    throw new Error(decodeXml(fault[1]).replace(/\s+/g, " ").trim());
  }
  const specific = xml.match(
    new RegExp(`<(?:[\\w]+:)?${method}Result[^>]*>([\\s\\S]*?)<\\/(?:[\\w]+:)?${method}Result>`, "i"),
  );
  const list = xml.match(/<(?:[\w]+:)?strDataList[^>]*>([\s\S]*?)<\/(?:[\w]+:)?strDataList>/i);
  const data = list ? decodeXml(list[1]).trim() : "";
  const status = specific ? decodeXml(specific[1]).trim() : "";
  if (data && data.includes(data.includes("\t") ? "\t" : ",")) return data;
  return status;
}

/**
 * Split a GetTransactionsLog strDataList into punch rows.
 * Default shape is tab-separated lines: employeeCode, punch time, then optional direction.
 * This page of the manual does not name those columns — dry-run prints the raw line.
 */
export function parsePunchRows(text, config, lastTimestamp) {
  const columns = config.columns;
  const recordSeparator = columns.recordSeparator;
  const fieldSeparator = columns.fieldSeparator;
  const trimmed = text.trim();
  if (!trimmed || !trimmed.includes(fieldSeparator)) return { rows: [], note: trimmed || null };

  const rows = [];
  let skipped = 0;
  for (const record of trimmed.split(recordSeparator)) {
    if (!record.trim()) continue;
    const fields = record.split(fieldSeparator).map((part) => part.trim());
    const rawTime = fields[columns.timestamp] ?? "";
    const timestamp = toIsoTimestamp(rawTime, config.timezoneOffset);
    if (!rawTime) continue;
    if (!timestamp) throw new Error(`Unparseable punch time "${rawTime}" in: ${record}`);
    if (lastTimestamp && timestamp < lastTimestamp) continue;
    const employeeCode = fields[columns.employeeCode] ?? "";
    const direction =
      columns.direction >= 0 ? punchDirection(fields[columns.direction]) : "PUNCH";
    const externalEventId = `${config.serialNumber}|${employeeCode}|${timestamp}`;
    if (!employeeCode || employeeCode.length > 200 || externalEventId.length > 200) {
      skipped += 1;
      rows.push({ timestamp, event: null, raw: record });
      continue;
    }
    rows.push({
      timestamp,
      raw: record,
      event: {
        externalKey: employeeCode,
        timestamp,
        direction,
        externalEventId,
      },
    });
  }
  rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return { rows, skipped, note: null };
}

export function signIngestBody(body, secret) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export const DEVICE_COMMAND_TYPES = ["ADD_EMPLOYEE", "BLOCK", "UNBLOCK", "DELETE"];

/**
 * The devices this bridge serves. `devices` in config.json lists several (one
 * Omni source each); without it the top-level serialNumber / ingestUrl /
 * ingestSecret describe the only device and keep cursor.json.
 */
export function deviceList(config) {
  if (Array.isArray(config.devices) && config.devices.length > 0) {
    return config.devices.map((device) => ({
      label: device.name || device.serialNumber,
      serialNumber: device.serialNumber,
      ingestUrl: device.ingestUrl,
      ingestSecret: device.ingestSecret,
      syncFrom: device.syncFrom ?? config.syncFrom,
      cursorPath: join(root, `cursor-${String(device.serialNumber).replace(/[^A-Za-z0-9_-]/g, "_")}.json`),
    }));
  }
  return [
    {
      label: config.serialNumber,
      serialNumber: config.serialNumber,
      ingestUrl: config.ingestUrl,
      ingestSecret: config.ingestSecret,
      syncFrom: config.syncFrom,
      cursorPath,
    },
  ];
}

/** SOAP method and fields for one queued command (eTimeTrackLite Web API 1.3). */
export function deviceCommandRequest(command, config, device) {
  const apiKey = ["APIKey", config.apiKey ?? ""];
  const code = ["EmployeeCode", command.employeeCode];
  const name = ["EmployeeName", (command.employeeName ?? "").trim()];
  const serial = ["SerialNumber", device.serialNumber];
  const auth = [
    ["UserName", config.esslUser],
    ["UserPassword", config.esslPassword],
  ];
  switch (command.type) {
    case "ADD_EMPLOYEE":
      // AddEmployee's CommandId is an int: send 0, a blank fails deserialization.
      return {
        method: "AddEmployee",
        fields: [apiKey, code, name, ["CardNumber", ""], serial, ...auth, ["CommandId", 0]],
      };
    case "BLOCK":
    case "UNBLOCK":
      return {
        method: "BlockUnblockUser",
        fields: [apiKey, code, name, serial, ["IsBlock", command.type === "BLOCK" ? "true" : "false"], ...auth, ["CommandId", ""]],
      };
    case "DELETE":
      return { method: "DeleteUser", fields: [apiKey, code, serial, ...auth, ["CommandId", ""]] };
    default:
      throw new Error(`Unknown device command type ${command.type}`);
  }
}

function soapTag(xml, name) {
  const match = xml.match(
    new RegExp(`<(?:[\\w]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w]+:)?${name}>`, "i"),
  );
  return match ? decodeXml(match[1]).trim() : "";
}

/** `<Method>Result` and `<CommandId>` of a reply. Throws on a SOAP fault. */
export function parseSoapReply(xml, method) {
  const fault = soapTag(xml, "faultstring");
  if (fault) throw new Error(fault.replace(/\s+/g, " "));
  return { result: soapTag(xml, `${method}Result`), commandId: soapTag(xml, "CommandId") };
}

const FAILURE_RE = /unsucc|fail|error|invalid|unauth|unathor|denied|reject|not\s*found|not\s*exist|already|timeout|timed\s*out/i;
const SUCCESS_RE = /succe/i;

/**
 * What to report for a command reply. The manual only says "success or
 * failure", so anything that does not read as success is reported as failed
 * with eSSL's own text, and HR can retry it.
 */
export function commandOutcome(reply) {
  const result = reply.result;
  if (FAILURE_RE.test(result) || !SUCCESS_RE.test(result)) {
    return { outcome: "failed", message: result ? `eSSL: ${result}` : "eSSL returned an empty result" };
  }
  const vendorCommandId = reply.commandId && !/^(0|blank)$/i.test(reply.commandId) ? reply.commandId : null;
  // With a command id the device's confirmation is polled; without one there is nothing to wait for.
  return vendorCommandId
    ? { outcome: "sent", vendorCommandId, message: result }
    : { outcome: "applied", message: result };
}

/** GetCommandStatus text → final outcome, or null while the device has not answered yet. */
export function statusOutcome(text) {
  if (FAILURE_RE.test(text)) return "failed";
  if (SUCCESS_RE.test(text)) return "applied";
  return null;
}

function requireConfig(config) {
  const missing = ["esslUrl", "esslUser", "esslPassword", "method", "timezoneOffset", "syncFrom"].filter(
    (key) => !config[key],
  );
  const hasDevices = Array.isArray(config.devices) && config.devices.length > 0;
  if (!hasDevices && !config.serialNumber) missing.push("serialNumber (or a devices list)");
  if (hasDevices) {
    config.devices.forEach((device, index) => {
      if (!device?.serialNumber) missing.push(`devices[${index}].serialNumber`);
    });
  }
  if (!Array.isArray(config.soapFields) || config.soapFields.length === 0) missing.push("soapFields");
  if (!config.columns) missing.push("columns");
  if (missing.length > 0) {
    throw new Error(`config.json is missing: ${missing.join(", ")}`);
  }
  if (!/^[+-]\d{2}:\d{2}$/.test(config.timezoneOffset)) {
    throw new Error('timezoneOffset must look like "+05:30"');
  }
  if (config.lookbackMinutes !== undefined && !(Number(config.lookbackMinutes) >= 0)) {
    throw new Error("lookbackMinutes must be 0 or a positive number");
  }
  const unknown = (config.allowCommands ?? []).filter((type) => !DEVICE_COMMAND_TYPES.includes(type));
  if (unknown.length > 0) {
    throw new Error(`allowCommands has unknown types: ${unknown.join(", ")} (use ${DEVICE_COMMAND_TYPES.join(", ")})`);
  }
}

async function loadConfig() {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new Error("Copy config.example.json to config.json in the essl-bridge folder and fill it in.");
  }
  const config = JSON.parse(raw);
  requireConfig(config);
  return config;
}

async function readCursor(device, config) {
  try {
    const saved = JSON.parse(await readFile(device.cursorPath, "utf8"));
    if (saved.lastTimestamp) return String(saved.lastTimestamp);
  } catch {
    // first run uses syncFrom
  }
  const start = toIsoTimestamp(device.syncFrom, config.timezoneOffset);
  if (!start) throw new Error(`syncFrom "${device.syncFrom}" is not a recognizable date`);
  return start;
}

async function writeCursor(device, lastTimestamp) {
  await writeFile(device.cursorPath, `${JSON.stringify({ lastTimestamp }, null, 2)}\n`);
}

async function esslFetch(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...options });
  const text = await response.text();
  if (!response.ok) {
    // A SOAP fault arrives as HTTP 500 with the reason inside; surface that.
    const fault = text.match(/<(?:[\w]+:)?faultstring[^>]*>([\s\S]*?)<\/(?:[\w]+:)?faultstring>/i);
    if (fault) throw new Error(`eSSL: ${decodeXml(fault[1]).replace(/\s+/g, " ").trim()}`);
    let hint = "";
    if (text.includes("500.24")) {
      hint =
        " IIS 500.24: the iclock app pool must use .NET 4.x and Classic pipeline, or disable ASP.NET Impersonation on that site. See eTimeTrackLite Web hosting manual.";
    } else if (text.includes("404")) {
      hint = " File not found — install/host eTimeTrackLite Web under IIS (iclock folder + WebAPIService.asmx).";
    }
    throw new Error(`eSSL HTTP ${response.status}: ${text.slice(0, 300)}${hint}`);
  }
  return text;
}

function soapCall(config, method, fields) {
  return esslFetch(config.esslUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"http://tempuri.org/${method}"`,
    },
    body: soapEnvelope(method, fields),
  });
}

async function discover(config) {
  const service = new URL(config.esslUrl);
  service.search = "";
  const indexHtml = await esslFetch(service);
  const ops = [...new Set([...indexHtml.matchAll(/\?op=([A-Za-z0-9_]+)/g)].map((match) => match[1]))];
  console.log(ops.length ? `Methods:\n${ops.map((op) => `  ${op}`).join("\n")}` : "No methods listed on the service page.");
  const opUrl = new URL(service);
  opUrl.search = `op=${config.method}`;
  const opHtml = await esslFetch(opUrl);
  const sample = opHtml.match(/<pre>([\s\S]*?)<\/pre>/i);
  console.log(`\nSOAP sample for ${config.method}:`);
  console.log(sample ? decodeXml(sample[1].replaceAll("<br>", "\n")) : "No sample found. Open that ?op= URL in a browser.");
}

async function fetchLogs(config, lastTimestamp, options = {}) {
  const from = formatEsslDate(lastTimestamp, config.timezoneOffset);
  const to = nowEsslDate(config.timezoneOffset);
  const soap = buildSoapEnvelope(config, { from, to });
  if (options.printSoap) {
    console.log("SOAP request body:\n", soap);
  }
  const xml = await esslFetch(config.esslUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"http://tempuri.org/${config.method}"`,
    },
    body: soap,
  });
  const result = extractSoapResult(xml, config.method);
  return { ...parsePunchRows(result, config, lastTimestamp), from, to };
}

function requireIngest(device) {
  if (!device.ingestUrl || !device.ingestSecret || device.ingestSecret === "CHANGE_ME") {
    throw new Error(`Set ingestUrl and ingestSecret for ${device.label} in config.json.`);
  }
}

async function postSigned(url, secret, payload) {
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hrms-signature": signIngestBody(body, secret),
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const reply = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Omni HTTP ${response.status}: ${JSON.stringify(reply)}`);
  }
  return reply;
}

async function syncPunches(config, device, options = {}) {
  // Punch helpers read the serial number from the config they are given.
  const deviceConfig = { ...config, serialNumber: device.serialNumber, syncFrom: device.syncFrom };
  const tag = `[${device.label}]`;
  const lastTimestamp = await readCursor(device, config);
  const since = lookbackStart(lastTimestamp, deviceConfig);
  const { rows, skipped, note, from, to } = await fetchLogs(deviceConfig, since, options);
  if (note && rows.length === 0) {
    console.log(`${tag} eSSL ${from} → ${to} returned no punch rows: ${note.slice(0, 500)}`);
    // eSSL replies "Unathorised User" (sic), so match both spellings.
    if (/una(u)?th/i.test(note)) {
      console.log(
        [
          "",
          "Web API auth failed (not the same as desktop eTimeTrackLite login unless both use the same DB).",
          `  esslUser sent: ${config.esslUser}`,
          `  serialNumber sent: ${device.serialNumber}`,
          "  1) Log in at http://<host>:85/iclock/ with the same username/password.",
          "  2) In the WEB app: Admin → Users → edit user → Is Admin (or full permissions).",
          "  3) Or create a new web user there and put that login in config.json.",
          "  4) If web login fails, run eTimeTrackDatabaseSettings on the server so Web uses the same DB as desktop.",
        ].join("\n"),
      );
    }
    return;
  }
  if (rows.length === 0) {
    if (!options.quiet) console.log(`${tag} No new punches from ${from} to ${to}.`);
    return;
  }

  const sendable = rows.filter((row) => row.event).length;
  console.log(`${tag} Fetched ${rows.length} log(s) from ${from} to ${to} (${sendable} pushable, ${skipped} skipped).`);
  console.log(`${tag} First row: ${rows[0].raw}`);

  if (options.dryRun) {
    for (const row of rows.slice(0, 5)) {
      console.log(row.event ?? `(skipped) ${row.raw}`);
    }
    console.log(`${tag} Dry run: nothing posted, cursor unchanged.`);
    return;
  }

  requireIngest(device);
  let cursor = lastTimestamp;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    const events = batch.flatMap((row) => (row.event ? [row.event] : []));
    const result =
      events.length > 0
        ? await postSigned(device.ingestUrl, device.ingestSecret, { events })
        : { accepted: 0, duplicates: 0, unmatched: 0 };
    // Look-back rows can all predate the saved cursor; never move it backwards.
    cursor = laterTimestamp(cursor, batch[batch.length - 1].timestamp);
    await writeCursor(device, cursor);
    console.log(tag, { from: batch[0].timestamp, to: cursor, ...result });
  }
}

/** Results Omni has not acknowledged yet (network blip); resent on the next pass. */
const unsentResults = new Map();

async function processCommands(config, device) {
  requireIngest(device);
  const tag = `[${device.label}]`;
  const allowed = new Set(config.allowCommands ?? []);
  const claim = await postSigned(`${device.ingestUrl}/commands/claim`, device.ingestSecret, {
    sentAt: new Date().toISOString(),
  });

  const results = [...(unsentResults.get(device.serialNumber) ?? [])];
  for (const command of claim.commands ?? []) {
    if (!allowed.has(command.type)) {
      results.push({
        id: command.id,
        outcome: "failed",
        message: `Not allowed by the office bridge: add ${command.type} to allowCommands in its config.json`,
      });
      continue;
    }
    if (!config.apiKey) {
      results.push({ id: command.id, outcome: "failed", message: "Set apiKey in the office bridge's config.json" });
      continue;
    }
    try {
      const { method, fields } = deviceCommandRequest(command, config, device);
      const outcome = commandOutcome(parseSoapReply(await soapCall(config, method, fields), method));
      results.push({ id: command.id, ...outcome });
      console.log(`${tag} ${command.type} ${command.employeeCode} → ${outcome.outcome}: ${outcome.message ?? ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ id: command.id, outcome: "failed", message: message.slice(0, 500) });
      console.log(`${tag} ${command.type} ${command.employeeCode} → failed: ${message}`);
    }
  }

  for (const pending of claim.awaitingStatus ?? []) {
    try {
      const xml = await soapCall(config, "GetCommandStatus", [
        ["CommandId", pending.vendorCommandId],
        ["UserName", config.esslUser],
        ["UserPassword", config.esslPassword],
      ]);
      const { result } = parseSoapReply(xml, "GetCommandStatus");
      const outcome = statusOutcome(result);
      if (outcome) {
        results.push({ id: pending.id, outcome, message: result ? `eSSL: ${result}` : null });
        console.log(`${tag} command ${pending.vendorCommandId} → ${outcome}: ${result}`);
      }
    } catch (err) {
      // Keep waiting; Omni fails it after 30 minutes without a confirmation.
      console.log(`${tag} status check for command ${pending.vendorCommandId} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (results.length === 0) return;
  try {
    await postSigned(`${device.ingestUrl}/commands/results`, device.ingestSecret, {
      sentAt: new Date().toISOString(),
      results,
    });
    unsentResults.delete(device.serialNumber);
  } catch (err) {
    unsentResults.set(device.serialNumber, results);
    throw err;
  }
}

/** Last error per task, so a persistent failure logs on change or every 10 min, not every pass. */
const lastErrors = new Map();
const REPEAT_ERROR_LOG_MS = 10 * 60_000;

async function runSafely(label, task) {
  try {
    await task();
    if (lastErrors.delete(label)) console.log(`${label}: recovered`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const previous = lastErrors.get(label);
    if (!previous || previous.message !== message || Date.now() - previous.loggedAt >= REPEAT_ERROR_LOG_MS) {
      console.error(`${label}: ${message}`);
      lastErrors.set(label, { message, loggedAt: Date.now() });
    }
    return false;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function watch(config, devices) {
  const commandMs = Math.max(5, Number(config.commandIntervalSeconds ?? 15)) * 1000;
  const punchMs = Math.max(1, Number(config.punchIntervalMinutes ?? 5)) * 60_000;
  console.log(
    `Watching ${devices.length} device(s): commands every ${commandMs / 1000}s, punches every ${punchMs / 60_000} min.`,
  );
  let nextPunchAt = 0;
  for (;;) {
    const started = Date.now();
    const punchesDue = started >= nextPunchAt;
    for (const device of devices) {
      if (punchesDue) {
        await runSafely(`[${device.label}] punches`, () => syncPunches(config, device, { quiet: true }));
      }
      await runSafely(`[${device.label}] commands`, () => processCommands(config, device));
    }
    if (punchesDue) nextPunchAt = started + punchMs;
    await sleep(Math.max(1000, commandMs - (Date.now() - started)));
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = await loadConfig();

  if (args.has("--discover")) {
    await discover(config);
    return;
  }

  const devices = deviceList(config);
  if (args.has("--watch")) {
    await watch(config, devices);
    return;
  }

  const options = { dryRun: args.has("--dry-run"), printSoap: args.has("--print-soap") };
  let ok = true;
  for (const device of devices) {
    ok = (await runSafely(`[${device.label}] punches`, () => syncPunches(config, device, options))) && ok;
    if (!options.dryRun) {
      ok = (await runSafely(`[${device.label}] commands`, () => processCommands(config, device))) && ok;
    }
  }
  if (!ok) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
