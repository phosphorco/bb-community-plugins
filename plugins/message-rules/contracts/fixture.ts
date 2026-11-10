import { parseDocument } from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { z } from "zod";
import { Id, normalizeAdvice } from "./model.ts";
import type { Capture, History } from "./model.ts";
const metaSchema = z
  .object({
    version: z.literal(1),
    id: Id,
    project_title: z.string().nullable().default(null),
    sender_id: z.string().nullable().default(null),
    destination_id: z.string().nullable().default(null),
    sender_title: z.string().nullable().default(null),
    destination_title: z.string().nullable().default(null),
    expect: z.enum(["allow", "reject", "unknown"]),
    expected_rules: z.array(Id).optional(),
    expected_batch: z.array(Id).optional(),
  })
  .strict();
export type Fixture = {
  meta: z.infer<typeof metaSchema>;
  capture: Capture;
  expectedAdvice?: string[];
  queued?: {
    id: string;
    senderId: string | null;
    eligible: boolean;
    reason?: string;
  }[];
  source: string;
};
const empty = (text: string | undefined): History =>
  text === undefined
    ? { events: [], coverage: "unavailable", through: null }
    : {
        events: text ? [{ id: "fixture-1", text, sequence: 1 }] : [],
        coverage: text ? "complete" : "empty-confirmed",
        through: 1,
      };
export function parseFixture(source: string): Fixture {
  if (Buffer.byteLength(source) > 262144)
    throw Error("Test file exceeds 256 KiB.");
  const normalized = source.replace(/\r\n/g, "\n");
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!front)
    throw Error(
      "Start with YAML front matter delimited by --- on its own line.",
    );
  const doc = parseDocument(front[1]!, { uniqueKeys: true });
  if (doc.errors.length)
    throw Error(doc.errors.map((x) => x.message).join("; "));
  const meta = metaSchema.parse(doc.toJS());
  if (
    meta.expected_rules &&
    new Set(meta.expected_rules).size !== meta.expected_rules.length
  )
    throw Error("Duplicate expected rule ID.");
  const body = normalized.slice(front[0].length),
    tree = unified().use(remarkParse).parse(body);
  const headers = tree.children
    .filter((x) => x.type === "heading" && x.depth === 1)
    .map((x) => ({
      name: body
        .slice(x.position!.start.offset! + 2, x.position!.end.offset!)
        .trim(),
      start: x.position!.end.offset!,
      at: x.position!.start.offset!,
    }));
  const sections = new Map<string, string>();
  const allowed = [
    "Message",
    "Sender context",
    "Destination context",
    "Expected advice",
    "Queued messages",
  ];
  headers.forEach((h, i) => {
    if (!allowed.includes(h.name)) return;
    if (sections.has(h.name)) throw Error("Duplicate section: " + h.name);
    const end = headers[i + 1]?.at ?? body.length;
    sections.set(
      h.name,
      body
        .slice(h.start, end)
        .replace(/^\n/, "")
        .replace(/\n\n$/, "")
        .replace(/\n$/, ""),
    );
  });
  if (!sections.has("Message"))
    throw Error("Add a top-level # Message section.");
  const expectedAdvice = sections.has("Expected advice")
    ? sections.get("Expected advice") === ""
      ? []
      : sections.get("Expected advice")!.split("\n---\n").map(normalizeAdvice)
    : undefined;
  let queued: Fixture["queued"];
  if (sections.has("Queued messages")) {
    const raw = sections
      .get("Queued messages")!
      .replace(/^```(?:yaml)?\n/, "")
      .replace(/\n```$/, "");
    queued = z
      .array(
        z
          .object({
            id: Id,
            senderId: z.string().nullable(),
            eligible: z.boolean(),
            reason: z.string().optional(),
          })
          .strict(),
      )
      .max(200)
      .parse(parseDocument(raw).toJS());
    if (new Set(queued.map((x) => x.id)).size !== queued.length)
      throw Error("Queued original IDs must be unique.");
  }
  return {
    meta,
    queued,
    capture: {
      projectTitle: meta.project_title,
      message: sections.get("Message")!,
      senderTitle: meta.sender_title,
      destinationTitle: meta.destination_title,
      sender: empty(sections.get("Sender context")),
      destination: empty(sections.get("Destination context")),
      provenance: {
        senderId: meta.sender_id,
        destinationId: meta.destination_id,
      },
    },
    expectedAdvice,
    source,
  };
}
export { fixtureTemplate } from "./template.ts";
