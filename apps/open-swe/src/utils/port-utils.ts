import * as net from "node:net";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "PortUtils");

/**
 * Check if a port is available on the host.
 * @param port - The port number to check
 * @returns Promise resolving to true if available, false if in use
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        resolve(false);
      } else {
        // Other errors - assume port is not available
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, "0.0.0.0");
  });
}

/**
 * Find an available port starting from the preferred port.
 * If the preferred port is taken, tries incrementing ports up to maxAttempts.
 * @param preferredPort - The port to try first
 * @param maxAttempts - Maximum number of ports to try (default: 100)
 * @returns Promise resolving to an available port, or undefined if none found
 */
export async function findAvailablePort(
  preferredPort: number,
  maxAttempts: number = 100,
): Promise<number | undefined> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferredPort + i;
    if (port > 65535) break;

    if (await isPortAvailable(port)) {
      if (i > 0) {
        logger.info("Found alternative port", {
          preferredPort,
          actualPort: port,
        });
      }
      return port;
    }
  }

  logger.warn("Could not find available port", {
    preferredPort,
    maxAttempts,
  });
  return undefined;
}

/**
 * Find available ports for a list of preferred ports.
 * Each port is checked and an alternative is found if it's in use.
 * @param preferredPorts - Array of preferred ports to check
 * @returns Promise resolving to array of available ports (may be different from input)
 */
export async function findAvailablePorts(
  preferredPorts: number[],
): Promise<number[]> {
  const allocatedPorts = new Set<number>();
  const result: number[] = [];

  for (const preferredPort of preferredPorts) {
    // Skip if this port was already allocated in this batch
    if (allocatedPorts.has(preferredPort)) {
      const alternative = await findAvailablePortExcluding(
        preferredPort,
        allocatedPorts,
      );
      if (alternative) {
        result.push(alternative);
        allocatedPorts.add(alternative);
      }
      continue;
    }

    const available = await isPortAvailable(preferredPort);
    if (available) {
      result.push(preferredPort);
      allocatedPorts.add(preferredPort);
    } else {
      // Find an alternative
      const alternative = await findAvailablePortExcluding(
        preferredPort,
        allocatedPorts,
      );
      if (alternative) {
        result.push(alternative);
        allocatedPorts.add(alternative);
      }
    }
  }

  return result;
}

/**
 * Find an available port excluding already allocated ports.
 */
async function findAvailablePortExcluding(
  preferredPort: number,
  excludePorts: Set<number>,
  maxAttempts: number = 100,
): Promise<number | undefined> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferredPort + i;
    if (port > 65535) break;
    if (excludePorts.has(port)) continue;

    if (await isPortAvailable(port)) {
      if (i > 0) {
        logger.info("Found alternative port", {
          preferredPort,
          actualPort: port,
        });
      }
      return port;
    }
  }

  return undefined;
}

/**
 * Port mapping from container port to host port.
 */
export interface PortMapping {
  containerPort: number;
  hostPort: number;
}

/**
 * Allocate available host ports for a list of container ports.
 * Returns mappings from container ports to available host ports.
 * @param containerPorts - Ports that the container wants to expose
 * @returns Promise resolving to array of port mappings
 */
export async function allocatePortMappings(
  containerPorts: number[],
): Promise<PortMapping[]> {
  const mappings: PortMapping[] = [];
  const allocatedHostPorts = new Set<number>();

  for (const containerPort of containerPorts) {
    // First try to use the same port on the host
    let hostPort: number | undefined;

    if (!allocatedHostPorts.has(containerPort) && await isPortAvailable(containerPort)) {
      hostPort = containerPort;
    } else {
      // Find an alternative starting from the container port
      hostPort = await findAvailablePortExcluding(containerPort, allocatedHostPorts);
    }

    if (hostPort) {
      mappings.push({ containerPort, hostPort });
      allocatedHostPorts.add(hostPort);
    } else {
      logger.warn("Could not allocate host port for container port", {
        containerPort,
      });
    }
  }

  return mappings;
}
