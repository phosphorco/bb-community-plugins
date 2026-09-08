import type { AnalyticsCompiledFigure } from "./echarts-options.ts";

export type FigureUpdateDecision =
  | Readonly<{ kind: "merge" }>
  | Readonly<{ kind: "replace-families"; families: readonly string[] }>
  | Readonly<{ kind: "full-replacement" }>
  | Readonly<{ kind: "rebuild-instance" }>;

export function decideFigureUpdate(
  previous: AnalyticsCompiledFigure | null,
  next: AnalyticsCompiledFigure,
): FigureUpdateDecision {
  if (previous == null) return { kind: "full-replacement" };
  if (previous.instanceKey !== next.instanceKey || previous.renderer !== next.renderer) return { kind: "rebuild-instance" };
  if (previous.structuralSignature === next.structuralSignature) return { kind: "merge" };
  const families = Object.keys(next.componentTopology).filter((family) =>
    JSON.stringify(previous.componentTopology[family as keyof typeof previous.componentTopology])
      !== JSON.stringify(next.componentTopology[family as keyof typeof next.componentTopology]),
  );
  return families.length > 0 ? { kind: "replace-families", families } : { kind: "full-replacement" };
}
