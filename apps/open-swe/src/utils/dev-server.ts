import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "DevServer");

/**
 * Detected dev server configuration for a project.
 */
export interface DevServerConfig {
  /** The command to run the dev server */
  command: string;
  /** The expected port the server will run on */
  port: number;
  /** The project type (e.g., "nextjs", "vite", "django") */
  projectType: string;
  /** Whether this is a web project that benefits from preview */
  isWebProject: boolean;
}

/**
 * Common dev server configurations by project type.
 */
const PROJECT_CONFIGS: Record<string, Omit<DevServerConfig, "isWebProject">> = {
  // Node.js / JavaScript
  nextjs: { command: "npm run dev", port: 3000, projectType: "nextjs" },
  vite: { command: "npm run dev", port: 5173, projectType: "vite" },
  cra: { command: "npm start", port: 3000, projectType: "create-react-app" },
  gatsby: { command: "npm run develop", port: 8000, projectType: "gatsby" },
  nuxt: { command: "npm run dev", port: 3000, projectType: "nuxt" },
  remix: { command: "npm run dev", port: 3000, projectType: "remix" },
  astro: { command: "npm run dev", port: 4321, projectType: "astro" },
  svelte: { command: "npm run dev", port: 5173, projectType: "svelte" },
  angular: { command: "npm start", port: 4200, projectType: "angular" },
  vue: { command: "npm run dev", port: 5173, projectType: "vue" },
  express: { command: "npm run dev", port: 3000, projectType: "express" },
  nest: { command: "npm run start:dev", port: 3000, projectType: "nestjs" },

  // Python
  django: { command: "python manage.py runserver 0.0.0.0:8000", port: 8000, projectType: "django" },
  flask: { command: "flask run --host=0.0.0.0", port: 5000, projectType: "flask" },
  fastapi: { command: "uvicorn main:app --reload --host 0.0.0.0", port: 8000, projectType: "fastapi" },
  streamlit: { command: "streamlit run app.py", port: 8501, projectType: "streamlit" },

  // Ruby
  rails: { command: "rails server -b 0.0.0.0", port: 3000, projectType: "rails" },

  // Go
  go: { command: "go run .", port: 8080, projectType: "go" },

  // Generic fallbacks
  generic_npm_dev: { command: "npm run dev", port: 3000, projectType: "npm" },
  generic_npm_start: { command: "npm start", port: 3000, projectType: "npm" },
};

/**
 * Detect the dev server configuration from a package.json content.
 */
export function detectFromPackageJson(packageJsonContent: string): DevServerConfig | null {
  try {
    const pkg = JSON.parse(packageJsonContent);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts || {};

    // Check for specific frameworks
    if (deps["next"]) {
      return { ...PROJECT_CONFIGS.nextjs, isWebProject: true };
    }
    if (deps["vite"]) {
      return { ...PROJECT_CONFIGS.vite, isWebProject: true };
    }
    if (deps["react-scripts"]) {
      return { ...PROJECT_CONFIGS.cra, isWebProject: true };
    }
    if (deps["gatsby"]) {
      return { ...PROJECT_CONFIGS.gatsby, isWebProject: true };
    }
    if (deps["nuxt"]) {
      return { ...PROJECT_CONFIGS.nuxt, isWebProject: true };
    }
    if (deps["@remix-run/dev"]) {
      return { ...PROJECT_CONFIGS.remix, isWebProject: true };
    }
    if (deps["astro"]) {
      return { ...PROJECT_CONFIGS.astro, isWebProject: true };
    }
    if (deps["svelte"]) {
      return { ...PROJECT_CONFIGS.svelte, isWebProject: true };
    }
    if (deps["@angular/core"]) {
      return { ...PROJECT_CONFIGS.angular, isWebProject: true };
    }
    if (deps["vue"]) {
      return { ...PROJECT_CONFIGS.vue, isWebProject: true };
    }
    if (deps["@nestjs/core"]) {
      return { ...PROJECT_CONFIGS.nest, isWebProject: true };
    }
    if (deps["express"]) {
      return { ...PROJECT_CONFIGS.express, isWebProject: true };
    }

    // Check for dev script
    if (scripts.dev) {
      // Try to detect port from script
      const portMatch = scripts.dev.match(/(?:PORT|port)[=:\s]+(\d+)/);
      const port = portMatch ? parseInt(portMatch[1], 10) : 3000;
      return {
        command: "npm run dev",
        port,
        projectType: "npm",
        isWebProject: true,
      };
    }

    // Check for start script
    if (scripts.start) {
      const portMatch = scripts.start.match(/(?:PORT|port)[=:\s]+(\d+)/);
      const port = portMatch ? parseInt(portMatch[1], 10) : 3000;
      return {
        command: "npm start",
        port,
        projectType: "npm",
        isWebProject: true,
      };
    }

    // Not a web project or no dev server found
    return null;
  } catch (error) {
    logger.warn("Failed to parse package.json", { error });
    return null;
  }
}

/**
 * Detect Python web framework from project files.
 */
export function detectPythonProject(files: string[]): DevServerConfig | null {
  const fileSet = new Set(files.map((f) => f.toLowerCase()));

  // Django
  if (fileSet.has("manage.py")) {
    return { ...PROJECT_CONFIGS.django, isWebProject: true };
  }

  // FastAPI (check for main.py with uvicorn)
  if (fileSet.has("main.py") && (fileSet.has("requirements.txt") || fileSet.has("pyproject.toml"))) {
    // Could be FastAPI, but we'd need to read the file to be sure
    // For now, assume FastAPI if main.py exists
    return { ...PROJECT_CONFIGS.fastapi, isWebProject: true };
  }

  // Flask
  if (fileSet.has("app.py") || fileSet.has("wsgi.py")) {
    return { ...PROJECT_CONFIGS.flask, isWebProject: true };
  }

  // Streamlit
  if (files.some((f) => f.includes("streamlit"))) {
    return { ...PROJECT_CONFIGS.streamlit, isWebProject: true };
  }

  return null;
}

/**
 * Detect Ruby on Rails project.
 */
export function detectRailsProject(files: string[]): DevServerConfig | null {
  const fileSet = new Set(files.map((f) => f.toLowerCase()));

  if (fileSet.has("config/routes.rb") || fileSet.has("gemfile")) {
    return { ...PROJECT_CONFIGS.rails, isWebProject: true };
  }

  return null;
}

/**
 * Detect project type from codebase tree and return dev server config.
 * @param codebaseTree - The codebase tree string (file listing)
 * @param packageJsonContent - Optional content of package.json
 */
export function detectDevServer(
  codebaseTree: string,
  packageJsonContent?: string,
): DevServerConfig | null {
  const files = codebaseTree
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // First, try package.json detection (most accurate for JS projects)
  if (packageJsonContent) {
    const config = detectFromPackageJson(packageJsonContent);
    if (config) {
      logger.info("Detected dev server from package.json", {
        projectType: config.projectType,
        command: config.command,
        port: config.port,
      });
      return config;
    }
  }

  // Check for package.json in files (indicates Node.js project)
  const hasPackageJson = files.some(
    (f) => f === "package.json" || f.endsWith("/package.json"),
  );
  if (hasPackageJson && !packageJsonContent) {
    // We have a package.json but couldn't read it - assume generic npm
    logger.info("Found package.json but content not available, using generic npm config");
    return { ...PROJECT_CONFIGS.generic_npm_dev, isWebProject: true };
  }

  // Check for Python projects
  const pythonConfig = detectPythonProject(files);
  if (pythonConfig) {
    logger.info("Detected Python dev server", {
      projectType: pythonConfig.projectType,
      command: pythonConfig.command,
      port: pythonConfig.port,
    });
    return pythonConfig;
  }

  // Check for Rails projects
  const railsConfig = detectRailsProject(files);
  if (railsConfig) {
    logger.info("Detected Rails dev server", {
      projectType: railsConfig.projectType,
      command: railsConfig.command,
      port: railsConfig.port,
    });
    return railsConfig;
  }

  logger.info("No dev server detected for this project");
  return null;
}

/**
 * Parse dev server output to extract the port it's running on.
 * Different frameworks output different messages.
 */
export function parsePortFromOutput(output: string): number | null {
  // Common patterns for port detection
  const patterns = [
    /(?:listening|running|started|ready)\s+(?:on|at)\s+(?:http:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i,
    /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i,
    /port\s+(\d+)/i,
    /:(\d{4,5})\s*$/m, // Port at end of line (4-5 digits)
    /http:\/\/\S+:(\d+)/i, // Any URL with port
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port < 65536) {
        return port;
      }
    }
  }

  return null;
}

/**
 * Check if the output indicates the dev server started successfully.
 */
export function isServerStarted(output: string): boolean {
  const successPatterns = [
    /ready/i,
    /listening/i,
    /started/i,
    /running/i,
    /compiled/i,
    /server\s+is\s+running/i,
    /local:/i,
    /webpack.*compiled/i,
    /vite.*ready/i,
  ];

  return successPatterns.some((pattern) => pattern.test(output));
}
