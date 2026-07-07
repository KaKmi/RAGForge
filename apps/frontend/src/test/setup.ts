import "@testing-library/jest-dom";

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
