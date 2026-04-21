import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";

interface ServerOptions {
  port: number;
  projectDir: string;
  apiOnly: boolean;
}

interface ServerReply {
  status: number;
  body: string | Buffer;
  headers: Record<string, string>;
}

function parseArgs(argv: string[]): ServerOptions {
  const options: ServerOptions = {
    port: 4310,
    projectDir: resolve(process.cwd(), "examples", "polarbear-in-space-example"),
    apiOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port" && argv[index + 1]) {
      options.port = Number.parseInt(argv[index + 1]!, 10);
      index += 1;
      continue;
    }
    if (arg === "--project" && argv[index + 1]) {
      options.projectDir = resolve(process.cwd(), argv[index + 1]!);
      index += 1;
      continue;
    }
    if (arg === "--api-only") {
      options.apiOnly = true;
    }
  }

  return options;
}

function jsonResponse(status: number, payload: unknown): ServerReply {
  return {
    status,
    body: `${JSON.stringify(payload, null, 2)}\n`,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  };
}

function textResponse(status: number, body: string | Buffer, contentType = "text/plain; charset=utf-8"): ServerReply {
  return {
    status,
    body,
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  };
}

function send(res: import("node:http").ServerResponse, response: ServerReply): void {
  res.writeHead(response.status ?? 200, response.headers);
  res.end(response.body);
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function safeStaticPath(root: string, requestPath: string): string | undefined {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const normalized = normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = resolve(root, `.${normalized}`);
  if (!fullPath.startsWith(root)) {
    return undefined;
  }
  return fullPath;
}

function safeProjectPath(root: string, requestPath: string): string | undefined {
  const normalized = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = resolve(root, normalized);
  if (!fullPath.startsWith(root)) {
    return undefined;
  }
  return fullPath;
}

const options = parseArgs(process.argv.slice(2));
const uiDistDir = resolve(process.cwd(), "ui", "dist");
const hasUiDist = existsSync(uiDistDir);

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (requestUrl.pathname === "/api/config") {
    send(res, jsonResponse(200, {
      defaultProjectDir: options.projectDir,
      apiOnly: options.apiOnly,
      hasUiDist,
    }));
    return;
  }

  if (requestUrl.pathname === "/api/workspace") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;

    try {
      const service = new ProjectKnowledgeService(projectDir);
      const snapshot = service.buildWorkspaceUiSnapshot();
      send(res, jsonResponse(200, snapshot));
    } catch (error) {
      send(res, jsonResponse(500, {
        error: error instanceof Error ? error.message : String(error),
        projectDir,
      }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/document") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const path = requestUrl.searchParams.get("path")?.trim();
    if (!path) {
      send(res, jsonResponse(400, { error: "Missing path query parameter." }));
      return;
    }
    const filePath = safeProjectPath(projectDir, path);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      send(res, jsonResponse(404, { error: "Document not found.", path, projectDir }));
      return;
    }
    try {
      send(res, textResponse(200, readFileSync(filePath, "utf8"), "text/markdown; charset=utf-8"));
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), path, projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/artifact/raw") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const path = requestUrl.searchParams.get("path")?.trim();
    if (!path) {
      send(res, jsonResponse(400, { error: "Missing path query parameter." }));
      return;
    }
    const filePath = safeProjectPath(projectDir, path);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      send(res, jsonResponse(404, { error: "Artifact not found.", path, projectDir }));
      return;
    }
    try {
      const stat = statSync(filePath);
      const maxBytes = 8 * 1024 * 1024;
      if (stat.size > maxBytes) {
        send(res, jsonResponse(413, { error: "Artifact too large for hex view.", size: stat.size, maxBytes }));
        return;
      }
      const buffer = readFileSync(filePath);
      send(res, {
        status: 200,
        body: buffer,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(buffer.length),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), path, projectDir }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/health") {
    send(res, jsonResponse(200, { ok: true }));
    return;
  }

  if (options.apiOnly || !hasUiDist) {
    send(res, textResponse(404, "UI bundle not found. Run `npm run ui:build` first or start with Vite in dev mode.\n"));
    return;
  }

  const staticPath = safeStaticPath(uiDistDir, requestUrl.pathname);
  if (!staticPath) {
    send(res, textResponse(403, "Forbidden\n"));
    return;
  }

  const filePath = existsSync(staticPath) && statSync(staticPath).isFile()
    ? staticPath
    : join(uiDistDir, "index.html");

  try {
    send(res, textResponse(200, readFileSync(filePath), mimeType(filePath)));
  } catch (error) {
    send(res, textResponse(500, `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`));
  }
});

server.listen(options.port, () => {
  console.log(`workspace-ui server listening on http://127.0.0.1:${options.port}`);
  console.log(`default project: ${options.projectDir}`);
  if (!hasUiDist || options.apiOnly) {
    console.log("serving API only");
  }
});
