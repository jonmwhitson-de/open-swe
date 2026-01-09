"use client";

import { useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Monitor,
  RefreshCw,
  ExternalLink,
  Loader2,
  AlertCircle,
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
}

export function PreviewTab({ previewPort, isLoading }: PreviewTabProps) {
  const [customPort, setCustomPort] = useState<string>("");
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeError, setIframeError] = useState(false);

  // Use custom port if entered, otherwise use the port from props
  const activePort = customPort ? parseInt(customPort, 10) : previewPort;
  const previewUrl = activePort ? `http://localhost:${activePort}` : null;

  const handleRefresh = useCallback(() => {
    setIframeKey((prev) => prev + 1);
    setIframeError(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setIframeError(true);
  }, []);

  const handleOpenExternal = useCallback(() => {
    if (previewUrl) {
      window.open(previewUrl, "_blank", "noopener,noreferrer");
    }
  }, [previewUrl]);

  return (
    <Card className="border-border bg-card relative flex h-full min-h-0 flex-col p-0">
      <CardContent className="h-full min-h-0 flex-1 p-0">
        <div className="flex h-full flex-col">
          {/* Toolbar */}
          <div className="border-border bg-muted/30 flex items-center gap-2 border-b px-3 py-2">
            <Monitor className="text-muted-foreground h-4 w-4" />
            <span className="text-muted-foreground text-sm font-medium">
              Preview
            </span>

            <div className="ml-auto flex items-center gap-2">
              <Input
                type="number"
                placeholder="Port (e.g., 3000)"
                value={customPort}
                onChange={(e) => setCustomPort(e.target.value)}
                className="h-7 w-32 text-xs"
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
                disabled={!previewUrl}
                className="h-7 w-7 p-0"
                title="Open in new tab"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
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
                        The development server at {previewUrl} may not be
                        running or accessible.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRefresh}
                    >
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
                      "dark:bg-neutral-900",
                    )}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                    onError={handleIframeError}
                  />
                )}
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <Monitor className="text-muted-foreground h-8 w-8" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">No preview available</p>
                  <p className="text-muted-foreground text-sm">
                    Enter a port number above to preview your running
                    application, or start a development server in the sandbox.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
