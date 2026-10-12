Get Transaction Log (Name: GetTransactionsLog )
Example:http://111.93.157.53/iclock/WebAPIService.asmx?op=GetTransactionsLog
By calling this method we can Get Transaction Log Records by passing From date to date &
serial Number Log records list will be displayed
The following is a sample SOAP 1.1 request and response. The placeholders shown need to be
replaced with actual values
POST /iclock/WebAPIService.asmx HTTP/1.1
Host: localhost
Content-Type: text/xml; charset=utf-8
Content-Length: length
SOAPAction: "http://tempuri.org/GetTransactionsLog"
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
xmlns:xsd="http://www.w3.org/2001/XMLSchema"
xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body>
 <GetTransactionsLog xmlns="http://tempuri.org/">
 <FromDateTime>string</FromDateTime>
 <ToDateTime>string</ToDateTime>
 <SerialNumber>string</SerialNumber>
 <UserName>string</UserName>
 <UserPassword>string</UserPassword>
 <strDataList>string</strDataList>
 </GetTransactionsLog>
 </soap:Body>
</soap:Envelope>
HTTP/1.1 200 OK
Content-Type: text/xml; charset=utf-8
Content-Length: length
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
xmlns:xsd="http://www.w3.org/2001/XMLSchema"
xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body>
 <GetTransactionsLogResponse xmlns="http://tempuri.org/">
 <GetTransactionsLogResult>string</GetTransactionsLogResult>
 <strDataList>string</strDataList>
 </GetTransactionsLogResponse>
 </soap:Body>
</soap:Envelope>
eTimetracklite
CONFIDENTIAL Page 24 of 33
Sample Data
POST /iclock/WebAPIService.asmx HTTP/1.1
Host: 192.168.1.140
Content-Type: text/xml; charset=utf-8
Content-Length: length
SOAPAction: "http://tempuri.org/GetTransactionsLog"
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
xmlns:xsd="http://www.w3.org/2001/XMLSchema"
xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body>
 <GetTransactionsLog xmlns="http://tempuri.org/">
 <FromDate>2021/05/22 09:05</FromDate>
 <ToDate>2021/05/23 16:30</ToDate>
 <SerialNumber>BRM9202760325</SerialNumber>
 <UserName>Test</UserName>
 <UserPassword>Test@1234</UserPassword>
 <strDataList>Balnk</strDataList>
 </GetTransactionsLog>
 </soap:Body>
</soap:Envelope>
HTTP/1.1 200 OK
Content-Type: text/xml; charset=utf-8
Content-Length: length
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
xmlns:xsd="http://www.w3.org/2001/XMLSchema"
xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body>
 <GetTransactionsLogResponse xmlns="http://tempuri.org/">
 <GetTransactionsLogResult>We will Post data</GetTransactionsLogResult>
 <strDataList>We will Post data</strDataList>
 </GetTransactionsLogResponse>
 </soap:Body>
</soap:Envelope>