import { useState } from "react";
import { Button, Card, Form, Input } from "antd";
import { useNavigate } from "react-router-dom";
import { LoginResponseSchema } from "@codecrush/contracts";

interface LoginForm {
  email: string;
  password: string;
}

/**
 * 登录页：邮箱+密码表单，调 POST /api/auth/login，
 * 成功后存 accessToken 到 localStorage 并跳 /admin。
 */
export default function LoginPage() {
  const nav = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async (values: LoginForm) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!resp.ok) {
        throw new Error(`登录失败（${resp.status}）`);
      }
      const data = LoginResponseSchema.parse(await resp.json());
      localStorage.setItem("token", data.accessToken);
      nav("/admin", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#f5f5f5",
      }}
    >
      <Card title="CodeCrushBot 登录" style={{ width: 380 }}>
        <Form<LoginForm>
          layout="vertical"
          onFinish={onFinish}
          initialValues={{ email: "demo@codecrush.local", password: "CodeCrushDemo123!" }}
        >
          <Form.Item
            label="邮箱"
            name="email"
            rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}
          >
            <Input placeholder="邮箱" />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password placeholder="密码" />
          </Form.Item>
          {error && <div style={{ color: "#ff4d4f", marginBottom: 12 }}>{error}</div>}
          <Button type="primary" htmlType="submit" loading={loading} block>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
