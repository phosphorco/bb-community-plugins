import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, DatasetComponent, GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

// The plugin owns one fixed modular registry. Feature components never import
// ECharts modules or dynamically mutate the registry.
echarts.use([AriaComponent, BarChart, DatasetComponent, GridComponent, LineChart, SVGRenderer, TooltipComponent]);

export { echarts };
