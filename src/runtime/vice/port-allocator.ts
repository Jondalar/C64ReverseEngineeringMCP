import { createServer } from "node:net";

export async function allocateViceMonitorPort(preferredPort = 6510, attempts = 50): Promise<number> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferredPort + offset;
    if (await isTcpPortFree(port)) {
      return port;
    }
  }
  throw new Error(`Could not find a free VICE monitor port starting at ${preferredPort}.`);
}

export async function isTcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

