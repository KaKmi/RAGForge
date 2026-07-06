const baseUrl = process.env.BACKEND_URL ?? "http://localhost:3000";

async function requestJson(path, init) {
  const res = await fetch(`${baseUrl}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return await res.json();
}

async function getToken() {
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN;
  const email = process.env.DEMO_USER_EMAIL ?? "demo@codecrush.local";
  const password = process.env.DEMO_USER_PASSWORD ?? "CodeCrushDemo123!";
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(
      `login failed (${res.status}): 请先运行 pnpm db:migrate && pnpm db:seed 创建 demo 账号`,
    );
  }
  return (await res.json()).accessToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const token = await getToken();
const authHeaders = { Authorization: `Bearer ${token}` };

const hello = await requestJson("/traces/hello", { method: "POST", headers: authHeaders });
if (!/^[a-f0-9]{32}$/i.test(hello.traceId) || !/^[a-f0-9]{16}$/i.test(hello.spanId)) {
  throw new Error(`invalid hello response: ${JSON.stringify(hello)}`);
}

let detail;
let lastError;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  try {
    detail = await requestJson(`/traces/${hello.traceId}`, { headers: authHeaders });
    if (detail.spans?.some((span) => span.name === "manual.hello")) {
      console.log(
        JSON.stringify({ status: "ok", traceId: hello.traceId, attempts: attempt }, null, 2),
      );
      process.exit(0);
    }
  } catch (err) {
    lastError = err;
  }
  await sleep(500);
}

throw new Error(
  `trace ${hello.traceId} did not appear in ClickHouse view: ${JSON.stringify(detail)} ${lastError ?? ""}`,
);
