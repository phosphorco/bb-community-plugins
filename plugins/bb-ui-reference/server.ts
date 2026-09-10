import { readFile } from "node:fs/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { frameSurfaceMap, SURFACE_MAP_SECTIONS } from "./ui-reference.ts";

const assetCandidates = (name: string) => [
  new URL(`./assets/${name}`, import.meta.url),
  new URL(`../assets/${name}`, import.meta.url),
];

async function readAsset(name: string): Promise<string> {
  for (const candidate of assetCandidates(name)) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // Source and built entrypoints have different depths within this workspace.
    }
  }
  throw new Error(`${name} is unavailable`);
}

export default function uiReferencePlugin(bb: BbPluginApi): void {
  bb.http.route("GET", "/surface-map", async () => {
    try {
      return new Response(await readAsset("bb-plugin-ui-surfaces.svg"), {
        headers: {
          "cache-control": "no-cache",
          "content-type": "image/svg+xml; charset=utf-8",
        },
      });
    } catch {
      return new Response("Surface map unavailable", { status: 404 });
    }
  });
  for (const section of SURFACE_MAP_SECTIONS) {
    bb.http.route("GET", `/surface-map-${section.id}`, async () => {
      try {
        const map = await readAsset("bb-plugin-ui-surfaces.svg");
        return new Response(frameSurfaceMap(map, section.viewBox), {
          headers: {
            "cache-control": "no-cache",
            "content-type": "image/svg+xml; charset=utf-8",
          },
        });
      } catch {
        return new Response("Surface map section unavailable", { status: 404 });
      }
    });
  }
  bb.http.route("GET", "/surface-legend", async () => {
    try {
      return new Response(await readAsset("bb-plugin-ui-surfaces-legend.svg"), {
        headers: {
          "cache-control": "no-cache",
          "content-type": "image/svg+xml; charset=utf-8",
        },
      });
    } catch {
      return new Response("Surface legend unavailable", { status: 404 });
    }
  });
  bb.http.route("GET", "/native-ui-icons", async () => {
    try {
      return new Response(await readAsset("bb-native-ui-icons.svg"), {
        headers: {
          "cache-control": "no-cache",
          "content-type": "image/svg+xml; charset=utf-8",
        },
      });
    } catch {
      return new Response("Native UI illustrations unavailable", { status: 404 });
    }
  });
}
