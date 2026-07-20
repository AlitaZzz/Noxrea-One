"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { Slider } from "antd";
import { groupJoints, type Joint } from "@/director/entities/jointConfig";

interface Props {
  characterId: string;
  values: Record<string, number>;
  onChange: (jointKey: string, value: number) => void;
  syncRef?: React.MutableRefObject<(() => void) | null>;
}

export default function PoseSliders({ characterId: _characterId, values, onChange, syncRef }: Props) {
  const groups = groupJoints();
  const [localVals, setLocalVals] = useState<Record<string, number>>({ ...values });
  const sliderRefs = useRef<Record<string, { valSpan: HTMLSpanElement }>>({});
  const prevCharId = useRef(_characterId);

  // 外部 values 变化时同步(预设/复位/切换角色)
  useEffect(() => { setLocalVals({ ...values }); }, [values, _characterId]);

  const syncFromValues = useCallback(() => {
    setLocalVals({ ...values });
  }, [values]);

  useEffect(() => {
    if (syncRef) syncRef.current = syncFromValues;
  }, [syncRef, syncFromValues]);

  return (
    <div id="pose-sliders-wrap">
      {groups.map((g) => (
        <div key={g.group} className="mb-1">
          <h4 style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--dir-txt)", margin: "16px 0 4px" }}>{g.group}</h4>
          {g.sides.map((s) => (
            <div key={s.side || g.group}>
              {s.side && <div style={{ fontSize: 11, color: "var(--dir-dim)", margin: "9px 0 5px" }}>{s.side}</div>}
              {s.joints.map((j) => {
                const val = localVals[j.key] ?? values[j.key] ?? 0;
                return (
                  <div key={j.key} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginBottom: 5 }}>
                      <b style={{ fontWeight: 500, color: "var(--dir-txt)" }}>{j.label}</b>
                      <span style={{ color: "var(--dir-dim)", fontVariantNumeric: "tabular-nums" }}>
                        {Math.round(val)}°
                      </span>
                    </div>
                    <Slider min={j.min} max={j.max} step={1} value={val}
                      style={{ margin: 0 }}
                      tooltip={{ formatter: (v) => `${Math.round(v as number)}°` }}
                      onChange={(v) => {
                        setLocalVals((prev) => ({ ...prev, [j.key]: v as number }));
                        onChange(j.key, v as number);
                      }} />
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
