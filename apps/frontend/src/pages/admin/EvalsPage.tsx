import { type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EVAL_ROWS, REPORTS } from "../../mocks/evals";
import { tagOf } from "../../mocks/agents";

/** 评测管理：列表 + 报告详情（指标卡 + 用例明细，对齐原型，纯本地 mock）。M11 接真实 /api/evaluations。 */

const EVAL_COLS = "130px 1fr 170px 90px 90px 90px 110px 110px 70px";
const CASE_COLS = "50px 1fr 90px 90px 90px 80px";

const mono: CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };

const btnPrimary: CSSProperties = {
  height: 32,
  padding: "0 16px",
  background: "#1677ff",
  color: "#fff",
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
  fontSize: 13,
  cursor: "pointer",
};

const btnGhost: CSSProperties = {
  height: 30,
  padding: "0 14px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  background: "#fff",
  display: "flex",
  alignItems: "center",
  fontSize: 13,
  cursor: "pointer",
};

const backBtn: CSSProperties = {
  height: 30,
  padding: "0 12px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  background: "#fff",
  display: "flex",
  alignItems: "center",
  fontSize: 13,
  cursor: "pointer",
};

const gridHeader: CSSProperties = {
  display: "grid",
  padding: "12px 16px",
  background: "#fafafa",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  fontWeight: 600,
  color: "rgba(0,0,0,.65)",
};

const gridRow: CSSProperties = {
  display: "grid",
  padding: "12px 16px",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  alignItems: "center",
};

function statusTag(tag: ReturnType<typeof tagOf>) {
  return {
    fontSize: 12,
    lineHeight: "20px",
    padding: "0 8px",
    borderRadius: 4,
    background: tag.bg,
    color: tag.c,
    border: `1px solid ${tag.bd}`,
  } as CSSProperties;
}

export default function EvalsPage() {
  const navigate = useNavigate();
  const { reportId } = useParams<{ reportId?: string }>();
  const report = reportId ? REPORTS[reportId] : null;

  if (reportId && report) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div onClick={() => navigate("/admin/evaluations")} style={backBtn}>
            ← 返回列表
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, ...mono }}>{report.id}</div>
          <span style={statusTag(tagOf("green"))}>已完成</span>
          <div style={{ flex: 1 }} />
          <div style={btnGhost}>导出报告</div>
        </div>

        <div
          style={{
            background: "#fff",
            border: "1px solid #f0f0f0",
            borderRadius: 8,
            padding: "14px 20px",
            marginBottom: 16,
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr",
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>评测集</div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{report.set}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>Agent / 版本</div>
            <div style={{ fontSize: 13 }}>{report.agent}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>用例数</div>
            <div style={{ fontSize: 13 }}>{report.total}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>完成时间</div>
            <div style={{ fontSize: 13 }}>{report.time}</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 16 }}>
          {report.metrics.map(mt => (
            <div key={mt.label} style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px" }}>
              <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)", marginBottom: 8 }}>{mt.label}</div>
              <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, marginBottom: 6, color: mt.color }}>{mt.value}</div>
              <div style={{ height: 6, background: "#f5f5f5", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: mt.pct, background: mt.color, borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>

        <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0", fontSize: 14, fontWeight: 600 }}>用例明细</div>
          <div style={{ ...gridHeader, gridTemplateColumns: CASE_COLS, padding: "10px 16px" }}>
            <div>#</div>
            <div>问题</div>
            <div>召回</div>
            <div>准确</div>
            <div>引用</div>
            <div>结果</div>
          </div>
          {report.cases.map((c, i) => {
            const t = tagOf(c.tag);
            return (
              <div key={i} style={{ ...gridRow, gridTemplateColumns: CASE_COLS, padding: "10px 16px" }}>
                <div style={{ color: "rgba(0,0,0,.45)" }}>{i + 1}</div>
                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.q}</div>
                <div>{c.recall}</div>
                <div>{c.acc}</div>
                <div>{c.cite}</div>
                <div>
                  <span style={statusTag(t)}>{c.st}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>评测管理</div>
        <div style={btnPrimary}>＋ 发起评测</div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ ...gridHeader, gridTemplateColumns: EVAL_COLS }}>
          <div>任务</div>
          <div>评测集</div>
          <div>Agent / 版本</div>
          <div>召回命中</div>
          <div>回答准确</div>
          <div>引用正确</div>
          <div>状态</div>
          <div>时间</div>
          <div>操作</div>
        </div>
        {EVAL_ROWS.map(r => {
          const t = tagOf(r.tag);
          const has = !!REPORTS[r.id];
          return (
            <div key={r.id} style={{ ...gridRow, gridTemplateColumns: EVAL_COLS }}>
              <div style={{ ...mono, fontSize: 12 }}>{r.id}</div>
              <div>{r.set}</div>
              <div style={{ color: "rgba(0,0,0,.65)" }}>{r.agent}</div>
              <div style={{ fontWeight: 500 }}>{r.m1}</div>
              <div style={{ fontWeight: 500 }}>{r.m2}</div>
              <div style={{ fontWeight: 500 }}>{r.m3}</div>
              <div>
                <span style={statusTag(t)}>{r.st}</span>
              </div>
              <div style={{ color: "rgba(0,0,0,.45)" }}>{r.time}</div>
              <div>
                <span
                  onClick={() => has && navigate(`/admin/evaluations/${r.id}`)}
                  style={{
                    color: has ? "#1677ff" : "rgba(0,0,0,.25)",
                    cursor: has ? "pointer" : "not-allowed",
                  }}
                >
                  报告
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
