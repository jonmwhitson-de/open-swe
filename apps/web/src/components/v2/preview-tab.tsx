"use client";

import { useState, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Monitor,
  RefreshCw,
  ExternalLink,
  Loader2,
  AlertCircle,
  Shield,
  Play,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PreviewTabProps {
  /**
   * The port number where the preview is running.
   * This is exposed from the sandbox container.
   */
  previewPort?: number;
  /**
   * Whether the programmer stream is currently loading.
   */
  isLoading?: boolean;
  /**
   * The sandbox session ID for executing commands.
   */
  sandboxSessionId?: string;
}

// Common dev server commands
const DEV_SERVER_PRESETS = [
  { label: "npm run dev", value: "npm run dev" },
  { label: "yarn dev", value: "yarn dev" },
  { label: "pnpm dev", value: "pnpm dev" },
  { label: "npm start", value: "npm start" },
  { label: "yarn start", value: "yarn start" },
  { label: "npx vite", value: "npx vite" },
  { label: "npx next dev", value: "npx next dev" },
  { label: "python -m http.server", value: "python -m http.server" },
  { label: "Custom...", value: "custom" },
];

interface StartServerResponse {
  success: boolean;
  port?: number;
  message: string;
  error?: string;
  backendUrl?: string;
  debug?: {
    originalError?: string;
    errorType?: string;
    env?: Record<string, string | undefined>;
  };
}

export function PreviewTab({
  previewPort,
  isLoading,
  sandboxSessionId,
}: PreviewTabProps) {
  const [customPort, setCustomPort] = useState<string>("");
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeError, setIframeError] = useState(false);
  const [useProxy, setUseProxy] = useState(true); // Default to using proxy

  // Server start state
  const [selectedPreset, setSelectedPreset] = useState<string>("npm run dev");
  const [customCommand, setCustomCommand] = useState<string>("");
  const [isStartingServer, setIsStartingServer] = useState(false);
  const [isStoppingServer, setIsStoppingServer] = useState(false);
  const [serverMessage, setServerMessage] = useState<string>("");
  const [serverError, setServerError] = useState<string>("");
  const [serverStartedPort, setServerStartedPort] = useState<number | null>(
    null,
  );

  // Use custom port if entered, otherwise use server started port or port from props
  const activePort = customPort
    ? parseInt(customPort, 10)
    : serverStartedPort ?? previewPort;

  // Generate URLs - proxy URL routes through Next.js API to avoid CORS issues
  const urls = useMemo(() => {
    if (!activePort || isNaN(activePort)) {
      return { proxy: null, direct: null };
    }
    return {
      proxy: `/api/preview/${activePort}`,
      direct: `http://localhost:${activePort}`,
    };
  }, [activePort]);

  const previewUrl = useProxy ? urls.proxy : urls.direct;

  const handleRefresh = useCallback(() => {
    setIframeKey((prev) => prev + 1);
    setIframeError(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setIframeError(true);
  }, []);

  const handleOpenExternal = useCallback(() => {
    // Always open the direct URL in external tab
    if (urls.direct) {
      window.open(urls.direct, "_blank", "noopener,noreferrer");
    }
  }, [urls.direct]);

  const handleToggleProxy = useCallback((checked: boolean) => {
    setUseProxy(checked);
    setIframeError(false);
    setIframeKey((prev) => prev + 1);
  }, []);

  const handleStartServer = useCallback(async () => {
    setIsStartingServer(true);
    setServerError("");
    setServerMessage("");

    const command =
      selectedPreset === "custom" ? customCommand : selectedPreset;
    const port = customPort ? parseInt(customPort, 10) : 3000;

    console.log("[Preview] Starting server...", {
      command,
      port,
      sandboxSessionId,
    });

    try {
      const response = await fetch("/api/preview/start-server", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command,
          port,
          sandboxSessionId,
        }),
      });

      console.log("[Preview] Response status:", response.status);

      const result: StartServerResponse = await response.json();
      console.log("[Preview] Response body:", result);

      if (result.success) {
        console.log("[Preview] Server started successfully on port:", result.port);
        setServerMessage(result.message);
        if (result.port) {
          setServerStartedPort(result.port);
          if (!customPort) {
            setCustomPort(String(result.port));
          }
        }
        // Refresh iframe after a short delay
        setTimeout(() => {
          setIframeKey((prev) => prev + 1);
          setIframeError(false);
        }, 1000);
      } else {
        console.error("[Preview] Server start failed:", result);
        if (result.debug) {
          console.error("[Preview] Debug info:", result.debug);
          console.error("[Preview] Backend URL:", result.backendUrl);
        }
        // Show a more detailed error message
        let errorMsg = result.error || result.message;
        if (result.backendUrl) {
          errorMsg += ` (backend: ${result.backendUrl})`;
        }
        setServerError(errorMsg);
      }
    } catch (error) {
      console.error("[Preview] Error starting server:", error);
      setServerError(
        error instanceof Error ? error.message : "Failed to start server",
      );
    } finally {
      setIsStartingServer(false);
    }
  }, [selectedPreset, customCommand, customPort, sandboxSessionId]);

  const handleStopServer = useCallback(async () => {
    setIsStoppingServer(true);
    setServerError("");
    setServerMessage("");

    console.log("[Preview] Stopping server...", { sandboxSessionId });

    try {
      const response = await fetch("/api/preview/stop-server", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sandboxSessionId,
        }),
      });

      console.log("[Preview] Stop response status:", response.status);

      const result = await response.json();
      console.log("[Preview] Stop response body:", result);

      if (result.success) {
        console.log("[Preview] Server stopped successfully");
        setServerMessage("Server stopped");
        setServerStartedPort(null);
      } else {
        console.error("[Preview] Server stop failed:", result);
        setServerError(result.error || result.message);
      }
    } catch (error) {
      console.error("[Preview] Error stopping server:", error);
      setServerError(
        error instanceof Error ? error.message : "Failed to stop server",
      );
    } finally {
      setIsStoppingServer(false);
    }
  }, [sandboxSessionId]);

  const showCustomInput = selectedPreset === "custom";

  return (
    <Card className="border-border bg-card relative flex h-full min-h-0 flex-col p-0">
      <CardContent className="h-full min-h-0 flex-1 p-0">
        <div className="flex h-full flex-col">
          {/* Toolbar */}
          <div className="border-border bg-muted/30 flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <Monitor className="text-muted-foreground h-4 w-4" />
            <span className="text-muted-foreground text-sm font-medium">
              Preview
            </span>

            <div className="ml-auto flex flex-wrap items-center gap-3">
              {/* Proxy toggle */}
              <div className="flex items-center gap-1.5">
                <Switch
                  id="proxy-mode"
                  checked={useProxy}
                  onCheckedChange={handleToggleProxy}
                  className="h-4 w-7"
                />
                <Label
                  htmlFor="proxy-mode"
                  className="text-muted-foreground flex cursor-pointer items-center gap-1 text-xs"
                  title="Use proxy to avoid CORS and networking issues"
                >
                  <Shield className="h-3 w-3" />
                  Proxy
                </Label>
              </div>

              <div className="bg-border h-4 w-px" />

              <Input
                type="number"
                placeholder="Port (e.g., 3000)"
                value={customPort}
                onChange={(e) => setCustomPort(e.target.value)}
                className="h-7 w-28 text-xs"
              />

              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                disabled={!previewUrl}
                className="h-7 w-7 p-0"
                title="Refresh preview"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenExternal}
                disabled={!urls.direct}
                className="h-7 w-7 p-0"
                title="Open in new tab"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Server Controls */}
          <div className="border-border bg-muted/20 flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <Select value={selectedPreset} onValueChange={setSelectedPreset}>
              <SelectTrigger className="h-7 w-40 text-xs">
                <SelectValue placeholder="Select command" />
              </SelectTrigger>
              <SelectContent>
                {DEV_SERVER_PRESETS.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {showCustomInput && (
              <Input
                type="text"
                placeholder="Enter custom command..."
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                className="h-7 w-48 text-xs"
              />
            )}

            <Button
              variant="default"
              size="sm"
              onClick={handleStartServer}
              disabled={
                isStartingServer ||
                (showCustomInput && !customCommand.trim())
              }
              className="h-7 gap-1.5 px-3 text-xs"
            >
              {isStartingServer ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" />
                  Start Server
                </>
              )}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleStopServer}
              disabled={isStoppingServer}
              className="h-7 gap-1.5 px-3 text-xs"
            >
              {isStoppingServer ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Stopping...
                </>
              ) : (
                <>
                  <Square className="h-3 w-3" />
                  Stop
                </>
              )}
            </Button>

            {serverMessage && (
              <span className="text-xs text-green-600 dark:text-green-400">
                {serverMessage}
              </span>
            )}

            {serverError && (
              <span className="text-destructive text-xs">{serverError}</span>
            )}
          </div>

          {/* Preview Content */}
          <div className="relative flex-1 overflow-hidden">
            {isLoading && !previewUrl ? (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                <p className="text-muted-foreground text-sm">
                  Waiting for development server...
                </p>
              </div>
            ) : previewUrl ? (
              <>
                {iframeError ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                    <AlertCircle className="text-destructive h-8 w-8" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        Unable to load preview
                      </p>
                      <p className="text-muted-foreground text-sm">
                        The development server on port {activePort} may not be
                        running or accessible.
                      </p>
                      {useProxy && (
                        <p className="text-muted-foreground text-xs">
                          Try disabling the proxy toggle if the server is
                          running locally.
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRefresh}
                      >
                        <RefreshCw className="mr-2 h-3.5 w-3.5" />
                        Try again
                      </Button>
                      {useProxy && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleToggleProxy(false)}
                        >
                          Try without proxy
                        </Button>
                      )}
                      <Button
                        variant="default"
                        size="sm"
                        onClick={handleStartServer}
                        disabled={isStartingServer}
                      >
                        {isStartingServer ? (
                          <>
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            Starting...
                          </>
                        ) : (
                          <>
                            <Play className="mr-2 h-3.5 w-3.5" />
                            Start Server
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <iframe
                    key={iframeKey}
                    src={previewUrl}
                    title="Application Preview"
                    className={cn(
                      "h-full w-full border-0 bg-white",
                      "dark:bg-neutral-900",
                    )}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                    onError={handleIframeError}
                  />
                )}
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                <Monitor className="text-muted-foreground h-8 w-8" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">No preview available</p>
                  <p className="text-muted-foreground text-sm">
                    Enter a port number above to preview your running
                    application, or start a development server using the
                    controls above.
                  </p>
                </div>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleStartServer}
                  disabled={isStartingServer}
                  className="mt-2"
                >
                  {isStartingServer ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Starting Server...
                    </>
                  ) : (
                    <>
                      <Play className="mr-2 h-4 w-4" />
                      Start Development Server
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
