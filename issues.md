I ran npm install and npm run start after we moved the files over from 
the old repo. I noticed I have an issue connecting to my salesforce mcp:
[AUTH] Running databricks auth login --profile DEFAULT...
[AUTH] Login completed for profile DEFAULT
[MODELS] Discovering models from https://7474652247359581.ai-gateway.cloud.databricks.com/api/2.0/serving-endpoints...
[MODELS] Found 30 chat models
[UC] Listing connections from https://fevm-mfg-lb-epl.cloud.databricks.com/api/2.1/unity-catalog/connections
[UC] Found 18 HTTP connections (of 81 total)
[MCP] Connecting to https://fevm-mfg-lb-epl.cloud.databricks.com/api/2.0/mcp/external/mcp-salesforce...
[MCP] >>> initialize -> https://fevm-mfg-lb-epl.cloud.databricks.com/api/2.0/mcp/external/mcp-salesforce
[MCP] >>> body: {
  "jsonrpc": "2.0",
  "id": 1777946662430,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {
      "name": "mason",
      "version": "1.0.0"
    }
  }
}
[MCP] <<< initialize status=401 content-type=application/json
[MCP] !!! Error response (401): {}
[MCP] !!! Response headers: {
  "alt-svc": "clear, clear",
  "content-length": "2",
  "content-type": "application/json",
  "date": "Tue, 05 May 2026 02:04:25 GMT",
  "server": "databricks",
  "server-timing": "request_id;dur=0;desc=\"2cef3a5c-d716-4603-ac1f-d0da6ed52e78\", client_protocol;dur=0;desc=\"HTTP/1.1\", request_id;dur=0;desc=\"7471b5e2-3eaa-4a64-a94d-a027788234e6\", client_protocol;dur=0;desc=\"HTTP/1.1\"",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-databricks-org-id": "7474652247359581",
  "x-request-id": "2cef3a5c-d716-4603-ac1f-d0da6ed52e78"
}
Error occurred in handler for 'mcp-connect': Error: MCP 401: {}
    at mcpRequest (/Users/grant.doyle/LocalRepo/mason/main.js:560:17)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async /Users/grant.doyle/LocalRepo/mason/main.js:595:22
    at async WebContents.<anonymous> (node:electron/js2c/browser_init:2:87023) {
  statusCode: 401
}

I also noticed the desktop icon is not as good as the one from the last repo (the new one is on the right): 
![alt text](vscode.markdown.preview.editor)