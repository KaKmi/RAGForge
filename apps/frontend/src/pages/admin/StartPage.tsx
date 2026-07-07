import { Link } from "react-router-dom";

interface StartStep {
  title: string;
  desc: string;
  to: string;
  done: boolean;
}

const STEPS: StartStep[] = [
  {
    title: "接入模型",
    desc: "配置生成模型与向量（Embedding）模型——这是文档入库和问答的前提。",
    to: "/admin/models",
    done: true,
  },
  {
    title: "创建知识库并上传文档",
    desc: "新建知识库、上传文档，系统自动解析、切片、向量化入库。",
    to: "/admin/knowledge-bases",
    done: true,
  },
  {
    title: "配置 Prompt",
    desc: "编辑回复生成与兜底话术模板，控制回答的风格与边界。",
    to: "/admin/prompts",
    done: false,
  },
  {
    title: "配置 Agent",
    desc: "为 Agent 选择知识库、生成模型与 Prompt，组成一个可对话的问答机器人。",
    to: "/admin/agents",
    done: false,
  },
  {
    title: "验证并上线",
    desc: "在检索测试确认召回正确，发布后到 C 端问答；遇到问题用 Trace 追踪链路。",
    to: "/admin/retrieval-test",
    done: false,
  },
];

interface StepTone {
  tag: string;
  tagBg: string;
  tagC: string;
  tagBd: string;
  numBg: string;
  numC: string;
  bd: string;
  btnLabel: string;
  btnBg: string;
  btnC: string;
  btnBd: string;
}

function stepTone(done: boolean, isCurrent: boolean): StepTone {
  if (done) {
    return {
      tag: "已完成",
      tagBg: "#f6ffed",
      tagC: "#52c41a",
      tagBd: "#b7eb8f",
      numBg: "#52c41a",
      numC: "#fff",
      bd: "#f0f0f0",
      btnLabel: "重新配置",
      btnBg: "#fff",
      btnC: "rgba(0,0,0,.65)",
      btnBd: "#d9d9d9",
    };
  }
  if (isCurrent) {
    return {
      tag: "进行中",
      tagBg: "#e6f4ff",
      tagC: "#1677ff",
      tagBd: "#91caff",
      numBg: "#1677ff",
      numC: "#fff",
      bd: "#91caff",
      btnLabel: "去配置",
      btnBg: "#1677ff",
      btnC: "#fff",
      btnBd: "#1677ff",
    };
  }
  return {
    tag: "待开始",
    tagBg: "#fafafa",
    tagC: "rgba(0,0,0,.45)",
    tagBd: "#e8e8e8",
    numBg: "#f0f0f0",
    numC: "rgba(0,0,0,.45)",
    bd: "#f0f0f0",
    btnLabel: "去配置",
    btnBg: "#fff",
    btnC: "rgba(0,0,0,.65)",
    btnBd: "#d9d9d9",
  };
}

/** 快速开始：进度条 + 5 步卡片，每步「去配置」跳对应路由。 */
export default function StartPage() {
  const doneCount = STEPS.filter((s) => s.done).length;
  const total = STEPS.length;
  const pct = Math.round((doneCount / total) * 100);
  const currentIdx = STEPS.findIndex((s) => !s.done);

  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>快速开始</div>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.5)", marginBottom: 6, lineHeight: 1.7 }}>
        按顺序完成下面 5 步，即可让一个 RAG 智能体从「上传知识」跑通到「C 端问答」。
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <div style={{ flex: 1, height: 6, borderRadius: 3, background: "#f0f0f0", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "#1677ff" }} />
        </div>
        <span style={{ fontSize: 12, color: "rgba(0,0,0,.5)" }}>
          已完成 {doneCount} / {total}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}>
        {STEPS.map((s, i) => {
          const t = stepTone(s.done, i === currentIdx);
          const numText = s.done ? "✓" : String(i + 1);
          return (
            <div
              key={s.title}
              style={{
                display: "flex",
                gap: 14,
                background: "#fff",
                border: `1px solid ${t.bd}`,
                borderRadius: 10,
                padding: "16px 18px",
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  flex: "none",
                  borderRadius: "50%",
                  background: t.numBg,
                  color: t.numC,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                {numText}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{s.title}</span>
                  <span
                    style={{
                      fontSize: 11,
                      lineHeight: "18px",
                      padding: "0 8px",
                      borderRadius: 9,
                      background: t.tagBg,
                      color: t.tagC,
                      border: `1px solid ${t.tagBd}`,
                    }}
                  >
                    {t.tag}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.55)", lineHeight: 1.7, marginTop: 4 }}>
                  {s.desc}
                </div>
              </div>
              <Link
                to={s.to}
                style={{
                  flex: "none",
                  alignSelf: "center",
                  height: 34,
                  padding: "0 16px",
                  borderRadius: 6,
                  background: t.btnBg,
                  color: t.btnC,
                  border: `1px solid ${t.btnBd}`,
                  display: "flex",
                  alignItems: "center",
                  fontSize: 13,
                  textDecoration: "none",
                }}
              >
                {t.btnLabel}
              </Link>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 20, fontSize: 12, color: "rgba(0,0,0,.4)", lineHeight: 1.7, maxWidth: 720 }}>
        运行看板、评测集与评测管理已在规划中，当前版本聚焦「配置 → 验证 → 上线 → 追踪」这条主链路。
      </div>
    </div>
  );
}
