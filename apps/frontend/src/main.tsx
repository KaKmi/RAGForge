import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";

const theme = { token: { colorPrimary: "#1677ff", borderRadius: 6 } };

// 注意：不启用 React.StrictMode——React 19 的双 mount/unmount 会打断 antd v6 的
// rc-motion/portal，导致 Modal/Drawer 等弹层在开发模式下无法挂载。生产构建本就不双调用。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ConfigProvider locale={zhCN} theme={theme}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </ConfigProvider>,
);
