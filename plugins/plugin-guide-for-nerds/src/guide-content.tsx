import { PluginBrandIcon } from "@/components/ui/plugin-icon";
import { useCallback, useEffect, useState } from "react";
import { useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { copyPluginSurfaceAgentReference } from "./agent-reference";
import { firstPartyPluginId } from "./plugin-icons";
import { ProductMap, isGuidePageId } from "./product-map";
import type { GuideContentProps } from "./floating/contract";
import type { PluginSurface } from "./surfaces";

export interface PluginReference {
  id: string;
  icon: string | null;
  iconUrl: string | null;
  iconTinted: boolean;
}

export async function loadPluginReferences(
  sdk: Pick<PluginBrowserBbSdk, "plugins">,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, PluginReference>> {
  const [installed, catalog] = await Promise.all([
    sdk.plugins
      .list({ signal })
      .then((response) =>
        response.plugins.map((plugin): PluginReference => ({
          id: plugin.id,
          icon: plugin.icon,
          iconUrl: plugin.iconUrl,
          iconTinted: true,
        })),
      )
      .catch((): PluginReference[] => []),
    sdk.plugins.catalog
      .search({ query: "", signal })
      .then((response) =>
        response.results.map((result): PluginReference => ({
          id: result.pluginId,
          icon: result.icon,
          iconUrl: result.iconUrl,
          iconTinted: result.iconTinted,
        })),
      )
      .catch((): PluginReference[] => []),
  ]);
  return new Map(
    [...catalog, ...installed].map((plugin) => [plugin.id, plugin]),
  );
}

export function usePluginReferences(
  sessionSignal: AbortSignal,
): ReadonlyMap<string, PluginReference> {
  const sdk = useSdk();
  const [plugins, setPlugins] = useState<ReadonlyMap<string, PluginReference>>(
    () => new Map(),
  );
  useEffect(() => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (sessionSignal.aborted) return;
    sessionSignal.addEventListener("abort", abort, { once: true });
    void loadPluginReferences(sdk, controller.signal).then((references) => {
      if (!controller.signal.aborted && !sessionSignal.aborted) {
        setPlugins(references);
      }
    });
    return () => {
      controller.abort();
      sessionSignal.removeEventListener("abort", abort);
    };
  }, [sdk, sessionSignal]);
  return plugins;
}

export default function GuideContent({
  initialSelection,
  onSelectionChange,
  sessionSignal,
}: GuideContentProps) {
  const plugins = usePluginReferences(sessionSignal);
  const [initialPageId] = useState(() =>
    isGuidePageId(initialSelection.pageId) ? initialSelection.pageId : "app-shell",
  );
  const pluginPageHref = useCallback(
    (displayName: string) => {
      const id = firstPartyPluginId(displayName);
      return id && plugins.has(id) ? `/plugins/${id}` : null;
    },
    [plugins],
  );
  const renderPluginIcon = useCallback(
    (displayName: string) => {
      const id = firstPartyPluginId(displayName);
      const plugin = id ? plugins.get(id) : undefined;
      return plugin ? (
        <PluginBrandIcon
          icon={plugin.icon}
          iconUrl={plugin.iconUrl}
          iconTinted={plugin.iconTinted}
          className="inline-block size-3.5 shrink-0 text-subtle-foreground"
        />
      ) : null;
    },
    [plugins],
  );
  const onSlideChange = useCallback(
    (pageId: string) => {
      if (!sessionSignal.aborted) {
        onSelectionChange({ section: "surfaces", pageId });
      }
    },
    [onSelectionChange, sessionSignal],
  );
  const onCopyForAgent = useCallback(
    (surface: PluginSurface) =>
      copyPluginSurfaceAgentReference(surface, sessionSignal),
    [sessionSignal],
  );
  return (
    <div
      data-guide-content
      className="min-h-0 w-full pb-2"
    >
      <ProductMap
        pluginPageHref={pluginPageHref}
        renderPluginIcon={renderPluginIcon}
        initialSlideId={initialPageId}
        onSlideChange={onSlideChange}
        onCopyForAgent={onCopyForAgent}
        sessionSignal={sessionSignal}
      />
    </div>
  );
}
