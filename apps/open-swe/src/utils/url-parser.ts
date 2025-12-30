import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "URLParser");

interface URLParseResult {
  success: true;
  url: URL;
}

interface URLParseError {
  success: false;
  errorMessage: string;
}

type URLParseResponse = URLParseResult | URLParseError;

/**
 * Safely parses a URL string and returns a structured result.
 * Only accepts remote HTTP(S) URLs - rejects file:// URLs and local paths.
 */
export function parseUrl(urlString: string): URLParseResponse {
  try {
    // Reject local file paths (absolute or relative)
    if (urlString.startsWith("/") || urlString.startsWith("./") || urlString.startsWith("../")) {
      logger.error("Local file paths not supported", { url: urlString });
      return {
        success: false,
        errorMessage: `Local file paths are not supported by this tool. Use the shell or view tool to read local files: ${urlString}`,
      };
    }

    const parsedUrl = new URL(urlString);

    // Only allow http and https protocols
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      logger.error("Unsupported URL protocol", { url: urlString, protocol: parsedUrl.protocol });
      return {
        success: false,
        errorMessage: `Unsupported URL protocol: ${parsedUrl.protocol}. Only http:// and https:// URLs are supported. Use the shell or view tool to read local files.`,
      };
    }

    return {
      success: true,
      url: parsedUrl,
    };
  } catch (e) {
    const errorString = e instanceof Error ? e.message : String(e);
    logger.error("Failed to parse URL", { url: urlString, error: errorString });

    return {
      success: false,
      errorMessage: `Failed to parse URL: ${urlString}\nError:\n${errorString}. If you're trying to read a local file, use the shell or view tool instead.`,
    };
  }
}
