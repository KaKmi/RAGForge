import {
  MOCK_AGENT_DIST,
  MOCK_HOT_QS,
  MOCK_STATS,
  MOCK_TREND_AREA,
  MOCK_TREND_LABELS,
  MOCK_TREND_LAST,
  MOCK_TREND_POINTS,
} from "../../mocks/dashboard";

/** 运行看板：4 列统计卡 + 近 7 日问答量折线图 + Agent 分布条 + 热门问题 Top5。M10 接真实看板数据。 */

const RANK_COLORS: [string, string][] = [
  ["#1677ff", "#fff"],
  ["#4096ff", "#fff"],
  ["#91caff", "#fff"],
  ["#f0f0f0", "rgba(0,0,0,.45)"],
  ["#f0f0f0", "rgba(0,0,0,.45)"],
];

export default function DashboardPage() {
  const maxHot = MOCK_HOT_QS[0].n;

  return (
    <div>
      {/* 4 列统计卡 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 16 }}>
        {MOCK_STATS.map((s) => (
          <div
            key={s.label}
            style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px" }}
          >
            <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)", marginBottom: 8 }}>{s.label}</div>
            <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, marginBottom: 8 }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>
              <span style={{ color: s.dc, fontWeight: 500 }}>{s.delta}</span> · {s.sub}
            </div>
          </div>
        ))}
      </div>

      {/* 2:1 网格：折线图 + Agent 分布 */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 16 }}>
        <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>近 7 日问答量</div>
          <svg viewBox="0 0 560 170" style={{ width: "100%", display: "block" }}>
            <polygon points={MOCK_TREND_AREA} fill="rgba(22,119,255,.08)" />
            <polyline
              points={MOCK_TREND_POINTS}
              fill="none"
              stroke="#1677ff"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle cx={540} cy={26} r={4} fill="#1677ff" />
            <text x={540} y={14} textAnchor="end" fontSize={12} fill="rgba(0,0,0,.65)" fontWeight={600}>
              {MOCK_TREND_LAST}
            </text>
            <text x={20} y={168} fontSize={10} fill="rgba(0,0,0,.35)">
              {MOCK_TREND_LABELS[0]}
            </text>
            <text x={280} y={168} fontSize={10} fill="rgba(0,0,0,.35)" textAnchor="middle">
              {MOCK_TREND_LABELS[1]}
            </text>
            <text x={540} y={168} fontSize={10} fill="rgba(0,0,0,.35)" textAnchor="end">
              {MOCK_TREND_LABELS[2]}
            </text>
          </svg>
        </div>
        <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Agent 问答分布 · 今日</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {MOCK_AGENT_DIST.map((ad) => (
              <div key={ad.name}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                  <span style={{ color: "rgba(0,0,0,.65)" }}>{ad.name}</span>
                  <span style={{ color: "rgba(0,0,0,.45)" }}>{ad.n} 次</span>
                </div>
                <div style={{ height: 8, background: "#f5f5f5", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${ad.pct}%`, background: ad.color, borderRadius: 4 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 热门问题 Top5 */}
      <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>热门问题 Top 5 · 近 7 日</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {MOCK_HOT_QS.map((hq, i) => {
            const [bg, fg] = RANK_COLORS[i] ?? RANK_COLORS[4];
            const pct = Math.round((hq.n / maxHot) * 100);
            return (
              <div key={hq.q} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 18,
                    height: 18,
                    flex: "none",
                    borderRadius: 4,
                    background: bg,
                    color: fg,
                    fontSize: 11,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {i + 1}
                </div>
                <div
                  style={{
                    width: 220,
                    flex: "none",
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {hq.q}
                </div>
                <div style={{ flex: 1, height: 8, background: "#f5f5f5", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: "#91caff", borderRadius: 4 }} />
                </div>
                <div style={{ width: 60, flex: "none", textAlign: "right", fontSize: 12, color: "rgba(0,0,0,.45)" }}>
                  {hq.n} 次
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
