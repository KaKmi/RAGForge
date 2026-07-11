import type { ChatMessage } from "../../models/ports/model-provider.port";
import type { NodeContract } from "../contracts/types";
import { renderTemplateStrict } from "./render-strict";

export function assembleMessages<TInput extends Record<string, unknown>, TOutput, TReserved>(args: {
  contract: NodeContract<TInput, TOutput, TReserved>;
  promptBody: string;
  input: TInput;
  reserved: TReserved;
}): ChatMessage[] {
  const { contract, promptBody, input, reserved } = args;
  // renderTemplateStrict 只接受 string vars；input 字段全部转字符串（history 等可空字段已在
  // inputSchema 校验后保证是 string，非 string/undefined 值不会到这里）
  const stringVars = Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]),
  );
  const rendered = renderTemplateStrict(promptBody, stringVars, contract.node);
  const envelope = { ...input, ...(reserved as object) };
  return [
    { role: "system", content: contract.systemInstructions },
    { role: "developer", content: rendered },
    { role: "user", content: JSON.stringify(envelope) },
  ];
}
