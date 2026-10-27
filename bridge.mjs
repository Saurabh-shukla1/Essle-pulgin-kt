#!/usr/bin/env node
/**
 * Office-PC bridge: pull new eSSL punches and POST them to the HRMS webhook.
 *
 *   cp config.example.json config.json   # then fill in the values
 *   node bridge.mjs --discover           # list SOAP methods and the live sample
 *   node bridge.mjs --dry-run            # fetch and print, do not push or move the cursor
 *   node bridge.mjs                      # push new punches and save the cursor
 *
 * Calls eTimeTrackLite GetTransactionsLog (FromDate/ToDate). cursor.json stores
 * the latest punch time successfully pushed. The same minute is asked again
 * next run; externalEventId is serial|employee|time, so the webhook stores it
 * once. The sample request uses FromDate/ToDate. If the server rejects those
 * names, set soapFields to FromDateTime and ToDateTime.
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

export function nowEsslDate(offset) {
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  const sign = match[1] === "-" ? -1 : 1;
  const shiftMs = sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  const shifted = new Date(Date.now() + shiftMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
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
  const inner = fields
    .map((name) => {
      const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : "";
      return `<${name}>${escapeXml(value)}</${name}>`;
    })
    .join("");
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

function requireConfig(config) {
  const missing = ["esslUrl", "esslUser", "esslPassword", "serialNumber", "method", "timezoneOffset", "syncFrom"].filter(
    (key) => !config[key],
  );
  if (!Array.isArray(config.soapFields) || config.soapFields.length === 0) missing.push("soapFields");
  if (!config.columns) missing.push("columns");
  if (missing.length > 0) {
    throw new Error(`config.json is missing: ${missing.join(", ")}`);
  }
  if (!/^[+-]\d{2}:\d{2}$/.test(config.timezoneOffset)) {
    throw new Error('timezoneOffset must look like "+05:30"');
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

async function readCursor(config) {
  try {
    const saved = JSON.parse(await readFile(cursorPath, "utf8"));
    if (saved.lastTimestamp) return String(saved.lastTimestamp);
  } catch {
    // first run uses syncFrom
  }
  const start = toIsoTimestamp(config.syncFrom, config.timezoneOffset);
  if (!start) throw new Error(`syncFrom "${config.syncFrom}" is not a recognizable date`);
  return start;
}

async function writeCursor(lastTimestamp) {
  await writeFile(cursorPath, `${JSON.stringify({ lastTimestamp }, null, 2)}\n`);
}

async function esslFetch(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...options });
  const text = await response.text();
  if (!response.ok) {
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

async function pushBatch(config, events) {
  const body = JSON.stringify({ events });
  const response = await fetch(config.ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hrms-signature": signIngestBody(body, config.ingestSecret),
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`ingest HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = await loadConfig();

  if (args.has("--discover")) {
    await discover(config);
    return;
  }

  const lastTimestamp = await readCursor(config);
  const printSoap = args.has("--print-soap");
  const { rows, skipped, note, from, to } = await fetchLogs(config, lastTimestamp, { printSoap });
  if (note && rows.length === 0) {
    console.log(`eSSL ${from} → ${to} returned no punch rows: ${note.slice(0, 500)}`);
    if (/unauth/i.test(note)) {
      console.log(
        [
          "",
          "Web API auth failed (not the same as desktop eTimeTrackLite login unless both use the same DB).",
          `  esslUser sent: ${config.esslUser}`,
          `  serialNumber sent: ${config.serialNumber}`,
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
    console.log(`No new punches from ${from} to ${to}.`);
    return;
  }

  const sendable = rows.filter((row) => row.event).length;
  console.log(`Fetched ${rows.length} log(s) from ${from} to ${to} (${sendable} pushable, ${skipped} skipped).`);
  console.log(`First row: ${rows[0].raw}`);

  if (args.has("--dry-run")) {
    for (const row of rows.slice(0, 5)) {
      console.log(row.event ?? `(skipped) ${row.raw}`);
    }
    console.log("Dry run: nothing posted, cursor unchanged.");
    return;
  }

  if (!config.ingestUrl || !config.ingestSecret || config.ingestSecret === "CHANGE_ME") {
    throw new Error("Set ingestUrl and ingestSecret in config.json before a live push.");
  }

  let cursor = lastTimestamp;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    const events = batch.flatMap((row) => (row.event ? [row.event] : []));
    const result = events.length > 0 ? await pushBatch(config, events) : { accepted: 0, duplicates: 0, unmatched: 0 };
    cursor = batch[batch.length - 1].timestamp;
    await writeCursor(cursor);
    console.log({ from: batch[0].timestamp, to: cursor, ...result });
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
