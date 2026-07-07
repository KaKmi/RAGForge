import { type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { EVALSET_ROWS } from "../../mocks/evals";

/** 评测集：列表 + 导入（对齐原型，纯本地 mock）。M11 接真实 /api/eval-sets。 */

const SET_COLS = "220px 90px 1fr 130px 150px";

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

const gridHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: SET_COLS,
  padding: "12px 16px",
  background: "#fafafa",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  fontWeight: 600,
  color: "rgba(0,0,0,.65)",
};

const gridRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: SET_COLS,
  padding: "12px 16px",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  alignItems: "center",
};

const linkBlue: CSSProperties = { color: "#1677ff", cursor: "pointer" };

export default function EvalSetsPage() {
  const navigate = useNavigate();

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>评测集</div>
        <div style={btnPrimary}>＋ 导入评测集</div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
        <div style={gridHeader}>
          <div>评测集名称</div>
          <div>用例数</div>
          <div>覆盖场景</div>
          <div>创建时间</div>
          <div>操作</div>
        </div>
        {EVALSET_ROWS.map(r => (
          <div key={r.name} style={gridRow}>
            <div style={{ fontWeight: 500 }}>{r.name}</div>
            <div>{r.n}</div>
            <div style={{ color: "rgba(0,0,0,.65)" }}>{r.cover}</div>
            <div style={{ color: "rgba(0,0,0,.45)" }}>{r.time}</div>
            <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
              <span style={linkBlue}>查看用例</span>
              <span style={linkBlue} onClick={() => navigate("/admin/evaluations")}>
                发起评测
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
