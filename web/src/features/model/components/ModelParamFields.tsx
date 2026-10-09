import { useTranslation } from "react-i18next";

import ParamFields, { type ParamFieldView } from "@/components/ui/ParamFields";

interface ModelParamFieldsProps {
  hasModel: boolean;
  fields: ParamFieldView[] | null;
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}

/** null fields means the selected model's parameter configuration is unavailable. */
export default function ModelParamFields({ hasModel, fields, values, onChange }: ModelParamFieldsProps) {
  const { t } = useTranslation();
  if (hasModel && fields && fields.length > 0) {
    return <ParamFields fields={fields} values={values} onChange={onChange} />;
  }
  const emptyMessage = !hasModel ? "modelConfig.selectModelForParams"
    : fields === null ? "modelConfig.paramsUnavailable"
    : "modelConfig.emptyParams";
  return (
    <p role="status" className="py-2 text-center text-sm text-muted-foreground">
      {t(emptyMessage)}
    </p>
  );
}
