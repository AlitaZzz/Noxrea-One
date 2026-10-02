/**
 * 角色骨骼姿态调节滑杆组。
 * 依据关节配置按部位 / 左右分组渲染滑杆，内部维持本地值以保证拖拽流畅，
 * 并通过 syncRef 支持外部（如姿态预设应用后）强制回填。
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Slider } from "@/components/ui/slider";
import { groupJoints } from "@/features/director/entities/joint-config";

interface Props {
  characterId: string;
  values: Record<string, number>;
  onChange: (jointKey: string, value: number) => void;
  syncRef?: React.MutableRefObject<(() => void) | null>;
}

export default function PoseSliders({ values, onChange, syncRef }: Props) {
  const { t } = useTranslation();
  const groups = groupJoints();
  const [localVals, setLocalVals] = useState<Record<string, number>>({ ...values });
  const [prevValues, setPrevValues] = useState(values);
  if (values !== prevValues) {
    setPrevValues(values);
    setLocalVals({ ...values });
  }

  const syncFromValues = useCallback(() => { setLocalVals({ ...values }); }, [values]);
  useEffect(() => { if (syncRef) syncRef.current = syncFromValues; }, [syncRef, syncFromValues]);

  return (
    <div id="pose-sliders-wrap">
      {groups.map((g) => (
        <div key={g.group}>
          <h4 className="mb-1 mt-4 text-[13px] font-semibold text-foreground first:mt-0">
            {t(`director.joint.group.${g.group}`)}
          </h4>
          {g.sides.map((s) => (
            <div key={s.side || g.group}>
              {s.side && (
                <div className="mb-1 mt-2 text-xs text-muted-foreground">
                  {t(`director.joint.side.${s.side}`)}
                </div>
              )}
              {s.joints.map((j) => {
                const val = localVals[j.key] ?? values[j.key] ?? 0;
                return (
                  <div key={j.key} className="mb-2.5">
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <b className="font-medium text-foreground">{t(`director.joint.label.${j.label}`)}</b>
                      <span className="tabular-nums text-muted-foreground">{Math.round(val)}°</span>
                    </div>
                    <Slider min={j.min} max={j.max} step={1} value={[val]}
                      onValueChange={([next]) => { setLocalVals((prev) => ({ ...prev, [j.key]: next })); onChange(j.key, next); }} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
