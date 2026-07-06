import { Card, Table, Typography } from "antd";
import type { TableProps } from "antd";
import type { EvalSet } from "@codecrush/contracts";
import { MOCK_EVAL_SETS } from "../../mocks/evals";

/** 评测集列表（占位，M11 接真实评测管线）。 */
export default function EvalSetsPage() {
  const columns: TableProps<EvalSet>["columns"] = [
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "简介", dataIndex: "desc", key: "desc" },
    { title: "用例数", dataIndex: "caseCount", key: "caseCount", width: 100 },
  ];
  return (
    <Card title="评测集">
      <Typography.Paragraph type="secondary">
        评测集与评测管理已在规划中，见 M11。以下为 mock 数据预览。
      </Typography.Paragraph>
      <Table dataSource={MOCK_EVAL_SETS} columns={columns} rowKey="id" pagination={false} />
    </Card>
  );
}
