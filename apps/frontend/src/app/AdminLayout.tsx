import { Avatar, Button, Layout } from "antd";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";

const { Header, Sider, Content } = Layout;

/** 分组侧栏导航（对齐新原型 NAV：配置 / 验证 & 观测 / 数据飞轮） */
type NavEntry = { kind: "group"; label: string } | { kind: "item"; key: string; label: string };
const NAV_ENTRIES: NavEntry[] = [
  { kind: "item", key: "/admin", label: "快速开始" },
  { kind: "group", label: "配置" },
  { kind: "item", key: "/admin/models", label: "模型接入" },
  { kind: "item", key: "/admin/knowledge-bases", label: "知识库" },
  { kind: "item", key: "/admin/prompts", label: "Prompt 管理" },
  { kind: "item", key: "/admin/applications", label: "应用管理" },
  { kind: "group", label: "验证 & 观测" },
  { kind: "item", key: "/admin/retrieval-test", label: "检索测试" },
  { kind: "item", key: "/admin/traces", label: "Trace 追踪" },
  { kind: "group", label: "数据飞轮" },
  { kind: "item", key: "/admin/gaps", label: "知识缺口" },
  { kind: "item", key: "/admin/evalsets", label: "评测集" },
  { kind: "item", key: "/admin/evaluations", label: "效果评测" },
];

/** 子路由需要高亮父级菜单的路径前缀（dashboard 不在侧栏） */
const PREFIX_KEYS = [
  "/admin/models",
  "/admin/knowledge-bases",
  "/admin/prompts",
  "/admin/agents",
  "/admin/applications",
  "/admin/retrieval-test",
  "/admin/traces",
  "/admin/gaps",
  "/admin/evalsets",
  "/admin/evaluations",
];

const PAGE_TITLES: Record<string, string> = {
  "/admin": "快速开始",
  "/admin/dashboard": "运行看板",
  "/admin/models": "模型接入",
  "/admin/knowledge-bases": "知识库",
  "/admin/prompts": "Prompt 管理",
  "/admin/agents": "Agent 管理",
  "/admin/applications": "应用管理",
  "/admin/retrieval-test": "检索测试",
  "/admin/traces": "Trace 追踪",
  "/admin/gaps": "知识缺口",
  "/admin/evalsets": "评测集",
  "/admin/evaluations": "效果评测",
};

function getSelectedKey(pathname: string): string {
  if (pathname === "/admin") return "/admin";
  return PREFIX_KEYS.find((k) => pathname === k || pathname.startsWith(`${k}/`)) ?? "";
}

function getPageTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  for (const k of PREFIX_KEYS) {
    if (pathname.startsWith(`${k}/`)) return PAGE_TITLES[k] ?? "";
  }
  return "";
}

export function AdminLayout() {
  const loc = useLocation();
  const navigate = useNavigate();
  const selectedKey = getSelectedKey(loc.pathname);
  const pageTitle = getPageTitle(loc.pathname);

  const handleLogout = () => {
    localStorage.removeItem("token");
    navigate("/login", { replace: true });
  };

  // height 而非 minHeight：滚动收敛到 Content 内部，侧栏/顶栏恒定可见
  return (
    <Layout style={{ height: "100vh" }}>
      <Sider theme="dark" width={208} style={{ background: "#001529" }}>
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 16, height: 56 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: "#1677ff",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              CC
            </div>
            <div style={{ color: "#fff", fontSize: 15, fontWeight: 600 }}>控制台</div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            {NAV_ENTRIES.map((entry, i) => {
              if (entry.kind === "group") {
                return (
                  <div
                    key={`g-${i}`}
                    style={{
                      padding: "10px 16px 2px",
                      fontSize: 11,
                      letterSpacing: 1,
                      color: "rgba(255,255,255,.35)",
                      userSelect: "none",
                    }}
                  >
                    {entry.label}
                  </div>
                );
              }
              const on = selectedKey === entry.key;
              return (
                <Link key={entry.key} to={entry.key} style={{ textDecoration: "none" }}>
                  <div
                    style={{
                      padding: "9px 16px",
                      borderRadius: 6,
                      fontSize: 14,
                      color: on ? "#fff" : "rgba(255,255,255,.65)",
                      background: on ? "#1677ff" : "transparent",
                    }}
                  >
                    {entry.label}
                  </div>
                </Link>
              );
            })}
          </div>
          <Link
            to="/chat"
            style={{
              margin: 8,
              padding: "9px 16px",
              borderRadius: 6,
              fontSize: 13,
              color: "rgba(255,255,255,.65)",
              border: "1px solid rgba(255,255,255,.2)",
              textAlign: "center",
              textDecoration: "none",
              display: "block",
            }}
          >
            ← 返回问答页
          </Link>
        </div>
      </Sider>
      <Layout>
        <Header
          style={{
            height: 56,
            background: "#fff",
            borderBottom: "1px solid #f0f0f0",
            display: "flex",
            alignItems: "center",
            padding: "0 24px",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>CodeCrushBot 控制台</div>
          <div style={{ fontSize: 13, color: "rgba(0,0,0,.25)" }}>/</div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{pageTitle}</div>
          <div style={{ flex: 1 }} />
          <Avatar size={28} style={{ background: "#87d068", fontSize: 12 }}>
            刘
          </Avatar>
          <Button type="text" size="small" onClick={handleLogout} style={{ color: "rgba(0,0,0,.45)" }}>
            退出
          </Button>
        </Header>
        <Content style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
