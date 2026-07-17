import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// RTL 默认 findBy*/waitFor 窗口只有 1s，是按「等一次状态更新」定的；本套件的等待对象却是
// 「antd 页面首帧」——懒加载 chunk 现场编译 + antd 6 cssinjs 首次渲染现算整套 token/样式，
// 是几百毫秒到数秒的同步 CPU 活。实测：空载最慢用例 ~1.6s，`pnpm test` 全量并跑时 ~2.1s，
// 机器再忙一点就冲破 1s/5s。窗口不是断言语义的一部分——元素该出现还是该出现，只是允许它
// 出现得慢一点；给到 15s（≈ 实测最坏值的 7 倍）后，余量足以吸收调度抖动。
configure({ asyncUtilTimeout: 15_000 });

// antd 6 响应式组件（Sider/Menu/Grid 等）依赖 matchMedia，jsdom 不实现，需 mock。
// 否则组件挂载时触发异步状态更新，产生 act(...) 警告并可能掩盖真实测试问题。
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
