import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSoapEnvelope,
  commandOutcome,
  deviceCommandRequest,
  deviceList,
  extractSoapResult,
  formatEsslDate,
  isoInOffset,
  laterTimestamp,
  lookbackStart,
  parsePunchRows,
  parseSoapReply,
  soapEnvelope,
  statusOutcome,
  signIngestBody,
  toIsoTimestamp,
} from "./bridge.mjs";

const config = {
  esslUser: "Test",
  esslPassword: "p&ss",
  serialNumber: "BRM9202760325",
  timezoneOffset: "+05:30",
  method: "GetTransactionsLog",
  soapFields: ["FromDateTime", "ToDateTime", "SerialNumber", "UserName", "UserPassword", "strDataList"],
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
  assert.match(xml, /<FromDateTime>2021-05-22 09:05<\/FromDateTime>/);
  assert.match(xml, /<ToDateTime>2021-05-23 16:30<\/ToDateTime>/);
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

test("isoInOffset renders epoch ms as local wall clock", () => {
  assert.equal(isoInOffset(Date.parse("2026-10-28T03:35:00Z"), "+05:30"), "2026-10-28T09:05:00+05:30");
});

test("lookback starts before the cursor but never before syncFrom", () => {
  const base = { ...config, syncFrom: "2026-10-28 08:00" };
  assert.equal(lookbackStart("2026-10-28T12:00:00+05:30", base), "2026-10-28T10:00:00+05:30");
  assert.equal(
    lookbackStart("2026-10-28T12:00:00+05:30", { ...base, lookbackMinutes: 30 }),
    "2026-10-28T11:30:00+05:30",
  );
  assert.equal(lookbackStart("2026-10-28T09:00:00+05:30", base), "2026-10-28T08:00:00+05:30");
  assert.equal(
    lookbackStart("2026-10-28T12:00:00+05:30", { ...base, lookbackMinutes: 0 }),
    "2026-10-28T12:00:00+05:30",
  );
});

test("cursor never moves backwards", () => {
  const cursor = "2026-10-28T12:00:00+05:30";
  assert.equal(laterTimestamp(cursor, "2026-10-28T10:30:00+05:30"), cursor);
  assert.equal(laterTimestamp(cursor, "2026-10-28T12:05:00+05:30"), "2026-10-28T12:05:00+05:30");
});

const device = { serialNumber: "BJ2C183961076", label: "office" };
const commandConfig = { ...config, apiKey: "11" };

test("AddEmployee request follows the manual's field order, CommandId 0", () => {
  const { method, fields } = deviceCommandRequest(
    { type: "ADD_EMPLOYEE", employeeCode: "26", employeeName: " Ravi Kumar " },
    commandConfig,
    device,
  );
  assert.equal(method, "AddEmployee");
  assert.deepEqual(fields.map(([name]) => name), [
    "APIKey", "EmployeeCode", "EmployeeName", "CardNumber", "SerialNumber", "UserName", "UserPassword", "CommandId",
  ]);
  const xml = soapEnvelope(method, fields);
  assert.match(xml, /<AddEmployee xmlns="http:\/\/tempuri.org\/"><APIKey>11<\/APIKey><EmployeeCode>26<\/EmployeeCode><EmployeeName>Ravi Kumar<\/EmployeeName><CardNumber><\/CardNumber><SerialNumber>BJ2C183961076<\/SerialNumber>/);
  assert.match(xml, /<UserPassword>p&amp;ss<\/UserPassword><CommandId>0<\/CommandId>/);
});

test("block and unblock share BlockUnblockUser with IsBlock true/false", () => {
  const block = deviceCommandRequest({ type: "BLOCK", employeeCode: "26", employeeName: "Ravi" }, commandConfig, device);
  const unblock = deviceCommandRequest({ type: "UNBLOCK", employeeCode: "26", employeeName: "Ravi" }, commandConfig, device);
  assert.equal(block.method, "BlockUnblockUser");
  assert.deepEqual(block.fields.find(([name]) => name === "IsBlock"), ["IsBlock", "true"]);
  assert.deepEqual(unblock.fields.find(([name]) => name === "IsBlock"), ["IsBlock", "false"]);
  const del = deviceCommandRequest({ type: "DELETE", employeeCode: "26" }, commandConfig, device);
  assert.equal(del.method, "DeleteUser");
  assert.deepEqual(del.fields.map(([name]) => name), ["APIKey", "EmployeeCode", "SerialNumber", "UserName", "UserPassword", "CommandId"]);
});

test("reply parsing reads Result and CommandId, not CommandIds", () => {
  const xml = `<soap:Envelope><soap:Body><AddEmployeeResponse xmlns="http://tempuri.org/">
    <AddEmployeeResult>Success</AddEmployeeResult><CommandId>501</CommandId>
  </AddEmployeeResponse></soap:Body></soap:Envelope>`;
  assert.deepEqual(parseSoapReply(xml, "AddEmployee"), { result: "Success", commandId: "501" });
  assert.throws(() => parseSoapReply("<faultstring>Server was unable</faultstring>", "AddEmployee"), /Server was unable/);
  assert.deepEqual(
    parseSoapReply("<X><DeleteUserResult>ok</DeleteUserResult><CommandIds>9</CommandIds></X>", "DeleteUser"),
    { result: "ok", commandId: "" },
  );
});

test("command outcome: success with an id waits for the device, anything else fails with eSSL's text", () => {
  assert.deepEqual(commandOutcome({ result: "Success", commandId: "501" }), {
    outcome: "sent",
    vendorCommandId: "501",
    message: "Success",
  });
  assert.deepEqual(commandOutcome({ result: "Successfully Blocked", commandId: "0" }), {
    outcome: "applied",
    message: "Successfully Blocked",
  });
  assert.equal(commandOutcome({ result: "Employee already exists", commandId: "" }).outcome, "failed");
  assert.equal(commandOutcome({ result: "Unsuccessful", commandId: "5" }).outcome, "failed");
  assert.equal(commandOutcome({ result: "Unathorised User", commandId: "" }).message, "eSSL: Unathorised User");
  assert.equal(commandOutcome({ result: "", commandId: "" }).outcome, "failed");
});

test("status outcome waits until the device answers", () => {
  assert.equal(statusOutcome("Success"), "applied");
  assert.equal(statusOutcome("Failed"), "failed");
  assert.equal(statusOutcome("Pending"), null);
});

test("devices list: one device from top-level fields, several with their own cursors", () => {
  const single = deviceList({ ...config, ingestUrl: "https://x/api/hrms/ingest/a", ingestSecret: "s", syncFrom: "2026-10-01 00:00" });
  assert.equal(single.length, 1);
  assert.equal(single[0].serialNumber, "BRM9202760325");
  assert.match(single[0].cursorPath, /cursor\.json$/);

  const many = deviceList({
    ...config,
    syncFrom: "2026-10-01 00:00",
    devices: [
      { name: "gate", serialNumber: "AAA1", ingestUrl: "https://x/1", ingestSecret: "s1" },
      { serialNumber: "BBB/2", ingestUrl: "https://x/2", ingestSecret: "s2", syncFrom: "2026-10-20 00:00" },
    ],
  });
  assert.deepEqual(many.map((d) => d.label), ["gate", "BBB/2"]);
  assert.match(many[0].cursorPath, /cursor-AAA1\.json$/);
  assert.match(many[1].cursorPath, /cursor-BBB_2\.json$/);
  assert.equal(many[0].syncFrom, "2026-10-01 00:00");
  assert.equal(many[1].syncFrom, "2026-10-20 00:00");
});
