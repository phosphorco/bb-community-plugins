import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const IDENTITY_BOUNDARIES_PLUGIN_ID = "identity-boundaries";

export const identityProfileSchema = z.object({
  id: z.string().min(1).max(256),
  displayName: z.string(),
  login: z.string(),
  profilePicture: z.string().nullable(),
  tag: z.string().regex(/^[a-z0-9_-]+$/),
});

export type IdentityProfile = z.infer<typeof identityProfileSchema>;

const getProfileOutputSchema = z.object({
  profile: identityProfileSchema.nullable(),
});

export type AgentationPromptInput = Parameters<
  BbPluginApi["sdk"]["threads"]["send"]
>[0]["input"][number];

export async function readCurrentIdentityId(
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(
      `/api/v1/plugins/${IDENTITY_BOUNDARIES_PLUGIN_ID}/http/current-profile`,
      { signal },
    );
    if (!response.ok) return null;
    const result = getProfileOutputSchema.safeParse(await response.json());
    return result.success ? result.data.profile?.id ?? null : null;
  } catch {
    return null;
  }
}

export async function getIdentityProfile(
  bb: BbPluginApi,
  identityId: string,
): Promise<IdentityProfile | null> {
  try {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: IDENTITY_BOUNDARIES_PLUGIN_ID,
      method: "getProfile",
      input: { identityId },
      outputSchema: getProfileOutputSchema,
    });
    return result.profile;
  } catch {
    // Identity Boundaries is an optional dependency. Its absence must not
    // prevent Agentation feedback from reaching the target thread.
    return null;
  }
}

export function wrapAgentationContent(
  content: string,
  profile: IdentityProfile,
): AgentationPromptInput[] {
  const marker = "\u2063";
  return [
    {
      type: "text",
      text: `[from=${profile.tag}]\n`,
      mentions: [],
      visibility: "agent-only",
    },
    {
      type: "text",
      text: `${marker} `,
      mentions: [
        {
          start: 0,
          end: marker.length,
          resource: {
            kind: "plugin",
            pluginId: IDENTITY_BOUNDARIES_PLUGIN_ID,
            itemId: `sender:${profile.id}`,
            label: profile.displayName,
          },
        },
      ],
    },
    { type: "text", text: content, mentions: [] },
    {
      type: "text",
      text: `\n[/from=${profile.tag}]`,
      mentions: [],
      visibility: "agent-only",
    },
  ];
}
