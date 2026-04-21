import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { createDiskParser, extractFileFromChain, type DiskFileEntry } from "../disk/index.js";
import { ByteBoozerDepacker, RleDepacker, depackExomizerRaw, depackExomizerSfx } from "../compression-tools.js";
import { writeFile as writeFileAsync, mkdtemp as mkdtempAsync, rm as rmAsync } from "node:fs/promises";
import { tmpdir } from "node:os";

interface UiMark {
  id: string;
  createdAt: string;
  projectDir: string;
  url: string;
  activeTab?: string;
  selectedEntityId?: string | null;
  selectedCartChunkKey?: string | null;
  selectedDiskFileKey?: string | null;
  selector?: string;
  componentPath?: string[];
  textContent?: string;
  note: string;
  status: "open" | "fixed";
}

function marksStorePath(projectDir: string): string {
  return join(projectDir, "session", "ui-marks.json");
}

function loadMarks(projectDir: string): UiMark[] {
  const path = marksStorePath(projectDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { marks?: UiMark[] };
    return parsed.marks ?? [];
  } catch {
    return [];
  }
}

function saveMarks(projectDir: string, marks: UiMark[]): void {
  const path = marksStorePath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ updatedAt: new Date().toISOString(), marks }, null, 2));
}

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
      const offsetParam = requestUrl.searchParams.get("offset");
      const lengthParam = requestUrl.searchParams.get("length");
      const offset = offsetParam ? Math.max(0, Number.parseInt(offsetParam, 10) || 0) : 0;
      const requested = lengthParam ? Math.max(0, Number.parseInt(lengthParam, 10) || 0) : stat.size - offset;
      if (offset > stat.size) {
        send(res, jsonResponse(416, { error: "Offset past end of file.", offset, size: stat.size }));
        return;
      }
      const length = Math.min(requested, stat.size - offset);
      const maxBytes = 8 * 1024 * 1024;
      if (length > maxBytes) {
        send(res, jsonResponse(413, { error: "Slice too large for hex view.", size: length, maxBytes }));
        return;
      }
      const fullBuffer = readFileSync(filePath);
      const buffer = (offset === 0 && length === fullBuffer.length) ? fullBuffer : fullBuffer.subarray(offset, offset + length);
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

  if (requestUrl.pathname === "/api/depack" && req.method === "POST") {
    // Try a series of pure-TS depackers on the raw bytes the client
    // pushes and stream back whichever one succeeds. Order roughly by
    // how unambiguous the stream format is so we don't happily chew a
    // valid Exomizer wrapper with the RLE depacker.
    const forcePacker = requestUrl.searchParams.get("packer")?.trim() || undefined;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => { chunks.push(chunk); });
    req.on("end", async () => {
      const input = Buffer.concat(chunks);
      if (input.length === 0) {
        send(res, jsonResponse(400, { error: "Empty request body" }));
        return;
      }
      const candidates = forcePacker
        ? [forcePacker]
        : ["exomizer_sfx", "exomizer_raw", "byteboozer", "rle"];
      const failures: Array<{ packer: string; error: string }> = [];
      for (const packer of candidates) {
        try {
          let out: Uint8Array | undefined;
          let loadAddress: number | undefined;
          if (packer === "exomizer_sfx") {
            let tempDir: string | undefined;
            try {
              tempDir = await mkdtempAsync(join(tmpdir(), "c64re-depack-"));
              const tempPath = join(tempDir, "input.prg");
              await writeFileAsync(tempPath, input);
              const result = await depackExomizerSfx({ inputPath: tempPath });
              out = result.data;
              loadAddress = result.loadAddress;
            } finally {
              if (tempDir) await rmAsync(tempDir, { recursive: true, force: true });
            }
          } else if (packer === "exomizer_raw") {
            let tempDir: string | undefined;
            try {
              tempDir = await mkdtempAsync(join(tmpdir(), "c64re-depack-"));
              const tempPath = join(tempDir, "input.bin");
              await writeFileAsync(tempPath, input);
              const result = await depackExomizerRaw({ inputPath: tempPath });
              out = result.data;
            } finally {
              if (tempDir) await rmAsync(tempDir, { recursive: true, force: true });
            }
          } else if (packer === "byteboozer") {
            const result = new ByteBoozerDepacker().unpack(input);
            out = result.data;
          } else if (packer === "rle") {
            const result = new RleDepacker().unpack(input, { hasHeader: input.length >= 2 && input[0] === 0 && input[1] === 0 });
            out = result.data;
          }
          if (!out || out.length === 0) throw new Error("depacker returned no bytes");
          const buffer = Buffer.from(out);
          send(res, {
            status: 200,
            body: buffer,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(buffer.length),
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
              "X-Depacker": packer,
              "X-Load-Address": loadAddress !== undefined ? `$${loadAddress.toString(16).toUpperCase().padStart(4, "0")}` : "",
            },
          });
          return;
        } catch (err) {
          failures.push({ packer, error: err instanceof Error ? err.message : String(err) });
        }
      }
      send(res, jsonResponse(422, {
        error: "No depacker matched the input stream.",
        attempts: failures,
        bytes: input.length,
      }));
    });
    return;
  }

  if (requestUrl.pathname === "/api/disk/assemble-chain" && req.method === "POST") {
    // Assemble a file's bytes by reading a caller-supplied list of
    // sector windows. Works for both standard KERNAL files (link bytes
    // at [0,1]) and custom-LUT files where the whole 256-byte sector is
    // raw data without link bytes. The client sends the exact chain it
    // wants to concatenate so the server never has to guess which
    // convention applies.
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as {
          projectDir?: string;
          path?: string;
          chain?: Array<{ track: number; sector: number; offsetInSector?: number; length?: number }>;
          stripLoadAddress?: boolean;
        };
        const projectDir = payload.projectDir?.trim()
          ? resolve(process.cwd(), payload.projectDir)
          : options.projectDir;
        if (!payload.path || !Array.isArray(payload.chain) || payload.chain.length === 0) {
          send(res, jsonResponse(400, { error: "path and non-empty chain[] required" }));
          return;
        }
        const imagePath = safeProjectPath(projectDir, payload.path);
        if (!imagePath || !existsSync(imagePath)) {
          send(res, jsonResponse(404, { error: "Disk image not found", path: payload.path }));
          return;
        }
        const parser = createDiskParser(new Uint8Array(readFileSync(imagePath)));
        if (!parser) {
          send(res, jsonResponse(415, { error: "Unrecognised disk image format", path: payload.path }));
          return;
        }
        const chunks: Uint8Array[] = [];
        for (const cell of payload.chain) {
          if (!Number.isInteger(cell.track) || cell.track < 1 || !Number.isInteger(cell.sector) || cell.sector < 0) continue;
          const data = parser.getSector(cell.track, cell.sector);
          if (!data) continue;
          const offset = Math.max(0, cell.offsetInSector ?? 0);
          const maxLength = data.length - offset;
          const length = Math.max(0, Math.min(cell.length ?? maxLength, maxLength));
          if (length > 0) chunks.push(data.subarray(offset, offset + length));
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        let output = new Uint8Array(total);
        let cursor = 0;
        for (const chunk of chunks) {
          output.set(chunk, cursor);
          cursor += chunk.length;
        }
        if (payload.stripLoadAddress && output.length >= 2) output = output.subarray(2);
        const buffer = Buffer.from(output);
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
        send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (requestUrl.pathname === "/api/disk/file-bytes") {
    // Extract a full file from a D64/G64 image by walking its sector
    // chain starting at the given track/sector. Used by the disk-file
    // hex view so the user sees the ASSEMBLED file, not just the first
    // physical sector.
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    const path = requestUrl.searchParams.get("path")?.trim();
    const trackParam = requestUrl.searchParams.get("track");
    const sectorParam = requestUrl.searchParams.get("sector");
    const typeParam = requestUrl.searchParams.get("type") ?? "PRG";
    const stripLoadParam = requestUrl.searchParams.get("strip_load_address") === "1";
    if (!path || !trackParam || !sectorParam) {
      send(res, jsonResponse(400, { error: "Missing path/track/sector query parameters." }));
      return;
    }
    const track = Number.parseInt(trackParam, 10);
    const sector = Number.parseInt(sectorParam, 10);
    if (!Number.isInteger(track) || track < 1 || !Number.isInteger(sector) || sector < 0) {
      send(res, jsonResponse(400, { error: "Invalid track/sector." }));
      return;
    }
    const imagePath = safeProjectPath(projectDir, path);
    if (!imagePath || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
      send(res, jsonResponse(404, { error: "Disk image not found.", path, projectDir }));
      return;
    }
    try {
      const parser = createDiskParser(new Uint8Array(readFileSync(imagePath)));
      if (!parser) {
        send(res, jsonResponse(415, { error: "Unrecognised disk image format.", path }));
        return;
      }
      const entry: DiskFileEntry = {
        name: `t${track}s${sector}`,
        type: (typeParam as DiskFileEntry["type"]) ?? "PRG",
        size: 0,
        track,
        sector,
      };
      const bytes = extractFileFromChain((t, s) => parser.getSector(t, s), entry, stripLoadParam);
      if (!bytes) {
        send(res, jsonResponse(404, { error: "File chain produced no bytes.", track, sector }));
        return;
      }
      const buffer = Buffer.from(bytes);
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
      send(res, jsonResponse(500, { error: error instanceof Error ? error.message : String(error), path }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/marks") {
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    if (req.method === "GET") {
      const filter = requestUrl.searchParams.get("status");
      const all = loadMarks(projectDir);
      const marks = filter ? all.filter((mark) => mark.status === filter) : all;
      send(res, jsonResponse(200, { marks }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as Partial<UiMark>;
          const now = new Date().toISOString();
          const all = loadMarks(projectDir);
          const mark: UiMark = {
            id: payload.id ?? `mark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            createdAt: payload.createdAt ?? now,
            projectDir,
            url: payload.url ?? "",
            activeTab: payload.activeTab,
            selectedEntityId: payload.selectedEntityId ?? null,
            selectedCartChunkKey: payload.selectedCartChunkKey ?? null,
            selectedDiskFileKey: payload.selectedDiskFileKey ?? null,
            selector: payload.selector,
            componentPath: payload.componentPath,
            textContent: payload.textContent,
            note: payload.note ?? "",
            status: payload.status ?? "open",
          };
          all.push(mark);
          saveMarks(projectDir, all);
          send(res, jsonResponse(200, { mark }));
        } catch (error) {
          send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }
    if (req.method === "DELETE") {
      const id = requestUrl.searchParams.get("id");
      const filter = requestUrl.searchParams.get("status");
      const all = loadMarks(projectDir);
      let kept: UiMark[];
      if (id) {
        kept = all.filter((mark) => mark.id !== id);
      } else if (!filter || filter === "all") {
        kept = [];
      } else {
        kept = all.filter((mark) => mark.status !== filter);
      }
      saveMarks(projectDir, kept);
      send(res, jsonResponse(200, { cleared: all.length - kept.length, remaining: kept.length }));
      return;
    }
    send(res, jsonResponse(405, { error: "Method not allowed" }));
    return;
  }

  if (requestUrl.pathname.startsWith("/api/marks/")) {
    const id = requestUrl.pathname.slice("/api/marks/".length);
    const projectDir = requestUrl.searchParams.get("projectDir")?.trim()
      ? resolve(process.cwd(), requestUrl.searchParams.get("projectDir")!)
      : options.projectDir;
    if (req.method === "PATCH") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as Partial<UiMark>;
          const all = loadMarks(projectDir);
          const index = all.findIndex((mark) => mark.id === id);
          if (index < 0) {
            send(res, jsonResponse(404, { error: "Mark not found" }));
            return;
          }
          all[index] = { ...all[index]!, ...payload, id };
          saveMarks(projectDir, all);
          send(res, jsonResponse(200, { mark: all[index] }));
        } catch (error) {
          send(res, jsonResponse(400, { error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }
    send(res, jsonResponse(405, { error: "Method not allowed" }));
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
