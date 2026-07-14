import { BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

export function MetricChart({ option, height = 260, ariaLabel }: {
  option: EChartsCoreOption;
  height?: number;
  ariaLabel: string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (import.meta.env.MODE === "test") return;
    if (!host.current) return;
    const chart = echarts.init(host.current, undefined, { renderer: "svg" });
    chart.setOption(option);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => chart.resize());
    observer?.observe(host.current);
    return () => {
      observer?.disconnect();
      chart.dispose();
    };
  }, [option]);

  return <div ref={host} role="img" aria-label={ariaLabel} style={{ width: "100%", height }} />;
}
