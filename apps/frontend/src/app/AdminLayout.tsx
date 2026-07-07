import { Avatar, Button, Layout } from "antd";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";

const { Header, Sider, Content } = Layout;

/** 侧栏 7 项导航（对齐原型 NAV：start/llm/kb/prompts/agents/retrieval/traces） */
const NAV_ITEMS = [
  { key: "/admin", label: "快速开始" },
  { key: "/admin/models", label: "模型接入" },
  { key: "/admin/knowledge-bases", label: "知识库" },
  { key: "/admin/prompts", label: "Prompt 管理" },
  { key: "/admin/agents", label: "Agent 管理" },
  { key: "/admin/retrieval-test", label: "检索测试" },
  { key: "/admin/traces", label: "Trace 追踪" },
] as const;

/** 子路由需要高亮父级菜单的路径前缀（dashboard/evalsets/evaluations 不在侧栏） */
const PREFIX_KEYS = [
  "/admin/models",
  "/admin/knowledge-bases",
  "/admin/prompts",
  "/admin/agents",
  "/admin/retrieval-test",
  "/admin/traces",
];

const PAGE_TITLES: Record<string, string> = {
  "/admin": "快速开始",
  "/admin/dashboard": "运行看板",
  "/admin/models": "模型接入",
  "/admin/knowledge-bases": "知识库",
  "/admin/prompts": "Prompt 管理",
  "/admin/agents": "Agent 管理",
  "/admin/retrieval-test": "检索测试",
  "/admin/traces": "Trace 追踪",
  "/admin/evalsets": "评测集",
  "/admin/evaluations": "评测管理",
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

  return (
    <Layout style={{ minHeight: "100vh" }}>
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
            {NAV_ITEMS.map((item) => {
              const on = selectedKey === item.key;
              return (
                <Link key={item.key} to={item.key} style={{ textDecoration: "none" }}>
                  <div
                    style={{
                      padding: "9px 16px",
                      borderRadius: 6,
                      fontSize: 14,
                      color: on ? "#fff" : "rgba(255,255,255,.65)",
                      background: on ? "#1677ff" : "transparent",
                    }}
                  >
                    {item.label}
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
