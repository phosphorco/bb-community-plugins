import { z } from "zod";
import { parseDocument } from "yaml";
import {
  PreviewPlacementInputV1Schema,
  type PreviewPlacementInputV1,
  type PreviewPlacementResultV1,
} from "@phosphorco/bb-message-admission/protocol";
const expected = z.strictObject({
  status:z.enum(["join","singleton","separate","conflict"]),
  targetGroupId:z.string().min(1).nullable(),
  orderedOriginalIds:z.array(z.string().min(1)),
  reasonCodes:z.array(z.string().min(1)).optional(),
}).superRefine((value,context)=>{
  if(new Set(value.orderedOriginalIds).size!==value.orderedOriginalIds.length)
    context.addIssue({code:"custom",message:"Expected original IDs must be unique."});
  if(value.reasonCodes&&new Set(value.reasonCodes).size!==value.reasonCodes.length)
    context.addIssue({code:"custom",message:"Expected reason codes must be unique."});
  if(value.status==="join"&&value.targetGroupId===null)
    context.addIssue({code:"custom",message:"An expected join must name its exact target group."});
});
const schema=z.strictObject({input:PreviewPlacementInputV1Schema,expect:expected});
export type NativePlacementFixture={input:PreviewPlacementInputV1;expect:z.infer<typeof expected>};
export type PlacementPort=(input:PreviewPlacementInputV1,signal:AbortSignal)=>Promise<PreviewPlacementResultV1>;
export type NativePlacementObservation=
  |{state:"simulated";inputHash:string;result:PreviewPlacementResultV1}
  |{state:"unsupported"|"unknown"|"not-run";reason:string};
export class PlacementUnavailable extends Error {
  constructor(readonly state:"unsupported"|"unknown",message:string){super(message);}
}
export function parseNativePlacement(source:string):NativePlacementFixture {
  const raw=source.replace(/^```(?:json)?\n/,"").replace(/\n```$/,"");
  const unique=parseDocument(raw,{uniqueKeys:true});
  if(unique.errors.length)throw Error("Ambiguous native placement JSON: "+unique.errors.map(e=>e.message).join("; "));
  return schema.parse(JSON.parse(raw));
}
