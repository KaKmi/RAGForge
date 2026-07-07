import { Injectable, NotFoundException } from "@nestjs/common";
import type { Agent, CreateAgentRequest, UpdateAgentRequest } from "@codecrush/contracts";

const MOCK_AGENTS: Agent[] = [
  {
    id: "aftersale",
    name: "售后助手",
    desc: "售后问答",
    status: "active",
    kbs: ["kb1"],
    genModelId: "m1",
    lightModelId: "m1",
    rerankModelId: "m3",
    promptRewriteVerId: "pv1",
    promptIntentVerId: "pv2",
    promptReplyVerId: "pv3",
    promptFallbackVerId: "pv4",
    topK: 20,
    topN: 5,
    threshold: 0.2,
    multi: true,
    vecWeight: 0.7,
    fallbackHuman: true,
  },
  {
    id: "product",
    name: "产品咨询助手",
    desc: "产品规格与使用咨询",
    status: "draft",
    kbs: ["kb2"],
    genModelId: "m1",
    promptRewriteVerId: "pv1",
    promptIntentVerId: "pv2",
    promptReplyVerId: "pv3",
    promptFallbackVerId: "pv4",
    topK: 10,
    topN: 3,
    threshold: 0.3,
    multi: false,
    fallbackHuman: false,
  },
];

@Injectable()
export class AgentsService {
  list(): Agent[] {
    return MOCK_AGENTS;
  }

  get(id: string): Agent {
    const agent = MOCK_AGENTS.find((a) => a.id === id);
    if (!agent) throw new NotFoundException(`agent ${id} not found`);
    return agent;
  }

  create(req: CreateAgentRequest): Agent {
    // M2 桩：仅回显（含客户端指定的 status）。M7 接 Agent 配置持久化。
    return { id: `agent-${MOCK_AGENTS.length + 1}`, ...req };
  }

  update(id: string, req: UpdateAgentRequest): Agent {
    const agent = MOCK_AGENTS.find((a) => a.id === id);
    if (!agent) throw new NotFoundException(`agent ${id} not found`);
    // M2 桩：原地合并（不持久化）
    Object.assign(agent, req);
    return agent;
  }
}
