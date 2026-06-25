import { createRuntimeFromEnv, type AppEvent, type RpcRequest, type RpcResponse } from "./runtime.js";
import { createLocalServer } from "./server/http-server.js";

const runtime = createRuntimeFromEnv();

if (process.env.COWORK_HTTP_PORT) {
  const port = Number(process.env.COWORK_HTTP_PORT);
  void createLocalServer(runtime, { port }).then((server) => {
    writeResponse({
      id: "http_server",
      event: {
        kind: "mcp_status",
        server: "http",
        url: `http://127.0.0.1:${server.port}`,
      },
    });
  });
}

process.stdin.setEncoding("utf-8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as RpcRequest;
      void dispatch(request);
    } catch (error) {
      writeResponse({
        id: "unknown",
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
});

async function dispatch(request: RpcRequest) {
  try {
    writeResponse(await runtime.handle(request, (event) => writeResponse({ id: request.id, event })));
  } catch (error) {
    writeResponse({
      id: request.id,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function writeResponse(response: RpcResponse | { id: string; event: AppEvent }) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
