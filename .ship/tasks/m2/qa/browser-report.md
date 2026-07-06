# M2 QA — Browser Report

> Playwright 驱动 frontend dev server（http://localhost:5173）。
> 验证 AC 1/3/7/8。AC 2（登录）由 backend e2e + frontend 单测覆盖，AC 4/9/10 由 backend e2e 覆盖。

## Verdict

**PASS** — 15 屏渲染、导航、Auth、Chat 三栏均通过。

## Passed

- AC3: 未登录访问 /admin 重定向到 /login
- AC1: /admin 渲染「快速开始」OK，console 无错
- AC1: /admin/dashboard 渲染「运行看板」OK，console 无错
- AC1: /admin/agents 渲染「Agent 管理」OK，console 无错
- AC1: /admin/knowledge-bases 渲染「知识库」OK，console 无错
- AC1: /admin/knowledge-bases/kb1/documents 渲染「文档」OK，console 无错
- AC1: /admin/knowledge-bases/kb1/documents/doc1/chunks 渲染「切片」OK，console 无错
- AC1: /admin/retrieval-test 渲染「检索测试」OK，console 无错
- AC1: /admin/prompts 渲染「Prompt」OK，console 无错
- AC1: /admin/evalsets 渲染「评测集」OK，console 无错
- AC1: /admin/evaluations 渲染「评测」OK，console 无错
- AC1: /admin/evaluations/er1 渲染「评测」OK，console 无错
- AC1: /admin/traces 渲染「Trace」OK，console 无错
- AC1: /admin/traces/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 渲染「Trace」OK，console 无错
- AC1: /admin/models 渲染「模型」OK，console 无错
- AC1: /chat 渲染「会话列表」OK，console 无错
- AC7: Sider 点击「模型接入」→ /admin/models
- AC8: /chat 三栏（会话列表/聊天/引用）渲染 OK

## Issues

（无）
