import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSoapEnvelope,
  extractSoapResult,
  formatEsslDate,
  parsePunchRows,
  signIngestBody,
  toIsoTimestamp,
} from "./bridge.mjs";

const config = {
  esslUser: "Test",
  esslPassword: "p&ss",
  serialNumber: "BRM9202760325",
  timezoneOffset: "+05:30",
  method: "GetTransactionsLog",
  soapFields: ["FromDate", "ToDate", "SerialNumber", "UserName", "UserPassword", "strDataList"],
  columns: {
    recordSeparator: "\n",
    fieldSeparator: "\t",
    employeeCode: 0,
    timestamp: 1,
    direction: -1,
  },
};

test("soap envelope matches the GetTransactionsLog sample", () => {
  const xml = buildSoapEnvelope(config, { from: "2021-05-22 09:05", to: "2021-05-23 16:30" });
  assert.match(xml, /<FromDate>2021-05-22 09:05<\/FromDate>/);
  assert.match(xml, /<ToDate>2021-05-23 16:30<\/ToDate>/);
  assert.match(xml, /<SerialNumber>BRM9202760325<\/SerialNumber>/);
  assert.match(xml, /<UserPassword>p&amp;ss<\/UserPassword>/);
  assert.match(xml, /<strDataList><\/strDataList>/);
});

test("parses strDataList rows and builds a stable event id", () => {
  const text = [
    "E001\t2026/09/25 09:01",
    "E001\t25/09/2026 18:05:00",
    "\t2026/09/25 09:02",
  ].join("\n");
  const { rows, skipped } = parsePunchRows(text, config, "2026-09-25T09:01:00+05:30");
  assert.equal(skipped, 1);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].event.externalKey, "E001");
  assert.equal(rows[0].event.timestamp, "2026-09-25T09:01:00+05:30");
  assert.equal(rows[1].event, null);
  assert.equal(rows[2].event.direction, "PUNCH");
  assert.equal(rows[2].event.externalEventId, "BRM9202760325|E001|2026-09-25T18:05:00+05:30");
});

test("a status message with no separators is not treated as punches", () => {
  const parsed = parsePunchRows("We will Post data", config, "2026-09-25T00:00:00+05:30");
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.note, "We will Post data");
});

test("punch rows are read from strDataList, not the status element", () => {
  assert.throws(
    () => extractSoapResult("<faultstring>Unknown element FromDate</faultstring>", "GetTransactionsLog"),
    /Unknown element FromDate/,
  );
  const xml = `<GetTransactionsLogResponse>
    <GetTransactionsLogResult>success</GetTransactionsLogResult>
    <strDataList>E001&#9;2026/09/25 09:01</strDataList>
  </GetTransactionsLogResponse>`;
  assert.equal(extractSoapResult(xml, "GetTransactionsLog"), "E001\t2026/09/25 09:01");
});

test("ingest signature is hex hmac of the exact body", () => {
  const body = JSON.stringify({ events: [{ externalKey: "E001" }] });
  const signature = signIngestBody(body, "secret");
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(signIngestBody(body, "secret"), signature);
  assert.notEqual(signIngestBody(`${body} `, "secret"), signature);
});

test("sample request dates round-trip", () => {
  assert.equal(toIsoTimestamp("2021/05/22 09:05", "+05:30"), "2021-05-22T09:05:00+05:30");
  assert.equal(formatEsslDate("2021-05-22T09:05:00+05:30", "+05:30"), "2021-05-22 09:05");
});
