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

  useEffect(() => { setLocalVals({ ...values }); }, [values, _characterId]);

  const syncFromValues = useCallback(() => { setLocalVals({ ...values }); }, [values]);
  useEffect(() => { if (syncRef) syncRef.current = syncFromValues; }, [syncRef, syncFromValues]);

  return (
    <div id="pose-sliders-wrap">
      {groups.map((g) => (
        <div key={g.group}>
          <h4 className="pose-h4">{g.group}</h4>
          {g.sides.map((s) => (
            <div key={s.side || g.group}>
              {s.side && <div className="pose-side">{s.side}</div>}
              {s.joints.map((j) => {
                const val = localVals[j.key] ?? values[j.key] ?? 0;
                return (
                  <div key={j.key} className="pose-sld">
                    <div className="pose-sld-lab">
                      <b>{j.label}</b>
                      <span className="pose-sld-val">{Math.round(val)}°</span>
                    </div>
                    <Slider min={j.min} max={j.max} step={1} value={val}
                      style={{ margin: 0 }}
                      tooltip={{ open: false }}
                      onChange={(v) => { setLocalVals((prev) => ({ ...prev, [j.key]: v as number })); onChange(j.key, v as number); }} />
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
