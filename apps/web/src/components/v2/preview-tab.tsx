"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Monitor,
  RefreshCw,
  ExternalLink,
  Loader2,
  AlertCircle,
  Play,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PreviewConfig {
  name?: string;
  command: string;
  port: number;
  install?: string;
  healthcheck?: string;
}

interface PreviewTabProps {
  previewPort?: number;
  isLoading?: boolean;
  sandboxSessionId?: string;
  workspacePath?: string;
}

interface StartServerResponse {
  success: boolean;
  port?: number;
  message: string;
  error?: string;
  portConflict?: boolean;
}

export function PreviewTab({
  previewPort,
  isLoading,
  sandboxSessionId,
  workspacePath,
}: PreviewTabProps) {
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeError, setIframeError] = useState(false);

  // Preview config from preview.json
  const [previewConfig, setPreviewConfig] = useState<PreviewConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string>("");

  // Server state
  const [isStartingServer, setIsStartingServer] = useState(false);
  const [isStoppingServer, setIsStoppingServer] = useState(false);
  const [serverMessage, setServerMessage] = useState<string>("");
  const [serverError, setServerError] = useState<string>("");
  const [serverRunning, setServerRunning] = useState(false);
  const [activePort, setActivePort] = useState<number | null>(null);

  // Port conflict dialog
  const [showPortDialog, setShowPortDialog] = useState(false);
  const [newPort, setNewPort] = useState<string>("");
  const [conflictPort, setConflictPort] = useState<number | null>(null);

  // Load preview.json on mount
  useEffect(() => {
    async function loadPreviewConfig() {
      if (!sandboxSessionId && !workspacePath) {
        setConfigLoading(false);
        return;
      }

      try {
        const response = await fetch("/api/preview/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sandboxSessionId, workspacePath }),
        });

        if (response.ok) {
          const config = await response.json();
          if (config && config.command) {
            setPreviewConfig(config);
            setActivePort(config.port || 5000);
          }
        }
      } catch (error) {
        console.error("[Preview] Failed to load preview.json:", error);
      } finally {
        setConfigLoading(false);
      }
    }

    loadPreviewConfig();
  }, [sandboxSessionId, workspacePath]);

  const previewUrl = useMemo(() => {
    if (!activePort) return null;
    const queryParams = sandboxSessionId
      ? `?sandboxSessionId=${encodeURIComponent(sandboxSessionId)}`
      : "";
    return `/api/preview/${activePort}${queryParams}`;
  }, [activePort, sandboxSessionId]);

  const directUrl = useMemo(() => {
    if (!activePort) return null;
    return `http://localhost:${activePort}`;
  }, [activePort]);

  const handleRefresh = useCallback(() => {
    setIframeKey((prev) => prev + 1);
    setIframeError(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setIframeError(true);
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (directUrl) {
      window.open(directUrl, "_blank", "noopener,noreferrer");
    }
  }, [directUrl]);

  const handleStartPreview = useCallback(async (portOverride?: number) => {
    setIsStartingServer(true);
    setServerError("");
    setServerMessage("");

    const port = portOverride || previewConfig?.port || 5000;
    const command = "./start.sh";

    try {
      const response = await fetch("/api/preview/start-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          port,
          sandboxSessionId,
          workspacePath,
        }),
      });

      const result: StartServerResponse = await response.json();

      if (result.success) {
        setServerMessage("Server started successfully");
        setServerRunning(true);
        setActivePort(result.port || port);
        setTimeout(() => {
          setIframeKey((prev) => prev + 1);
          setIframeError(false);
        }, 1500);
      } else if (result.portConflict) {
        // Port conflict - show dialog
        setConflictPort(port);
        setNewPort(String(port + 1));
        setShowPortDialog(true);
      } else {
        setServerError(result.error || result.message);
      }
    } catch (error) {
      setServerError(
        error instanceof Error ? error.message : "Failed to start server"
      );
    } finally {
      setIsStartingServer(false);
    }
  }, [previewConfig, sandboxSessionId, workspacePath]);

  const handleStopServer = useCallback(async () => {
    setIsStoppingServer(true);
    setServerError("");
    setServerMessage("");

    try {
      const response = await fetch("/api/preview/stop-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxSessionId }),
      });

      const result = await response.json();

      if (result.success) {
        setServerMessage("Server stopped");
        setServerRunning(false);
      } else {
        setServerError(result.error || result.message);
      }
    } catch (error) {
      setServerError(
        error instanceof Error ? error.message : "Failed to stop server"
      );
    } finally {
      setIsStoppingServer(false);
    }
  }, [sandboxSessionId]);

  const handlePortConflictRetry = useCallback(() => {
    const port = parseInt(newPort, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      setShowPortDialog(false);
      handleStartPreview(port);
    }
  }, [newPort, handleStartPreview]);

  // Loading state
  if (configLoading) {
    return (
      <Card className="border-border bg-card relative flex h-full min-h-0 flex-col p-0">
        <CardContent className="flex h-full items-center justify-center p-0">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
            <p className="text-muted-foreground text-sm">Loading preview configuration...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {/* Port Conflict Dialog */}
      <Dialog open={showPortDialog} onOpenChange={setShowPortDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Port Conflict</DialogTitle>
            <DialogDescription>
              Port {conflictPort} is already in use. Please enter a different port number.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              type="number"
              value={newPort}
              onChange={(e) => setNewPort(e.target.value)}
              placeholder="Enter new port (e.g., 5001)"
              min={1}
              max={65535}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPortDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handlePortConflictRetry}>
              Try Port {newPort}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="border-border bg-card relative flex h-full min-h-0 flex-col p-0">
        <CardContent className="h-full min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col">
            {/* Minimal Toolbar */}
            <div className="border-border bg-muted/30 flex items-center gap-2 border-b px-3 py-2">
              <Monitor className="text-muted-foreground h-4 w-4" />
              <span className="text-muted-foreground text-sm font-medium">
                Preview
              </span>
              {previewConfig?.name && (
                <span className="text-muted-foreground text-xs">
                  — {previewConfig.name}
                </span>
              )}

              <div className="ml-auto flex items-center gap-2">
                {activePort && (
                  <span className="text-muted-foreground text-xs">
                    Port: {activePort}
                  </span>
                )}

                {serverRunning && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleRefresh}
                      className="h-7 w-7 p-0"
                      title="Refresh preview"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleOpenExternal}
                      className="h-7 w-7 p-0"
                      title="Open in new tab"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleStopServer}
                      disabled={isStoppingServer}
                      className="h-7 gap-1.5 px-2 text-xs"
                    >
                      {isStoppingServer ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Square className="h-3 w-3" />
                      )}
                      Stop
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Status Messages */}
            {(serverMessage || serverError) && (
              <div className="border-border border-b px-3 py-1.5">
                {serverMessage && (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    {serverMessage}
                  </span>
                )}
                {serverError && (
                  <span className="text-destructive text-xs">{serverError}</span>
                )}
              </div>
            )}

            {/* Preview Content */}
            <div className="relative flex-1 overflow-hidden">
              {serverRunning && previewUrl ? (
                <>
                  {iframeError ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                      <AlertCircle className="text-destructive h-8 w-8" />
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Unable to load preview</p>
                        <p className="text-muted-foreground text-sm">
                          The server may still be starting up.
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={handleRefresh}>
                        <RefreshCw className="mr-2 h-3.5 w-3.5" />
                        Try again
                      </Button>
                    </div>
                  ) : (
                    <iframe
                      key={iframeKey}
                      src={previewUrl}
                      title="Application Preview"
                      className={cn(
                        "h-full w-full border-0 bg-white",
                        "dark:bg-neutral-900"
                      )}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                      onError={handleIframeError}
                    />
                  )}
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                  <Monitor className="text-muted-foreground h-12 w-12" />
                  <div className="space-y-2">
                    <p className="text-lg font-medium">
                      {previewConfig ? "Ready to Preview" : "No Preview Available"}
                    </p>
                    <p className="text-muted-foreground text-sm max-w-md">
                      {previewConfig
                        ? `Click the button below to start the ${previewConfig.name || "application"} on port ${previewConfig.port || 5000}.`
                        : "No preview.json found. The application needs to generate a preview configuration."}
                    </p>
                  </div>

                  {previewConfig && (
                    <Button
                      size="lg"
                      onClick={() => handleStartPreview()}
                      disabled={isStartingServer}
                      className="mt-4 gap-2"
                    >
                      {isStartingServer ? (
                        <>
                          <Loader2 className="h-5 w-5 animate-spin" />
                          Starting Preview...
                        </>
                      ) : (
                        <>
                          <Play className="h-5 w-5" />
                          Start Preview
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
