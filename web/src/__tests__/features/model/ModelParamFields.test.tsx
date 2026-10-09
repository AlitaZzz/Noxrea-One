// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModelParamFields from "@/features/model/components/ModelParamFields";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh" } }),
}));

afterEach(cleanup);

const switchField = {
  name: "hd",
  type: "switch" as const,
  label: "高清",
  formatValue: (value: unknown) => String(value),
};

describe("ModelParamFields 空态", () => {
  it("未选模型时提示选择模型", () => {
    render(<ModelParamFields hasModel={false} fields={null} values={{}} onChange={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("modelConfig.selectModelForParams");
  });

  it("已选模型但配置不可用时不要求重新选择", () => {
    render(<ModelParamFields hasModel fields={null} values={{}} onChange={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("modelConfig.paramsUnavailable");
    expect(screen.queryByText("modelConfig.selectModelForParams")).toBeNull();
  });

  it("已选模型且配置没有可调字段时显示参数空态", () => {
    render(<ModelParamFields hasModel fields={[]} values={{}} onChange={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("modelConfig.emptyParams");
    expect(screen.queryByText("modelConfig.selectModelForParams")).toBeNull();
  });

  it("配置到达后替换空态并保留字段修改回调", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ModelParamFields hasModel fields={null} values={{ hd: true }} onChange={onChange} />);
    expect(screen.getByRole("status")).toHaveTextContent("modelConfig.paramsUnavailable");
    rerender(<ModelParamFields hasModel fields={[switchField]} values={{ hd: true }} onChange={onChange} />);

    expect(screen.getByRole("switch", { name: "高清" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "高清" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("hd", false);
    rerender(<ModelParamFields hasModel={false} fields={null} values={{}} onChange={onChange} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("modelConfig.selectModelForParams");
  });
});
