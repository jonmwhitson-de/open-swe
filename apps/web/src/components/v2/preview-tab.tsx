"use client";

import { useState, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Monitor,
  RefreshCw,
  ExternalLink,
  Loader2,
  AlertCircle,
  Shield,
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
  const [useProxy, setUseProxy] = useState(true); // Default to using proxy

  // Use custom port if entered, otherwise use the port from props
  const activePort = customPort ? parseInt(customPort, 10) : previewPort;

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

            <div className="ml-auto flex items-center gap-3">
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
                disabled={!urls.direct}
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
